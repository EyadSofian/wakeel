/**
 * Which addresses tenant URLs may reach (architecture §5.3, threat T3). The policy is applied to the
 * address the proxy will actually dial, after its own DNS lookup, on every hop.
 *
 * IPv4 is a blocklist of every special-purpose range (IANA IPv4 Special-Purpose Address Registry)
 * plus cloud metadata addresses that sit in public space. IPv6 is an allowlist: only global unicast
 * (2000::/3) passes, minus its special-purpose blocks; forms that embed an IPv4 address (mapped,
 * NAT64, 6to4) are judged by the IPv4 they carry.
 *
 * Inputs must be canonical: the WHATWG URL parser has already turned decimal, octal and hex hosts
 * into dotted decimal, and resolvers return canonical text. Anything else is refused rather than
 * guessed at.
 */

export type AddressCheck = { allowed: true } | { allowed: false; range: string };

const LOOPBACK_NAMES = new Set(["localhost.localdomain", "ip6-localhost", "ip6-loopback"]);

const ALLOWED: AddressCheck = { allowed: true };
const blocked = (range: string): AddressCheck => ({ allowed: false, range });

/** [network, prefix length]. Order does not matter; the first match names the range in logs. */
const V4_BLOCKS: readonly (readonly [string, number])[] = [
  ["0.0.0.0", 8], // "this network"; 0.0.0.0 reaches the local host on Linux
  ["10.0.0.0", 8], // private
  ["100.64.0.0", 10], // shared address space (CGNAT); Alibaba metadata 100.100.100.200
  ["127.0.0.0", 8], // loopback
  ["169.254.0.0", 16], // link-local; metadata 169.254.169.254 (AWS, GCP, Azure, Oracle, DigitalOcean)
  ["172.16.0.0", 12], // private
  ["192.0.0.0", 24], // IETF protocol assignments
  ["192.0.2.0", 24], // documentation
  ["192.88.99.0", 24], // 6to4 relay anycast (deprecated)
  ["192.168.0.0", 16], // private
  ["198.18.0.0", 15], // benchmarking
  ["198.51.100.0", 24], // documentation
  ["203.0.113.0", 24], // documentation
  ["224.0.0.0", 4], // multicast
  ["240.0.0.0", 4], // reserved, including 255.255.255.255
  ["168.63.129.16", 32], // Azure wire server and instance metadata: public space, internal service
];

const V4_TABLE = V4_BLOCKS.map(([network, length]) => {
  const base = parseV4(network);
  if (base === undefined) throw new Error(`address-policy: bad network ${network}`);
  const mask = length === 0 ? 0 : (0xffff_ffff << (32 - length)) >>> 0;
  return { base, mask, label: `${network}/${length}` };
});

/** Blocks inside 2000::/3 that are not ordinary internet hosts. Prefix lengths are multiples of 4 or handled bitwise. */
const V6_BLOCKS: readonly (readonly [string, number])[] = [
  ["2001::", 23], // IETF protocol assignments, including Teredo 2001::/32
  ["2001:db8::", 32], // documentation
  ["3fff::", 20], // documentation (RFC 9637)
];

const V6_TABLE = V6_BLOCKS.map(([network, length]) => {
  const groups = parseV6(network);
  if (!groups) throw new Error(`address-policy: bad network ${network}`);
  return { groups, length, label: `${network}/${length}` };
});

/** Checks one canonical IPv4 or IPv6 address (no brackets, no zone). */
export function checkAddress(address: string): AddressCheck {
  if (address.includes(":")) {
    if (address.includes("%")) return blocked("zoned address");
    const groups = parseV6(address);
    return groups ? checkV6(groups) : blocked("not an address");
  }
  const v4 = parseV4(address);
  return v4 === undefined ? blocked("not an address") : checkV4(v4);
}

/**
 * Names refused before any lookup: `localhost` and everything under it (RFC 6761 §6.3) and the
 * loopback aliases common in /etc/hosts. Other names are judged by the addresses they resolve to.
 */
export function checkHostname(hostname: string): AddressCheck {
  const name = hostname.toLowerCase().replace(/\.$/, "");
  if (name === "localhost" || name.endsWith(".localhost")) return blocked("localhost");
  if (LOOPBACK_NAMES.has(name)) return blocked("localhost");
  return ALLOWED;
}

