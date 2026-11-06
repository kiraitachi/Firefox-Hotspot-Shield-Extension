// Message schemas for the Elite API (api.hsselite.com/1/plain/*).
// 'required' marks fields the official encoder always writes (checked empirically).
// Field numbers/types were extracted from the generated protobufjs code in the
// official Chrome extension 5.2.12 (proto.api.*). Only the fields this port needs.

export const DeviceInfo = {
  fields: [
    [1, 'platform', 'int32', 'required'], // Platform enum: EXTENSION_CHROME=5, EXTENSION_FFOX=7, EXTENSION_EDGE=10
    [2, 'hash', 'string', 'required'],
    [3, 'package_name', 'string', 'required'],
    [4, 'app_version', 'int32', 'required'],
    [5, 'model', 'string'],
    [6, 'make', 'string'],
    [7, 'os_name', 'string'],
    [8, 'language', 'string'],
    [9, 'signature', 'string'],
    [10, 'token', 'string'],
    [11, 'channel', 'string'],
    [12, 'bn_proxy_device_id', 'string'],
    [13, 'wl_id', 'string'],
    [14, 'timezone', 'string'],
    [15, 'store_country', 'string'],
    [16, 'currency', 'string'],
  ],
};

export const ResponseStatus = {
  fields: [
    [1, 'success', 'bool'],
    [2, 'error_code', 'uint32'],
    [3, 'error_message', 'string'],
    [4, 'debug', 'string'],
    [5, 'server_time', 'uint64'],
  ],
};

// Package.id enum: ELITE=1, DEDICATED=10, TURBO=11, TRIAL=15, ADS=13, VIRTUAL_LOCATION=12, ...
export const Package = {
  fields: [
    [1, 'id', 'int32'],
    [2, 'is_active', 'bool'],
    [3, 'expiration_date', 'uint64'],
    [4, 'is_lifetime', 'bool'],
  ],
};

// Subset of the account state the backend returns (more fields exist; unknown ones are skipped).
export const UserStatus = {
  fields: [
    [1, 'packages_list', 'int32', 'repeated'],
    [2, 'packages', Package, 'repeated'],
    [3, 'login', 'string'], // "_AFFREE_" for anonymous users
    [4, 'devices_max', 'uint32'],
    [5, 'devices_used', 'uint32'],
    [6, 'is_anonymous', 'bool'],
  ],
};

// POST vpn-auth. token_type: CONSUMER=1, PARTNER=2 (the official extension sends 2).
export const VPNAuthRequest = {
  fields: [
    [1, 'DeviceInfo', DeviceInfo, 'required'],
    [2, 'token_type', 'int32'],
  ],
};

// auth_method: WIREGUARD=1, ELITE=2, ELITE_ANONYMOUS=3
export const VPNAuthResponse = {
  fields: [
    [1, 'ResponseStatus', ResponseStatus],
    [2, 'JWT', 'string'],
    [3, 'auth_method', 'int32'],
    [4, 'UserStatus', UserStatus],
  ],
};

export const StatusRequest = {
  fields: [
    [1, 'DeviceInfo', DeviceInfo, 'required'],
    [2, 'JWT', 'string'],
  ],
};

export const StatusResponse = {
  fields: [
    [1, 'ResponseStatus', ResponseStatus],
    [2, 'UserStatus', UserStatus],
    [3, 'token', 'string'],
    [4, 'client_cache', 'string'],
    [5, 'wl_id', 'string'],
  ],
};

// POST signin. login and password are required fields. The official client lower-cases
// and trims the email, trims the password, and omits DeviceInfo.token.
export const SigninRequest = {
  fields: [
    [1, 'DeviceInfo', DeviceInfo, 'required'],
    [2, 'login', 'string', 'required'],
    [3, 'password', 'string', 'required'],
  ],
};
export const SigninResponse = {
  fields: [
    [1, 'ResponseStatus', ResponseStatus],
    [2, 'UserStatus', UserStatus],
    [3, 'token', 'string'],
    [4, 'JWT', 'string'],
    [5, 'JWT_refresh', 'string'],
  ],
};

// POST signout. selected_device_hash (optional) is for signing out a *different* device.
export const SignoutRequest = {
  fields: [
    [1, 'DeviceInfo', DeviceInfo, 'required'],
    [2, 'selected_device_hash', 'string'],
  ],
};
export const SignoutResponse = {
  fields: [
    [1, 'ResponseStatus', ResponseStatus],
    [2, 'UserStatus', UserStatus],
    [3, 'token', 'string'],
  ],
};
