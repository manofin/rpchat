import net from 'node:net';

const UNSPECIFIED = new Set(['0.0.0.0', '::', '::0']);

function stripBrackets(raw: string): string {
  const t = raw.trim();
  if (t.startsWith('[') && t.endsWith(']')) return t.slice(1, -1);
  return t;
}

/** Map :ffff:IPv4 and bracketed IPv6 to a canonical IP string, or null. */
export function normalizePeerAddress(addr: string | undefined | null): string | null {
  if (!addr) return null;
  let s = stripBrackets(addr);
  const zone = s.indexOf('%');
  if (zone >= 0) s = s.slice(0, zone);
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(s);
  if (mapped) s = mapped[1];
  return net.isIP(s) ? s : null;
}

function isLoopbackIpv4(ip: string): boolean {
  const parts = ip.split('.').map(Number);
  return parts.length === 4 && parts[0] === 127;
}

export function isLoopbackPeer(addr: string | undefined | null): boolean {
  const ip = normalizePeerAddress(addr);
  if (!ip) return false;
  if (net.isIP(ip) === 6) return ip === '::1';
  return isLoopbackIpv4(ip);
}

/** Bind HOST that is loopback-only (not 0.0.0.0 / :: / LAN). */
export function isLoopbackHost(host: string): boolean {
  const h = host.trim().toLowerCase();
  if (h === 'localhost') return true;
  return isLoopbackPeer(h);
}

export function parseTrustedProxyIps(raw: string): { ips: string[]; errors: string[] } {
  const ips: string[] = [];
  const errors: string[] = [];
  const seen = new Set<string>();
  if (raw === undefined || raw === null || raw.trim() === '') return { ips, errors };

  for (const token of raw.split(',')) {
    const t = token.trim();
    if (!t) continue;
    if (t.includes('*')) {
      errors.push(`TAILSCALE_TRUSTED_PROXY_IPS 와일드카드 거부: ${t}`);
      continue;
    }
    if (t.includes('/')) {
      errors.push(`TAILSCALE_TRUSTED_PROXY_IPS 네트워크/CIDR 거부: ${t}`);
      continue;
    }
    const ip = normalizePeerAddress(t);
    if (!ip) {
      errors.push(`TAILSCALE_TRUSTED_PROXY_IPS DNS/비IP 거부: ${t}`);
      continue;
    }
    if (UNSPECIFIED.has(ip)) {
      errors.push(`TAILSCALE_TRUSTED_PROXY_IPS 전체 네트워크 거부: ${t}`);
      continue;
    }
    if (seen.has(ip)) continue;
    seen.add(ip);
    ips.push(ip);
  }
  return { ips, errors };
}

export function isTrustedIngressPeer(addr: string | undefined | null, trustedIps: string[]): boolean {
  if (isLoopbackPeer(addr)) return true;
  const ip = normalizePeerAddress(addr);
  if (!ip) return false;
  const allow = new Set(trustedIps.map((x) => normalizePeerAddress(x)).filter((x): x is string => x !== null));
  return allow.has(ip);
}