function checkV4(value: number): AddressCheck {
  for (const { base, mask, label } of V4_TABLE) {
    if ((value & mask) >>> 0 === base) return blocked(label);
  }
  return ALLOWED;
}

function checkV6(g: readonly number[]): AddressCheck {
  const [g0, g1, g2, g3, g4, g5, g6, g7] = g as [number, number, number, number, number, number, number, number];
  const embedded = (hi: number, lo: number) => checkV4(((hi << 16) | lo) >>> 0);

  // ::ffff:a.b.c.d — IPv4-mapped. A dual-stack socket dials the IPv4 address.
  if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0xffff) return embedded(g6, g7);
  // 64:ff9b::a.b.c.d — NAT64 well-known prefix (DNS64 hands these out for IPv4-only hosts).
  if (g0 === 0x64 && g1 === 0xff9b && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0) return embedded(g6, g7);
  // 2002:aabb:ccdd::/48 — 6to4 carries a.b.c.d in the second and third groups.
  if (g0 === 0x2002) return embedded(g1, g2);

  // Everything outside global unicast: ::, ::1, IPv4-compatible, SIIT, discard, NAT64 local use,
  // unique local (fc00::/7, incl. AWS metadata fd00:ec2::254), link-local, site-local, multicast.
  if ((g0 & 0xe000) !== 0x2000) return blocked("outside 2000::/3");

  for (const { groups, length, label } of V6_TABLE) {
    if (prefixMatches(g, groups, length)) return blocked(label);
  }
  return ALLOWED;
}

function prefixMatches(address: readonly number[], network: readonly number[], length: number): boolean {
  for (let i = 0, left = length; left > 0; i++, left -= 16) {
    const bits = Math.min(16, left);
    const mask = (0xffff << (16 - bits)) & 0xffff;
    if (((address[i] ?? 0) & mask) !== ((network[i] ?? 0) & mask)) return false;
  }
  return true;
}

/** Canonical dotted decimal only: four parts, 0–255, no leading zeros. */
function parseV4(text: string): number | undefined {
  const parts = text.split(".");
  if (parts.length !== 4) return undefined;
  let value = 0;
  for (const part of parts) {
    if (!/^(0|[1-9][0-9]{0,2})$/.test(part)) return undefined;
    const n = Number(part);
    if (n > 255) return undefined;
    value = value * 256 + n;
  }
  return value;
}

/** Eight 16-bit groups, or undefined. Accepts `::` once and a dotted IPv4 tail. */
function parseV6(text: string): number[] | undefined {
  let head = text;
  const tail: number[] = [];
  const lastColon = head.lastIndexOf(":");
  if (head.slice(lastColon + 1).includes(".")) {
    const v4 = parseV4(head.slice(lastColon + 1));
    if (v4 === undefined) return undefined;
    tail.push(v4 >>> 16, v4 & 0xffff);
    // "::ffff:1.2.3.4" → "::ffff"; "::1.2.3.4" and "64:ff9b::1.2.3.4" keep their "::".
    head = text[lastColon - 1] === ":" ? text.slice(0, lastColon + 1) : text.slice(0, lastColon);
  }

  const halves = head.split("::");
  if (halves.length > 2) return undefined;
  const parse = (s: string) => (s === "" ? [] : s.split(":"));
  const left = parse(halves[0] ?? "");
  const right = halves.length === 2 ? parse(halves[1] ?? "") : [];
  const groups: number[] = [];
  for (const part of [...left, ...right]) {
    if (!/^[0-9a-fA-F]{1,4}$/.test(part)) return undefined;
  }
  const explicit = left.length + right.length + tail.length;
  if (halves.length === 2) {
    if (explicit > 7) return undefined;
    groups.push(...left.map(hex), ...new Array<number>(8 - explicit).fill(0), ...right.map(hex));
  } else {
    if (explicit !== 8) return undefined;
    groups.push(...left.map(hex));
  }
  groups.push(...tail);
  return groups.length === 8 ? groups : undefined;
}

function hex(s: string): number {
  return Number.parseInt(s, 16);
}
