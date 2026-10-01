import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

/**
 * Private-network guard. The agent must only ever connect to a server you control:
 * loopback, RFC 1918 LAN, Tailscale/CGNAT (100.64.0.0/10) or IPv6 ULA/loopback.
 * Hostnames are allowed only if explicitly allowlisted, and the Mineflayer adapter
 * additionally checks that they RESOLVE to private addresses before connecting.
 */

function ipv4ToInt(ip: string): number {
  return ip.split('.').reduce((acc, octet) => (acc << 8) + Number(octet), 0) >>> 0;
}

const PRIVATE_V4_RANGES: Array<[string, number]> = [
  ['127.0.0.0', 8], // loopback
  ['10.0.0.0', 8], // RFC 1918
  ['172.16.0.0', 12], // RFC 1918
  ['192.168.0.0', 16], // RFC 1918
  ['100.64.0.0', 10], // CGNAT, used by Tailscale
];

export function isPrivateIpAddress(ip: string): boolean {
  const family = isIP(ip);
  if (family === 4) {
    const value = ipv4ToInt(ip);
    return PRIVATE_V4_RANGES.some(([base, bits]) => {
      const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
      return (value & mask) === (ipv4ToInt(base) & mask);
    });
  }
  if (family === 6) {
    const lower = ip.toLowerCase();
    if (lower === '::1') return true;
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(lower);
    if (mapped?.[1] !== undefined) return isPrivateIpAddress(mapped[1]);
    return /^f[cd][0-9a-f]{2}:/.test(lower); // fc00::/7 unique local (Tailscale uses fd7a:…)
  }
  return false;
}

export type HostCheck =
  | { ok: true; kind: 'loopback' | 'private-ip' | 'allowlisted-hostname' }
  | { ok: false; reason: string };

/** `allowlistName` names the setting that allowlists hostnames, for the error message. */
export function checkPrivateHost(
  host: string,
  allowedHostnames: readonly string[],
  allowlistName = 'MC_ALLOWED_HOSTNAMES',
): HostCheck {
  const h = host.trim().toLowerCase();
  if (h === 'localhost') return { ok: true, kind: 'loopback' };
  if (isIP(h) !== 0) {
    return isPrivateIpAddress(h)
      ? { ok: true, kind: h.startsWith('127.') || h === '::1' ? 'loopback' : 'private-ip' }
      : {
          ok: false,
          reason: `${host} is a public IP address; only private/loopback servers are allowed`,
        };
  }
  if (allowedHostnames.map((a) => a.toLowerCase()).includes(h)) {
    return { ok: true, kind: 'allowlisted-hostname' };
  }
  return {
    ok: false,
    reason: `${host} is a hostname that is not in ${allowlistName}; add it only if it is a private server you control`,
  };
}

export type UrlCheck =
  | { ok: true; url: URL; host: string; kind: 'loopback' | 'private-ip' | 'allowlisted-hostname' }
  | { ok: false; reason: string };

/**
 * The same guard for an HTTP base URL (e.g. a local model server): plain http(s) to a
 * private host, with no credentials, query or fragment in the URL.
 */
export function checkPrivateUrl(
  raw: string,
  allowedHostnames: readonly string[],
  allowlistName: string,
): UrlCheck {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, reason: `${raw} is not a valid URL` };
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { ok: false, reason: `${raw} must be an http:// or https:// URL` };
  }
  if (url.username !== '' || url.password !== '') {
    return { ok: false, reason: 'the URL must not contain credentials' };
  }
  if (url.search !== '' || url.hash !== '') {
    return { ok: false, reason: 'the URL must not have a query or fragment' };
  }
  // URL keeps IPv6 hosts in brackets and normalizes IPv4 forms such as 127.1 or 0x7f.0.0.1.
  const host = url.hostname.replace(/^\[(.*)\]$/, '$1');
  const check = checkPrivateHost(host, allowedHostnames, allowlistName);
  return check.ok ? { ok: true, url, host, kind: check.kind } : check;
}

/** Refuses anything that is not (or does not resolve exclusively to) a private address. */
export async function assertPrivateDestination(
  host: string,
  allowedHostnames: readonly string[],
  resolve: (host: string) => Promise<string[]> = async (h) =>
    (await lookup(h, { all: true })).map((a) => a.address),
  allowlistName = 'MC_ALLOWED_HOSTNAMES',
): Promise<void> {
  const check = checkPrivateHost(host, allowedHostnames, allowlistName);
  if (!check.ok) throw new Error(`Refusing to connect: ${check.reason}`);
  if (check.kind !== 'allowlisted-hostname') return;
  const addresses = await resolve(host);
  const bad = addresses.filter((a) => !isPrivateIpAddress(a));
  if (addresses.length === 0 || bad.length > 0) {
    throw new Error(
      `Refusing to connect: ${host} resolves to non-private address(es): ${bad.join(', ') || 'none'}`,
    );
  }
}
