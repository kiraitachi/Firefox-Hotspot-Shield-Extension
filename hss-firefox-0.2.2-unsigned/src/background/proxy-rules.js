// Routing decisions, ported from the PAC script the official extension generates
// (Ne.generatePacScript and friends). Pure functions: no browser APIs, so they can
// be unit-tested directly.
//
// Order of evaluation matches the PAC script:
//   1. internal domains (API hosts, vendor account sites)   -> direct
//   2. local network (plain hostnames, .local, private IPs) -> direct
//   3. connected:     user bypass list -> direct, everything else -> proxy
//   4. not connected: "always protect" list -> proxy, everything else -> leave alone
//
// The one deliberate difference: when we are not protecting a request we return
// 'passthrough' (leave the browser's own proxy settings untouched) instead of
// forcing DIRECT, so users with a corporate/system proxy are not overridden.

export function hostFromUrl(url) {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return '';
  }
}

/** Lower-case, strip scheme/path/port, trailing dot and a leading "www.". */
export function normalizeDomain(input) {
  let host = String(input ?? '').trim().toLowerCase();
  if (!host) return '';
  if (host.includes('://')) host = hostFromUrl(host);
  host = host.replace(/\/.*$/, '').replace(/:\d+$/, '').replace(/\.$/, '');
  return host.replace(/^www\./, '');
}

/** host === domain, or host is a subdomain of domain (PAC: host === d || dnsDomainIs(host, '.' + d)). */
export function domainMatches(host, domain) {
  if (!host || !domain) return false;
  return host === domain || host.endsWith('.' + domain);
}

export const matchesAny = (host, domains) => domains.some((d) => domainMatches(host, d));

const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

export function isPrivateIPv4(host) {
  const m = IPV4.exec(host);
  if (!m) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  return (
    a === 10 ||
    a === 127 ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 169 && b === 254) || // link-local (not in the original list; harmless to keep local)
    (a === 173 && b === 37) // [official] present in the original PAC private-range list
  );
}

export function isPrivateIPv6(host) {
  const h = host.replace(/^\[|\]$/g, '').toLowerCase();
  if (!h.includes(':')) return false;
  if (h === '::1') return true;
  const first = h.startsWith(':') ? 0 : parseInt(h.split(':')[0], 16);
  if (Number.isNaN(first)) return false;
  return (first & 0xfe00) === 0xfc00 || (first & 0xffc0) === 0xfe80; // fc00::/7, fe80::/10
}

/**
 * Local-network check without DNS. The official PAC script also resolved every
 * hostname (dnsResolveEx) to spot private addresses; doing that here would send
 * every hostname to the local DNS resolver while the VPN is on, which is a privacy
 * leak, so it is deliberately omitted. Literal IPs, plain hostnames and *.local /
 * *.lan / *.home.arpa are still treated as local.
 */
export function isLocalHost(host) {
  if (!host) return false;
  if (isPrivateIPv4(host) || isPrivateIPv6(host)) return true;
  if (!host.includes('.') && !host.includes(':')) return true; // plain hostname
  return host.endsWith('.local') || host.endsWith('.lan') || host.endsWith('.home.arpa');
}

/**
 * @returns {'direct' | 'proxy' | 'passthrough'}
 */
export function decide({ host, active, bypass = [], secured = [], internal = [] }) {
  if (!host) return 'passthrough';
  if (matchesAny(host, internal)) return 'direct';
  if (isLocalHost(host)) return active ? 'direct' : 'passthrough';
  if (active) return matchesAny(host, bypass) ? 'direct' : 'proxy';
  return matchesAny(host, secured) ? 'proxy' : 'passthrough';
}
