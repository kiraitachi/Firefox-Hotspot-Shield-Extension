// Account/session handling, ported from the user logic of the official "Elite" class:
// signIn, signOut, getStatus and statusCallback (derive session state from a response).
//
// Semantics kept from the official client:
//  * every status/signin/signout response REPLACES the session state wholesale
//  * the account token returned by the backend is sent in DeviceInfo on later calls
//  * "authorized" means a real login (not the anonymous "_AFFREE_" placeholder)
//  * email is trimmed + lower-cased and the password trimmed before sending
//  * status is read first on startup, also for anonymous users (that is where the
//    anonymous token comes from)
//
// Deliberate differences:
//  * the password is never stored, and neither is the signin JWT or JWT_refresh (only the
//    account token, which is what the official client actually uses afterwards)
//  * sign-out always succeeds locally, even offline
//  * a status response that omits the token does not drop an existing token
//  * identity-change events fire after the operation queue is released, so handlers may
//    safely call back into this service (a reconnect re-reads the token)

import { ApiError } from './elite-api.js';

const KEY = 'account';
const ANONYMOUS_LOGIN = '_AFFREE_';
// Package.id: ELITE=1, DEDICATED=10, TURBO=11, TRIAL=15 (official: any of these means premium)
const PREMIUM_PACKAGE_IDS = new Set([1, 10, 11, 15]);

const SESSION_ENDED = 'Your session has ended. Sign in again to use your account.';

export function isAnonymousUser(userStatus) {
  if (!userStatus) return true;
  if (userStatus.is_anonymous !== undefined) return Boolean(userStatus.is_anonymous);
  return !userStatus.login || userStatus.login === ANONYMOUS_LOGIN;
}

/** Mirrors the official hasActiveElitePackage(). */
export function hasActiveElitePackage(userStatus) {
  if (!userStatus) return false;
  if ((userStatus.packages ?? []).some((p) => p.is_active || p.id === 1)) return true;
  return (userStatus.packages_list ?? []).some((id) => PREMIUM_PACKAGE_IDS.has(id));
}

/** Pure: response -> session state (the official statusCallback, minus side effects). */
export function deriveAccount({ userStatus, token }) {
  const isAnonymous = isAnonymousUser(userStatus);
  const login = userStatus?.login;
  const authorized = Boolean(userStatus && !isAnonymous && login && login !== ANONYMOUS_LOGIN);
  return {
    token: token || undefined,
    login: authorized ? login : undefined,
    authorized,
    isAnonymous,
    elite: hasActiveElitePackage(userStatus),
    devicesMax: userStatus?.devices_max,
    devicesUsed: userStatus?.devices_used,
  };
}

const signedOut = () => deriveAccount({ userStatus: null, token: undefined });

function friendlySignInError(e) {
  if (!(e instanceof ApiError)) return e;
  if (e.code === 403 && e.message === 'signin failed') {
    return new ApiError('Email or password is incorrect.', { code: 403, httpStatus: e.httpStatus, cause: e });
  }
  return e;
}

export class AccountService {
  /**
   * @param {object} o
   * @param {EliteApi} o.elite
   * @param {Storage} o.storage
   * @param {({includeToken?: boolean}) => Promise<object>} o.deviceInfo  builds DeviceInfo
   * @param {({tierChanged, tokenChanged, account}) => Promise<void>} [o.onIdentityChange]
   */
  constructor({ elite, storage, deviceInfo, onIdentityChange = async () => {} }) {
    this.elite = elite;
    this.storage = storage;
    this.deviceInfo = deviceInfo;
    this.onIdentityChange = onIdentityChange;
    this.state = signedOut();
    this.jwt = undefined; // only between signin and the follow-up status; never persisted
    this.notice = null;
    this.lastEventError = null;
    this.queue = Promise.resolve();
  }

  async init() {
    const saved = await this.storage.get(KEY);
    if (saved && typeof saved === 'object') this.state = { ...signedOut(), ...saved };
  }

  /** What the popup may see. Contains no secrets. */
  snapshot() {
    const { authorized, login, elite, isAnonymous, devicesMax, devicesUsed } = this.state;
    return { authorized, login: login ?? null, elite, isAnonymous, devicesMax, devicesUsed, notice: this.notice };
  }

  /** Token placed in DeviceInfo on authenticated calls. */
  deviceToken() {
    return this.state.token || this.jwt;
  }

