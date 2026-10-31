import { LIMITS } from "./limits";

/**
 * Sanitise compiler / interpreter output before it is stored or displayed:
 * strip /box/ and /opt/toolchains/... prefixes and every other absolute host
 * path, collapse version banners, and truncate. Applied by the worker before
 * a result leaves the judge host, and asserted by the Phase 2 sanitisation
 * test (no "/box/" or "/opt/toolchains/" may appear in stored compileOutput).
 */
export function sanitizeToolOutput(raw: string, maxBytes: number = LIMITS.compile.outputBytes): string {
  let text = raw.replace(/\r\n?/g, "\n");

  // Toolchain paths: "/opt/toolchains/gcc-13.2.0/include/c++/13.2.0/bits/stl_vector.h"
  // → "<toolchain>/include/c++/13.2.0/bits/stl_vector.h"
  text = text.replace(/\/opt\/toolchains\/[^/\s:'"]+/g, "<toolchain>");
  // Box paths: "/box/main.cpp" and host-side "/var/local/lib/isolate/3/box/main.cpp"
  // → "main.cpp" (the whole prefix up to and including "/box/").
  text = text.replace(/(?:\/[A-Za-z0-9._+-]+)*\/box\//g, "");
  text = text.replace(/(^|[\s'"(=])\/box(?=[\s'":)]|$)/gm, "$1.");
  // Any other absolute path with 2+ segments (host include dirs, isolate
  // internals) → "<system>/<basename>".
  text = text.replace(/(^|[\s'"(=])\/(?:[A-Za-z0-9._+-]+\/)+([A-Za-z0-9._+-]+)/gm, "$1<system>/$2");
  // Collapse version banners ("GNU C++20 (GCC) version 13.2.0 (x86_64-linux-gnu)").
  text = text.replace(/^.*\bversion \d+\.\d+(?:\.\d+)?\b.*\(.*\)\s*$/gm, "");
  text = text.replace(/\n{3,}/g, "\n\n").trim();

  return truncateUtf8(text, maxBytes);
}

/** Truncate to at most maxBytes of UTF-8, marking the cut. */
export function truncateUtf8(text: string, maxBytes: number): string {
  const encoder = new TextEncoder();
  const buf = encoder.encode(text);
  if (buf.byteLength <= maxBytes) return text;
  const marker = "\n… (truncated)";
  let cut = Math.max(0, maxBytes - encoder.encode(marker).byteLength);
  // Do not split a multi-byte sequence.
  while (cut > 0 && (buf[cut]! & 0xc0) === 0x80) cut--;
  return new TextDecoder().decode(buf.subarray(0, cut)) + marker;
}

/** UTF-8 byte length without Node's Buffer (usable in the browser). */
export function utf8Length(text: string): number {
  return new TextEncoder().encode(text).byteLength;
}
