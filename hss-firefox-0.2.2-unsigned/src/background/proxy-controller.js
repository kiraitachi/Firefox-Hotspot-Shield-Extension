// Replaces three pieces of the official extension that cannot run on Firefox:
//   * the PAC-script renderer (Ne)          -> proxy.onRequest + proxy-rules.js
//   * the onAuthRequired credential handler -> proxyAuthorizationHeader on each ProxyInfo
//   * the proxy status/connect state (Je)   -> this class
//
// Firefox lets an extension answer every request with a ProxyInfo from JavaScript,
// so no PAC script, no proxy.settings (which would clobber the user's own proxy
// configuration) and no webRequestAuthProvider are needed.

import { decide, hostFromUrl, matchesAny, normalizeDomain } from './proxy-rules.js';

const SETTINGS_KEY = 'proxy.settings';
const REFRESH_AHEAD_MS = 10 * 60_000; // refresh credentials when this close to expiry
const ERROR_REFRESH_COOLDOWN_MS = 30_000;

/**
 * Toolbar button icons: always the Hotspot Shield logo, with a status dot (none / green / amber).
 * manifest.json's browser_action.default_icon must equal `off` so a fresh install shows the logo
 * before any code runs (tests/assets.test.js enforces this and that every file exists).
 */
const iconSet = (name) => ({ 16: `assets/icons/toolbar-${name}-16.png`, 32: `assets/icons/toolbar-${name}-32.png` });
export const TOOLBAR_ICONS = { off: iconSet('off'), on: iconSet('on'), warn: iconSet('warn') };

const DIRECT = { type: 'direct' };
// Used to fail closed: an unreachable loopback proxy makes the request fail instead of leaking.
const BLOCK = [{ type: 'http', host: '127.0.0.1', port: 9, failoverTimeout: 1 }];

export function basicAuthHeader(username, password) {
  const bytes = new TextEncoder().encode(`${username}:${password}`);
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return `Basic ${btoa(binary)}`;
}

const describe = (e) => e?.message ?? String(e);

export class ProxyController {
  /**
   * @param {object} o
   * @param {object} o.browserApi  `browser` (proxy, privacy, browserAction)
   * @param {PangoApi} o.pango
   * @param {Storage} o.storage
   * @param {object} o.config
   * @param {(snapshot:object)=>void} [o.onChange]
   */
  constructor({ browserApi, pango, storage, config, now = Date.now, onChange = () => {} }) {
    this.api = browserApi;
    this.pango = pango;
    this.storage = storage;
    this.config = config;
    this.now = now;
    this.onChange = onChange;

    this.settings = {
      intent: false, // the user wants the VPN on (persisted; drives the kill switch across restarts)
      location: 'optimal',
      bypass: [],
      secured: [],
      webrtcProtection: config.defaults.webrtcProtection,
      blockWhenDown: config.defaults.blockWhenDown,
    };
    this.status = 'disconnected'; // disconnected | connecting | connected | disconnecting
    this.error = null;
    this.startedAt = 0;
    this.creds = null;
    this.lastProxyError = null;
    this.privacyWarning = null;

    this.initialised = false;
    this.ready = new Promise((resolve) => {
      this.resolveReady = resolve;
    });
    this.refreshing = null;
    this.lastRefreshAt = 0;
  }

  /** Attach listeners. Call synchronously at startup, before init() resolves. */
  register() {
    this.api.proxy.onRequest.addListener(this.onRequest, { urls: ['<all_urls>'] });
    this.api.proxy.onError.addListener(this.onProxyError);
  }

  async init() {
    const saved = await this.storage.get(SETTINGS_KEY);
    if (saved && typeof saved === 'object') Object.assign(this.settings, saved);
    this.initialised = true;
    this.resolveReady();

    if (this.settings.intent) {
      // The user had the VPN on when the browser closed: stay fail-closed while we reconnect.
      this.#setStatus('connecting');
      try {
        await this.refreshCredentials();
        this.startedAt = this.now();
        this.#setStatus('connected', null);
      } catch (e) {
        this.#setStatus('connecting', describe(e));
      }
    }
    await this.#applyWebRTC();
    this.#emit();
  }