  /** Stable identifier of who the backend session belongs to (Pango "cacheId"). */
  identity() {
    return this.deviceToken() || 'anonymous';
  }

  #tierKey() {
    return JSON.stringify([this.state.authorized, this.state.login, this.state.elite]);
  }

  #tokenKey() {
    return this.state.token ?? '';
  }

  async #apply({ userStatus, token, jwt }, { keepTokenIfMissing = false } = {}) {
    const next = deriveAccount({ userStatus, token });
    const sameUser = next.authorized === this.state.authorized && next.login === this.state.login;
    if (!next.token && keepTokenIfMissing && sameUser) next.token = this.state.token;
    this.state = next;
    this.jwt = jwt;
    await this.storage.set(KEY, this.state);
  }

  async #fetchStatus() {
    const info = await this.elite.status(await this.deviceInfo(), this.jwt);
    await this.#apply({ userStatus: info.userStatus, token: info.token }, { keepTokenIfMissing: true });
  }

  #serial(fn) {
    const run = this.queue.then(fn);
    this.queue = run.then(() => {}, () => {});
    return run;
  }

  /** Runs `fn` serialised; afterwards (queue free) reports identity changes. */
  async #run(fn) {
    let diff = null;
    let outcome;
    await this.#serial(async () => {
      const [tier, token] = [this.#tierKey(), this.#tokenKey()];
      try {
        outcome = { value: await fn() };
      } catch (error) {
        outcome = { error };
      }
      diff = { tierChanged: this.#tierKey() !== tier, tokenChanged: this.#tokenKey() !== token };
    });
    if (diff.tierChanged || diff.tokenChanged) {
      try {
        await this.onIdentityChange({ ...diff, account: this.snapshot() });
        this.lastEventError = null;
      } catch (e) {
        this.lastEventError = e?.message ?? String(e);
      }
    }
    if (outcome.error) throw outcome.error;
    return outcome.value;
  }

  /** Re-read the account status. Failures leave the current state untouched. */
  refresh() {
    return this.#run(async () => {
      const wasAuthorized = this.state.authorized;
      await this.#fetchStatus();
      if (wasAuthorized && !this.state.authorized) this.notice = SESSION_ENDED;
      return this.snapshot();
    });
  }

  /**
   * Make sure we have a token before logging in to the VPN backend (best effort).
   *
   * Deliberately silent (no identity event): this runs from inside a Pango login, where the
   * backend session is empty anyway, and an identity handler that talks to Pango would wait
   * on the very login that is waiting on us.
   */
  async ensureIdentity() {
    await this.#serial(async () => {
      if (this.deviceToken()) return;
      try {
        await this.#fetchStatus();
      } catch {
        /* proceed without a token; the backend decides whether that is acceptable */
      }
    });
  }

  signIn(email, password) {
    return this.#run(async () => {
      const login = String(email ?? '').trim().toLowerCase();
      const secret = String(password ?? '').trim(); // the official client trims both fields
      if (!login || !secret) throw new ApiError('Enter your email and password.');

      let response;
      try {
        response = await this.elite.signIn(await this.deviceInfo({ includeToken: false }), login, secret);
      } catch (e) {
        throw friendlySignInError(e);
      }
      await this.#apply(response);
      if (!this.state.authorized) {
        await this.#apply({ userStatus: null, token: undefined });
        throw new ApiError('Sign-in was not accepted for this device.');
      }

      // The official client re-reads status after signing in. A transient failure here
      // keeps the sign-in; a response saying we are NOT signed in does not.
      try {
        await this.#fetchStatus();
      } catch {
        /* keep the sign-in */
      }
      if (!this.state.authorized) {
        await this.#apply({ userStatus: null, token: undefined });
        throw new ApiError('Sign-in could not be confirmed. Please try again.');
      }
      this.notice = null;
      return this.snapshot();
    });
  }

  signOut() {
    return this.#run(async () => {
      let response = null;
      try {
        response = await this.elite.signOut(await this.deviceInfo());
      } catch {
        /* offline or already revoked: we still sign out locally */
      }
      if (response) await this.#apply({ userStatus: response.userStatus, token: response.token });
      if (!response || this.state.authorized) await this.#apply({ userStatus: null, token: undefined });
      this.notice = null;
      try {
        await this.#fetchStatus(); // pick up a fresh anonymous token, as the official client does
      } catch {
        /* anonymous without a token is fine; the next login re-reads it */
      }
      return this.snapshot();
    });
  }
}
