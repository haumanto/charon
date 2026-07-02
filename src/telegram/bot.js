import TelegramBot from 'node-telegram-bot-api';
import { TELEGRAM_BOT_TOKEN, TELEGRAM_ENABLED } from '../config.js';
import { installTelegramRedaction } from './redact.js';

// Telegram is OPTIONAL by design (2026-07-02, operator): this deployment runs charon as a
// signal satellite with a placeholder token — alerts/commands are off. A throwing/polling
// bot with an invalid token 401-spammed AND killed signal batches mid-processing (the
// candidate pipeline sends alerts inline; the rejection propagated into fetchServerSignals'
// catch). When no valid token is configured, export a no-op stub instead: every method is
// an async no-op resolving { message_id: 0 } (sendCandidateAlert reads sent.message_id and
// inserts it — must not throw), `then` is undefined so `await bot` never treats the Proxy
// as a thenable, and no network/polling ever starts.
function makeDisabledBot() {
  const result = { message_id: 0, ok: false, disabled: true };
  const noop = async () => result;
  return new Proxy({}, {
    get(_target, prop) {
      if (prop === 'then' || typeof prop === 'symbol') return undefined;
      if (prop === 'isDisabledStub') return true;
      return noop;
    },
  });
}

export const bot = TELEGRAM_ENABLED
  ? installTelegramRedaction(new TelegramBot(TELEGRAM_BOT_TOKEN, {
      polling: process.env.NODE_ENV === 'test' ? false : true,
    }))
  : makeDisabledBot();
