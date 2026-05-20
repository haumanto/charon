#!/usr/bin/env node
// Aggregate the shadow ledger by tier. Read-only.
//
//   node scripts/shadow-report.js                  # all tiers, all time
//   node scripts/shadow-report.js --tier=fee_graduated_trending
//   node scripts/shadow-report.js --days=7         # last N days only
//
// Reports per tier: count, win-rate (median > 0%) at 1h/4h/24h,
// median return %, p25/p75. Only includes rows where the entry quote
// AND the snapshot at the requested window were both captured.

import 'dotenv/config';
import { db } from '../src/db/connection.js';

const args = Object.fromEntries(
  process.argv.slice(2)
    .map((a) => a.replace(/^--/, '').split('='))
    .map(([k, v]) => [k, v === undefined ? true : v]),
);

const tier = args.tier || null;
const daysBack = Number(args.days || 30);
const cutoff = Date.now() - daysBack * 24 * 60 * 60 * 1000;

const where = ['emit_at_ms >= ?'];
const params = [cutoff];
if (tier) { where.push('tier = ?'); params.push(tier); }

const rows = db.prepare(`
  SELECT id, base_mint, symbol, tier, has_fee_claim, consecutive_flags,
         emit_at_ms, entry_price_usd, entry_mcap_usd, entry_error,
         px_1h_usd, px_4h_usd, px_24h_usd, abandoned
  FROM shadow_trades
  WHERE ${where.join(' AND ')}
  ORDER BY emit_at_ms DESC
`).all(...params);

if (rows.length === 0) {
  console.log(`No shadow_trades rows in last ${daysBack}d${tier ? ` for tier=${tier}` : ''}.`);
  process.exit(0);
}

function pctReturn(entry, exit) {
  if (entry == null || exit == null || entry <= 0) return null;
  return ((exit - entry) / entry) * 100;
}
function quantile(arr, q) {
  if (arr.length === 0) return null;
  const sorted = [...arr].sort((a, b) => a - b);
  const idx = (sorted.length - 1) * q;
  const lo = Math.floor(idx), hi = Math.ceil(idx);
  return lo === hi ? sorted[lo] : sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}
function pct(v) {
  if (v == null) return '   —   ';
  const s = v >= 0 ? '+' : '';
  return `${s}${v.toFixed(1)}%`.padStart(8);
}

const groups = new Map();
for (const r of rows) {
  if (!groups.has(r.tier)) groups.set(r.tier, []);
  groups.get(r.tier).push(r);
}

const tierOrder = ['fee_graduated_trending', 'fee_graduated', 'fee_trending', 'graduated_trending'];
const sorted = [...groups.entries()].sort((a, b) => {
  const ai = tierOrder.indexOf(a[0]);
  const bi = tierOrder.indexOf(b[0]);
  return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi);
});

console.log(`Shadow ledger — last ${daysBack}d, ${rows.length} total rows\n`);
console.log('TIER                       n   entry%   1h: win%  median   p25/p75      4h: win%  median   p25/p75      24h: win%  median   p25/p75');
console.log('─'.repeat(135));

for (const [tierName, group] of sorted) {
  const entry = group.filter((r) => r.entry_price_usd != null && !r.entry_error);
  const entryPct = group.length ? (entry.length / group.length) * 100 : 0;

  const windows = ['1h', '4h', '24h'].map((w) => {
    const returns = entry
      .map((r) => pctReturn(r.entry_price_usd, r[`px_${w}_usd`]))
      .filter((v) => v != null);
    if (returns.length === 0) return { n: 0, winRate: null, median: null, p25: null, p75: null };
    const winRate = (returns.filter((v) => v > 0).length / returns.length) * 100;
    return {
      n: returns.length,
      winRate,
      median: quantile(returns, 0.5),
      p25: quantile(returns, 0.25),
      p75: quantile(returns, 0.75),
    };
  });

  const line = [
    tierName.padEnd(24),
    String(group.length).padStart(4),
    `${entryPct.toFixed(0)}%`.padStart(8),
    ...windows.map((w) => `  n=${String(w.n).padStart(3)} ${pct(w.winRate)} ${pct(w.median)}  ${pct(w.p25)}/${pct(w.p75)}`),
  ];
  console.log(line.join('  '));
}

const abandoned = rows.filter((r) => r.abandoned).length;
const pending = rows.filter((r) => !r.abandoned && r.px_24h_usd == null).length;
console.log('─'.repeat(135));
console.log(`abandoned: ${abandoned}  ·  pending (not yet 24h old): ${pending}  ·  complete: ${rows.length - abandoned - pending}`);
console.log(`\nNote: entry% is share of rows that captured a Jupiter entry price. Win% means median return > 0%.`);
console.log(`      Returns are paper PnL only — no slippage, fees, MEV, or psychology modeled.`);
