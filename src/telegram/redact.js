import { redactOrWithhold } from '../../tools/redact.js';

export function redactTelegramPayload(value) {
  if (typeof value === 'string') return redactOrWithhold(value);
  if (Array.isArray(value)) return value.map(redactTelegramPayload);
  if (value && typeof value === 'object') {
    if (value instanceof Uint8Array || typeof value.pipe === 'function') return value;
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, redactTelegramPayload(entry)]),
    );
  }
  return value;
}

// Redact CONTENT-bearing option fields ONLY — never transport fields. The library's
// request options include the API `url` itself (…/bot<TOKEN>/method); the exact-value
// pass rewrote the registered bot token inside it to [REDACTED-SECRET] → every call
// 401'd "invalid token specified" and the signal pipeline stalled (live 2026-07-02,
// first post-#253 boot). Meridian never hit this because its choke wraps payload text,
// not the request envelope.
const CONTENT_OPTION_KEYS = ['form', 'qs', 'body', 'formData'];

export function installTelegramRedaction(telegramBot) {
  if (!telegramBot || typeof telegramBot._request !== 'function' || telegramBot.__charonRedactionInstalled) {
    return telegramBot;
  }
  const request = telegramBot._request.bind(telegramBot);
  telegramBot._request = (method, options = {}) => {
    const safe = { ...options };
    for (const key of CONTENT_OPTION_KEYS) {
      if (key in safe) safe[key] = redactTelegramPayload(safe[key]);
    }
    return request(method, safe);
  };
  Object.defineProperty(telegramBot, '__charonRedactionInstalled', { value: true });
  return telegramBot;
}
