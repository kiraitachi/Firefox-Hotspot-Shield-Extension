// Background entry point (runs in the background page, see background.html).
// Wires the Elite/Pango clients to the proxy controller and exposes a small
// message API for the popup.

import { CONFIG } from './config.js';
import { AccountService } from './account.js';
import { buildDeviceInfo, getOrCreateHash } from './device.js';
import { EliteApi } from './elite-api.js';
import { PangoApi } from './pango-api.js';
import { ProxyController } from './proxy-controller.js';
import { Storage } from './storage.js';

const storage = new Storage(browser.storage.local);

// ---- identity ---------------------------------------------------------------------------

let deviceHash = null;
const getHash = async () => (deviceHash ??= await getOrCreateHash(storage));
// `account` is created below; DeviceInfo carries its token on every call except signin.
const deviceInfo = async ({ includeToken = true } = {}) =>
  buildDeviceInfo({ config: CONFIG, hash: await getHash(), token: includeToken ? account.deviceToken() : undefined });

// auth_method enum (official bundle: WIREGUARD=1, ELITE=2, ELITE_ANONYMOUS=3)
const AUTH_METHODS = { 1: 'wireguard', 2: 'elite', 3: 'elite_anonymous' };

function jwtExpiryMs(jwt) {
  try {
    const payload = jwt.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
    const json = JSON.parse(atob(payload + '='.repeat((4 - (payload.length % 4)) % 4)));
    return typeof json.exp === 'number' ? json.exp * 1000 : 0;
  } catch {
    return 0;
  }
}

// ---- API clients ------------------------------------------------------------------------

const elite = new EliteApi({ baseUrl: CONFIG.eliteApi, timeoutMs: CONFIG.requestTimeoutMs });

let jwtCache = null; // { jwt, authMethod, expiresAt, identity }
async function loginCredentials() {
  // The official client reads the account status first (that is where the token comes from).
  await account.ensureIdentity();
  const identity = account.identity();
  if (jwtCache && jwtCache.identity === identity && jwtCache.expiresAt - CONFIG.credentialSkewMs > Date.now()) {
    return toLogin(jwtCache);
  }
  const { jwt, authMethod } = await elite.vpnAuth(await deviceInfo(), CONFIG.tokenType);
  const expiresAt = jwtExpiryMs(jwt);
  // Only cache when the expiry is readable, as the official client does.
  jwtCache = expiresAt ? { jwt, authMethod, expiresAt, identity } : null;
  return toLogin({ jwt, authMethod });
}

async function toLogin({ jwt, authMethod }) {
  const hash = await getHash();
  const method = AUTH_METHODS[authMethod];
  if (!method) throw new Error(`vpn-auth returned an unknown auth_method: ${authMethod}`);
  return {
    accessToken: jwt,
    authMethod: method,
    deviceId: `${CONFIG.carrierId}_${hash}`,
    deviceType: CONFIG.device.deviceType,
    carrierId: CONFIG.carrierId,
    cacheId: account.identity(),
  };
}

// Plan or session changed (sign-in, sign-out, Elite gained or lost, token rotated).
// Runs after the account operation has released its queue, so it may call back into it.
async function onIdentityChange({ tierChanged }) {
  jwtCache = null;
  await pango.resetIdentity(); // the backend session belongs to the previous identity
  if (!tierChanged) return; // token rotation only: the next call logs in again, lazily
  const locations = await pango.refreshLocations().catch(() => []); // new plan, new location list
  await controller.onIdentityChanged(locations);
}

const pango = new PangoApi({
  baseUrl: CONFIG.pangoApi,
  storage,
  loginCredentials,
  timeoutMs: CONFIG.requestTimeoutMs,
  skewMs: CONFIG.credentialSkewMs,
});

const account = new AccountService({ elite, storage, deviceInfo, onIdentityChange });

// ---- proxy controller -------------------------------------------------------------------

const controller = new ProxyController({
  browserApi: browser,
  pango,
  storage,
  config: CONFIG,
  onChange: () => browser.runtime.sendMessage({ type: 'changed' }).catch(() => {}), // no popup open: ignore
});

// Register synchronously so no request can slip past the listener while we load state.
controller.register();
const started = (async () => {
  await pango.init();
  await account.init();
  await pango.verifyIdentity(account.identity());
  await controller.init();
})();
// Official startup order: read the account status (best effort; never blocks startup).
started.then(() => account.refresh()).catch(() => {});

// ---- maintenance ------------------------------------------------------------------------

browser.alarms.create('hss-tick', { periodInMinutes: 5 });
browser.alarms.create('hss-locations', { periodInMinutes: 60 });
browser.alarms.create('hss-account', { periodInMinutes: 720 }); // official: status refresh every 12 h
browser.alarms.onAlarm.addListener(async ({ name }) => {
  await started;
  if (name === 'hss-tick') await controller.tick();
  if (name === 'hss-account') await account.refresh().catch(() => {});
  // Only talk to the backend in the background while the VPN is meant to be on.
  if (name === 'hss-locations' && controller.settings.intent) await pango.refreshLocations().catch(() => {});
});

// ---- popup message API ------------------------------------------------------------------

const LOCATION_STALE_MS = 6 * 3_600_000;

async function activeDomain() {
  try {
    const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
    const url = new URL(tab?.url ?? '');
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.hostname : null;
  } catch {
    return null;
  }
}

// Never blocks on the network: the popup renders from cache first, then calls
// refreshLocations when `locationsStale` is set and re-renders.
async function fullState() {
  await started;
  const [domain, incognitoAllowed] = await Promise.all([
    activeDomain(),
    browser.extension.isAllowedIncognitoAccess().catch(() => true),
  ]);
  return {
    ...controller.snapshot(),
    account: account.snapshot(),
    locations: pango.locationsCached(),
    locationsStale: pango.state.locations.length === 0 || Date.now() - pango.state.lastLocationUpdate > LOCATION_STALE_MS,
    activeDomain: domain,
    incognitoAllowed,
    diagnostics: {
      version: browser.runtime.getManifest().version,
      upstreamVersion: CONFIG.upstreamVersion,
      deviceHash: deviceHash ? `${deviceHash.slice(0, 6)}…${deviceHash.slice(-4)}` : null,
      pangoAuthed: pango.isAuthed(),
      account: { authorized: account.state.authorized, elite: account.state.elite, eventError: account.lastEventError },
      eliteError: elite.lastError,
      pangoError: pango.lastError,
    },
  };
}

const handlers = {
  getState: async () => {},
  refreshLocations: () => pango.refreshLocations(),
  connect: ({ location }) => controller.connect(location),
  disconnect: () => controller.disconnect(),
  setLocation: ({ location }) => controller.setLocation(location),
  setBypass: ({ domain, on }) => controller.setBypass(domain, on),
  setSecured: ({ domain, on }) => controller.setSecured(domain, on),
  setOption: ({ key, value }) => controller.setOption(key, value),
  signIn: ({ login, password }) => account.signIn(login, password),
  signOut: () => account.signOut(),
};

browser.runtime.onMessage.addListener((msg) => {
  const handler = handlers[msg?.type];
  if (!handler) return undefined; // not ours (e.g. the 'changed' broadcast)
  return (async () => {
    await started;
    try {
      const result = await handler(msg);
      return { ok: true, result, state: await fullState() };
    } catch (e) {
      return { ok: false, error: e.message, state: await fullState() };
    }
  })();
});
