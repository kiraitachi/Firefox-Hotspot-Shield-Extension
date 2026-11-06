// Device identity sent to the backend. Mirrors Elite.deviceInfo() and the
// User.hash logic of the official extension.

const HASH_KEY = 'device.hash';
const HASH_PREFIX = 'HC'; // [official] sdk.config.elite.prefix

/** "5.2.12" -> 50212 (official scheme: major, then minor and patch zero-padded to 2 digits). */
export function decimalVersion(version) {
  const [major = 0, minor = 0, patch = 0] = String(version).split('.').map((n) => Number(n) || 0);
  const pad = (n) => String(n).padStart(2, '0');
  return Number(`${major}${pad(minor)}${pad(patch)}`);
}

function randomHex(bytes) {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return Array.from(buf, (b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Stable per-install identifier. The official extension built this from
 * Math.random(); we use a CSPRNG but keep the same shape ("HC" + 32 hex chars).
 */
export async function getOrCreateHash(storage) {
  let hash = await storage.get(HASH_KEY);
  if (!hash) {
    hash = HASH_PREFIX + randomHex(16);
    await storage.set(HASH_KEY, hash);
  }
  return hash;
}

/**
 * `token` is the account/session token from the status or signin response. The official
 * client sends it in DeviceInfo on every call except signin/signup.
 */
export function buildDeviceInfo({ config, hash, token, navigatorLike = globalThis.navigator }) {
  const ua = navigatorLike?.userAgent ?? '';
  const osMatch = ua.match(/\(([^);]+)/);
  const language = navigatorLike?.language ? navigatorLike.language.replace(/-.*/, '').toLowerCase() : '';
  const info = {
    platform: config.device.platform,
    hash,
    package_name: config.device.packageName,
    app_version: decimalVersion(config.upstreamVersion),
    model: config.device.model,
    make: config.device.make,
    os_name: osMatch ? osMatch[1] : 'undefined',
  };
  if (language) info.language = language;
  if (token) info.token = token;
  return info;
}
