"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  EXAM_HEARTBEAT_INTERVAL_MS,
  IDLE_GAP_MS,
  SNAPSHOT_INTERVAL_MS,
  classifyInsertion,
  classifyPaste,
  isNoiseFocusLoss,
  paletteCounts,
  type ExamHeartbeatResponse,
  type ExamQuestionKind,
  type InvigilatorMessage,
  type ProctorEventBatchResponse,
  type QuestionProgress,
} from "@recx/shared";
import { ExamClock } from "@/components/exam/exam-clock";
import { FocusOverlay } from "@/components/exam/focus-overlay";
import { MonitoredChip } from "@/components/exam/monitored-chip";
import { QuestionPalette } from "@/components/exam/question-palette";
import { ExamConsole } from "@/components/exam/exam-console";
import { ExamMcq } from "@/components/exam/exam-mcq";
import type { ExamMcqView } from "@/server/queries/exam";
import { SaveStatePill, type SaveState } from "@/components/exam/save-state-pill";
import { ExamQuestion } from "@/components/exam/exam-question";
import type { PaperLanguageView } from "@recx/shared";
import type { EditorPrefs } from "@/components/editor/editor-types";
import { ExamBottomBar } from "@/components/exam/exam-bottom-bar";
import { TelemetryQueue } from "@/lib/exam/client/telemetry-queue";
import { displayCount } from "@/lib/exam/client/exam-browser-bridge";
import { clearAttempt, markSynced, putDraft } from "@/lib/exam/client/draft-store";
import { sha256Hex } from "@/lib/exam/client/sha256";

/**
 * The exam session (Phase 6c): the one client that drives the sitting.
 *
 * It owns five loops, and each exists because SPEC §5 names it:
 *
 *   1. the heartbeat, every 10s, which is the ONLY source of the clock;
 *   2. telemetry, flushed on a 5s tick or 25 events and on pagehide;
 *   3. snapshots, every 30s while dirty plus on run and submit;
 *   4. focus and fullscreen, which raise the covering overlay within the same
 *      tick as the loss and lower it only once the server has recorded it;
 *   5. the write-ahead store, which is written BEFORE every network call.
 *
 * What it deliberately does NOT do is block anything. No preventDefault on
 * paste, copy, cut or contextmenu — SPEC §5: "Blocking is both bypassable and
 * counterproductive: students legitimately paste their own earlier code and
 * sample input, blocking drives them to clipboard-typing macros which
 * silences the signal, and preventDefault on contextmenu/copy breaks
 * assistive technology."
 */

/**
 * How many distinct copies a sitting remembers for the paste refusal
 * (Phase 12s). Generous for anybody working normally — a candidate copies
 * a handful of times — and bounded so it cannot grow without limit.
 */
const COPIED_TEXT_MEMORY = 200;

/**
 * How many forged events are worth recording in one sitting (Phase 12s).
 *
 * `AUTOMATION_HINT` is context for a reviewer, and the second one says
 * nothing the first did not. A script that dispatches a paste event in a
 * loop must not turn a context signal into a telemetry flood — the same
 * reason `scriptErrors` stops at three.
 */
const FORGED_EVENT_CAP = 3;

/**
 * One language a sitting may be answered in (Phase 13a).
 *
 * `PaperLanguageView`, re-exported under the name this surface uses. A
 * TYPE import, deliberately: the labels are resolved on the server because
 * calling the catalog's label helpers from a client component puts eleven
 * toolchains' compiler flags in the browser bundle, which the sitting's own
 * size budget caught at 1.2 KB over.
 */
export type ExamLanguageView = PaperLanguageView;

/**
 * Is this one of the languages a question accepts?
 *
 * The QUESTION's list, not the paper's (Phase 13c): a paper may accept
 * C++ and Python while the question about pointers accepts only C++, and
 * the editor, the switch and the routes all have to agree on which list
 * applies.
 */
function accepts(languages: readonly ExamLanguageView[], key: string): boolean {
  return languages.some((language) => language.key === key);
}

/**
 * The language a question OPENS in: the one it was last worked in if the
 * paper still accepts it, else the paper's default.
 *
 * Used by two state initialisers that must agree — the sources and the
 * languages — because seeding the editor with the C++ starter while the
 * picker says Python is the kind of disagreement a candidate discovers by
 * submitting the wrong thing.
 */
function openingLanguage(question: ExamQuestionView, recovered: Readonly<Record<string, string>>): string {
  const was = recovered[question.questionId];
  // Against the QUESTION's list (Phase 13c): a candidate who worked in
  // Python on a question the paper has since narrowed to C must not be
  // put back into a language this question no longer accepts.
  return was !== undefined && accepts(question.languages, was) ? was : question.languageKey;
}

export interface ExamQuestionView {
  readonly questionId: string;
  readonly title: string;
  readonly statementHtml: string;
  readonly points: number;
  readonly samples: ReadonlyArray<{ readonly input: string; readonly output: string }>;
  /**
   * The starter code for every language this paper accepts (Phase 13a),
   * keyed by toolchain key. Switching language mid-sitting swaps the
   * editor to the right one with no request; a problem with no starter in
   * a language gives an empty editor, as the practice workspace does.
   */
  readonly starters: Readonly<Record<string, string>>;
  /**
   * THE TOOLCHAIN KEY — `cpp20`, `c17` — which is what every exam route
   * takes, because each validates against the keys of LANGUAGE_CATALOG.
   *
   * It used to be one field called `language` carrying
   * `LANGUAGE_CATALOG[key].editorLanguage` instead, which is the editor's
   * highlighting mode (`"cpp"`). Two different things under one name, and
   * the wrong one reached the server: every snapshot, every run and every
   * SUBMIT from a sitting was refused as "Malformed", so a candidate could
   * not save and could not hand in — and the editor was the only part of
   * the chain the value was right for, so nothing looked broken until a
   * request was made. Reported from a live sitting (Phase 12r.2).
   */
  readonly languageKey: string;
  /**
   * The languages THIS question accepts (Phase 13c) -- the paper's set,
   * or fewer where the question narrows it ("answer this one in C"). The
   * picker renders this list, and the routes validate against the same
   * one.
   */
  readonly languages: readonly ExamLanguageView[];
  /**
   * Phase 16f. `ANSWER` for an output-only question: the submission IS the
   * answer, so this question gets a box rather than an editor, no language
   * picker and no Run. Frozen in the layout at start, read here.
   */
  readonly kind: ExamQuestionKind;
  /**
   * Phase 16g. A debugging question's edit budget, frozen in the layout.
   * The pane shows the rule and a live count against the starter, so the
   * refusal at hand-in is never the first time a candidate hears it.
   */
  readonly editBudget?: number;
}

