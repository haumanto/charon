// Shadow ledger: paper-trade Charon's top-tier signals against
// hypothetical Jupiter entry/exit prices. No capital, no execution.
//
// Logs every emit where tier rank >= 3 (fee_* family + graduated_trending),
// fetches an entry price snapshot, and follows up at +1h / +4h / +24h.
// Aggregate report via `node scripts/shadow-report.js`.
//
// The point: observe whether top-tier Charon signals would have produced
// alpha at small spot-buy size, BEFORE risking any real capital.

import { db } from '../db/connection.js';
import { fetchJupiterAsset } from '../enrichment/jupiter.js';
import { now } from '../utils.js';

const DEDUP_WINDOW_MS = 24 * 60 * 60 * 1000;   // don't re-record same mint within 24h
const MIN_TIER_RANK = 3;                        // fee_*, fee_graduated_trending, fee_graduated, fee_trending, graduated_trending
const ABANDON_AFTER_MS = 25 * 60 * 60 * 1000;   // give up on snapshots after 25h
const POLL_INTERVAL_MS = 5 * 60 * 1000;

function tierRank(tier) {
  switch (tier) {
    case 'fee_graduated_trending': return 6;
    case 'fee_graduated':          return 5;
    case 'fee_trending':           return 4;
    case 'graduated_trending':     return 3;
    case 'multi_source':           return 2;
    case 'dual_source':            return 1;
    case 'single_source':          return 0;
    default:                       return 0;
  }
}

async function priceFor(mint) {
  try {
    const asset = await fetchJupiterAsset(mint, { useCache: false });
    if (!asset) return { price: null, mcap: null, error: 'no_asset' };
    const price = Number(asset.usdPrice ?? 0);
    const mcap = Number(asset.mcap ?? asset.marketCap ?? 0);
    return {
      price: Number.isFinite(price) && price > 0 ? price : null,
      mcap:  Number.isFinite(mcap)  && mcap  > 0 ? mcap  : null,
      error: null,
    };
  } catch (err) {
    return { price: null, mcap: null, error: err.message?.slice(0, 200) || 'unknown' };
  }
}

// Lazy-prepare: shadowLedger is imported BEFORE initDb() runs, so we can't
// prepare statements at module load — the table doesn't exist yet.
let _stmts = null;
function stmts() {
  if (_stmts) return _stmts;
  _stmts = {
    hasRecent: db.prepare(`SELECT 1 FROM shadow_trades WHERE base_mint = ? AND emit_at_ms >= ? LIMIT 1`),
    insert: db.prepare(`
      INSERT INTO shadow_trades (
        base_mint, symbol, tier, sources_json, min_sources, consecutive_flags,
        has_fee_claim, emit_at_ms, entry_price_usd, entry_mcap_usd, entry_error
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `),
    pending: db.prepare(`
      SELECT id, base_mint, emit_at_ms, px_1h_at_ms, px_4h_at_ms, px_24h_at_ms
      FROM shadow_trades
      WHERE abandoned = 0 AND px_24h_at_ms IS NULL
      ORDER BY emit_at_ms ASC
      LIMIT 200
    `),
    updates: {
      '1h':  db.prepare(`UPDATE shadow_trades SET px_1h_usd  = ?, px_1h_at_ms  = ? WHERE id = ?`),
      '4h':  db.prepare(`UPDATE shadow_trades SET px_4h_usd  = ?, px_4h_at_ms  = ? WHERE id = ?`),
      '24h': db.prepare(`UPDATE shadow_trades SET px_24h_usd = ?, px_24h_at_ms = ? WHERE id = ?`),
    },
    abandon: db.prepare(`UPDATE shadow_trades SET abandoned = 1 WHERE id = ?`),
  };
  return _stmts;
}

export async function recordEmit(meta) {
  try {
    const tier = meta?.tier;
    if (!tier || tierRank(tier) < MIN_TIER_RANK) return;
    const mint = meta?.base_mint;
    if (!mint) return;

    const at = now();
    if (stmts().hasRecent.get(mint, at - DEDUP_WINDOW_MS)) return;

    const { price, mcap, error } = await priceFor(mint);
    stmts().insert.run(
      mint,
      meta.symbol || null,
      tier,
      JSON.stringify(meta.sources || []),
      Number.isFinite(meta.min_sources) ? meta.min_sources : 1,
      Number.isFinite(meta.consecutive_flags) ? meta.consecutive_flags : 1,
      meta.has_fee_claim ? 1 : 0,
      at,
      price,
      mcap,
      error,
    );
  } catch (err) {
    console.log(`[shadow] recordEmit error: ${err.message}`);
  }
}

async function snapshotFor(row, window, dueAtMs) {
  const at = now();
  if (at < dueAtMs) return false;
  if (row[`px_${window}_at_ms`] != null) return false;
  const { price } = await priceFor(row.base_mint);
  stmts().updates[window].run(price, at, row.id);
  return true;
}

export async function pollFollowups() {
  try {
    const rows = stmts().pending.all();
    let touched = 0, abandoned = 0;
    for (const row of rows) {
      const age = now() - row.emit_at_ms;
      // Abandon stragglers — keep the row but stop polling
      if (age > ABANDON_AFTER_MS) {
        stmts().abandon.run(row.id);
        abandoned++;
        continue;
      }
      if (await snapshotFor(row, '1h',  row.emit_at_ms +      60 * 60 * 1000)) touched++;
      if (await snapshotFor(row, '4h',  row.emit_at_ms +  4 * 60 * 60 * 1000)) touched++;
      if (await snapshotFor(row, '24h', row.emit_at_ms + 24 * 60 * 60 * 1000)) touched++;
    }
    if (touched + abandoned > 0) {
      console.log(`[shadow] poll: ${touched} snapshot(s), ${abandoned} abandoned, ${rows.length} pending`);
    }
  } catch (err) {
    console.log(`[shadow] poll error: ${err.message}`);
  }
}

let _pollTimer = null;
export function startShadowPoller() {
  if (_pollTimer) return;
  _pollTimer = setInterval(pollFollowups, POLL_INTERVAL_MS);
  console.log(`[shadow] follow-up poller every ${POLL_INTERVAL_MS / 1000}s (tier>=${MIN_TIER_RANK}, 24h dedup)`);
  // Don't run pollFollowups() immediately at boot — rows from previous
  // run might exist but their snapshot windows haven't aged on this run.
}
