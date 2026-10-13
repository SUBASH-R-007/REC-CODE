/**
 * Note limits, shared by the editor (client) and the server schema. Kept
 * dependency-free so the editor bundle carries no validation library.
 */

/** contentMd is capped at 64 KB of UTF-8. */
export const NOTE_MAX_BYTES = 64 * 1024;
export const NOTE_TITLE_MAX = 120;
/** A soft per-student cap: notes are private study aids, not file storage. */
export const MAX_NOTES_PER_USER = 1_000;
export const NOTES_PAGE_SIZE = 30;

const encoder = new TextEncoder();

export function utf8ByteLength(text: string): number {
  return encoder.encode(text).byteLength;
}

/** "12.3 KB of 64 KB". */
export function formatNoteSize(bytes: number): string {
  const kb = bytes / 1024;
  const shown = kb < 10 ? kb.toFixed(1) : Math.round(kb).toString();
  return `${shown} KB of ${NOTE_MAX_BYTES / 1024} KB`;
}
