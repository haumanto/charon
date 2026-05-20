import { setDefaultResultOrder } from 'node:dns';
import { APP_NAME, SIGNAL_SERVER_URL, SIGNAL_POLL_MS, GRADUATED_POLL_MS, TRENDING_POLL_MS, POSITION_CHECK_MS, validateConfig } from './config.js';
import { initDb } from './db/connection.js';
import { db } from './db/connection.js';
import { initLiveExecution } from './liveExecutor.js';
import { setupTelegram } from './telegram/commands.js';
import { monitorPositions } from './execution/positions.js';
import { processCandidateFromSignals, maybeProcessDegenCandidate } from './pipeline/orchestrator.js';
import { sendTelegram } from './telegram/send.js';
import { makeFailureTracker } from './utils.js';
import { sinkSignal, startSinkFlusher } from './output/meridianSink.js';
import { startShadowPoller } from './output/shadowLedger.js';

const SINK_MODE = process.env.CHARON_SINK_MODE === 'true';

setDefaultResultOrder('ipv4first');
validateConfig();

function seedSinkStrategy() {
  const config = {
    entry_mode: 'immediate',
    min_source_count: 1,
    require_fee_claim: false,
    token_age_max_ms: 0,
    min_mcap_usd: 0,
    max_mcap_usd: 0,
    min_fee_claim_sol: 0,
    min_gmgn_total_fee_sol: 0,
    min_holders: 0,
    max_top20_holder_percent: 100,
    min_saved_wallet_holders: 0,
    max_ath_distance_pct: 0,
    min_graduated_volume_usd: 0,
    trending_min_volume_usd: 0,
    trending_min_swaps: 0,
    trending_max_rug_ratio: 1,
    trending_max_bundler_rate: 1,
    position_size_sol: 0,
    max_open_positions: 0,
    tp_percent: 0,
    sl_percent: 0,
    trailing_enabled: false,
    trailing_percent: 0,
    partial_tp: false,
    partial_tp_at_percent: 0,
    partial_tp_sell_percent: 0,
    max_hold_ms: 0,
    use_llm: false,
    llm_min_confidence: 0,
  };
  db.prepare(`INSERT OR REPLACE INTO strategies (id, name, enabled, config_json, created_at_ms) VALUES (?, ?, 1, ?, ?)`)
    .run('sink', 'Meridian Sink', JSON.stringify(config), Date.now());
  db.prepare(`UPDATE strategies SET enabled = 0 WHERE id != 'sink'`).run();
}

export async function startCharon() {
  initDb();
  if (SINK_MODE) seedSinkStrategy();
  initLiveExecution();
  if (!SINK_MODE) setupTelegram();
  if (SINK_MODE) {
    startSinkFlusher();
    startShadowPoller();
  }

  if (SIGNAL_SERVER_URL) {
    // ── Server mode: fetch signals from signal server ──────────────────────
    const { fetchServerSignals, setCandidateHandler, setDegenHandler } = await import('./signals/serverClient.js');

    const candidateHandler = SINK_MODE ? sinkSignal : processCandidateFromSignals;
    const degenHandler = SINK_MODE ? sinkSignal : maybeProcessDegenCandidate;
    setCandidateHandler(candidateHandler);
    setDegenHandler(degenHandler);

    const alert = SINK_MODE ? (msg) => { console.log(`[alert] ${String(msg).slice(0, 200)}`); return Promise.resolve(); } : (msg) => sendTelegram(msg);
    const trackServer = makeFailureTracker('server signals', alert);
    const trackDip = makeFailureTracker('dip monitor', alert);

    await fetchServerSignals().catch(error => console.log(`[server] initial fetch failed: ${error.message}`));
    setInterval(() => trackServer(() => fetchServerSignals()), SIGNAL_POLL_MS);

    if (!SINK_MODE) {
      // Price monitor for dip buy strategy — not needed in sink mode
      const { monitorPriceAlerts, cleanupAlerts } = await import('./signals/priceMonitor.js');
      const { setCandidateHandler: setAlertHandler } = await import('./signals/priceMonitor.js');
      setAlertHandler(processCandidateFromSignals);
      setInterval(() => trackDip(() => monitorPriceAlerts()), 10_000);
      setInterval(() => cleanupAlerts(), 60 * 60 * 1000);
    }

    console.log(`[bot] ${APP_NAME} started (server mode: ${SIGNAL_SERVER_URL})`);
  } else {
    // ── Standalone mode: direct polling (legacy) ───────────────────────────
    const { fetchGraduatedCoins } = await import('./signals/graduated.js');
    const { fetchGmgnTrending, setDegenHandler } = await import('./signals/trending.js');
    const { startWebsocket, setCandidateHandler } = await import('./signals/feeClaim.js');

    setDegenHandler(maybeProcessDegenCandidate);
    setCandidateHandler(processCandidateFromSignals);

    await fetchGraduatedCoins().catch(error => console.log(`[graduated] initial fetch failed: ${error.message}`));
    await fetchGmgnTrending().catch(error => console.log(`[trending] initial fetch failed: ${error.message}`));

    setInterval(() => fetchGraduatedCoins().catch(error => console.log(`[graduated] ${error.message}`)), GRADUATED_POLL_MS);
    setInterval(() => fetchGmgnTrending().catch(error => console.log(`[trending] ${error.message}`)), TRENDING_POLL_MS);
    startWebsocket();

    console.log(`[bot] ${APP_NAME} started (standalone mode)`);
  }

  if (!SINK_MODE) {
    // Position monitoring — not needed in sink mode (no positions held)
    const trackPositions = makeFailureTracker('position monitor', (msg) => sendTelegram(msg));
    setInterval(() => trackPositions(() => monitorPositions()), POSITION_CHECK_MS);
  } else {
    console.log(`[bot] sink mode active — Telegram, positions, swaps all disabled`);
  }
}
