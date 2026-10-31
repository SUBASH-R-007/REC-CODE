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
  type ProctorEventBatchResponse,
  type QuestionProgress,
} from "@recx/shared";
import { ExamClock } from "@/components/exam/exam-clock";
import { FocusOverlay } from "@/components/exam/focus-overlay";
import { MonitoredChip } from "@/components/exam/monitored-chip";
import { QuestionPalette } from "@/components/exam/question-palette";
import { SaveStatePill, type SaveState } from "@/components/exam/save-state-pill";
import { ExamQuestion } from "@/components/exam/exam-question";
import type { EditorPrefs } from "@/components/editor/editor-types";
import { ExamBottomBar } from "@/components/exam/exam-bottom-bar";
import { TelemetryQueue } from "@/lib/exam/client/telemetry-queue";
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

export interface ExamQuestionView {
  readonly questionId: string;
  readonly title: string;
  readonly statementHtml: string;
  readonly points: number;
  readonly samples: ReadonlyArray<{ readonly input: string; readonly output: string }>;
  readonly starter: string;
  readonly language: string;
}

export function ExamSession({
  attemptId,
  questions,
  initialMsRemaining,
  initialStatus,
  candidate,
  labSupervised,
  initialSources,
  editorPrefs,
}: {
  readonly attemptId: string;
  readonly questions: readonly ExamQuestionView[];
  readonly initialMsRemaining: number;
  readonly initialStatus: string;
  readonly candidate: { readonly name: string; readonly section: string | null };
  readonly labSupervised: boolean;
  /** Recovered from the write-ahead store, newest-wins over the starter code. */
  readonly initialSources: Readonly<Record<string, string>>;
  /** The candidate's font size and tab size; the keymap is the arena's (Phase 12j). */
  readonly editorPrefs: EditorPrefs;
}) {
  const now = () => (typeof performance !== "undefined" ? performance.now() : Date.now());

  const [current, setCurrent] = useState(0);
  const [sources, setSources] = useState<Record<string, string>>(() => {
    const seeded: Record<string, string> = {};
    for (const question of questions) {
      seeded[question.questionId] = initialSources[question.questionId] ?? question.starter;
    }
    return seeded;
  });
  const [marked, setMarked] = useState<Record<string, boolean>>({});
  const [visited, setVisited] = useState<Record<string, boolean>>(() =>
    questions.length > 0 ? { [questions[0]!.questionId]: true } : {},
  );

  const [clock, setClock] = useState({ msRemaining: initialMsRemaining, at: now() });
  const [status, setStatus] = useState(initialStatus);
  const [revoked, setRevoked] = useState<string | null>(null);
  const [save, setSave] = useState<SaveState>({ kind: "saved", secondsAgo: 0 });
  const [overlay, setOverlay] = useState<{ heading: string; body: string; pending: boolean } | null>(null);

  const question = questions[current];
  const questionId = question?.questionId ?? "";

  // ── Refs for things the loops read without re-subscribing ──────────────
  const queue = useRef<TelemetryQueue | null>(null);
  const copiedHashes = useRef<Set<string>>(new Set());
  /** Phase 11b: the first edit, the last edit, and whether this idle gap was already recorded. */
  const firstKeystrokeAt = useRef<number | null>(null);
  const lastEditAt = useRef<number | null>(null);
  const idleRecorded = useRef(false);
  /** A tight error loop must not become a telemetry flood; three is enough to say "the page is broken". */
  const scriptErrors = useRef(0);
  const sourcesRef = useRef(sources);
  const questionIdRef = useRef(questionId);
  const dirty = useRef(false);
  const lastSavedAt = useRef(Date.now());
  const startedAt = useRef(Date.now());
  const lastBurst = useRef({ atMs: 0, chars: 0 });

  sourcesRef.current = sources;
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
          }),
        });
        if (cancelled) return;
        if (!response.ok) return;
        const body = (await response.json()) as ExamHeartbeatResponse;
        setClock({ msRemaining: body.msRemaining, at: now() });
        setStatus(body.status);
        if (body.revokeReason) setRevoked(body.revokeReason);
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

  // ── Snapshots and the write-ahead store ────────────────────────────────
  const persist = useCallback(
    async (trigger: "TICK" | "RUN" | "SUBMIT" | "PASTE") => {
      const id = questionIdRef.current;
      const source = sourcesRef.current[id];
      if (!id || source === undefined) return;
      const language = questions.find((candidate) => candidate.questionId === id)?.language ?? "cpp20";

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
        if (!response.ok) throw new Error(String(response.status));
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

    const onCopyOrCut = (event: ClipboardEvent, kind: "COPY" | "CUT") => {
      const text = window.getSelection()?.toString() ?? "";
      if (text === "") return;
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
      const text = event.clipboardData?.getData("text") ?? "";
      if (text === "") return;
      const size = new TextEncoder().encode(text).length;
      void sha256Hex(text).then((hash) => {
        const kind =
          hash === null
            ? "EXTERNAL_PASTE"
            : classifyPaste({ hash, internalHashes: copiedHashes.current });
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
    document.addEventListener("paste", onPaste);
    document.addEventListener("contextmenu", onContextMenu);
    return () => {
      document.removeEventListener("copy", onCopy);
      document.removeEventListener("cut", onCut);
      document.removeEventListener("paste", onPaste);
      document.removeEventListener("contextmenu", onContextMenu);
    };
  }, [record, atMs, persist, revoked]);

  // Environment hints, recorded once at start.
  useEffect(() => {
    if (revoked) return;
    if (navigator.webdriver) record({ kind: "AUTOMATION_HINT", atMs: 0 });
    const screenWithExtended = screen as Screen & { isExtended?: boolean };
    if (screenWithExtended.isExtended === true) record({ kind: "MULTI_MONITOR", atMs: 0 });
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
      const target = questions[index];
      if (!target) return;
      // A question change saves immediately (SPEC §5), before the editor's
      // text is replaced by the next question's.
      if (dirty.current) void persist("TICK");
      setCurrent(index);
      setVisited((seen) => ({ ...seen, [target.questionId]: true }));
    },
    [questions, persist],
  );

  const progress = useMemo<QuestionProgress[]>(
    () =>
      questions.map((q) => ({
        visited: visited[q.questionId] === true,
        // Answered means "there is work here": anything beyond the starter.
        answered: (sources[q.questionId] ?? "").trim() !== (q.starter ?? "").trim(),
        marked: marked[q.questionId] === true,
      })),
    [questions, visited, sources, marked],
  );

  const counts = paletteCounts(progress);

  const submit = useCallback(async () => {
    // Every answer at once, so the server snapshots and creates submissions
    // in one pass and the attempt closes last (lib/exam/submit.ts).
    const answers = questions.map((q) => ({
      questionId: q.questionId,
      language: q.language,
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
      setRevoked("submitted");
    } catch {
      // The sitting is NOT closed, so the candidate can try again — and
      // their work is in the write-ahead store either way.
      setSave({ kind: "failed" });
    }
  }, [attemptId, questions]);

  const copyMyCode = useCallback(() => {
    const text = sourcesRef.current[questionIdRef.current] ?? "";
    void navigator.clipboard?.writeText(text).catch(() => undefined);
  }, []);

  if (!question) {
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
          Question {current + 1} of {questions.length}
        </p>
        <div className="ml-auto flex items-center gap-3">
          <ExamClock serverMsRemaining={clock.msRemaining} receivedAtMs={clock.at} />
          <SaveStatePill state={save} onCopyCode={copyMyCode} />
          <MonitoredChip labSupervised={labSupervised} />
        </div>
      </header>

      <div className="flex min-h-0 flex-1">
        <QuestionPalette progress={progress} current={current} onSelect={goTo} />
        <ExamQuestion
          question={question}
          source={sources[question.questionId] ?? ""}
          onSourceChange={onSourceChange}
          onInsertion={onInsertion}
          position={current + 1}
          total={questions.length}
          prefs={editorPrefs}
        />
      </div>

      <ExamBottomBar
        canGoPrevious={current > 0}
        onPrevious={() => goTo(current - 1)}
        onMarkAndNext={() => {
          setMarked((flags) => ({ ...flags, [question.questionId]: true }));
          goTo(Math.min(current + 1, questions.length - 1));
        }}
        onClear={() => {
          setSources((previous) => ({ ...previous, [question.questionId]: question.starter }));
          dirty.current = true;
        }}
        onSaveAndNext={() => {
          void persist("TICK");
          goTo(Math.min(current + 1, questions.length - 1));
        }}
        onSubmit={() => void submit()}
        answered={counts.answered}
        total={counts.total}
        status={status}
        revoked={revoked}
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
    </div>
  );
}
