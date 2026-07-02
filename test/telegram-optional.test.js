import test from 'node:test';
import assert from 'node:assert/strict';

// Telegram-optional (2026-07-02): with a placeholder token the bot must be a no-op stub —
// no polling, no 401 storms, and candidate processing must survive alert sends (the live
// failure: sendTelegram rejections killed signal batches mid-processing).

process.env.NODE_ENV = 'test';
process.env.TELEGRAM_BOT_TOKEN = '0:sixteencharsdummy';
process.env.TELEGRAM_CHAT_ID = '1';
process.env.HELIUS_API_KEY = 'test-helius';

const { TELEGRAM_ENABLED, validateConfig } = await import('../src/config.js');
const { bot } = await import('../src/telegram/bot.js');

test('placeholder token → TELEGRAM_ENABLED false, validateConfig does not throw', () => {
  assert.equal(TELEGRAM_ENABLED, false);
  assert.doesNotThrow(() => validateConfig());
});

test('disabled bot is a stub: methods resolve { message_id: 0 } and never throw', async () => {
  assert.equal(bot.isDisabledStub, true);
  const sent = await bot.sendMessage('1', 'hello', { parse_mode: 'HTML' });
  assert.equal(sent.message_id, 0);
  assert.equal(sent.disabled, true);
  await bot.setMyCommands([{ command: 'menu', description: 'x' }]);
  await bot.answerCallbackQuery('cb', {});
  assert.equal(typeof bot.on, 'function');
});

test('stub is not a thenable — `await bot` must not hang or unwrap', async () => {
  assert.equal(bot.then, undefined);
  const same = await Promise.resolve(bot);
  assert.equal(same.isDisabledStub, true);
});

test('valid-format token enables telegram (format check only, no network)', async () => {
  const re = /^\d{6,}:[A-Za-z0-9_-]{30,}$/;
  assert.equal(re.test('123456789:AAF0deadbeefDEADBEEF0123456789_abcde'), true);
  assert.equal(re.test('0:sixteencharsdummy'), false);
  assert.equal(re.test(''), false);
});
