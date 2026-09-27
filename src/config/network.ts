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

export function checkPrivateHost(host: string, allowedHostnames: readonly string[]): HostCheck {
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
    reason: `${host} is a hostname that is not in MC_ALLOWED_HOSTNAMES; add it only if it is a private server you control`,
  };
}
