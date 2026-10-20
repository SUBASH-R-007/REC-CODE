"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { LanguageKey } from "@recx/shared";
import { clearLegacyDraft, readLegacyDraft, rememberLanguage, sendDraftBeacon } from "@/lib/drafts/browser";
import { idbGet, idbPut } from "@/lib/drafts/idb";
import { LOCAL_DEBOUNCE_MS, SERVER_DEBOUNCE_MS, localDraftKey, serverRetryDelayMs } from "@/lib/drafts/keys";
import { isWorthOffering, readDraftRecord, resolveDraft, type DraftCopy, type LocalRead } from "@/lib/drafts/merge";
import type { DraftSync } from "@/lib/drafts/status";
import { MAX_SOURCE_BYTES, fitsUtf8 } from "@/lib/judge/submit-schema";
import { saveDraft } from "@/server/actions/drafts";

/**
 * Draft persistence for the workspace — the student's code survives a closed
 * tab, a crashed laptop, a dead battery and a campus wifi drop.
 *
 *   local    IndexedDB, 400 ms after the last keystroke (and on blur / hide).
 *   server   CodeDraft, 3 s after the last keystroke, on editor blur, when
 *            the connection comes back, and by sendBeacon when the page is
 *            hidden or unloaded. Failed saves retry with backoff.
 *
 * On load (and on every language switch) the IndexedDB copy is compared with
 * the server copy (src/lib/drafts/merge.ts): the newer wins, and the other
 * one — if it differs — is offered back through the restore bar. Nothing is
 * overwritten until the student edits, so an un-chosen copy is never lost
 * by merely opening the page.
 */

export interface DraftLanguage {
  key: LanguageKey;
  starter: string;
}

export interface InitialServerDraft {
  language: LanguageKey;
  source: string;
  updatedAt: number;
}

/**
 *   local / server   the other saved copy, which lost to a newer one
 *   previous         what was on screen before a restore or a reset (undo)
 */
export interface RestoreOffer {
  kind: "local" | "server" | "previous";
  /** For "previous": what replaced it. */
  reason?: "restore" | "reset";
  source: string;
  updatedAt: number | null;
}

interface Snapshot {
  language: LanguageKey;
  source: string;
  editedAt: number;
}

/** Edit times before 2020 come from a broken clock or an old record (the server refuses them). */
const MIN_EDIT_TIME_MS = Date.UTC(2020, 0, 1);

function syncable(source: string): boolean {
  return fitsUtf8(source, MAX_SOURCE_BYTES) && !source.includes("\u0000");
}