  // ---- request routing --------------------------------------------------------------

  onRequest = (info) => {
    const host = hostFromUrl(info.url);
    // API hosts are decided synchronously and never wait on init(): init() itself talks to them.
    if (matchesAny(host, this.config.alwaysDirectDomains)) return DIRECT;
    if (!this.initialised) return this.ready.then(() => this.onRequest(info));

    const verdict = decide({
      host,
      active: this.settings.intent,
      bypass: this.settings.bypass,
      secured: this.settings.secured,
      internal: this.config.alwaysDirectDomains,
    });
    if (verdict === 'direct') return DIRECT;
    if (verdict === 'passthrough') return undefined; // leave the browser's own proxy settings alone
    return this.#proxyInfo();
  };

  #credsValid(c) {
    return Boolean(c?.servers?.length && c.expires - this.config.credentialSkewMs > this.now());
  }

  #proxyInfo() {
    if (this.#credsValid(this.creds)) return this.#toProxyInfo(this.creds);
    return this.refreshCredentials().then(
      (c) => this.#toProxyInfo(c),
      () => (this.settings.blockWhenDown ? BLOCK : undefined),
    );
  }

  #toProxyInfo(creds) {
    const proxyAuthorizationHeader = basicAuthHeader(creds.username, creds.password);
    // Several servers => Firefox fails over in order. No DIRECT entry: fail closed (as the PAC did).
    return creds.servers.map((s) => ({
      type: 'https',
      host: s.address,
      port: this.config.proxyPort,
      proxyAuthorizationHeader,
      failoverTimeout: this.config.failoverTimeoutSec,
    }));
  }

  onProxyError = (details) => {
    this.lastProxyError = { message: describe(details), at: this.now() };
    if (this.settings.intent && this.now() - this.lastRefreshAt > ERROR_REFRESH_COOLDOWN_MS) {
      this.refreshCredentials({ force: true }).catch(() => {});
    }
    this.#emit();
  };

  // ---- credentials ------------------------------------------------------------------

  refreshCredentials({ force = false } = {}) {
    if (!this.refreshing) {
      this.lastRefreshAt = this.now();
      this.refreshing = this.pango
        .getProxyCredentials(this.settings.location, { force })
        .then((c) => {
          this.creds = c;
          return c;
        })
        .finally(() => {
          this.refreshing = null;
        });
    }
    return this.refreshing;
  }

  /** Periodic maintenance (alarm). Reconnects after startup failures and renews credentials early. */
  async tick() {
    if (!this.settings.intent) return;
    try {
      if (this.status !== 'connected') {
        await this.refreshCredentials();
        this.startedAt ||= this.now();
        this.#setStatus('connected', null);
      } else if (!this.creds || this.creds.expires - REFRESH_AHEAD_MS < this.now()) {
        await this.refreshCredentials({ force: true });
      }
    } catch (e) {
      this.#setStatus(this.status, describe(e));
    }
  }

  // ---- user actions -----------------------------------------------------------------

  async connect(location = this.settings.location) {
    this.#setStatus('connecting', null);
    this.settings.location = location || 'optimal';
    this.creds = null;
    try {
      await this.refreshCredentials();
      this.settings.intent = true;
      this.startedAt = this.now();
      await this.#save();
      await this.#applyWebRTC();
      this.#setStatus('connected', null);
    } catch (e) {
      this.settings.intent = false;
      this.creds = null;
      await this.#save();
      await this.#applyWebRTC();
      this.#setStatus('disconnected', describe(e));
      throw e;
    }
  }

  async disconnect() {
    this.#setStatus('disconnecting');
    this.settings.intent = false;
    this.startedAt = 0;
    await this.#save();
    await this.#applyWebRTC();
    this.#setStatus('disconnected', null);
  }

  async setLocation(location) {
    const next = location || 'optimal';
    if (next === this.settings.location) return;
    if (this.settings.intent) return this.connect(next);
    this.settings.location = next;
    this.creds = null;
    await this.#save();
    this.#emit();
  }

  /**
   * The account changed plan (signed in/out, Elite gained/lost). Cached credentials belong to
   * the old plan, and a location only the old plan could use must not be kept.
   * @param {object[]} locations  the new plan's location list ([] when unknown)
   */
  async onIdentityChanged(locations = []) {
    this.creds = null;
    const current = locations.find((l) => l.name === this.settings.location);
    const usable = current && String(current.status).toLowerCase() === 'ok';
    if (this.settings.location !== 'optimal' && locations.length > 0 && !usable) this.settings.location = 'optimal';
    await this.#save();
    if (this.settings.intent) {
      try {
        await this.connect(this.settings.location);
      } catch {
        /* connect() already recorded the error and switched the VPN off cleanly */
      }
    } else {
      this.#emit();
    }
  }

  async setBypass(domain, on) {
    const d = normalizeDomain(domain);
    if (!d) return;
    this.settings.bypass = this.#toggle(this.settings.bypass, d, on);
    if (on) this.settings.secured = this.settings.secured.filter((x) => x !== d);
    await this.#save();
    this.#emit();
  }

  async setSecured(domain, on) {
    const d = normalizeDomain(domain);
    if (!d) return;
    this.settings.secured = this.#toggle(this.settings.secured, d, on);
    if (on) this.settings.bypass = this.settings.bypass.filter((x) => x !== d);
    await this.#save();
    this.#emit();
  }

  async setOption(key, value) {
    if (key !== 'webrtcProtection' && key !== 'blockWhenDown') throw new Error(`unknown option: ${key}`);
    this.settings[key] = Boolean(value);
    await this.#save();
    await this.#applyWebRTC();
    this.#emit();
  }

  #toggle(list, domain, on) {
    const without = list.filter((x) => x !== domain);
    return on ? [...without, domain].sort() : without;
  }

  // ---- state, persistence, UI -------------------------------------------------------

  #save() {
    return this.storage.set(SETTINGS_KEY, this.settings);
  }

  #setStatus(status, error = this.error) {
    this.status = status;
    this.error = error;
    this.#emit();
  }

  snapshot() {
    return {
      status: this.status,
      error: this.error,
      location: this.settings.location,
      startedAt: this.startedAt,
      intent: this.settings.intent,
      bypass: [...this.settings.bypass],
      secured: [...this.settings.secured],
      webrtcProtection: this.settings.webrtcProtection,
      blockWhenDown: this.settings.blockWhenDown,
      lastProxyError: this.lastProxyError,
      privacyWarning: this.privacyWarning,
      credentialsExpire: this.creds?.expires ?? 0,
      serverCount: this.creds?.servers?.length ?? 0,
    };
  }

  #emit() {
    this.#updateIcon();
    try {
      this.onChange(this.snapshot());
    } catch {
      /* UI listeners must never break the controller */
    }
  }

  #updateIcon() {
    const browserAction = this.api.browserAction;
    if (!browserAction) return;
    let icon = TOOLBAR_ICONS.off;
    let title = 'Hotspot Shield: off';
    if (this.status === 'connected') {
      icon = TOOLBAR_ICONS.on;
      title = 'Hotspot Shield: protected';
    } else if (this.settings.intent) {
      icon = TOOLBAR_ICONS.warn;
      title = 'Hotspot Shield: reconnecting (traffic is blocked)';
    }
    Promise.resolve(browserAction.setIcon({ path: icon })).catch(() => {});
    Promise.resolve(browserAction.setTitle({ title })).catch(() => {});
  }

  async #applyWebRTC() {
    const network = this.api.privacy?.network;
    if (!network?.webRTCIPHandlingPolicy) return;
    try {
      if (this.settings.intent && this.settings.webrtcProtection) {
        await network.webRTCIPHandlingPolicy.set({ value: 'disable_non_proxied_udp' });
        await network.peerConnectionEnabled?.set({ value: false }); // Firefox-only, as in the official Firefox path
      } else {
        // clear() hands control back to the user's own setting instead of forcing a value
        await network.webRTCIPHandlingPolicy.clear({});
        await network.peerConnectionEnabled?.clear({});
      }
      this.privacyWarning = null;
    } catch (e) {
      this.privacyWarning = describe(e);
    }
  }
}
