// Client for the Pango API (https://api.pango-cloud.com/user/*).
// Ported from the "Pango" class (N) in the official background bundle.
//
//   POST /login      access_token (JWT), auth_method, device_id, device_type, carrier_id
//                    -> { result: "OK", access_token }
//   GET  /locations  access_token, type=proxy        -> { locations: [...] }
//   POST /provide    access_token, type=proxy[, location]
//                    -> { servers: [{ address, ... }], username, password, expire_time }
//   GET  /logout     access_token
//
// Differences from the official client (intentional):
//  * 401 handling actually works. The original threw `new Error(msg, { authFailed })`,
//    but Error() only honours `cause`, so `e.authFailed` was always undefined and
//    the "re-authenticate once and retry" branch never ran.
//  * credentials are treated as expired slightly early (credentialSkewMs)
//  * expire_time is normalised to milliseconds (accepts seconds too)

import { ApiError } from './elite-api.js';

const STATE_KEY = 'pango.state';

const emptyState = () => ({ accessToken: undefined, deviceId: undefined, cacheId: undefined, locations: [], lastLocationUpdate: 0, proxyCache: {} });

export const toMillis = (t) => (t < 1e11 ? t * 1000 : t);

export class PangoApi {
  /**
   * @param {object} o
   * @param {string} o.baseUrl
   * @param {Storage} o.storage
   * @param {() => Promise<{accessToken:string, authMethod:string, deviceId:string, deviceType:string, carrierId:string, cacheId?:string}>} o.loginCredentials
   */
  constructor({ baseUrl, storage, loginCredentials, fetchImpl = globalThis.fetch?.bind(globalThis), timeoutMs = 20_000, skewMs = 60_000, now = Date.now }) {
    this.baseUrl = baseUrl;
    this.storage = storage;
    this.loginCredentials = loginCredentials;
    this.fetch = fetchImpl;
    this.timeoutMs = timeoutMs;
    this.skewMs = skewMs;
    this.now = now;
    this.state = emptyState();
    this.lastError = null;
    this.authPromise = null;
    this.locationPromise = null;
    this.providePromises = new Map();
  }

  async init() {
    const saved = await this.storage.get(STATE_KEY);
    if (saved && typeof saved === 'object') this.state = { ...emptyState(), ...saved };
  }

  isAuthed() {
    return Boolean(this.state.accessToken && this.state.deviceId);
  }

  locationsCached() {
    return [...this.state.locations];
  }

