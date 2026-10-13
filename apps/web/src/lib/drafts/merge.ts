/**
 * Which copy of a student's code the workspace opens with. Pure — no
 * storage, no clock — so every case is unit-tested (test/drafts-merge.test.ts).
 *
 * Two copies may exist for one (problem, language):
 *   local   the IndexedDB copy on this device (400 ms after each keystroke);
 *   server  the CodeDraft row (3 s after each keystroke, on blur, and by
 *           beacon when the page is hidden).
 * Each carries `updatedAt`: the epoch-ms time of the edit that produced it,
 * read from the clock of the device that made the edit.
 *
 * The rule: the NEWER copy wins. When the other copy differs (and is worth
 * having — not empty, not the untouched starter code) it is offered back
 * through a non-blocking "Restore …" bar, never silently discarded. A local
 * record that cannot be read is ignored (reported, never a crash). With no
 * copy at all the starter code is used.
 */

export interface DraftCopy {
  source: string;
  /** Epoch ms of the edit that produced this copy. */
  updatedAt: number;
}

/** A local IndexedDB read: a copy, nothing stored, or a record that could not be read. */
export type LocalRead = DraftCopy | null | "corrupt";

export type DraftOrigin = "local" | "server" | "starter";

/** The copy that was not loaded, offered back to the student. */
export interface DraftOffer {
  origin: "local" | "server";
  source: string;
  updatedAt: number;
}

export interface DraftResolution {
  source: string;
  origin: DraftOrigin;
  /** Edit time of the loaded copy; null for the starter code. */
  updatedAt: number | null;
  /** The other saved copy, when it differs and is worth restoring. */
  alternative: DraftOffer | null;
  /** The local record existed but could not be read; it was ignored. */
  localCorrupt: boolean;
  /** The loaded copy is newer than the server's (or the server has none): sync it up. */
  serverBehind: boolean;
}

/** Hard ceiling for anything stored as a draft (the source cap is 256 KB of UTF-8). */
const MAX_LOCAL_SOURCE_CHARS = 512 * 1024;

/** Finite, non-negative epoch ms; anything else counts as "oldest". */
export function normalizeTime(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

/**
 * Read a raw IndexedDB value. `undefined` / `null` → nothing stored; a
 * well-formed `{source, updatedAt}` → a copy; anything else → "corrupt".
 */
export function readDraftRecord(raw: unknown): LocalRead {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== "object" || Array.isArray(raw)) return "corrupt";
  const record = raw as { source?: unknown; updatedAt?: unknown };
  if (typeof record.source !== "string" || record.source.length > MAX_LOCAL_SOURCE_CHARS) return "corrupt";
  if (typeof record.updatedAt !== "number" || !Number.isFinite(record.updatedAt) || record.updatedAt < 0) {
    return "corrupt";
  }
  return { source: record.source, updatedAt: Math.floor(record.updatedAt) };
}

/** A copy is worth offering back unless it is blank or the untouched starter. */
export function isWorthOffering(source: string, starter: string): boolean {
  return source.trim().length > 0 && source !== starter;
}

function validCopy(copy: DraftCopy | null | undefined): DraftCopy | null {
  if (!copy || typeof copy.source !== "string") return null;
  return { source: copy.source, updatedAt: normalizeTime(copy.updatedAt) };
}

export function resolveDraft(input: { local: LocalRead; server: DraftCopy | null; starter: string }): DraftResolution {
  const localCorrupt = input.local === "corrupt";
  const local = input.local === "corrupt" ? null : validCopy(input.local);
  const server = validCopy(input.server);
  const { starter } = input;

  if (!local && !server) {
    return { source: starter, origin: "starter", updatedAt: null, alternative: null, localCorrupt, serverBehind: false };
  }
  if (local && !server) {
    return {
      source: local.source,
      origin: "local",
      updatedAt: local.updatedAt,
      alternative: null,
      localCorrupt,
      // A local draft the server has never seen; the untouched starter is not worth a write.
      serverBehind: local.source !== starter,
    };
  }
  if (!local && server) {
    return { source: server.source, origin: "server", updatedAt: server.updatedAt, alternative: null, localCorrupt, serverBehind: false };
  }

  // Both exist (narrowed by the branches above).
  const l = local as DraftCopy;
  const s = server as DraftCopy;
  if (l.source === s.source) {
    // Same code: nothing to choose. Keep the later timestamp so the next edit compares correctly.
    const newer = l.updatedAt >= s.updatedAt ? l : s;
    return {
      source: l.source,
      origin: newer === l ? "local" : "server",
      updatedAt: newer.updatedAt,
      alternative: null,
      localCorrupt,
      serverBehind: false,
    };
  }

  // Different code: the newer edit wins. A tie keeps this device's copy —
  // it is what the student last saw here.
  const localWins = l.updatedAt >= s.updatedAt;
  const winner = localWins ? l : s;
  const loser = localWins ? s : l;
  return {
    source: winner.source,
    origin: localWins ? "local" : "server",
    updatedAt: winner.updatedAt,
    alternative: isWorthOffering(loser.source, starter)
      ? { origin: localWins ? "server" : "local", source: loser.source, updatedAt: loser.updatedAt }
      : null,
    localCorrupt,
    serverBehind: localWins,
  };
}

/**
 * The language the workspace opens in: the student's remembered choice if
 * this problem offers it; else the language of their most recently edited
 * server draft for this problem; else the first offered language.
 */
export function pickInitialLanguage<K extends string>(input: {
  preferred: string | null | undefined;
  available: readonly K[];
  serverDrafts: readonly { language: string; updatedAt: number }[];
}): K | null {
  const { available } = input;
  const offered = (key: string | null | undefined): K | null =>
    key && (available as readonly string[]).includes(key) ? (key as K) : null;
  const preferred = offered(input.preferred);
  if (preferred) return preferred;
  const recent = [...input.serverDrafts]
    .filter((d) => offered(d.language) !== null)
    .sort((a, b) => normalizeTime(b.updatedAt) - normalizeTime(a.updatedAt))[0];
  return offered(recent?.language) ?? available[0] ?? null;
}
