import { describe, expect, test } from "vitest";
import { checkAddress, checkHostname } from "../src/address-policy";

/**
 * Unit table for the range policy (architecture §5.3, threat T3). The integration suite in
 * ssrf.test.ts proves the same rules hold end to end; this table pins each range on its own.
 * Rows only ever get added.
 */
const BLOCKED_V4: [string, string][] = [
  ["0.0.0.0", "this network"],
  ["0.1.2.3", "this network"],
  ["10.0.0.1", "private"],
  ["10.255.255.255", "private"],
  ["100.64.0.1", "shared address space (CGNAT)"],
  ["100.100.100.200", "Alibaba Cloud metadata, inside 100.64.0.0/10"],
  ["127.0.0.1", "loopback"],
  ["127.255.255.254", "loopback"],
  ["169.254.0.1", "link-local"],
  ["169.254.169.254", "cloud metadata (AWS, GCP, Azure, Oracle, DigitalOcean)"],
  ["168.63.129.16", "Azure wire server, a public address used as metadata"],
  ["172.16.0.1", "private"],
  ["172.31.255.255", "private"],
  ["192.0.0.1", "IETF protocol assignments"],
  ["192.0.0.192", "IETF protocol assignments"],
  ["192.0.2.1", "documentation"],
  ["192.88.99.1", "6to4 relay anycast"],
  ["192.168.1.1", "private"],
  ["198.18.0.1", "benchmarking"],
  ["198.19.255.255", "benchmarking"],
  ["198.51.100.1", "documentation"],
  ["203.0.113.1", "documentation"],
  ["224.0.0.1", "multicast"],
  ["239.255.255.250", "multicast"],
  ["240.0.0.1", "reserved"],
  ["255.255.255.255", "broadcast"],
];

const ALLOWED_V4 = [
  "1.1.1.1",
  "8.8.8.8",
  "93.184.215.14",
  "172.15.255.255",
  "172.32.0.1",
  "100.63.255.255",
  "100.128.0.1",
];

const BLOCKED_V6: [string, string][] = [
  ["::", "unspecified"],
  ["::1", "loopback"],
  ["0:0:0:0:0:0:0:1", "loopback, long form"],
  ["::ffff:127.0.0.1", "IPv4-mapped loopback"],
  ["::ffff:7f00:1", "IPv4-mapped loopback, hex form"],
  ["::ffff:10.0.0.1", "IPv4-mapped private"],
  ["::ffff:169.254.169.254", "IPv4-mapped metadata"],
  ["::ffff:a9fe:a9fe", "IPv4-mapped metadata, hex form"],
  ["::ffff:0:7f00:1", "IPv4-translated (SIIT) loopback"],
  ["::127.0.0.1", "IPv4-compatible (deprecated)"],
  ["::8.8.8.8", "IPv4-compatible (deprecated), even when public"],
  ["64:ff9b::7f00:1", "NAT64 loopback"],
  ["64:ff9b::169.254.169.254", "NAT64 metadata"],
  ["64:ff9b:1::1", "local-use NAT64"],
  ["100::1", "discard-only"],
  ["2001::1", "Teredo"],
  ["2001:db8::1", "documentation"],
  ["2002:7f00:1::", "6to4 loopback"],
  ["2002:a9fe:a9fe::1", "6to4 metadata"],
  ["3fff::1", "documentation (RFC 9637)"],
  ["fc00::1", "unique local"],
  ["fd00:ec2::254", "AWS metadata over IPv6, inside fc00::/7"],
  ["fe80::1", "link-local"],
  ["fe80::1%25en0", "link-local with a zone"],
  ["fec0::1", "site-local (deprecated)"],
  ["ff02::1", "multicast"],
  ["4000::1", "outside global unicast 2000::/3"],
];

const ALLOWED_V6 = [
  "2606:4700:4700::1111",
  "2001:4860:4860::8888",
  "::ffff:8.8.8.8",
  "64:ff9b::808:808",
  "2002:808:808::1",
];

describe("checkAddress", () => {
  test.each(BLOCKED_V4)("blocks %s (%s)", (address) => {
    expect(checkAddress(address)).toMatchObject({ allowed: false });
  });

  test.each(ALLOWED_V4)("allows public IPv4 %s", (address) => {
    expect(checkAddress(address)).toEqual({ allowed: true });
  });

  test.each(BLOCKED_V6)("blocks %s (%s)", (address) => {
    expect(checkAddress(address)).toMatchObject({ allowed: false });
  });

  test.each(ALLOWED_V6)("allows public IPv6 %s", (address) => {
    expect(checkAddress(address)).toEqual({ allowed: true });
  });

  test.each(["", "localhost", "1.2.3", "1.2.3.4.5", "01.2.3.4", "::ffff:1.2.3", "gggg::1", "1::2::3", "[::1]"])(
    "blocks %j, which is not a canonical address",
    (address) => {
      expect(checkAddress(address)).toMatchObject({ allowed: false });
    },
  );

  test("says which range blocked the address, for the log", () => {
    expect(checkAddress("169.254.169.254")).toEqual({ allowed: false, range: "169.254.0.0/16" });
    expect(checkAddress("::ffff:10.0.0.1")).toEqual({ allowed: false, range: "10.0.0.0/8" });
  });
});

describe("checkHostname", () => {
  test.each([
    "localhost",
    "LOCALHOST",
    "localhost.",
    "app.localhost",
    "app.localhost.",
    "localhost.localdomain",
    "ip6-localhost",
    "ip6-loopback",
  ])("blocks %s before any lookup", (host) => {
    expect(checkHostname(host)).toMatchObject({ allowed: false });
  });

  test.each(["example.com", "localhost.example.com", "api.example.com."])("leaves %s to the address check", (host) => {
    expect(checkHostname(host)).toEqual({ allowed: true });
  });
});
