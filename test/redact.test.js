import test from 'node:test';
import assert from 'node:assert/strict';

const EXACT_ENV_SECRET = 'env-wallet-secret-253';
const REGEX_META_SECRET = 'fake.*secret+$[253]';
const RPC_URL = 'https://exact-rpc.quiknode.pro/rpc-token-253/';
const PARAM_SECRET = 'param-secret-253';
const PROVIDER_PATH_SECRET = 'provider-path-secret-253';
const TEXT_SECRET = 'egress-text-secret-253';

const REDACT_ENV_KEYS = [
  'TELEGRAM_BOT_TOKEN',
  'SIGNAL_SERVER_KEY',
  'HELIUS_API_KEY',
  'SOLANA_PRIVATE_KEY',
  'PRIVATE_KEY',
  'JUPITER_API_KEY',
  'LLM_API_KEY',
  'GMGN_API_KEY',
  'SOLANA_RPC_URL',
  'SOLANA_WS_URL',
  'TELEGRAM_CHAT_ID',
  'NODE_ENV',
];
const ORIGINAL_ENV = Object.fromEntries(REDACT_ENV_KEYS.map((key) => [key, process.env[key]]));
let importId = 0;

function setRedactionEnv(env = {}) {
  for (const key of REDACT_ENV_KEYS) {
    if (Object.prototype.hasOwnProperty.call(env, key)) process.env[key] = env[key];
    else delete process.env[key];
  }
}

function restoreEnv() {
  for (const key of REDACT_ENV_KEYS) {
    if (ORIGINAL_ENV[key] === undefined) delete process.env[key];
    else process.env[key] = ORIGINAL_ENV[key];
  }
}

async function importFreshRedactor(env = {}) {
  setRedactionEnv(env);
  return import(`../tools/redact.js?case=${importId++}`);
}

function expectClean(value, secrets) {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  for (const secret of secrets) assert.equal(text.includes(secret), false, `leaked ${secret}`);
}

test.afterEach(() => {
  restoreEnv();
});

test('redacts env and registered exact values, including regex metacharacters', async () => {
  const redact = await importFreshRedactor({
    SOLANA_PRIVATE_KEY: EXACT_ENV_SECRET,
    TELEGRAM_BOT_TOKEN: 'telegram-token-253',
    JUPITER_API_KEY: 'jupiter-key-253',
    LLM_API_KEY: 'llm-key-253',
  });
  redact.registerSecret(REGEX_META_SECRET);

  const out = redact.redactSensitive(`wallet=${EXACT_ENV_SECRET} meta=${REGEX_META_SECRET}`);

  assert.match(out, /\[REDACTED-SECRET\]/);
  expectClean(out, [EXACT_ENV_SECRET, REGEX_META_SECRET]);
});

test('redacts exact RPC URLs, URL credential params, and provider-token paths', async () => {
  const redact = await importFreshRedactor({ SOLANA_RPC_URL: RPC_URL });

  const exact = redact.redactSensitive(`rpc failed ${RPC_URL}`);
  const param = redact.redactSensitive(`rpc failed https://plain.example/rpc?dkey=${PARAM_SECRET}&slot=1`);
  const provider = redact.redactSensitive(`rpc failed https://aged-bold.quiknode.pro/${PROVIDER_PATH_SECRET}/`);

  assert.match(exact, /\[REDACTED-RPC-URL\]/);
  expectClean(exact, [RPC_URL]);
  assert.equal(param.includes('dkey=[REDACTED]&slot=1'), true);
  expectClean(param, [PARAM_SECRET]);
  assert.equal(provider.includes('https://aged-bold.quiknode.pro/[REDACTED]'), true);
  expectClean(provider, [PROVIDER_PATH_SECRET]);
});

test('redacts key-length base58 blobs but preserves tx/signature contexts and 44-char mints', async () => {
  const { redactSensitive } = await importFreshRedactor();
  const keyLike = 'A'.repeat(87);
  const mint = 'B'.repeat(44);

  const out = redactSensitive(`raw ${keyLike} tx: ${keyLike} https://solscan.io/tx/${keyLike} mint ${mint}`);

  assert.equal(out.includes('raw [REDACTED-KEY]'), true);
  assert.equal((out.match(new RegExp(keyLike, 'g')) || []).length, 2);
  assert.equal(out.includes(mint), true);
});

test('is idempotent on a kitchen-sink fixture', async () => {
  const redact = await importFreshRedactor({
    SOLANA_PRIVATE_KEY: EXACT_ENV_SECRET,
    SOLANA_RPC_URL: RPC_URL,
  });
  redact.registerSecret(REGEX_META_SECRET);
  const fixture = [
    EXACT_ENV_SECRET,
    REGEX_META_SECRET,
    RPC_URL,
    `https://plain.example/rpc?api-key=${PARAM_SECRET}`,
    `https://mainnet.helius-rpc.com/${PROVIDER_PATH_SECRET}`,
    'C'.repeat(88),
  ].join(' ');

  const once = redact.redactSensitive(fixture);
  const twice = redact.redactSensitive(once);

  assert.equal(twice, once);
  expectClean(twice, [EXACT_ENV_SECRET, REGEX_META_SECRET, RPC_URL, PARAM_SECRET, PROVIDER_PATH_SECRET]);
});

test('fail-closes by withholding content on redaction errors', async () => {
  const { redactOrWithhold } = await importFreshRedactor();
  const hostile = { toString() { throw new Error('boom'); } };

  assert.equal(redactOrWithhold(hostile), '[REDACTION-FAILED — content withheld]');
});

test('redacts Telegram payload strings and wraps the outbound request choke point', async () => {
  setRedactionEnv({
    NODE_ENV: 'test',
    TELEGRAM_BOT_TOKEN: 'fake-telegram-token-253',
    TELEGRAM_CHAT_ID: 'chat-253',
    SIGNAL_SERVER_KEY: TEXT_SECRET,
  });
  const { installTelegramRedaction, redactTelegramPayload } = await import(`../src/telegram/redact.js?case=${importId++}`);

  const payload = redactTelegramPayload({
    form: {
      text: `leak ${TEXT_SECRET}`,
      reply_markup: {
        inline_keyboard: [[{
          text: `open ${TEXT_SECRET}`,
          url: `https://plain.example/?token=${TEXT_SECRET}`,
        }]],
      },
    },
  });
  expectClean(payload, [TEXT_SECRET]);
  assert.equal(payload.form.text.includes('[REDACTED-SECRET]'), true);
  assert.equal(payload.form.reply_markup.inline_keyboard[0][0].url.includes('token=[REDACTED]'), true);

  const calls = [];
  const fakeBot = {
    _request(method, options) {
      calls.push({ method, options });
      return { ok: true };
    },
  };
  installTelegramRedaction(fakeBot);
  fakeBot._request('sendMessage', { form: { text: `wrapped ${TEXT_SECRET}` } });

  assert.equal(calls.length, 1);
  expectClean(calls[0].options, [TEXT_SECRET]);
  assert.equal(calls[0].options.form.text.includes('[REDACTED-SECRET]'), true);
});
