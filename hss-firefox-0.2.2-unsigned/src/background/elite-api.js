// Client for the Elite API (https://api.hsselite.com/1/plain/<endpoint>).
// Ported from the "Elite" class in the official background bundle. Only the calls
// vpn-auth (get a JWT), status, signin and signout.

import { decodeMessage, encodeMessage } from './protobuf-lite.js';
import * as M from './messages.js';

export class ApiError extends Error {
  constructor(message, { code, httpStatus, authFailed = false, cause } = {}) {
    super(message, { cause });
    this.name = 'ApiError';
    this.code = code; // backend ResponseStatus.error_code, when present
    this.httpStatus = httpStatus;
    this.authFailed = authFailed; // true => caller should re-authenticate and retry once
  }
}

export class EliteApi {
  constructor({ baseUrl, fetchImpl = globalThis.fetch?.bind(globalThis), timeoutMs = 20_000 }) {
    this.baseUrl = baseUrl;
    this.fetch = fetchImpl;
    this.timeoutMs = timeoutMs;
    this.lastError = null;
  }

  async #call(endpoint, reqSchema, respSchema, payload) {
    const body = encodeMessage(reqSchema, payload);
    let res;
    try {
      res = await this.fetch(this.baseUrl + endpoint, {
        method: 'POST',
        body,
        credentials: 'omit',
        cache: 'no-store',
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (cause) {
      throw new ApiError(`Network error calling ${endpoint}`, { cause });
    }

    const buf = new Uint8Array(await res.arrayBuffer());

    // The official client decodes the body regardless of HTTP status because the
    // backend reports failures inside ResponseStatus. Do the same, and only fall
    // back to the HTTP status when the body is not a decodable response.
    let msg = null;
    try {
      msg = decodeMessage(respSchema, buf);
    } catch (cause) {
      if (!res.ok) throw new ApiError(`HTTP ${res.status} from ${endpoint}`, { httpStatus: res.status, cause });
      throw new ApiError(`Undecodable response from ${endpoint}`, { cause });
    }
    if (!msg.ResponseStatus) {
      throw new ApiError(
        res.ok ? `Response from ${endpoint} has no ResponseStatus` : `HTTP ${res.status} from ${endpoint}`,
        { httpStatus: res.status },
      );
    }
    if (!msg.ResponseStatus.success) {
      throw new ApiError(msg.ResponseStatus.error_message || `${endpoint} failed`, {
        code: msg.ResponseStatus.error_code,
        httpStatus: res.status,
      });
    }
    return msg;
  }

  async #track(promise) {
    try {
      const result = await promise;
      this.lastError = null;
      return result;
    } catch (e) {
      this.lastError = { message: e.message, code: e.code, httpStatus: e.httpStatus, at: Date.now() };
      throw e;
    }
  }

  /** Anonymous login. Returns the JWT used to log in to the Pango API. */
  vpnAuth(deviceInfo, tokenType) {
    return this.#track(
      this.#call('vpn-auth', M.VPNAuthRequest, M.VPNAuthResponse, { DeviceInfo: deviceInfo, token_type: tokenType }).then(
        (msg) => {
          if (!msg.JWT) throw new ApiError('vpn-auth returned no JWT');
          // proto default for an absent auth_method is 1 (matches the generated code)
          return { jwt: msg.JWT, authMethod: msg.auth_method ?? 1, userStatus: msg.UserStatus ?? null };
        },
      ),
    );
  }

  /**
   * Account/session status (anonymous vs signed-in, packages, device usage). The
   * response also carries the account `token` that later calls send in DeviceInfo.
   */
  status(deviceInfo, jwt) {
    return this.#track(
      this.#call('status', M.StatusRequest, M.StatusResponse, { DeviceInfo: deviceInfo, JWT: jwt }).then((msg) => ({
        userStatus: msg.UserStatus ?? null,
        token: msg.token || undefined,
      })),
    );
  }

  /**
   * Email + password sign-in. `deviceInfo` must NOT carry a token (the official client
   * omits it here). Backend failures (e.g. error_code 403 for bad credentials) surface
   * as ApiError with `.code`. The password is only ever placed in the request body.
   */
  signIn(deviceInfo, login, password) {
    return this.#track(
      this.#call('signin', M.SigninRequest, M.SigninResponse, { DeviceInfo: deviceInfo, login, password }).then((msg) => ({
        userStatus: msg.UserStatus ?? null,
        token: msg.token || undefined,
        jwt: msg.JWT || undefined,
        // msg.JWT_refresh is deliberately dropped: nothing in the client ever uses it.
      })),
    );
  }

  /** Ends the session server-side. `selectedDeviceHash` signs out a different device. */
  signOut(deviceInfo, selectedDeviceHash) {
    return this.#track(
      this.#call('signout', M.SignoutRequest, M.SignoutResponse, {
        DeviceInfo: deviceInfo,
        selected_device_hash: selectedDeviceHash,
      }).then((msg) => ({ userStatus: msg.UserStatus ?? null, token: msg.token || undefined })),
    );
  }
}
