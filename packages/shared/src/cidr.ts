/**
 * CIDR matching (Phase 6d). Pure: parse a block, test an address. No DNS, no
 * I/O, no ambient anything.
 *
 * SPEC §5: "LAB_SUPERVISED: enforce ExamSession CIDR allowlisting on attempt
 * start and on every heartbeat, so leaving the lab network ends the session."
 *
 * And, honestly, from the same section's list of what each control is worth:
 *
 *   IP/CIDR allowlisting is defeated by a VPN or hotspot outside a lab;
 *   inside a lab it usefully detects a candidate who has left the supervised
 *   network.
 *
 * So this is not an anti-cheating measure. It is a presence check for a
 * supervised room, and that is all it is sold as anywhere in the product.
 *
 * It takes the RAW address, which exists only for the lifetime of a request:
 * SPEC §4 forbids storing one anywhere, so the attempt stores `hashIp()` and
 * the comparison happens here, in memory, against the hall's allowlist.
 */

export interface ParsedCidr {
  readonly kind: "ipv4" | "ipv6";
  /** Network bytes, masked. 4 bytes for IPv4, 16 for IPv6. */
  readonly bytes: Uint8Array;
  readonly prefix: number;
}

function parseIpv4(text: string): Uint8Array | null {
  const parts = text.split(".");
  if (parts.length !== 4) return null;
  const bytes = new Uint8Array(4);
  for (let i = 0; i < 4; i++) {
    const part = parts[i]!;
    // No leading zeros: "010" is octal in some parsers and decimal in others,
    // and an allowlist that disagrees with the kernel is worse than none.
    if (!/^(0|[1-9][0-9]{0,2})$/.test(part)) return null;
    const value = Number(part);
    if (value > 255) return null;
    bytes[i] = value;
  }
  return bytes;
}

function parseIpv6(text: string): Uint8Array | null {
  // An IPv4-mapped tail ("::ffff:10.0.0.1") is common from a dual-stack
  // proxy. Rewriting it as two hex groups up front means the rest of this
  // function parses ONE grammar instead of two interleaved ones — the first
  // version tried to carry the tail separately and got both "::ffff:1.2.3.4"
  // and "2001:db8:::1" wrong, in opposite directions.
  let normalised = text;
  const lastColon = text.lastIndexOf(":");
  if (lastColon !== -1 && text.slice(lastColon + 1).includes(".")) {
    const v4 = parseIpv4(text.slice(lastColon + 1));
    if (!v4) return null;
    const high = (((v4[0]! << 8) | v4[1]!) >>> 0).toString(16);
    const low = (((v4[2]! << 8) | v4[3]!) >>> 0).toString(16);
    normalised = `${text.slice(0, lastColon + 1)}${high}:${low}`;
  }

  const halves = normalised.split("::");
  if (halves.length > 2) return null;
  // ":::" leaves a stray colon on an inner edge. Checked explicitly, because
  // stripping it (as the first version did) silently accepts the malformed
  // address instead of refusing it.
  if (halves.length === 2 && (halves[0]!.endsWith(":") || halves[1]!.startsWith(":"))) return null;
  if (halves.length === 1 && (normalised.startsWith(":") || normalised.endsWith(":"))) return null;

  const parseGroups = (part: string): number[] | null => {
    if (part === "") return [];
    const groups: number[] = [];
    for (const group of part.split(":")) {
      if (!/^[0-9a-fA-F]{1,4}$/.test(group)) return null;
      groups.push(Number.parseInt(group, 16));
    }
    return groups;
  };

  const left = parseGroups(halves[0]!);
  const right = halves.length === 2 ? parseGroups(halves[1]!) : [];
  if (left === null || right === null) return null;

  const total = left.length + right.length;
  // No "::" means all eight groups are written out. With "::", it stands for
  // at least one omitted group, so seven is the most that may be written.
  if (halves.length === 1 && total !== 8) return null;
  if (halves.length === 2 && total > 7) return null;

  const groups = [...left, ...new Array<number>(8 - total).fill(0), ...right];
  const bytes = new Uint8Array(16);
  for (let i = 0; i < 8; i++) {
    bytes[i * 2] = (groups[i]! >> 8) & 0xff;
    bytes[i * 2 + 1] = groups[i]! & 0xff;
  }
  return bytes;
}

