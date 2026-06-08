import WebSocket from 'ws';
import { PUMP_PROGRAM, PUMP_AMM, DISC_DIST_FEES, SOLANA_WS_URL } from '../config.js';
import { now, pruneSeen, lamToSol, discMatch, parseDistFees } from '../utils.js';
import { numSetting, boolSetting } from '../db/settings.js';
import { storeSignalEvent } from './trending.js';
import { graduated } from './graduated.js';
import { trending } from './trending.js';
import { buildFeeSnapshot } from '../pipeline/candidateBuilder.js';

export const seenFeeClaims = new Map();
let candidateHandler = null;

export function setCandidateHandler(fn) {
  candidateHandler = fn;
}

export async function handleFeeClaim(fee, signature) {
  const sol = lamToSol(fee.distributed);
  if (sol < numSetting('min_fee_claim_sol', 2)) return;
  const graduatedCoin = graduated.get(fee.mint) || null;
  const trendingToken = boolSetting('trending_enabled', true) ? trending.get(fee.mint) || null : null;
  if (!graduatedCoin && !trendingToken) return;

  const key = `${signature}:${fee.mint}:${fee.distributed}`;
  pruneSeen(seenFeeClaims, 10 * 60 * 1000);
  if (seenFeeClaims.has(key)) return;
  seenFeeClaims.set(key, now());
  storeSignalEvent(fee.mint, 'fee_claim', 'pump_logs', { signature, fee: buildFeeSnapshot(fee, signature) });
  const route = graduatedCoin && trendingToken
    ? 'fee_graduated_trending'
    : graduatedCoin
      ? 'fee_graduated'
      : 'fee_trending';
  if (candidateHandler) {
    await candidateHandler({
      mint: fee.mint,
      fee,
      signature,
      graduatedCoin,
      trendingToken,
      route,
    });
  }
}

async function processLog(logInfo) {
  const { signature, logs, err } = logInfo;
  if (err || !logs) return;
  for (const line of logs) {
    if (!line.startsWith('Program data: ')) continue;
    let data;
    try {
      data = Buffer.from(line.slice('Program data: '.length), 'base64');
    } catch {
      continue;
    }
    if (data.length < 8 || !discMatch(data, DISC_DIST_FEES)) continue;
    try {
      await handleFeeClaim(parseDistFees(data), signature);
    } catch (error) {
      console.log(`[fee] parse/alert failed: ${error.message}`);
    }
  }
}

export function startWebsocket() {
  // Failover across WS endpoints so one provider flap doesn't blind the fee-claim
  // feed (our highest-value signal — fee_trending). PUMP_HELIUS_WS_URL is an
  // optional secondary; unset = single-endpoint behaviour, exactly as before.
  const endpoints = [SOLANA_WS_URL, process.env.PUMP_HELIUS_WS_URL].filter(Boolean);
  let epIdx = 0;
  let ws;
  let pingTimer;
  function connect() {
    const wsUrl = endpoints[epIdx % endpoints.length];
    ws = new WebSocket(wsUrl);
    ws.on('open', () => {
      const which = endpoints.length > 1 ? ('endpoint ' + ((epIdx % endpoints.length) + 1) + '/' + endpoints.length) : 'single';
      console.log('[ws] connected (' + which + ')');
      for (const [id, program] of [[1, PUMP_PROGRAM], [2, PUMP_AMM]]) {
        ws.send(JSON.stringify({
          jsonrpc: '2.0',
          id,
          method: 'logsSubscribe',
          params: [{ mentions: [program] }, { commitment: 'confirmed' }],
        }));
      }
      pingTimer = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) ws.ping();
      }, 30_000);
    });
    ws.on('message', raw => {
      let msg;
      try {
        msg = JSON.parse(raw);
      } catch {
        return;
      }
      const value = msg.params?.result?.value;
      if (msg.method === 'logsNotification' && value) {
        processLog(value).catch(error => console.log(`[ws] process failed: ${error.message}`));
      }
    });
    ws.on('close', () => {
      clearInterval(pingTimer);
      epIdx += 1; // rotate to the next endpoint on reconnect (no-op if single)
      const next = endpoints.length > 1 ? (' — failover to endpoint ' + ((epIdx % endpoints.length) + 1) + '/' + endpoints.length) : '';
      console.log('[ws] closed, reconnecting in 5s' + next);
      setTimeout(connect, 5000);
    });
    ws.on('error', error => console.log(`[ws] ${error.message}`));
  }
  connect();
}
