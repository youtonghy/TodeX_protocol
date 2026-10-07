/**
 * Loopback classification shared by every protocol helper (transport policy,
 * server URL normalization, local preview URLs). Kept dependency-free so both
 * `todex.ts` and `mobileParity.ts` can import it without a cycle.
 */

/** One canonical dotted-decimal octet: 1–3 digits, no leading zero, ≤ 255. */
function isCanonicalOctet(part: string): boolean {
  return /^(0|[1-9]\d{0,2})$/.test(part) && Number(part) <= 255;
}

/**
 * Whether `hostname` (as `URL.hostname` yields it, brackets and a trailing
 * dot tolerated) names this machine: `localhost`, `::1`, `127.0.0.0/8` in
 * canonical dotted decimal, or an IPv4-mapped IPv6 form of the latter.
 * Ambiguous spellings such as `127.0.0.08`, `0127.0.0.1` or `127.1` are not
 * loopback here (matching the mobile client and the backend), since other
 * parsers read them as different addresses.
 */
export function isLoopbackHostname(hostname: string | null | undefined): boolean {
  if (typeof hostname !== 'string') return false;
  const host = hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '').toLowerCase();
  if (host === 'localhost' || host === '::1' || host === '0:0:0:0:0:0:0:1') return true;
  const ipv4 = host.split('.');
  if (ipv4.length === 4 && ipv4[0] === '127') return ipv4.every(isCanonicalOctet);
  // URL.hostname can expose an IPv4-mapped IPv6 loopback address.
  const mapped = host.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return isLoopbackHostname(mapped[1]);
  const mappedHex = host.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (mappedHex) {
    const high = Number.parseInt(mappedHex[1], 16);
    const low = Number.parseInt(mappedHex[2], 16);
    return isLoopbackHostname(`${high >> 8}.${high & 0xff}.${low >> 8}.${low & 0xff}`);
  }
  return false;
}