  async #persist() {
    await this.storage.set(STATE_KEY, this.state);
  }

  async resetState() {
    this.state = emptyState();
    await this.storage.remove(STATE_KEY);
  }

  async #request(path, { method = 'GET', query, form } = {}) {
    const url = new URL(this.baseUrl + path);
    if (query) for (const [k, v] of Object.entries(query)) if (v !== undefined) url.searchParams.set(k, v);
    const init = { method, credentials: 'omit', cache: 'no-store', signal: AbortSignal.timeout(this.timeoutMs) };
    if (form) init.body = new URLSearchParams(form);

    let res;
    try {
      res = await this.fetch(url.toString(), init);
    } catch (cause) {
      throw new ApiError(`Network error calling ${path}`, { cause });
    }
    const text = await res.text();
    if (!res.ok) {
      const authFailed = res.status === 401;
      if (authFailed) await this.resetState();
      throw new ApiError(`${path}: HTTP ${res.status} ${text.slice(0, 200)}`, { httpStatus: res.status, authFailed });
    }
    let json;
    try {
      json = JSON.parse(text);
    } catch (cause) {
      throw new ApiError(`${path}: response is not JSON`, { httpStatus: res.status, cause });
    }
    if (String(json?.result).toLowerCase() !== 'ok') {
      throw new ApiError(`${path}: ${json?.result} ${json?.error ?? ''}`.trim(), { httpStatus: res.status });
    }
    return json;
  }

  async #track(promise) {
    try {
      const result = await promise;
      this.lastError = null;
      return result;
    } catch (e) {
      this.lastError = { message: e.message, httpStatus: e.httpStatus, at: this.now() };
      throw e;
    }
  }

  async login({ accessToken, authMethod, deviceId, deviceType, carrierId, cacheId = 'anonymous' }) {
    if (!(accessToken && authMethod && deviceId && deviceType && carrierId)) {
      throw new Error('login: all credential values must be provided');
    }
    const json = await this.#request('/login', {
      method: 'POST',
      form: { access_token: accessToken, auth_method: authMethod, device_id: deviceId, device_type: deviceType, carrier_id: carrierId },
    });
    // A fresh login invalidates everything cached for the previous session (the
    // location list and server pool can differ per account tier).
    this.state = emptyState();
    this.state.accessToken = json.access_token;
    this.state.deviceId = deviceId;
    this.state.cacheId = cacheId; // whose session this is (account token, or "anonymous")
    await this.#persist();
  }

  /** If the stored session belongs to a different identity, end it (official verifyCacheId). */
  async verifyIdentity(cacheId) {
    if (this.isAuthed() && this.state.cacheId !== cacheId) await this.resetIdentity();
  }

  /** Best-effort server logout, then always drop all cached session state. */
  async resetIdentity() {
    try {
      await this.logout();
    } catch {
      /* the session may already be invalid; local reset below is what matters */
    } finally {
      await this.resetState();
    }
  }

  async logout() {
    if (!this.isAuthed()) return;
    try {
      await this.#request('/logout', { query: { access_token: this.state.accessToken } });
    } finally {
      await this.resetState();
    }
  }

  #autoAuth() {
    if (!this.authPromise) {
      this.authPromise = this.#track(this.loginCredentials().then((c) => this.login(c))).finally(() => {
        this.authPromise = null;
      });
    }
    return this.authPromise;
  }

  /** Run `fn`; if the session is missing or rejected (401), log in again and retry once. */
  async #withAuth(fn) {
    if (this.isAuthed()) {
      try {
        return await fn();
      } catch (e) {
        if (!(e instanceof ApiError && e.authFailed)) throw e;
      }
    }
    await this.#autoAuth();
    return fn();
  }

  /** Refresh the list of server locations. Concurrent calls share one request. */
  refreshLocations() {
    if (!this.locationPromise) {
      this.locationPromise = this.#track(
        this.#withAuth(async () => {
          const json = await this.#request('/locations', { query: { access_token: this.state.accessToken, type: 'proxy' } });
          this.state.locations = Array.isArray(json.locations) ? json.locations : [];
          this.state.lastLocationUpdate = this.now();
          await this.#persist();
          return [...this.state.locations];
        }),
      ).finally(() => {
        this.locationPromise = null;
      });
    }
    return this.locationPromise;
  }

  async cachedOrFetchLocations() {
    return this.state.locations.length > 0 ? this.locationsCached() : this.refreshLocations();
  }

  #valid(creds) {
    return Boolean(creds?.servers?.length && creds.username && creds.password && creds.expires - this.skewMs > this.now());
  }

  /**
   * Proxy servers + credentials for a location ("optimal" = let the backend choose).
   * Cached until shortly before they expire; concurrent calls share one request.
   */
  getProxyCredentials(location = 'optimal', { force = false } = {}) {
    const key = location || 'optimal';
    const cached = this.state.proxyCache[key];
    if (!force && this.#valid(cached)) return Promise.resolve(cached);

    if (!this.providePromises.has(key)) {
      const p = this.#track(
        this.#withAuth(async () => {
          const json = await this.#request('/provide', {
            method: 'POST',
            query: { access_token: this.state.accessToken, type: 'proxy', location: key === 'optimal' ? undefined : key },
          });
          if (!json.servers?.length) throw new ApiError('provide returned an empty server list');
          if (!json.username || !json.password) throw new ApiError('provide returned no username/password');
          const expires = toMillis(Number(json.expire_time));
          if (!(expires > this.now())) throw new ApiError('provide returned already-expired credentials');
          const creds = { servers: json.servers, username: json.username, password: json.password, expires };
          this.state.proxyCache[key] = creds;
          await this.#persist();
          return creds;
        }),
      ).finally(() => this.providePromises.delete(key));
      this.providePromises.set(key, p);
    }
    return this.providePromises.get(key);
  }
}
