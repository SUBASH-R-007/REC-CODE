import { describe, expect, it } from "vitest";
import { cidrContains, matchesAnyCidr, parseAddress, parseCidr } from "../src/cidr";

const contains = (block: string, address: string) => {
  const parsed = parseCidr(block);
  if (!parsed) throw new Error(`fixture block does not parse: ${block}`);
  return cidrContains(parsed, address);
};

describe("parseAddress", () => {
  it("parses dotted-quad IPv4", () => {
    expect(parseAddress("10.0.0.1")?.bytes).toEqual(new Uint8Array([10, 0, 0, 1]));
    expect(parseAddress("255.255.255.255")?.kind).toBe("ipv4");
    expect(parseAddress("0.0.0.0")?.kind).toBe("ipv4");
  });

  it("refuses an octet over 255, the wrong number of octets, and empty parts", () => {
    for (const bad of ["256.0.0.1", "10.0.0", "10.0.0.1.2", "10..0.1", "10.0.0.", ""]) {
      expect(parseAddress(bad), bad).toBeNull();
    }
  });

  it("refuses leading zeros, because the kernel may read them as octal", () => {
    // An allowlist that disagrees with the network stack is worse than none.
    expect(parseAddress("010.0.0.1")).toBeNull();
    expect(parseAddress("10.00.0.1")).toBeNull();
  });

  it("refuses anything that is not numeric", () => {
    for (const bad of ["ten.0.0.1", "10.0.0.-1", "10.0.0.1x", " 10.0.0.1 ".replace(/ /g, "_")]) {
      expect(parseAddress(bad), bad).toBeNull();
    }
  });

  it("tolerates surrounding whitespace and brackets, as a URL writes them", () => {
    expect(parseAddress("  10.0.0.1  ")?.kind).toBe("ipv4");
    expect(parseAddress("[2001:db8::1]")?.kind).toBe("ipv6");
  });

  it("parses full and compressed IPv6", () => {
    expect(parseAddress("2001:0db8:0000:0000:0000:0000:0000:0001")?.kind).toBe("ipv6");
    const compressed = parseAddress("2001:db8::1");
    const full = parseAddress("2001:0db8:0000:0000:0000:0000:0000:0001");
    expect(compressed?.bytes).toEqual(full?.bytes);
  });

  it("parses the loopback and the all-zeros address", () => {
    expect(parseAddress("::1")?.bytes[15]).toBe(1);
    expect(parseAddress("::")?.bytes).toEqual(new Uint8Array(16));
  });

  it("parses an IPv4-mapped address, which is what a dual-stack proxy sends", () => {
    const mapped = parseAddress("::ffff:10.0.0.1");
    expect(mapped?.kind).toBe("ipv6");
    expect(mapped?.bytes.slice(12)).toEqual(new Uint8Array([10, 0, 0, 1]));
    expect(mapped?.bytes[10]).toBe(0xff);
  });

  it("parses an IPv4 tail with no mapping prefix", () => {
    expect(parseAddress("::10.0.0.1")?.bytes.slice(12)).toEqual(new Uint8Array([10, 0, 0, 1]));
  });

  it("agrees with the written-out form for every mapped address it accepts", () => {
    // The mapped form is rewritten into hex groups before parsing, so this
    // asserts the rewrite is faithful rather than merely accepted.
    for (const [mapped, written] of [
      ["::ffff:192.168.1.1", "::ffff:c0a8:101"],
      ["::ffff:10.0.0.1", "::ffff:a00:1"],
      ["::255.255.255.255", "::ffff:ffff"],
      ["2001:db8::ffff:1.2.3.4", "2001:db8::ffff:102:304"],
    ] as const) {
      expect(parseAddress(mapped)?.bytes, mapped).toEqual(parseAddress(written)?.bytes);
    }
  });

  it("refuses a stray colon at either edge", () => {
    for (const bad of [":2001:db8::1", "2001:db8::1:", ":1:2:3:4:5:6:7:8"]) {
      expect(parseAddress(bad), bad).toBeNull();
    }
  });

  it("refuses too many or too few groups", () => {
    expect(parseAddress("1:2:3:4:5:6:7")).toBeNull();
    expect(parseAddress("1:2:3:4:5:6:7:8:9")).toBeNull();
    // "::" must stand for at least one group, so eight written groups plus
    // "::" is not an address.
    expect(parseAddress("1:2:3:4::5:6:7:8")).toBeNull();
  });

  it("refuses malformed IPv6", () => {
    for (const bad of ["2001:db8::1::2", "2001:db8:::1", "12345::1", "2001:db8", "2001:db8::g"]) {
      expect(parseAddress(bad), bad).toBeNull();
    }
  });
});