export function useDrafts({
  problemId,
  slug,
  languages,
  serverDrafts,
  initialLanguage,
}: {
  problemId: string;
  /** Only for migrating Phase 1 localStorage drafts (keyed by slug). */
  slug: string;
  languages: readonly DraftLanguage[];
  serverDrafts: readonly InitialServerDraft[];
  initialLanguage: LanguageKey | null;
}) {
  // Everything below reads its inputs once: router.refresh() re-renders the
  // page with fresh props, and none of that may disturb the open editor.
  const [starters] = useState(() => new Map(languages.map((l) => [l.key, l.starter])));
  const [serverCopies] = useState(
    () => new Map<LanguageKey, DraftCopy>(serverDrafts.map((d) => [d.language, { source: d.source, updatedAt: d.updatedAt }])),
  );
  const starterOf = useCallback((key: LanguageKey) => starters.get(key) ?? "", [starters]);

  const [language, setLanguage] = useState<LanguageKey | null>(initialLanguage);
  const [source, setSourceState] = useState(() =>
    initialLanguage ? (serverCopies.get(initialLanguage)?.source ?? starterOf(initialLanguage)) : "",
  );
  const [offer, setOffer] = useState<RestoreOffer | null>(null);
  const [sync, setSync] = useState<DraftSync>(() => ({
    local: "idle",
    server: initialLanguage && serverCopies.has(initialLanguage) ? "saved" : "idle",
  }));

  /** The truth for the async paths (timers, beacons, IndexedDB callbacks). */
  const live = useRef({
    language: initialLanguage,
    source,
    /** Edit time of what is on screen; null while it is the untouched starter. */
    editedAt: initialLanguage ? (serverCopies.get(initialLanguage)?.updatedAt ?? null) : null,
    /** The student typed since this language was shown. */
    touched: false,
    /** The on-screen code is newer than IndexedDB's copy. */
    localDirty: false,
  });
  const timers = useRef<{ local?: ReturnType<typeof setTimeout>; server?: ReturnType<typeof setTimeout>; retry?: ReturnType<typeof setTimeout> }>({});
  const failures = useRef(0);
  const inFlight = useRef(new Set<LanguageKey>());
  const queued = useRef(new Map<LanguageKey, Snapshot>());
  const resolveToken = useRef(0);
  const lastBeacon = useRef<string | null>(null);

  const setSyncFor = useCallback((key: LanguageKey, patch: Partial<DraftSync>) => {
    if (live.current.language === key) setSync((s) => ({ ...s, ...patch }));
  }, []);

  const capture = useCallback((): Snapshot | null => {
    const l = live.current;
    return l.language && l.editedAt !== null ? { language: l.language, source: l.source, editedAt: l.editedAt } : null;
  }, []);

  // ── Local (IndexedDB) ────────────────────────────────────────────────
  const writeLocal = useCallback(() => {
    clearTimeout(timers.current.local);
    const snap = capture();
    if (!snap || !live.current.localDirty) return;
    live.current.localDirty = false;
    void idbPut(localDraftKey(problemId, snap.language), { source: snap.source, updatedAt: snap.editedAt }).then((ok) => {
      if (ok) clearLegacyDraft(slug, snap.language);
      setSyncFor(snap.language, { local: ok ? "saved" : "unavailable" });
    });
  }, [capture, problemId, slug, setSyncFor]);

  // ── Server (CodeDraft) ───────────────────────────────────────────────
  const writeServer = useCallback(
    async (given?: Snapshot | null): Promise<void> => {
      const snap = given ?? capture();
      if (!snap) return;
      if (snap.language === live.current.language) {
        clearTimeout(timers.current.server);
        clearTimeout(timers.current.retry);
      }
      if (serverCopies.get(snap.language)?.source === snap.source) return;
      if (!syncable(snap.source)) {
        setSyncFor(snap.language, { server: "unsyncable" });
        return;
      }
      if (inFlight.current.has(snap.language)) {
        queued.current.set(snap.language, snap);
        return;
      }
      inFlight.current.add(snap.language);
      let retry = false;
      try {
        const result = await saveDraft({
          problemId,
          language: snap.language,
          source: snap.source,
          clientUpdatedAt: snap.editedAt,
        });
        if (result.ok) {
          failures.current = 0;
          if (result.data.saved) serverCopies.set(snap.language, { source: snap.source, updatedAt: snap.editedAt });
          setSyncFor(snap.language, { server: result.data.saved ? "saved" : "superseded" });
        } else {
          retry = true;
        }
      } catch {
        // Offline, or the server could not be reached.
        retry = true;
      } finally {
        inFlight.current.delete(snap.language);
      }
      if (retry) {
        failures.current += 1;
        setSyncFor(snap.language, { server: "failed" });
        if (snap.language === live.current.language) {
          clearTimeout(timers.current.retry);
          timers.current.retry = setTimeout(() => void writeServer(), serverRetryDelayMs(failures.current));
        }
      }
      const next = queued.current.get(snap.language);
      if (next) {
        queued.current.delete(snap.language);
        void writeServer(next);
      }
    },
    [capture, problemId, serverCopies, setSyncFor],
  );

  /** Page hidden or unloading: a beacon outlives the page; a server action may not. */
  const beacon = useCallback(() => {
    const snap = capture();
    if (!snap || serverCopies.get(snap.language)?.source === snap.source || !syncable(snap.source)) return;
    const key = `${snap.language}:${snap.editedAt}`;
    if (lastBeacon.current === key) return;
    clearTimeout(timers.current.server);
    if (sendDraftBeacon({ problemId, language: snap.language, source: snap.source, clientUpdatedAt: snap.editedAt })) {
      lastBeacon.current = key;
    }
  }, [capture, problemId, serverCopies]);

  // ── Edits ────────────────────────────────────────────────────────────
  /** Apply new code as an edit: new edit time, both saves scheduled. */
  const edit = useCallback(
    (next: string) => {
      const l = live.current;
      if (!l.language) return;
      // Monotonic: an edit is always newer than the copy it started from,
      // even when that copy came from a device whose clock runs ahead.
      l.editedAt = Math.max(Date.now(), (l.editedAt ?? 0) + 1);
      l.source = next;
      l.touched = true;
      l.localDirty = true;
      setSourceState(next);
      clearTimeout(timers.current.local);
      timers.current.local = setTimeout(writeLocal, LOCAL_DEBOUNCE_MS);
      clearTimeout(timers.current.server);
      timers.current.server = setTimeout(() => void writeServer(), SERVER_DEBOUNCE_MS);
    },
    [writeLocal, writeServer],
  );

  const setSource = useCallback(
    (next: string) => {
      if (next !== live.current.source) edit(next);
    },
    [edit],
  );

  /** Save everything now (before Submit / Run, on editor blur). */
  const flush = useCallback(() => {
    writeLocal();
    void writeServer();
  }, [writeLocal, writeServer]);

  // ── Load: compare the device copy with the server copy ──────────────
  const resolveLocal = useCallback(
    async (key: LanguageKey) => {
      const token = ++resolveToken.current;
      const raw = await idbGet(localDraftKey(problemId, key));
      if (token !== resolveToken.current || live.current.language !== key) return;
      let local: LocalRead = raw.ok ? readDraftRecord(raw.value) : null;
      let legacy = false;
      if (local === null) {
        const old = readLegacyDraft(slug, key);
        if (old !== null) {
          local = { source: old, updatedAt: 0 };
          legacy = true;
        }
      }
      if (local === "corrupt") console.warn("[drafts] the saved copy on this device could not be read; it was ignored");
      const starter = starterOf(key);
      const resolution = resolveDraft({ local, server: serverCopies.get(key) ?? null, starter });
      const l = live.current;

      if (l.touched) {
        // The student started typing before the saved copies were read: keep
        // the typing, and offer what would have been loaded.
        if (resolution.origin !== "starter" && resolution.source !== l.source && isWorthOffering(resolution.source, starter)) {
          setOffer({ kind: resolution.origin, source: resolution.source, updatedAt: resolution.updatedAt });
        }
        return;
      }

      if (resolution.source !== l.source) {
        l.source = resolution.source;
        setSourceState(resolution.source);
      }
      l.editedAt = resolution.updatedAt;
      const localMatches = local !== null && local !== "corrupt" && local.source === resolution.source;
      setSync((s) => ({ ...s, local: localMatches ? "saved" : s.local }));
      setOffer(
        resolution.alternative
          ? { kind: resolution.alternative.origin, source: resolution.alternative.source, updatedAt: resolution.alternative.updatedAt }
          : null,
      );
      // A Phase 1 draft (or a record with an impossible edit time): give it a
      // real edit time and store it properly, on this device and the server.
      const restamp = resolution.origin === "local" && (legacy || (resolution.updatedAt ?? 0) < MIN_EDIT_TIME_MS);
      if (restamp) {
        l.editedAt = Date.now();
        l.localDirty = true;
        writeLocal();
      }
      if (resolution.serverBehind || restamp) void writeServer();
    },
    [problemId, slug, serverCopies, starterOf, writeLocal, writeServer],
  );

  const changeLanguage = useCallback(
    (next: LanguageKey) => {
      const l = live.current;
      if (!l.language || next === l.language || !starters.has(next)) return;
      // Save the outgoing language first (both reads happen synchronously).
      writeLocal();
      void writeServer();
      clearTimeout(timers.current.retry);
      rememberLanguage(next);
      const known = serverCopies.get(next);
      const shown = known?.source ?? starterOf(next);
      live.current = { language: next, source: shown, editedAt: known?.updatedAt ?? null, touched: false, localDirty: false };
      setLanguage(next);
      setSourceState(shown);
      setOffer(null);
      setSync({ local: "idle", server: known ? "saved" : "idle" });
      void resolveLocal(next);
    },
    [resolveLocal, serverCopies, starterOf, starters, writeLocal, writeServer],
  );

  // ── Restore bar and reset ───────────────────────────────────────────
  const applyOffer = useCallback(() => {
    if (!offer) return;
    const replaced = { source: live.current.source, updatedAt: live.current.editedAt };
    edit(offer.source);
    setOffer({ kind: "previous", reason: "restore", source: replaced.source, updatedAt: replaced.updatedAt });
  }, [edit, offer]);

  const dismissOffer = useCallback(() => setOffer(null), []);

  const reset = useCallback(() => {
    const l = live.current;
    if (!l.language) return;
    const starter = starterOf(l.language);
    const replaced = { source: l.source, updatedAt: l.editedAt };
    if (replaced.source === starter) return;
    edit(starter);
    setOffer({ kind: "previous", reason: "reset", source: replaced.source, updatedAt: replaced.updatedAt });
  }, [edit, starterOf]);

  // ── Lifecycle ────────────────────────────────────────────────────────
  useEffect(() => {
    if (live.current.language) void resolveLocal(live.current.language);
  }, [resolveLocal]);

  useEffect(() => {
    const onHide = () => {
      writeLocal();
      beacon();
    };
    const onVisibility = () => {
      if (document.visibilityState === "hidden") onHide();
      else {
        // Back from a beacon (whose outcome is unknown): confirm with a normal save.
        clearTimeout(timers.current.server);
        timers.current.server = setTimeout(() => void writeServer(), SERVER_DEBOUNCE_MS);
      }
    };
    const onOnline = () => void writeServer();
    window.addEventListener("pagehide", onHide);
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("online", onOnline);
    const pending = timers.current;
    return () => {
      window.removeEventListener("pagehide", onHide);
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("online", onOnline);
      // Leaving the workspace inside the app: the page lives on, so a normal save completes.
      writeLocal();
      void writeServer();
      clearTimeout(pending.local);
      clearTimeout(pending.server);
      clearTimeout(pending.retry);
    };
  }, [beacon, writeLocal, writeServer]);

  return {
    language,
    source,
    setSource,
    changeLanguage,
    reset,
    flush,
    sync,
    offer,
    applyOffer,
    dismissOffer,
  };
}
