/**
 * Minimal POSIX ustar writer for test bundles. Pure and deterministic: the
 * same entries always produce the same bytes (fixed mtime, uid, gid and
 * mode), so re-writing a bundle with identical content is a no-op against an
 * immutable key instead of a conflict.
 *
 * Only regular files are written; directories are implied by the paths.
 */
export interface TarEntry {
  /** Relative path with "/" separators, e.g. "tests/000.in". */
  name: string;
  bytes: Uint8Array;
}

const BLOCK = 512;
/** ustar's 11-octal-digit size field. */
const MAX_FILE_BYTES = 0o77777777777;
const NAME_MAX = 100;
const PREFIX_MAX = 155;

export class TarError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TarError";
  }
}

function assertSafeName(name: string) {
  const segments = name.split("/");
  const ok =
    name.length > 0 &&
    /^[\x21-\x7e]+$/.test(name) &&
    !name.startsWith("/") &&
    segments.every((s) => s.length > 0 && s !== "." && s !== "..");
  if (!ok) throw new TarError(`Unsafe tar entry name ${JSON.stringify(name)}.`);
}

/** Split a path into ustar's prefix (≤155) and name (≤100) fields. */
export function splitUstarName(name: string): { prefix: string; name: string } {
  if (name.length <= NAME_MAX) return { prefix: "", name };
  for (let i = name.indexOf("/"); i !== -1; i = name.indexOf("/", i + 1)) {
    const prefix = name.slice(0, i);
    const rest = name.slice(i + 1);
    if (prefix.length <= PREFIX_MAX && rest.length <= NAME_MAX && rest.length > 0) return { prefix, name: rest };
  }
  throw new TarError(`Tar entry name too long for ustar: ${name.slice(0, 60)}…`);
}

function writeString(header: Uint8Array, offset: number, length: number, value: string) {
  for (let i = 0; i < value.length && i < length; i++) header[offset + i] = value.charCodeAt(i);
}

/** Octal, zero-padded to length-1 digits, NUL-terminated. */
function writeOctal(header: Uint8Array, offset: number, length: number, value: number) {
  writeString(header, offset, length, value.toString(8).padStart(length - 1, "0") + "\0");
}

function headerFor(entry: TarEntry): Uint8Array {
  const header = new Uint8Array(BLOCK);
  const { prefix, name } = splitUstarName(entry.name);
  writeString(header, 0, 100, name);
  writeOctal(header, 100, 8, 0o644); // mode
  writeOctal(header, 108, 8, 0); // uid
  writeOctal(header, 116, 8, 0); // gid
  writeOctal(header, 124, 12, entry.bytes.byteLength); // size
  writeOctal(header, 136, 12, 0); // mtime: fixed for determinism
  writeString(header, 148, 8, "        "); // checksum placeholder (spaces)
  writeString(header, 156, 1, "0"); // typeflag: regular file
  writeString(header, 257, 6, "ustar\0");
  writeString(header, 263, 2, "00");
  writeString(header, 345, 155, prefix);
  let sum = 0;
  for (const byte of header) sum += byte;
  // Six octal digits, NUL, space — the traditional checksum layout.
  writeString(header, 148, 8, sum.toString(8).padStart(6, "0") + "\0 ");
  return header;
}

/** Serialise entries as a ustar archive (terminated by two zero blocks). */
export function writeTar(entries: readonly TarEntry[]): Buffer {
  const seen = new Set<string>();
  const parts: Uint8Array[] = [];
  for (const entry of entries) {
    assertSafeName(entry.name);
    if (seen.has(entry.name)) throw new TarError(`Duplicate tar entry ${entry.name}.`);
    seen.add(entry.name);
    if (entry.bytes.byteLength > MAX_FILE_BYTES) throw new TarError(`Tar entry ${entry.name} is too large.`);
    parts.push(headerFor(entry), entry.bytes);
    const pad = (BLOCK - (entry.bytes.byteLength % BLOCK)) % BLOCK;
    if (pad > 0) parts.push(new Uint8Array(pad));
  }
  parts.push(new Uint8Array(BLOCK * 2));
  return Buffer.concat(parts);
}