describe("cidrContains", () => {
  it("matches inside an IPv4 block and refuses outside it", () => {
    expect(contains("10.0.0.0/8", "10.1.2.3")).toBe(true);
    expect(contains("10.0.0.0/8", "11.1.2.3")).toBe(false);
  });

  it("handles a /24, the common lab subnet", () => {
    expect(contains("192.168.1.0/24", "192.168.1.1")).toBe(true);
    expect(contains("192.168.1.0/24", "192.168.1.255")).toBe(true);
    expect(contains("192.168.1.0/24", "192.168.2.1")).toBe(false);
  });

  it("handles a non-byte-aligned prefix", () => {
    // /20 covers 10.1.0.0 - 10.1.15.255
    expect(contains("10.1.0.0/20", "10.1.15.255")).toBe(true);
    expect(contains("10.1.0.0/20", "10.1.16.0")).toBe(false);
    // /25 splits a /24 in half.
    expect(contains("192.168.1.0/25", "192.168.1.127")).toBe(true);
    expect(contains("192.168.1.0/25", "192.168.1.128")).toBe(false);
  });

  it("treats a bare address as a single host", () => {
    expect(contains("192.168.1.5", "192.168.1.5")).toBe(true);
    expect(contains("192.168.1.5", "192.168.1.6")).toBe(false);
  });

  it("masks the block, so a sloppy entry still works", () => {
    // Someone writes the lab's own address with the subnet's prefix.
    expect(contains("192.168.1.37/24", "192.168.1.200")).toBe(true);
  });

  it("matches everything at /0 and only itself at /32", () => {
    expect(contains("0.0.0.0/0", "8.8.8.8")).toBe(true);
    expect(contains("8.8.8.8/32", "8.8.8.8")).toBe(true);
    expect(contains("8.8.8.8/32", "8.8.8.9")).toBe(false);
  });

  it("never matches across address families", () => {
    // A dual-stack lab must list both forms; an IPv4 block silently matching
    // an IPv6 client would be a hole.
    expect(contains("10.0.0.0/8", "::ffff:10.0.0.1")).toBe(false);
    expect(contains("::/0", "10.0.0.1")).toBe(false);
  });

  it("matches inside an IPv6 block", () => {
    expect(contains("2001:db8::/32", "2001:db8:1234::1")).toBe(true);
    expect(contains("2001:db8::/32", "2001:db9::1")).toBe(false);
    expect(contains("2001:db8::/127", "2001:db8::1")).toBe(true);
    expect(contains("2001:db8::/128", "2001:db8::1")).toBe(false);
  });

  it("refuses an address that does not parse rather than matching it", () => {
    expect(contains("10.0.0.0/8", "not an address")).toBe(false);
    expect(contains("10.0.0.0/8", "")).toBe(false);
  });
});

describe("parseCidr", () => {
  it("refuses a prefix out of range for the family", () => {
    expect(parseCidr("10.0.0.0/33")).toBeNull();
    expect(parseCidr("2001:db8::/129")).toBeNull();
  });

  it("refuses a malformed prefix", () => {
    for (const bad of ["10.0.0.0/", "10.0.0.0/x", "10.0.0.0/-1", "10.0.0.0/08", "10.0.0.0/8/8"]) {
      expect(parseCidr(bad), bad).toBeNull();
    }
  });

  it("accepts an IPv6 prefix above 32, which the IPv4 pattern must not bound", () => {
    expect(parseCidr("2001:db8::/64")?.prefix).toBe(64);
    expect(parseCidr("2001:db8::/128")?.prefix).toBe(128);
  });
});

describe("matchesAnyCidr", () => {
  const lab = ["10.12.0.0/16", "192.168.1.0/24"];

  it("allows an address in any listed block", () => {
    expect(matchesAnyCidr("10.12.5.6", lab)).toEqual({ allowed: true, invalid: [], empty: false });
    expect(matchesAnyCidr("192.168.1.9", lab).allowed).toBe(true);
  });

  it("refuses an address in none of them", () => {
    expect(matchesAnyCidr("49.207.1.1", lab).allowed).toBe(false);
  });

  it("treats an empty allowlist as no restriction, not as a lockout", () => {
    // A hall whose allowlist nobody filled in must not lock every candidate
    // out of their exam.
    expect(matchesAnyCidr("49.207.1.1", [])).toEqual({ allowed: true, invalid: [], empty: true });
  });

  it("reports an unparseable entry while the valid ones still decide", () => {
    const result = matchesAnyCidr("10.12.5.6", ["10.12.0.0/16", "not-a-cidr", "10.0.0.0/99"]);
    expect(result.allowed).toBe(true);
    expect(result.invalid).toEqual(["not-a-cidr", "10.0.0.0/99"]);
    expect(result.empty).toBe(false);
  });

  it("is empty — not a refusal — when every entry is invalid", () => {
    // Otherwise one typo locks a whole hall out, which is the worst possible
    // failure mode for a configuration mistake.
    const result = matchesAnyCidr("10.12.5.6", ["garbage", "also-garbage"]);
    expect(result).toEqual({ allowed: true, invalid: ["garbage", "also-garbage"], empty: true });
  });

  it("refuses when an allowlist is configured and the address is unknown", () => {
    // A check that silently passes when it cannot run is not a check.
    expect(matchesAnyCidr(null, lab)).toEqual({ allowed: false, invalid: [], empty: false });
  });

  it("allows an unknown address when no allowlist is configured", () => {
    expect(matchesAnyCidr(null, []).allowed).toBe(true);
  });

  it("handles a dual-stack lab that lists both families", () => {
    const dual = ["10.12.0.0/16", "2001:db8:cafe::/48"];
    expect(matchesAnyCidr("10.12.0.1", dual).allowed).toBe(true);
    expect(matchesAnyCidr("2001:db8:cafe:1::9", dual).allowed).toBe(true);
    expect(matchesAnyCidr("2001:db8:beef::1", dual).allowed).toBe(false);
  });
});
