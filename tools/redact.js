const REDACTION_FAILED = "[REDACTION-FAILED — content withheld]";
const DEFAULT_REPLACEMENT = "[REDACTED-SECRET]";
const RPC_URL_REPLACEMENT = "[REDACTED-RPC-URL]";
const BASE58_RE = /(?<![1-9A-HJ-NP-Za-km-z])([1-9A-HJ-NP-Za-km-z]{80,96})(?![1-9A-HJ-NP-Za-km-z])/g;
const PROVIDER_URL_RE = /\b(https?:\/\/)([^\/\s"'<>]*?(?:quiknode\.pro|chainstack\.com|helius-rpc\.com|drpc\.org)(?::\d+)?)(?:[/?#][^\s"'<>]*)?/gi;
const URL_CREDENTIAL_RE = /([?&](?:dkey|api-?key|apikey|token|key|auth)=)[^&\s"'<>]+/gi;

const _secrets = new Map();

export function registerSecret(value) {
  const secret = value == null ? "" : String(value);
  registerExactSecret(secret, /^https?:\/\//i.test(secret) ? RPC_URL_REPLACEMENT : DEFAULT_REPLACEMENT);
}

export function redactSensitive(text) {
  let out = String(text);

  for (const [secret, replacement] of sortedSecrets()) {
    out = out.split(secret).join(replacement);
  }

  out = out.replace(URL_CREDENTIAL_RE, "$1[REDACTED]");
  out = out.replace(PROVIDER_URL_RE, (_match, scheme, host) => `${scheme}${host}/[REDACTED]`);
  out = out.replace(BASE58_RE, (match, _key, offset, fullText) => {
    const before = fullText.slice(Math.max(0, offset - 24), offset);
    return /tx|sig|solscan/i.test(before) ? match : "[REDACTED-KEY]";
  });

  return out;
}

export function redactOrWithhold(text) {
  try {
    return redactSensitive(text);
  } catch {
    return REDACTION_FAILED;
  }
}

function registerExactSecret(value, replacement) {
  if (value == null) return;
  const secret = String(value);
  if (secret.length < 8) return;
  _secrets.set(secret, replacement);
}

function sortedSecrets() {
  return [..._secrets.entries()].sort((left, right) => right[0].length - left[0].length);
}

function seedFromEnv() {
  for (const key of [
    "TELEGRAM_BOT_TOKEN",
    "SIGNAL_SERVER_KEY",
    "HELIUS_API_KEY",
    "SOLANA_PRIVATE_KEY",
    "PRIVATE_KEY",
    "JUPITER_API_KEY",
    "LLM_API_KEY",
    "GMGN_API_KEY",
  ]) {
    registerSecret(process.env[key]);
  }

  const rpcUrlValues = [
    process.env.SOLANA_RPC_URL,
    process.env.SOLANA_WS_URL,
  ];
  for (const rpcUrl of rpcUrlValues) {
    const trimmed = String(rpcUrl || "").trim();
    if (trimmed) registerExactSecret(trimmed, RPC_URL_REPLACEMENT);
  }
}

seedFromEnv();