export function ExamSession({
  attemptId,
  questions,
  initialMsRemaining,
  initialStatus,
  candidate,
  labSupervised,
  refuseOutsidePaste,
  mcqs,
  initialChoices,
  initialSources,
  initialLanguages,
  editorPrefs,
}: {
  readonly attemptId: string;
  readonly questions: readonly ExamQuestionView[];
  /** The multiple-choice half of the paper (Phase 12r). */
  readonly mcqs: readonly ExamMcqView[];
  /** Answers already recorded for this attempt, by mcqId. */
  readonly initialChoices: Readonly<Record<string, number>>;
  readonly initialMsRemaining: number;
  readonly initialStatus: string;
  readonly candidate: { readonly name: string; readonly section: string | null };
  readonly labSupervised: boolean;
  /**
   * Phase 12s. Refuse a paste into the editor whose text was not copied
   * inside this sitting. The default is false and the engine's standing
   * decision is to instrument rather than block; this is the per-paper
   * option an invigilator may turn on.
   */
  readonly refuseOutsidePaste: boolean;
  /** Recovered from the write-ahead store, newest-wins over the starter code. */
  readonly initialSources: Readonly<Record<string, string>>;
  /**
   * The language each question was last worked in, by questionId (Phase
   * 13a), read from the last snapshot the server holds and clamped to the
   * accepted set. A candidate who wrote Python, closed the laptop and came
   * back -- or moved to another machine -- must come back to Python, not
   * to the paper's default with their Python in a C++ editor.
   */
  readonly initialLanguages: Readonly<Record<string, string>>;

  /** The candidate's font size and tab size; the keymap is the arena's (Phase 12j). */
  readonly editorPrefs: EditorPrefs;
}) {
  const now = () => (typeof performance !== "undefined" ? performance.now() : Date.now());

  const [current, setCurrent] = useState(0);
  const [sources, setSources] = useState<Record<string, string>>(() => {
    const seeded: Record<string, string> = {};
    for (const question of questions) {
      const language = openingLanguage(question, initialLanguages);
      seeded[question.questionId] = initialSources[question.questionId] ?? question.starters[language] ?? "";
    }
    return seeded;
  });
  /**
   * Which language each question is being answered in (Phase 13a).
   *
   * Per question, not per paper: a candidate may reasonably write the
   * string question in Python and the one about pointers in C, and the
   * submit path creates one `Submission` per question anyway so there is
   * nothing to unify.
   */
  const [langs, setLangs] = useState<Record<string, string>>(() => {
    const seeded: Record<string, string> = {};
    for (const question of questions) {
      seeded[question.questionId] = openingLanguage(question, initialLanguages);
    }
    return seeded;
  });
  const [marked, setMarked] = useState<Record<string, boolean>>({});
  const [visited, setVisited] = useState<Record<string, boolean>>(() =>
    questions.length > 0 ? { [questions[0]!.questionId]: true } : mcqs.length > 0 ? { [mcqs[0]!.mcqId]: true } : {},
  );
  /** What this candidate has picked, by mcqId, in the order they were shown. */
  const [choices, setChoices] = useState<Record<string, number>>(() => ({ ...initialChoices }));
  /** When the last paste was refused, for the transient notice (Phase 12s). */
  const [pasteRefusedAt, setPasteRefusedAt] = useState<number | null>(null);

  const [clock, setClock] = useState({ msRemaining: initialMsRemaining, at: now() });
  const [status, setStatus] = useState(initialStatus);
  const [revoked, setRevoked] = useState<string | null>(null);
  /** Phase 12t: this page handed the paper in, as opposed to being refused. */
  const [handedIn, setHandedIn] = useState(false);
  const [save, setSave] = useState<SaveState>({ kind: "saved", secondsAgo: 0 });
  const [overlay, setOverlay] = useState<{ heading: string; body: string; pending: boolean } | null>(null);
  /**
   * What the invigilator has said, and not had acknowledged (Phase 12v).
   *
   * Derived from the heartbeat on every beat rather than accumulated here,
   * so the server stays the record of what is outstanding. `acknowledged`
   * holds the ids this client has answered but not yet seen the server
   * drop, which is what keeps the same message from being shown again on
   * the next beat before the acknowledgement has landed — and what keeps it
   * coming back if the beat carrying it never arrived.
   */
  const [message, setMessage] = useState<InvigilatorMessage | null>(null);
  const acknowledged = useRef<Set<string>>(new Set());

  /**
   * The palette, as ONE numbered list of mixed items (Phase 12r).
   *
   * Programs first, in the order the layout shuffled them, then the
   * multiple-choice questions in the paper's own order. NOT interleaved by
   * authored position, which looks tidier and would quietly undo the thing
   * the layout exists for: the coding questions' order is randomised per
   * candidate, and sorting the merged list by the author's numbering would
   * put them back exactly as written.
   */
  const items = useMemo(
    () => [
      ...questions.map((q) => ({ kind: "code" as const, question: q })),
      ...mcqs.map((m) => ({ kind: "mcq" as const, mcq: m })),
    ],
    [questions, mcqs],
  );
  const item = items[current];
  const question = item?.kind === "code" ? item.question : undefined;
  const questionId = question?.questionId ?? "";
  /** The id a palette entry is keyed by, whichever kind it is. */
  const keyOf = (entry: (typeof items)[number]) => (entry.kind === "code" ? entry.question.questionId : entry.mcq.mcqId);

  // ── Refs for things the loops read without re-subscribing ──────────────
  const queue = useRef<TelemetryQueue | null>(null);
  const copiedHashes = useRef<Set<string>>(new Set());
  /** The same copies as text, for the synchronous refusal (Phase 12s). */
  const copiedTexts = useRef<Set<string>>(new Set());
  /** Phase 11b: the first edit, the last edit, and whether this idle gap was already recorded. */
  const firstKeystrokeAt = useRef<number | null>(null);
  const lastEditAt = useRef<number | null>(null);
  const idleRecorded = useRef(false);
  /** A tight error loop must not become a telemetry flood; three is enough to say "the page is broken". */
  const scriptErrors = useRef(0);
  /** Events the browser did not generate; capped for the same reason. */
  const forgedEvents = useRef(0);
  const sourcesRef = useRef(sources);
  /** The loops read the language the same way they read the source. */
  const langsRef = useRef(langs);
  const questionIdRef = useRef(questionId);
  const dirty = useRef(false);
  const lastSavedAt = useRef(Date.now());
  const startedAt = useRef(Date.now());
  const lastBurst = useRef({ atMs: 0, chars: 0 });

  sourcesRef.current = sources;
  langsRef.current = langs;
  questionIdRef.current = questionId;

  /** Milliseconds into the sitting, as the client believes. Server-clamped. */
  const atMs = useCallback(() => Math.max(0, Date.now() - startedAt.current), []);

  // ── Telemetry ──────────────────────────────────────────────────────────
  useEffect(() => {
    const q = new TelemetryQueue(attemptId, {
      onResponse: (response: ProctorEventBatchResponse) => {
        // The overlay's text and its warning number come from the server, so
        // the number a candidate is shown is the number that was counted.
        if (response.focusWarning) {
          setOverlay((open) =>
            open ? { ...open, body: response.focusWarning!.body, pending: false } : open,
          );
          if (response.focusWarning.action === "AUTOSUBMIT") {
            setStatus("AUTO_SUBMITTED");
            setRevoked("submitted");
          }
        } else {
          // Nothing to wait for: whatever is open may be dismissed.
          setOverlay((open) => (open ? { ...open, pending: false } : open));
        }
      },
      onRevoked: (reason) => setRevoked(reason),
    });
    queue.current = q;
    return () => {
      q.stop();
      queue.current = null;
    };
  }, [attemptId]);

  const record = useCallback(
    (event: Parameters<TelemetryQueue["add"]>[0]) => {
      queue.current?.add(event);
    },
    [],
  );

  // The 5-second flush tick.
  useEffect(() => {
    const id = window.setInterval(() => {
      if (queue.current?.due()) void queue.current.flush();
    }, 1_000);
    return () => window.clearInterval(id);
  }, []);

  // ── The heartbeat: the only clock ──────────────────────────────────────
  useEffect(() => {
    if (revoked) return;
    let cancelled = false;

    const beat = async () => {
      try {
        const response = await fetch(`/api/exam/${attemptId}/hb`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          credentials: "same-origin",
          body: JSON.stringify({
            clientSeq: queue.current?.nextSeq() ?? 0,
            clientNowMs: Date.now(),
            visible: document.visibilityState === "visible",
            // Resent on every beat until the server stops calling them
            // pending: the write is idempotent, and an acknowledgement
            // that was lost with its beat must not be lost for good.
            ...(acknowledged.current.size > 0
              ? { acknowledgedMessageIds: [...acknowledged.current].slice(0, 20) }
              : {}),
          }),
        });
        if (cancelled) return;
        if (!response.ok) return;
        const body = (await response.json()) as ExamHeartbeatResponse;
        setClock({ msRemaining: body.msRemaining, at: now() });
        setStatus(body.status);
        if (body.revokeReason) setRevoked(body.revokeReason);

        // The server has taken these: they are no longer outstanding, so
        // there is nothing left to resend.
        const pending = body.pendingInvigilatorMessages;
        for (const id of [...acknowledged.current]) {
          if (!pending.some((candidate) => candidate.id === id)) acknowledged.current.delete(id);
        }
        setMessage(pending.find((candidate) => !acknowledged.current.has(candidate.id)) ?? null);
      } catch {
        // A dropped beat is a dropped beat; the next one is ten seconds away
        // and the server is the one counting. The save pill reports the
        // connection, so there is nothing to show here.
      }
    };

    void beat();
    const id = window.setInterval(() => void beat(), EXAM_HEARTBEAT_INTERVAL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [attemptId, revoked]);

  /**
   * Running the samples (Phase 12q.5). The run id is what the console
   * streams; `running` is the gap between asking and having one, which is
   * the only moment the button has to lock itself against a second click
   * — after that the route's own in-flight budget refuses one.
   */
  const [runId, setRunId] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [consoleOpen, setConsoleOpen] = useState(false);
  const [runError, setRunError] = useState<string | null>(null);

  // ── Snapshots and the write-ahead store ────────────────────────────────
  const persist = useCallback(
    async (trigger: "TICK" | "RUN" | "SUBMIT" | "PASTE") => {
      const id = questionIdRef.current;
      const source = sourcesRef.current[id];
      if (!id || source === undefined) return;
      // The language THIS question is being answered in (Phase 13a), not
      // the paper's default: the snapshot is the record of the answer, and
      // a record whose language is wrong reconstructs as the wrong program.
      const language = langsRef.current[id] ?? questions.find((q) => q.questionId === id)?.languageKey ?? "cpp20";

      // WRITE AHEAD FIRST. If the network call below fails, the work is
      // already safe and the pill can say so honestly.
      await putDraft({
        attemptId,
        questionId: id,
        language,
        source,
        savedAtMs: Date.now(),
        synced: false,
      });

      setSave({ kind: "saving" });
      try {
        const response = await fetch(`/api/exam/${attemptId}/snapshot`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          credentials: "same-origin",
          body: JSON.stringify({ questionId: id, language, source, trigger, atMs: atMs() }),
        });
        if (response.status === 409) {
          const body = (await response.json().catch(() => ({}))) as { revokeReason?: string };
          setRevoked(body.revokeReason ?? "submitted");
          return;
        }
        /**
         * The route answers, and its answer is read (Phase 12q.5).
         *
         * Two things used to be dropped here. A 200 was rendered as
         * "Saved" whatever the body said — but the route replies
         * `{ stored: false, reason }` for a file over the size limit and
         * for a sitting that has spent its snapshot budget, and "Saved"
         * when nothing was saved is the one thing the pill must never
         * say. And any other non-200 became "check your connection",
         * which sends a candidate to look at their wifi while the real
         * reason sits unread in the response.
         */
        if (!response.ok) {
          const body = (await response.json().catch(() => ({}))) as { error?: string };
          setSave({
            kind: "refused",
            message:
              body.error ??
              (response.status >= 500
                ? "the server could not store it. Keep working; copy your code to be safe."
                : `the server refused it (${response.status}).`),
          });
          return;
        }
        const body = (await response.json().catch(() => ({}))) as {
          stored?: boolean;
          reason?: "unchanged" | "too_large" | "capped" | null;
        };
        if (body.stored === false && body.reason !== "unchanged") {
          // `unchanged` is not a failure: the server already holds this
          // exact text, which is what "Saved" means. The other two are.
          setSave({
            kind: "refused",
            message:
              body.reason === "too_large"
                ? "this answer is too large to store. Shorten it, and copy your code to be safe."
                : "this sitting has reached its snapshot limit. Copy your code to be safe.",
          });
          return;
        }
        await markSynced(attemptId, id, source);
        dirty.current = false;
        lastSavedAt.current = Date.now();
        setSave({ kind: "saved", secondsAgo: 0 });
      } catch {
        // Honest, and distinct: the work IS stored locally, and the pill
        // offers "Copy my code" so it can be rescued into Notepad.
        setSave(navigator.onLine ? { kind: "failed" } : { kind: "offline", retryInSeconds: 10 });
      }
    },
    [attemptId, atMs, questions],
  );

  /**
   * Run this answer against the question's samples.
   *
   * The route snapshots with `trigger: "RUN"` before it queues anything —
   * the trigger the snapshot API has accepted since Phase 6c and that
   * nothing ever sent, because until now there was no Run to send it from.
   * So the timeline a reviewer reads shows what was in the editor when it
   * was run, and the work is stored before the judge is involved.
   */
  const runSamples = useCallback(async () => {
    const id = questionIdRef.current;
    const source = sourcesRef.current[id];
    if (!id || source === undefined || source.trim() === "") return;
    const language = langsRef.current[id] ?? questions.find((q) => q.questionId === id)?.languageKey ?? "cpp20";
    setRunning(true);
    setConsoleOpen(true);
    try {
      const response = await fetch(`/api/exam/${attemptId}/run`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ questionId: id, language, source, atMs: atMs() }),
      });
      if (response.status === 409) {
        const body = (await response.json().catch(() => ({}))) as { revokeReason?: string };
        if (body.revokeReason) {
          setRevoked(body.revokeReason);
          return;
        }
      }
      const body = (await response.json().catch(() => ({}))) as { runId?: string; error?: string };
      if (!response.ok || !body.runId) {
        // The route's own sentence, not a guess: it refuses for reasons a
        // candidate can act on (a run already going, no samples, the
        // wrong language), and inventing one would send them looking in
        // the wrong place.
        setRunError(body.error ?? "That run could not be started.");
        return;
      }
      setRunError(null);
      setRunId(body.runId);
      // A run IS a save, as far as the pill is concerned: the route wrote
      // the snapshot before it queued anything.
      await markSynced(attemptId, id, source);
      dirty.current = false;
      lastSavedAt.current = Date.now();
      setSave({ kind: "saved", secondsAgo: 0 });
    } catch {
      setRunError("That run could not be started. Check your connection.");
    } finally {
      setRunning(false);
    }
  }, [attemptId, atMs, questions]);

  /**
   * Record one multiple-choice answer (Phase 12r).
   *
   * Written through at once rather than on Save and next: ticking a box is
   * the whole of answering an MCQ, and a candidate who picks an option and
   * then loses the network should not also lose the pick. The pill reports
   * it like any other save, because to a candidate it is one.
   */
  const choose = useCallback(
    async (mcqId: string, index: number) => {
      setChoices((picked) => ({ ...picked, [mcqId]: index }));
      setSave({ kind: "saving" });
      try {
        const response = await fetch(`/api/exam/${attemptId}/mcq`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          credentials: "same-origin",
          body: JSON.stringify({ mcqId, chosenIndex: index }),
        });
        if (response.status === 409) {
          const body = (await response.json().catch(() => ({}))) as { revokeReason?: string };
          if (body.revokeReason) {
            setRevoked(body.revokeReason);
            return;
          }
        }
        if (!response.ok) {
          const body = (await response.json().catch(() => ({}))) as { error?: string };
          setSave({ kind: "refused", message: body.error ?? `the server refused it (${response.status}).` });
          return;
        }
        lastSavedAt.current = Date.now();
        setSave({ kind: "saved", secondsAgo: 0 });
      } catch {
        setSave(navigator.onLine ? { kind: "failed" } : { kind: "offline", retryInSeconds: 10 });
      }
    },
    [attemptId],
  );

  /** The refusal notice is a moment's explanation, not a banner. */
  useEffect(() => {
    if (pasteRefusedAt === null) return;
    const id = window.setTimeout(() => setPasteRefusedAt(null), 6_000);
    return () => window.clearTimeout(id);
  }, [pasteRefusedAt]);

  // The 30-second tick while dirty, and the "Saved · Ns ago" counter.
  useEffect(() => {
    const id = window.setInterval(() => {
      setSave((state) =>
        state.kind === "saved"
          ? { kind: "saved", secondsAgo: Math.round((Date.now() - lastSavedAt.current) / 1000) }
          : state,
      );
      if (dirty.current && Date.now() - lastSavedAt.current >= SNAPSHOT_INTERVAL_MS) void persist("TICK");

      /**
       * One IDLE_GAP per gap, recorded when the gap becomes notable rather
       * than when editing resumes: a candidate who stops for the last forty
       * minutes of a sitting never resumes, and that is precisely the gap a
       * reviewer wants to see.
       */
      const idleSince = lastEditAt.current;
      if (idleSince !== null && !idleRecorded.current && Date.now() - idleSince >= IDLE_GAP_MS) {
        idleRecorded.current = true;
        record({ kind: "IDLE_GAP", atMs: atMs(), durationMs: IDLE_GAP_MS });
      }
    }, 1_000);
    return () => window.clearInterval(id);
  }, [persist, record, atMs]);

  // ── Focus, visibility and fullscreen ───────────────────────────────────
  useEffect(() => {
    if (revoked) return;
    let lostAt: number | null = null;

    /** Raise the overlay NOW; the server decides when it may come down. */
    const cover = (heading: string) => {
      setOverlay({
        heading,
        body: "Return to full screen to continue. Your timer is still running.",
        pending: true,
      });
    };

    const onHidden = () => {
      if (lostAt !== null) return;
      lostAt = Date.now();
      cover("You left the exam window");
    };

    const onVisible = () => {
      if (lostAt === null) return;
      const durationMs = Date.now() - lostAt;
      lostAt = null;
      // Under 1.5s is UI noise — an OS notification, a Bluetooth reconnect —
      // so it is neither recorded nor counted, and the overlay just goes.
      if (isNoiseFocusLoss(durationMs)) {
        setOverlay(null);
        return;
      }
      record({ kind: "FOCUS_LOSS", atMs: atMs(), durationMs });
      // Flush at once: the overlay stays non-dismissible until the server
      // answers, which is what "written before the overlay becomes
      // dismissible" means in practice.
      void queue.current?.flush();
    };

    const onVisibility = () => {
      if (document.visibilityState === "hidden") onHidden();
      else onVisible();
    };

    const onFullscreenChange = () => {
      if (document.fullscreenElement === null) {
        record({ kind: "FULLSCREEN_EXIT", atMs: atMs() });
        cover("You left full screen");
        void queue.current?.flush();
      }
    };

    const onResize = () => record({ kind: "WINDOW_RESIZE", atMs: atMs() });

    window.addEventListener("blur", onHidden);
    window.addEventListener("focus", onVisible);
    document.addEventListener("visibilitychange", onVisibility);
    document.addEventListener("fullscreenchange", onFullscreenChange);
    window.addEventListener("resize", onResize);
    return () => {
      window.removeEventListener("blur", onHidden);
      window.removeEventListener("focus", onVisible);
      document.removeEventListener("visibilitychange", onVisibility);
      document.removeEventListener("fullscreenchange", onFullscreenChange);
      window.removeEventListener("resize", onResize);
    };
  }, [record, atMs, revoked]);

  // Clipboard: instrumented, never blocked.
  useEffect(() => {
    if (revoked) return;

    /**
     * An event the browser did not generate (Phase 12s).
     *
     * `isTrusted` is false for any event produced by `dispatchEvent`, and
     * true for every event a person causes — including through a screen
     * reader, a switch device or an on-screen keyboard, because those act
     * through the browser rather than around it. So this is not a guess
     * about software: it is the platform saying which of the two happened.
     *
     * It is the honest half of the extension question (docs/PROCTORING.md
     * §9). A page cannot enumerate extensions and should not try; what it
     * can notice is a clipboard or key event that arrived without a person
     * behind it. `AUTOMATION_HINT` is the right kind for it — the same kind
     * `navigator.webdriver` records — and SPEC §5 makes that kind
     * context-only and structurally unable to lift an attempt above NONE on
     * its own, which is exactly the weight this deserves: a reviewer reads
     * it beside the timeline, and nobody is flagged by it.
     *
     * Nothing is blocked on it. A dispatched paste event inserts nothing by
     * itself anyway — the script doing the dispatching has to insert the
     * text some other way, and that route arrives as PROGRAMMATIC_INSERT
     * and SNAPSHOT_JUMP, the second of which is derived on the server from
     * the snapshots and so does not depend on this page at all.
     */
    const noteIfForged = (event: Event) => {
      if (event.isTrusted) return;
      if (forgedEvents.current >= FORGED_EVENT_CAP) return;
      forgedEvents.current += 1;
      record({ kind: "AUTOMATION_HINT", atMs: atMs() });
    };

    const onCopyOrCut = (event: ClipboardEvent, kind: "COPY" | "CUT") => {
      noteIfForged(event);
      const text = window.getSelection()?.toString() ?? "";
      if (text === "") return;
      /**
       * The text itself, for the SYNCHRONOUS decision a refusal needs
       * (Phase 12s): `preventDefault` is only honoured inside the paste
       * event's own tick, and hashing through WebCrypto is a promise. It
       * never leaves the browser — docs/PROCTORING.md §5 forbids clipboard
       * content capture, and this is the same in-memory status the editor's
       * own buffer has. Bounded, so a sitting that copies all afternoon
       * cannot grow it without limit.
       */
      copiedTexts.current.add(text);
      if (copiedTexts.current.size > COPIED_TEXT_MEMORY) {
        const oldest = copiedTexts.current.values().next().value;
        if (oldest !== undefined) copiedTexts.current.delete(oldest);
      }
      void sha256Hex(text).then((hash) => {
        // The hash joins the internal set, so pasting it back reads as
        // INTERNAL_PASTE rather than as text from outside.
        if (hash) copiedHashes.current.add(hash);
        record({ kind, atMs: atMs(), size: new TextEncoder().encode(text).length, ...(hash ? { hash } : {}) });
      });
    };

    const onCopy = (event: ClipboardEvent) => onCopyOrCut(event, "COPY");
    const onCut = (event: ClipboardEvent) => onCopyOrCut(event, "CUT");

    const onPaste = (event: ClipboardEvent) => {
      noteIfForged(event);
      const text = event.clipboardData?.getData("text") ?? "";
      if (text === "") return;
      const size = new TextEncoder().encode(text).length;
      /**
       * Phase 12s, and only when the paper asked for it.
       *
       * The classification is already done below from `copiedHashes`, the
       * set of hashes of everything copied inside this sitting — so
       * "only what was copied inside" is a rule the client can already
       * evaluate. What this adds is refusing the rest, and it is shaped
       * to keep all three of SPEC §5's objections answered:
       *
       *   - a paste of the candidate's OWN earlier work still goes
       *     through, which is the case §5 was protecting;
       *   - the refusal is still RECORDED as EXTERNAL_PASTE with its
       *     size, so the signal is not silenced — which was the
       *     substantive objection, since a candidate who then reaches for
       *     a clipboard-typing macro shows up as CADENCE_BURST and
       *     SNAPSHOT_JUMP anyway;
       *   - only a paste INTO THE EDITOR is prevented. Copy, cut and the
       *     context menu are untouched here and everywhere, so assistive
       *     technology keeps working.
       *
       * Synchronously, before the hash resolves, because preventDefault
       * is only honoured within the event's own tick: the decision is
       * made from the synchronous set and the event is recorded after.
       */
      const target = event.target;
      const insideEditor =
        target instanceof Element ? target.closest("[data-editor-root]") !== null : false;
      if (refuseOutsidePaste && insideEditor && !copiedTexts.current.has(text)) {
        /**
         * Both of these, and the second one is why this listener is
         * registered in the CAPTURE phase (Phase 12t).
         *
         * `preventDefault` alone stops the browser's own insertion, and
         * that was not enough: Monaco and CodeMirror each handle `paste` on
         * their own hidden textarea and insert the text themselves. A
         * listener on `document` in the bubble phase runs AFTER the
         * editor's, so the refusal notice appeared and the text landed
         * anyway — a refusal in name only, which is worse than no refusal
         * because an invigilator chose it believing it did something.
         * Capture runs this first; `stopPropagation` then keeps the
         * editor's own handler from ever seeing the event.
         *
         * Only on the refusal path. An allowed paste is not touched at all,
         * so the editor handles it exactly as it always did.
         */
        event.preventDefault();
        event.stopPropagation();
        setPasteRefusedAt(Date.now());
      }
      void sha256Hex(text).then((hash) => {
        const kind =
          hash === null
            ? "EXTERNAL_PASTE"
            : classifyPaste({ hash, internalHashes: copiedHashes.current });
        /**
         * No "refused" field, and not for want of wanting one: the wire
         * schema is `.strict()` precisely so nothing can be added to it
         * ("an attempt to add one is rejected rather than ignored"), and a
         * batch carrying an unknown key is refused WHOLE — every event in
         * it lost. A reviewer does not need it anyway: the event is an
         * EXTERNAL_PASTE and the paper's `refuseOutsidePaste` says what
         * happened to every one of them.
         */
        record({ kind, atMs: atMs(), size, ...(hash ? { hash } : {}) });
        void queue.current?.flush();
        // A paste is worth a snapshot: it is the moment the timeline most
        // needs a point in it.
        void persist("PASTE");
      });
    };

    const onContextMenu = () => record({ kind: "CONTEXT_MENU", atMs: atMs() });

    document.addEventListener("copy", onCopy);
    document.addEventListener("cut", onCut);
    // Capture, so a refusal lands before the editor's own paste handler;
    // see the comment on the refusal above.
    document.addEventListener("paste", onPaste, true);
    document.addEventListener("contextmenu", onContextMenu);
    return () => {
      document.removeEventListener("copy", onCopy);
      document.removeEventListener("cut", onCut);
      document.removeEventListener("paste", onPaste, true);
      document.removeEventListener("contextmenu", onContextMenu);
    };
  }, [record, atMs, persist, revoked, refuseOutsidePaste]);

  // Environment hints, recorded once at start.
  useEffect(() => {
    if (revoked) return;
    if (navigator.webdriver) record({ kind: "AUTOMATION_HINT", atMs: 0 });

    /**
     * Displays, from the best source available (Phase 14d).
     *
     * `screen.isExtended` is what a web page has, and PROCTORING.md §2 is
     * blunt about it: Chromium-only, absent for reasons that mean nothing,
     * and falsified by a content script that runs before any page script.
     * It stays as the fallback because most sittings are in an ordinary
     * browser and an unreliable hint is still worth a line a reviewer can
     * discount.
     *
     * Inside REC Exam Browser the question is asked of the operating
     * system instead, which is one of the few things the application
     * genuinely knows that a page does not. Same signal either way --
     * MULTI_MONITOR means more than one screen, and PROCTORING.md §3 means
     * it is a line a reviewer reads and never a refusal.
     */
    let cancelled = false;
    void displayCount().then((count) => {
      if (cancelled) return;
      if (count !== null) {
        if (count > 1) record({ kind: "MULTI_MONITOR", atMs: 0 });
        return;
      }
      const screenWithExtended = screen as Screen & { isExtended?: boolean };
      if (screenWithExtended.isExtended === true) record({ kind: "MULTI_MONITOR", atMs: 0 });
    });
    return () => {
      cancelled = true;
    };
  }, [record, revoked]);

  /**
   * Phase 11b: the network and the page itself.
   *
   * Both are context for the candidate's benefit as much as the
   * reviewer's. A sitting that lost the network for four minutes explains a
   * heartbeat gap the server will otherwise record against them, and a
   * script error explains work that went missing — the reviewer sees that
   * the page broke rather than that the candidate did something.
   *
   * Neither carries any text: the event is the fact, and the message of a
   * script error stays in the browser.
   */
  useEffect(() => {
    if (revoked) return;

    const onOffline = () => record({ kind: "NETWORK_DROP", atMs: atMs() });
    const onError = () => {
      if (scriptErrors.current >= 3) return;
      scriptErrors.current += 1;
      record({ kind: "CLIENT_SCRIPT_ERROR", atMs: atMs() });
    };

    window.addEventListener("offline", onOffline);
    window.addEventListener("error", onError);
    window.addEventListener("unhandledrejection", onError);
    return () => {
      window.removeEventListener("offline", onOffline);
      window.removeEventListener("error", onError);
      window.removeEventListener("unhandledrejection", onError);
    };
  }, [record, atMs, revoked]);

  // The last flush, as the page goes away.
  useEffect(() => {
    const onHide = () => {
      queue.current?.flushOnHide();
      if (dirty.current) void persist("TICK");
    };
    window.addEventListener("pagehide", onHide);
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "hidden") onHide();
    });
    return () => window.removeEventListener("pagehide", onHide);
  }, [persist]);

  // A finished sitting leaves nothing behind on a shared lab machine.
  useEffect(() => {
    if (revoked === "submitted" || revoked === "expired") void clearAttempt(attemptId);
  }, [revoked, attemptId]);

  // ── Editing ────────────────────────────────────────────────────────────
  const onSourceChange = useCallback(
    (next: string) => {
      setSources((previous) => ({ ...previous, [questionIdRef.current]: next }));
      dirty.current = true;

      /**
       * Phase 11b. FIRST_KEYSTROKE and IDLE_GAP were in the vocabulary from
       * Phase 4 and emitted by nothing, so a reviewer could not see the two
       * plainest facts about a sitting: when the candidate started, and
       * whether they stopped. Both are INFO and neither can move a band.
       */
      const at = atMs();
      if (firstKeystrokeAt.current === null) {
        firstKeystrokeAt.current = at;
        record({ kind: "FIRST_KEYSTROKE", atMs: at });
      }
      lastEditAt.current = Date.now();
      idleRecorded.current = false;
    },
    [atMs, record],
  );

  /** CodeMirror's own account of where an insertion came from. */
  const onInsertion = useCallback(
    (change: { chars: number; origin: string | null }) => {
      const at = atMs();
      // A burst is "this much, this fast": the window is the gap since the
      // previous insertion, which is what a macro compresses and a person
      // cannot.
      const windowMs = Math.max(1, at - lastBurst.current.atMs);
      lastBurst.current = { atMs: at, chars: change.chars };
      const kind = classifyInsertion({
        chars: change.chars,
        origin: change.origin as never,
        windowMs,
      });
      if (kind === null) return;
      record({ kind, atMs: at, chars: change.chars, windowMs });
    },
    [atMs, record],
  );

  // ── Navigation ─────────────────────────────────────────────────────────
  const goTo = useCallback(
    (index: number) => {
      const target = items[index];
      if (!target) return;
      // A question change saves immediately (SPEC §5), before the editor's
      // text is replaced by the next question's.
      if (dirty.current) void persist("TICK");
      setCurrent(index);
      setVisited((seen) => ({ ...seen, [keyOf(target)]: true }));
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyOf is pure over `items`.
    [items, persist],
  );

  /**
   * Change the language this question is answered in (Phase 13a).
   *
   * The decision that matters is what happens to what is already in the
   * editor, and the rule is: NOTHING, unless it is still the starter.
   *
   * A candidate twenty minutes into a C++ answer who opens the dropdown to
   * read what else is offered, and picks something by accident, must not
   * lose twenty minutes of work — so their text is left exactly as it is,
   * the picker moves, and picking the old language back changes nothing at
   * all. Only an editor still holding the starter (or nothing) is swapped
   * to the new language's starter, which is the case where keeping the
   * text would be the unhelpful answer: a Python candidate staring at
   * `#include <iostream>`.
   *
   * It is persisted at once rather than waiting for the 30-second tick,
   * because the language is now part of what the answer IS: a sitting that
   * crashed between the switch and the next tick would come back in the
   * old language, with the new language's code in the editor.
   */
  const changeLanguage = useCallback(
    (next: string) => {
      const id = questionIdRef.current;
      const question = questions.find((q) => q.questionId === id);
      // The QUESTION's list, so a narrowed question cannot be switched
      // into a language the paper allows elsewhere (Phase 13c).
      if (!question || !accepts(question.languages, next)) return;
      const from = langsRef.current[id] ?? question.languageKey;
      if (from === next) return;

      const current = sourcesRef.current[id] ?? "";
      const untouched = current.trim() === "" || current.trim() === (question.starters[from] ?? "").trim();
      langsRef.current = { ...langsRef.current, [id]: next };
      setLangs((previous) => ({ ...previous, [id]: next }));
      if (untouched) {
        const starter = question.starters[next] ?? "";
        sourcesRef.current = { ...sourcesRef.current, [id]: starter };
        setSources((previous) => ({ ...previous, [id]: starter }));
      }
      dirty.current = true;
      void persist("TICK");
    },
    [persist, questions],
  );

  const progress = useMemo<QuestionProgress[]>(
    () =>
      items.map((entry) =>
        entry.kind === "code"
          ? {
              visited: visited[entry.question.questionId] === true,
              // Answered means "there is work here": anything beyond the starter.
              /**
               * Answered means "there is work here": anything beyond the
               * starter OF THE LANGUAGE THIS QUESTION IS IN (Phase 13a).
               * Measured against the paper's default starter instead, a
               * candidate who switched to Python and had not typed yet
               * would see the question marked answered.
               */
              answered:
                (sources[entry.question.questionId] ?? "").trim() !==
                (
                  entry.question.starters[langs[entry.question.questionId] ?? entry.question.languageKey] ?? ""
                ).trim(),
              marked: marked[entry.question.questionId] === true,
            }
          : {
              visited: visited[entry.mcq.mcqId] === true,
              // For an MCQ there is no "beyond the starter": an option is
              // picked or it is not.
              answered: choices[entry.mcq.mcqId] !== undefined,
              marked: marked[entry.mcq.mcqId] === true,
            },
      ),
    [items, visited, sources, langs, marked, choices],
  );

  const counts = paletteCounts(progress);

  const submit = useCallback(async () => {
    // Every answer at once, so the server snapshots and creates submissions
    // in one pass and the attempt closes last (lib/exam/submit.ts).
    const answers = questions.map((q) => ({
      questionId: q.questionId,
      // Each question's own language (Phase 13a). The submit path creates
      // one Submission per question and judges each with the toolchain
      // named here, so a paper answered half in Python and half in C is
      // judged that way.
      language: langsRef.current[q.questionId] ?? q.languageKey,
      source: sourcesRef.current[q.questionId] ?? "",
    }));
    setSave({ kind: "saving" });
    try {
      const response = await fetch(`/api/exam/${attemptId}/submit`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ answers }),
      });
      if (response.status === 409) {
        setStatus("SUBMITTED");
        setRevoked("submitted");
        return;
      }
      if (!response.ok) throw new Error(String(response.status));
      setStatus("SUBMITTED");
      setHandedIn(true);
      setRevoked("submitted");
    } catch {
      // The sitting is NOT closed, so the candidate can try again — and
      // their work is in the write-ahead store either way.
      setSave({ kind: "failed" });
    }
  }, [attemptId, questions]);

  /**
   * Acknowledge the invigilator's message (Phase 12v).
   *
   * Taken off the screen at once — the candidate has read it and said so,
   * and making them wait for a round trip in the middle of an exam would be
   * the wrong trade. The id goes into the set the next beat carries, and
   * the server records the time.
   */
  const acknowledgeMessage = useCallback((id: string) => {
    acknowledged.current.add(id);
    setMessage(null);
  }, []);

  const copyMyCode = useCallback(() => {
    const text = sourcesRef.current[questionIdRef.current] ?? "";
    void navigator.clipboard?.writeText(text).catch(() => undefined);
  }, []);

  /**
   * A paper with nothing on it (Phase 6c), and the day that guard ate a
   * sitting (Phase 12t).
   *
   * It used to read `if (!question)`, which was exactly right when a paper
   * held coding questions and nothing else: no current question meant no
   * questions. Phase 12r merged multiple-choice questions into the same
   * palette, and from that moment `question` was undefined whenever the
   * CURRENT item was a multiple-choice question — so the first time a
   * candidate clicked one, the whole sitting was replaced by "This paper
   * has no questions. Tell your invigilator.": no palette, no clock, no
   * editor, no way back, mid-exam. On an all-multiple-choice paper it fired
   * on the first render.
   *
   * The condition is now the thing it was always meant to say. Found by the
   * exam journey (`e2e/exam-journey.spec.ts`), on its first run, which is
   * the fifth place this blind spot has been found and the first one that
   * cost a candidate their whole screen.
   */
  if (items.length === 0) {
    return (
      <main className="p-8">
        <p className="text-sm text-text-secondary">This paper has no questions. Tell your invigilator.</p>
      </main>
    );
  }

  return (
    <div className="flex h-dvh flex-col">
      {/* 56px glass top bar (SPEC §5). */}
      <header className="flex h-14 shrink-0 items-center gap-4 border-b border-border bg-elevated/80 px-4 backdrop-blur">
        <div className="min-w-0">
          <p className="truncate text-sm font-medium text-text">{candidate.name}</p>
          {candidate.section ? <p className="truncate text-xs text-text-secondary">{candidate.section}</p> : null}
        </div>
        <p className="ml-2 text-sm tabular-nums text-text-secondary">
          Question {current + 1} of {items.length}
        </p>
        <div className="ml-auto flex items-center gap-3">
          <ExamClock serverMsRemaining={clock.msRemaining} receivedAtMs={clock.at} />
          <SaveStatePill state={save} onCopyCode={copyMyCode} />
          <MonitoredChip labSupervised={labSupervised} />
        </div>
      </header>

      <div className="flex min-h-0 flex-1">
        <QuestionPalette progress={progress} current={current} onSelect={goTo} />
        {item?.kind === "mcq" ? (
          <ExamMcq
            mcq={item.mcq}
            chosen={choices[item.mcq.mcqId] ?? null}
            onChoose={(index) => void choose(item.mcq.mcqId, index)}
            position={current + 1}
            total={items.length}
          />
        ) : question ? (
          <ExamQuestion
            question={question}
            source={sources[question.questionId] ?? ""}
            onSourceChange={onSourceChange}
            onInsertion={onInsertion}
            position={current + 1}
            total={items.length}
            prefs={editorPrefs}
            languages={question.languages}
            language={langs[question.questionId] ?? question.languageKey}
            onLanguageChange={changeLanguage}
          />
        ) : null}
      </div>

      {item?.kind === "code" && question && question.samples.length > 0 ? (
        <ExamConsole
          runId={runId}
          sending={running}
          sampleCount={question.samples.length}
          open={consoleOpen}
          onToggle={() => setConsoleOpen((was) => !was)}
          error={runError}
        />
      ) : null}

      {/**
        * The refusal, said once and briefly. A candidate who meant to
        * paste their own earlier work needs to know why nothing appeared,
        * and a candidate who meant to paste from elsewhere has been told
        * the rule rather than left guessing.
        */}
      {pasteRefusedAt !== null ? (
        <p
          role="status"
          aria-live="polite"
          className="shrink-0 border-t border-warning/40 bg-warning-subtle px-4 py-2 text-sm text-warning"
        >
          That paste was not copied inside this sitting, so it was not inserted. Your own earlier work still pastes
          normally. The attempt has been recorded.
        </p>
      ) : null}

      <ExamBottomBar
        canGoPrevious={current > 0}
        onPrevious={() => goTo(current - 1)}
        onMarkAndNext={() => {
          if (item) setMarked((flags) => ({ ...flags, [keyOf(item)]: true }));
          goTo(Math.min(current + 1, items.length - 1));
        }}
        /**
         * Clear belongs to an editor. An MCQ has nothing to clear — and
         * deliberately offers no "unpick": a blank and a wrong answer
         * score the same, and an endpoint that removes recorded work is a
         * bigger risk than the convenience is worth.
         */
        onClear={
          question
            ? () => {
                setSources((previous) => ({
                  ...previous,
                  [question.questionId]: question.starters[langs[question.questionId] ?? question.languageKey] ?? "",
                }));
                dirty.current = true;
              }
            : undefined
        }
        onSaveAndNext={() => {
          // An MCQ was already written through when it was picked, so Save
          // and next is just "next" for one.
          if (item?.kind === "code") void persist("TICK");
          goTo(Math.min(current + 1, items.length - 1));
        }}
        /*
          Phase 16f: and not on an output-only question, which has no
          program to run and whose Run would queue a job no node could
          serve. The route refuses it too.
        */
        onRun={
          item?.kind === "code" && question && question.kind !== "ANSWER" && question.samples.length > 0
            ? () => void runSamples()
            : undefined
        }
        running={running}
        onSubmit={() => void submit()}
        answered={counts.answered}
        total={counts.total}
        status={status}
        revoked={revoked}
        handedIn={handedIn}
      />

      <FocusOverlay
        open={overlay !== null && revoked === null}
        heading={overlay?.heading ?? ""}
        body={overlay?.body ?? ""}
        pending={overlay?.pending ?? false}
        onDismiss={() => {
          setOverlay(null);
          // Re-entering fullscreen is the candidate's own action; a
          // programmatic request without a user gesture would be refused.
          void document.documentElement.requestFullscreen?.().catch(() => undefined);
        }}
      />
      {/*
        The invigilator's own words, in the same dialog and for the same
        reason (Phase 12v): it is the one message in a sitting that must not
        be missable, and the desk told the invigilator the candidate "must
        acknowledge it before continuing". Only shown when the focus warning
        is not, because two modal dialogs at once is nobody's design.
      */}
      <FocusOverlay
        open={message !== null && overlay === null && revoked === null}
        heading="A message from your invigilator"
        body={message?.body ?? ""}
        pending={false}
        actionLabel="I have read this"
        onDismiss={() => {
          if (message) acknowledgeMessage(message.id);
        }}
      />
    </div>
  );
}
