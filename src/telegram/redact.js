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

export function installTelegramRedaction(telegramBot) {
  if (!telegramBot || typeof telegramBot._request !== 'function' || telegramBot.__charonRedactionInstalled) {
    return telegramBot;
  }
  const request = telegramBot._request.bind(telegramBot);
  telegramBot._request = (method, options = {}) => request(method, redactTelegramPayload(options));
  Object.defineProperty(telegramBot, '__charonRedactionInstalled', { value: true });
  return telegramBot;
}
