/**
 * IP range classification for SSRF containment — SDD v0.5 §19.1.
 * Prohibited: loopback, link-local, RFC1918/private IPv4, CGNAT,
 * unique-local IPv6, multicast, unspecified, broadcast, and IPv4-mapped
 * IPv6 forms of any of those.
 */
import { isIP } from 'node:net';

export type IpClass = 'public' | 'prohibited';

function classifyIpv4(address: string): IpClass {
  const octets = address.split('.').map((part) => Number.parseInt(part, 10));
  if (octets.length !== 4 || octets.some((o) => Number.isNaN(o) || o < 0 || o > 255)) {
    return 'prohibited';
  }
  const [a, b] = octets as [number, number, number, number];
  if (a === 0) return 'prohibited'; // unspecified / "this network"
  if (a === 10) return 'prohibited'; // RFC1918
  if (a === 100 && b >= 64 && b <= 127) return 'prohibited'; // CGNAT 100.64/10
  if (a === 127) return 'prohibited'; // loopback
  if (a === 169 && b === 254) return 'prohibited'; // link-local
  if (a === 172 && b >= 16 && b <= 31) return 'prohibited'; // RFC1918
  if (a === 192 && b === 168) return 'prohibited'; // RFC1918
  if (a === 192 && b === 0) return 'prohibited'; // 192.0.0/24 special + 192.0.2/24 doc
  if (a === 198 && (b === 18 || b === 19)) return 'prohibited'; // benchmarking
  if (a >= 224) return 'prohibited'; // multicast + reserved + broadcast
  return 'public';
}

function classifyIpv6(address: string): IpClass {
  const lower = address.toLowerCase().replace(/%.*$/, '');
  // IPv4-mapped / IPv4-compatible forms delegate to the IPv4 classifier.
  const v4Match = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(lower) ?? /^::(\d+\.\d+\.\d+\.\d+)$/.exec(lower);
  if (v4Match) return classifyIpv4(v4Match[1]!);

  const expanded = expandIpv6(lower);
  if (expanded === null) return 'prohibited';
  const firstWord = expanded[0]!;

  if (expanded.every((word) => word === 0)) return 'prohibited'; // :: unspecified
  if (expanded.slice(0, 7).every((word) => word === 0) && expanded[7] === 1) return 'prohibited'; // ::1 loopback
  if ((firstWord & 0xffc0) === 0xfe80) return 'prohibited'; // link-local fe80::/10
  if ((firstWord & 0xfe00) === 0xfc00) return 'prohibited'; // unique-local fc00::/7
  if ((firstWord & 0xff00) === 0xff00) return 'prohibited'; // multicast ff00::/8
  if (firstWord === 0x2001 && expanded[1] === 0x0db8) return 'prohibited'; // documentation
  if (firstWord === 0x0064 && expanded[1] === 0xff9b) {
    // 64:ff9b::/96 NAT64 — embedded IPv4 in the last two words.
    const v4 = `${expanded[6]! >> 8}.${expanded[6]! & 0xff}.${expanded[7]! >> 8}.${expanded[7]! & 0xff}`;
    return classifyIpv4(v4);
  }
  return 'public';
}

function expandIpv6(address: string): number[] | null {
  const parts = address.split('::');
  if (parts.length > 2) return null;
  const head = parts[0] === '' ? [] : parts[0]!.split(':');
  const tail = parts.length === 2 && parts[1] !== '' ? parts[1]!.split(':') : [];
  const missing = 8 - head.length - tail.length;
  if (parts.length === 2 && missing < 0) return null;
  if (parts.length === 1 && head.length !== 8) return null;
  const words = [...head, ...Array<string>(Math.max(missing, 0)).fill('0'), ...tail];
  const out: number[] = [];
  for (const word of words) {
    const value = Number.parseInt(word === '' ? '0' : word, 16);
    if (Number.isNaN(value) || value < 0 || value > 0xffff) return null;
    out.push(value);
  }
  return out;
}

/**
 * Classify a literal IP address. Non-IP input returns null (caller must
 * resolve the hostname first).
 */
export function classifyIpLiteral(address: string): IpClass | null {
  const bare = address.replace(/^\[|\]$/g, '');
  const version = isIP(bare);
  if (version === 4) return classifyIpv4(bare);
  if (version === 6) return classifyIpv6(bare);
  return null;
}

export function isProhibitedAddress(address: string): boolean {
  const cls = classifyIpLiteral(address);
  return cls === null ? true : cls === 'prohibited';
}
