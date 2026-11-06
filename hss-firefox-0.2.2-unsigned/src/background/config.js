// Everything that identifies this client to the backend or that you might need to
// tweak lives here. Values marked [official] are taken verbatim from the Chrome
// extension 5.2.12; values marked [port] are the Firefox-specific choices.

export const CONFIG = {
  // Elite API: protobuf over HTTPS POST, issues the anonymous JWT. [official]
  eliteApi: 'https://api.hsselite.com/1/plain/',
  // Pango API: JSON, exchanges the JWT for proxy servers + credentials. [official]
  pangoApi: 'https://api.pango-cloud.com/user',

  carrierId: 'hss_unified', // [official]

  device: {
    platform: 7, // [port] DeviceInfo.Platform.EXTENSION_FFOX (Chrome sends 5)
    // [official] The only package name present in the Chrome build. If the backend
    // rejects the Firefox client, this is the first thing to experiment with.
    packageName: 'com.anchorfree.extchrome',
    model: 'Firefox', // [port]
    make: 'Firefox', // [port]
    deviceType: 'firefox_extension', // [port] Chrome sends 'chrome_extension'
  },

  // The version of the official extension this port tracks. Sent as
  // DeviceInfo.app_version using the official scheme (5.2.12 -> 50212).
  upstreamVersion: '5.2.12',

  tokenType: 2, // [official] VPNAuth.TokenType.PARTNER

  proxyPort: 443, // [official] the PAC script always emitted "HTTPS <address>:443"
  failoverTimeoutSec: 5, // [port] how long Firefox waits before trying the next proxy
  credentialSkewMs: 60_000, // treat credentials as expired this early
  requestTimeoutMs: 20_000,

  // Hosts that must NEVER go through the tunnel. [official: De + Be + Ae lists]
  // The API hosts are mandatory: proxying them would deadlock reconnection.
  alwaysDirectDomains: [
    // API hosts
    'api.hsselite.com',
    'api.pango-cloud.com',
    'api-prod-partner-us-west-2.northghost.com',
    'api-stage-partner-us-west-2.northghost.com',
    // account / billing sites of the same vendor family
    'hotspotshield.com',
    'betternet.co',
    'touchvpn.net',
    'protected.net',
    'totalsecurity.com',
    'totaldrive.com',
    'totalvpn.com',
    'totaladblock.com',
    'totalav.com',
    // local
    'localhost',
  ],

  // User-facing defaults (persisted once the user changes them). [port]
  defaults: {
    webrtcProtection: true, // official Firefox path also disabled WebRTC while connected
    blockWhenDown: true, // fail closed: never leak traffic if the proxy is unreachable
  },
};
