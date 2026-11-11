"use client";

/**
 * sha256 in the browser, for the clipboard fingerprints the exam records.
 *
 * SPEC §5: "Maintain a per-attempt Set<string> of sha256 hashes of text
 * copied inside the exam origin, and classify every paste as INTERNAL_PASTE
 * (hash present) or EXTERNAL_PASTE (hash absent), recording size and hash but
 * never the clipboard text."
 *
 * So the hash is computed on the CLIENT and the text never leaves it. Sending
 * the text to be hashed server-side would defeat the promise the chip makes
 * to the candidate: "the size and a one-way fingerprint of pasted and copied
 * text — never the text itself".
 *
 * `crypto.subtle` needs a secure context. On http://localhost it is one; on a
 * plain-http deployment it is not, and then there is no hash — so a paste is
 * recorded with its size and no fingerprint rather than with its text. The
 * deployment is https (docs/RUNBOOK.md), and this degrades rather than
 * failing.
 */
export async function sha256Hex(text: string): Promise<string | null> {
  if (typeof crypto === "undefined" || !crypto.subtle) return null;
  try {
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
    return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
  } catch {
    // Not a secure context, or the algorithm was refused.
    return null;
  }
}