/** An address, as bytes. Null when it is not an address at all. */
export function parseAddress(text: string): { kind: "ipv4" | "ipv6"; bytes: Uint8Array } | null {
  const trimmed = text.trim();
  if (trimmed === "") return null;
  // A bracketed form, as a URL writes it.
  const bare = trimmed.startsWith("[") && trimmed.endsWith("]") ? trimmed.slice(1, -1) : trimmed;
  if (bare.includes(":")) {
    const bytes = parseIpv6(bare);
    return bytes ? { kind: "ipv6", bytes } : null;
  }
  const bytes = parseIpv4(bare);
  return bytes ? { kind: "ipv4", bytes } : null;
}

function maskInPlace(bytes: Uint8Array, prefix: number): void {
  for (let i = 0; i < bytes.length; i++) {
    const bitsBefore = i * 8;
    if (prefix >= bitsBefore + 8) continue;
    if (prefix <= bitsBefore) {
      bytes[i] = 0;
      continue;
    }
    const keep = prefix - bitsBefore;
    bytes[i] = bytes[i]! & (0xff << (8 - keep)) & 0xff;
  }
}

/**
 * Parse "10.0.0.0/8", "192.168.1.5" (a bare address, treated as /32) or
 * "2001:db8::/32". Returns null for anything else — an allowlist entry that
 * does not parse must never be treated as matching, and must never be
 * treated as matching nothing silently either (see `matchesAnyCidr`).
 */
export function parseCidr(text: string): ParsedCidr | null {
  const trimmed = text.trim();
  if (trimmed === "") return null;
  const slash = trimmed.lastIndexOf("/");
  const addressPart = slash === -1 ? trimmed : trimmed.slice(0, slash);
  const address = parseAddress(addressPart);
  if (!address) return null;
  const maxPrefix = address.kind === "ipv4" ? 32 : 128;

  let prefix = maxPrefix;
  if (slash !== -1) {
    const prefixPart = trimmed.slice(slash + 1);
    if (!/^(0|[1-9][0-9]?|1[01][0-9]|12[0-8])$/.test(prefixPart)) return null;
    prefix = Number(prefixPart);
    if (prefix > maxPrefix) return null;
  }

  const bytes = new Uint8Array(address.bytes);
  maskInPlace(bytes, prefix);
  return { kind: address.kind, bytes, prefix };
}

/** Is this address inside this block? */
export function cidrContains(block: ParsedCidr, address: string): boolean {
  const parsed = parseAddress(address);
  if (!parsed) return false;
  if (parsed.kind !== block.kind) return false;
  const bytes = new Uint8Array(parsed.bytes);
  maskInPlace(bytes, block.prefix);
  for (let i = 0; i < bytes.length; i++) if (bytes[i] !== block.bytes[i]) return false;
  return true;
}

export interface AllowlistResult {
  readonly allowed: boolean;
  /** Entries that are not CIDR blocks at all. A misconfiguration, not a verdict. */
  readonly invalid: string[];
  /** True when the allowlist is empty — i.e. not configured. */
  readonly empty: boolean;
}

/**
 * Is the address allowed by this list?
 *
 * Three cases the caller has to tell apart, which is why this returns a shape
 * rather than a boolean:
 *
 *   - `empty`: no allowlist is configured. NOT the same as "nothing is
 *     allowed". A hall whose allowlist nobody filled in must not lock every
 *     candidate out of their exam; the caller treats this as "no network
 *     restriction" and says so on the invigilator's screen.
 *   - `invalid`: some entries do not parse. The valid ones still decide the
 *     answer, and the invalid ones are reported so somebody fixes the typo
 *     rather than wondering why the lab's own subnet is being refused.
 *   - `allowed`: the address is inside at least one valid block.
 */
export function matchesAnyCidr(address: string | null, allowlist: readonly string[]): AllowlistResult {
  const invalid: string[] = [];
  const blocks: ParsedCidr[] = [];
  for (const entry of allowlist) {
    const block = parseCidr(entry);
    if (block) blocks.push(block);
    else invalid.push(entry);
  }
  if (blocks.length === 0) return { allowed: true, invalid, empty: true };
  if (address === null) {
    // An allowlist IS configured and we cannot tell where the request came
    // from (no trusted proxy). Refused: a check that silently passes when it
    // cannot run is not a check. docs/RUNBOOK.md requires TRUST_PROXY for a
    // lab-supervised deployment for exactly this reason.
    return { allowed: false, invalid, empty: false };
  }
  return { allowed: blocks.some((block) => cidrContains(block, address)), invalid, empty: false };
}
