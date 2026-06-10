import fs from 'node:fs';
import path from 'node:path';
import { now } from '../utils.js';
import { recordEmit as shadowRecord } from './shadowLedger.js';

const SINK_PATH = process.env.MERIDIAN_SINK_PATH || '/home/meridian/meridian/data/charon-signals.json';
const FLUSH_MS = Number(process.env.MERIDIAN_SINK_FLUSH_MS || 15_000);
const TTL_MS = Number(process.env.MERIDIAN_SINK_TTL_MS || 30 * 60_000);
const SCHEMA_VERSION = 1;

const buffer = new Map();
let lastFlushAt = 0;
let flushTimer = null;

function tierRank(route) {
  switch (route) {
    case 'fee_graduated_trending': return 6;
    case 'fee_graduated': return 5;
    case 'fee_trending': return 4;
    case 'graduated_trending': return 3;
    case 'multi_source': return 2;
    case 'dual_source': return 1;
    case 'single_source': return 0;
    default: return 0;
  }
}

function sourcesFromRoute(route) {
  const set = new Set();
  if (typeof route !== 'string') return [];
  if (route.includes('fee')) set.add('fee_claim');
  if (route.includes('graduated')) set.add('graduated');
  if (route.includes('trending')) set.add('trending');
  if (route === 'multi_source' || route === 'dual_source') set.add('multi_source');
  return [...set];
}

function tierMinSources(route) {
  switch (route) {
    case 'fee_graduated_trending': return 3;
    case 'fee_graduated':
    case 'fee_trending':
    case 'graduated_trending':
    case 'multi_source': return 2;
    case 'dual_source': return 2;
    default: return 1;
  }
}

function buildRecord({ mint, route, fee, graduatedCoin, trendingToken }) {
  const symbol = graduatedCoin?.ticker || trendingToken?.symbol || null;
  const mcap = Number(
    graduatedCoin?.marketCap ?? trendingToken?.market_cap ?? trendingToken?.marketCap ?? 0,
  ) || null;
  const volume = Number(
    graduatedCoin?.volume ?? trendingToken?.volume ?? trendingToken?.volume24h ?? 0,
  ) || null;
  return {
    base_mint: mint,
    symbol,
    source: route || 'unknown',
    sources: sourcesFromRoute(route),
    min_sources: tierMinSources(route),
    confidence: tierRank(route) / 6,
    seen_at: new Date(now()).toISOString(),
    mcap_usd: mcap,
    volume_24h_usd: volume,
    has_fee_claim: Boolean(fee),
    // Fee-claim MAGNITUDE (raw SOL distributed) — bigger claim = more LP fee
    // activity = stronger signal. Emit raw; Meridian's Darwin buckets it from
    // observed outcomes (no hardcoded tiers). null for non-fee routes.
    fee_claim_sol: fee?.distributed != null ? Number((Number(fee.distributed) / 1e9).toFixed(4)) : null,
    consecutive_flag_count: 1,
  };
}

function pruneExpired() {
  const at = now();
  const cutoff = at - TTL_MS;
  for (const [mint, entry] of buffer) {
    if (entry.seen_at_ms < cutoff) buffer.delete(mint);
  }
}

function atomicWrite(payload) {
  const dir = path.dirname(SINK_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const tmp = `${SINK_PATH}.tmp`;
  const fd = fs.openSync(tmp, 'w');
  try {
    fs.writeFileSync(fd, JSON.stringify(payload, null, 2));
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, SINK_PATH);
}

function flush() {
  pruneExpired();
  const signals = [...buffer.values()]
    .map(entry => ({
      ...entry.record,
      consecutive_flag_count: entry.count,
    }))
    .sort((a, b) => (b.confidence || 0) - (a.confidence || 0));
  // Restart guard (2026-06-10 audit): the buffer is in-memory and dies on every
  // deploy; the boot-time flush used to clobber a still-valid file with an empty
  // payload, blanking meridian's charon feed for a poll cycle. If we have nothing
  // buffered but the existing file's newest signal is still inside TTL, keep it —
  // meridian applies its own read-side TTL, so a legitimately-dead feed still
  // ages out there. A genuinely-expired file (newest signal older than TTL)
  // falls through and gets overwritten with the honest empty payload.
  if (signals.length === 0) {
    try {
      const prev = JSON.parse(fs.readFileSync(SINK_PATH, 'utf8'));
      const newest = Math.max(0, ...(prev.signals || []).map(sig => Date.parse(sig.seen_at) || 0));
      if (newest && (now() - newest) < TTL_MS) return;
    } catch { /* missing/unreadable file — write the empty payload */ }
  }
  const payload = {
    schema_version: SCHEMA_VERSION,
    generated_at: new Date(now()).toISOString(),
    ttl_ms: TTL_MS,
    signals,
  };
  try {
    atomicWrite(payload);
    lastFlushAt = now();
  } catch (err) {
    console.log(`[sink] flush failed: ${err.message}`);
  }
}

export async function sinkSignal(payload) {
  try {
    if (!payload?.mint) return;
    const at = now();
    const existing = buffer.get(payload.mint);
    if (existing) {
      const incomingRank = tierRank(payload.route);
      const currentRank = tierRank(existing.record.source);
      if (incomingRank >= currentRank) {
        existing.record = { ...existing.record, ...buildRecord(payload) };
      }
      existing.count += 1;
      existing.seen_at_ms = at;
    } else {
      buffer.set(payload.mint, {
        record: buildRecord(payload),
        count: 1,
        seen_at_ms: at,
      });
    }
    if (at - lastFlushAt >= FLUSH_MS) flush();
    // Shadow ledger: paper-trade top-tier signals (fire-and-forget — sink path must never block)
    const entry = buffer.get(payload.mint);
    shadowRecord({
      base_mint: payload.mint,
      symbol: entry?.record?.symbol || null,
      tier: payload.route,
      sources: entry?.record?.sources || [],
      min_sources: entry?.record?.min_sources || 1,
      consecutive_flags: entry?.count || 1,
      has_fee_claim: Boolean(payload.fee),
    }).catch((err) => console.log(`[sink] shadow record failed: ${err.message}`));
  } catch (err) {
    console.log(`[sink] error: ${err.message}`);
  }
}

export function startSinkFlusher() {
  if (flushTimer) return;
  flushTimer = setInterval(flush, FLUSH_MS);
  console.log(`[sink] writing ${SINK_PATH} every ${FLUSH_MS}ms (TTL ${TTL_MS}ms)`);
  flush();
}
