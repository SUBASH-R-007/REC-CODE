import { z } from "zod";
import { PROCTOR_EVENT_KINDS, proctorEventKindSchema, type ProctorEventKind } from "./proctor";
import type { FocusLimitAction } from "./assessment";

/**
 * The telemetry policy (Phase 6c). Pure: the thresholds, the classifications
 * and the warning arithmetic. No DOM, no I/O.
 *
 * SPEC §5's instruction is "instrument, do not block":
 *
 *   Do NOT block paste, copy, cut, right-click or text selection. Allow them
 *   and instrument them. [...] Blocking is both bypassable and
 *   counterproductive: students legitimately paste their own earlier code and
 *   sample input, blocking drives them to clipboard-typing macros which
 *   silences the signal, and preventDefault on contextmenu/copy breaks
 *   assistive technology.
 *
 * So every function here answers "what did we just see?" and never "should we
 * stop it?". The one function that produces a consequence —
 * `focusWarningOutcome` — can return an auto-submit and nothing worse, which
 * is the ceiling SPEC §0 sets for the whole system: flag for review and
 * withhold from the public leaderboard, never a penalty.
 */

// ── Thresholds ───────────────────────────────────────────────────────────

/**
 * A focus loss shorter than this is UI noise, not a signal (SPEC §5: "losses
 * <1500ms dropped as UI noise"). An OS notification, a Bluetooth reconnect
 * and a click on a native scrollbar all produce one.
 */
export const FOCUS_LOSS_NOISE_MS = 1_500;

/** Grace to re-enter fullscreen before the exit is recorded (SPEC §5). */
export const FULLSCREEN_REENTRY_GRACE_MS = 10_000;

/**
 * A transaction inserting at least this many characters with neither
 * `input.type` nor `input.paste` annotation is PROGRAMMATIC_INSERT — "that is
 * what an extension typing the clipboard looks like" (SPEC §5).
 */
export const PROGRAMMATIC_INSERT_MIN_CHARS = 80;

/** CADENCE_BURST: >= 80 chars inside 200ms with no paste/programmatic annotation. */
export const CADENCE_BURST_MIN_CHARS = 80;
export const CADENCE_BURST_WINDOW_MS = 200;

/** No editing for this long is an IDLE_GAP. */
export const IDLE_GAP_MS = 120_000;

/** Raw rows per attempt; past this, only aggregates increment (SPEC §5). */
export const MAX_RAW_EVENTS_PER_ATTEMPT = 2_000;

/** Flush on a 5s tick or 25 events (SPEC §5). */
export const EVENT_FLUSH_INTERVAL_MS = 5_000;
export const EVENT_FLUSH_COUNT = 25;

/** Payloads <= 32 KB; over 64 KB is refused with 413 (SPEC §5). */
export const EVENT_PAYLOAD_TARGET_BYTES = 32 * 1024;
export const EVENT_PAYLOAD_MAX_BYTES = 64 * 1024;

/** A snapshot every 30s while dirty, capped at 200 per attempt, 64 KB each. */
export const SNAPSHOT_INTERVAL_MS = 30_000;
export const MAX_SNAPSHOTS_PER_ATTEMPT = 200;
export const SNAPSHOT_MAX_BYTES = 64 * 1024;

// ── Classification ───────────────────────────────────────────────────────

/**
 * A paste is INTERNAL when its sha256 is already in the per-attempt set of
 * things copied inside the exam origin, EXTERNAL otherwise (SPEC §5).
 *
 * Neither is an accusation. Students legitimately paste their own earlier
 * code and the sample input, which is most of what EXTERNAL_PASTE catches;
 * it is a chip on a reviewer's timeline, not a finding.
 */
export function classifyPaste(args: {
  readonly hash: string;
  readonly internalHashes: ReadonlySet<string>;
}): Extract<ProctorEventKind, "INTERNAL_PASTE" | "EXTERNAL_PASTE"> {
  return args.internalHashes.has(args.hash) ? "INTERNAL_PASTE" : "EXTERNAL_PASTE";
}

/** Is this focus loss too short to be worth a row? */
export function isNoiseFocusLoss(durationMs: number): boolean {
  return !Number.isFinite(durationMs) || durationMs < FOCUS_LOSS_NOISE_MS;
}

/**
 * CodeMirror 6 transaction annotations, which is where editor telemetry comes
 * from rather than DOM events — "CM6 tells you the exact inserted character
 * count and whether the origin was input.type, input.paste or programmatic; a
 * DOM paste listener tells you almost nothing and is silenced by one
 * addEventListener override" (SPEC §5).
 */
export const INSERTION_ORIGINS = ["input.type", "input.paste", "programmatic"] as const;
export type InsertionOrigin = (typeof INSERTION_ORIGINS)[number];

/**
 * What one editor transaction is, if anything. Null for ordinary typing,
 * which is almost every transaction.
 *
 * `programmatic` here means CM6 reported NO input annotation — the hallmark
 * of an extension writing into the document. A transaction the editor itself
 * caused (a format, an undo) carries an annotation and is not this.
 */
export function classifyInsertion(args: {
  readonly chars: number;
  readonly origin: InsertionOrigin | null;
  readonly windowMs?: number;
}): Extract<ProctorEventKind, "PROGRAMMATIC_INSERT" | "CADENCE_BURST"> | null {
  const chars = Number.isFinite(args.chars) ? Math.floor(args.chars) : 0;
  if (args.origin === "input.paste") return null; // A paste is a paste, classified above.
  if (args.origin === null || args.origin === "programmatic") {
    return chars >= PROGRAMMATIC_INSERT_MIN_CHARS ? "PROGRAMMATIC_INSERT" : null;
  }
  // Typed. Fast enough and large enough to be a macro rather than a person.
  if (
    args.windowMs !== undefined &&
    chars >= CADENCE_BURST_MIN_CHARS &&
    args.windowMs <= CADENCE_BURST_WINDOW_MS
  ) {
    return "CADENCE_BURST";
  }
  return null;
}

/** Has the candidate been idle long enough to record a gap? */
export function isIdleGap(msSinceLastEdit: number): boolean {
  return Number.isFinite(msSinceLastEdit) && msSinceLastEdit >= IDLE_GAP_MS;
}

// ── The accommodation exemption ──────────────────────────────────────────

/**
 * Is this signal exempt for this candidate?
 *
 * SPEC §7 requires a SCREEN_READER accommodation to exempt focus loss and
 * fullscreen exit, because assistive technology legitimately moves focus and
 * leaves fullscreen. The list itself is the Phase 4 `Accommodation.
 * exemptSignals` column (see `suggestedExemptSignals`), so this is only the
 * lookup — which is deliberately the ONLY thing Phase 6 needs to know about
 * an accommodation to apply it, and the only projection a reviewer receives
 * (`reviewerAccommodationView`): never the kind, never the reason, never a
 * disability label.
 */
export function isExemptSignal(
  kind: ProctorEventKind,
  exemptSignals: readonly ProctorEventKind[],
): boolean {
  return exemptSignals.includes(kind);
}

// ── Focus warnings ───────────────────────────────────────────────────────

/**
 * What a focus-loss or fullscreen-exit warning does at this count.
 *
 * "WARN" shows the covering overlay and nothing else. At the limit,
 * `onLimit` decides, and SPEC §5 bounds the options:
 *
 *   On limit, auto-submit and flag for human review — never auto-void. A
 *   wifi drop or an OS notification produces false positives; auto-submit
 *   plus review is defensible, voiding is not.
 *
 * There is deliberately no outcome that voids, scores or disables anything.
 */
export type FocusWarningAction = "NONE" | "WARN" | "AUTOSUBMIT" | "FLAG_ONLY";

export interface FocusWarningOutcome {
  /** 1-based, for "This is warning 2 of 3". Zero when exempt. */
  readonly warningNumber: number;
  readonly atLimit: boolean;
  readonly action: FocusWarningAction;
}

export function focusWarningOutcome(args: {
  /** Warnings already recorded, BEFORE this one. */
  readonly previousWarnings: number;
  readonly maxWarnings: number;
  readonly onLimit: FocusLimitAction;
  /** True when this signal is exempt for this candidate (an accommodation). */
  readonly exempt: boolean;
}): FocusWarningOutcome {
  // An exempt signal does not even count towards the limit. Counting it and
  // then declining to act would still end the sitting at warning three.
  if (args.exempt) return { warningNumber: 0, atLimit: false, action: "NONE" };

  const max = Math.max(1, Math.floor(args.maxWarnings));
  const warningNumber = Math.max(0, Math.floor(args.previousWarnings)) + 1;
  if (warningNumber < max) return { warningNumber, atLimit: false, action: "WARN" };
  return {
    warningNumber,
    atLimit: true,
    action: args.onLimit === "AUTOSUBMIT" ? "AUTOSUBMIT" : "FLAG_ONLY",
  };
}

/**
 * The covering overlay's body text (SPEC §5 gives it almost verbatim). It
 * states the consequence plainly, because "no silent trapping: the deterrent
 * requires awareness, and transparency also removes the 'I didn't know'
 * appeal."
 *
 * Under FLAG_ONLY the sentence about automatic submission would be a lie, so
 * it is not shown.
 */
export function overlayBody(args: {
  readonly warningNumber: number;
  readonly maxWarnings: number;
  readonly onLimit: FocusLimitAction;
}): string {
  const base = "Return to full screen to continue. Your timer is still running.";
  if (args.warningNumber <= 0) return base;
  const count = `This is warning ${args.warningNumber} of ${args.maxWarnings}`;
  if (args.onLimit === "AUTOSUBMIT") {
    return `${base} ${count} — at ${args.maxWarnings} warnings your test is submitted automatically.`;
  }
  return `${base} ${count} — at ${args.maxWarnings} warnings this is recorded for a human to review.`;
}

// ── Flushing ─────────────────────────────────────────────────────────────

/**
 * Should the client send what it has? Flush on a 5s tick or 25 events, and
 * always when the page is going away — SPEC §5 wants the last batch out via
 * `sendBeacon` on `pagehide` / `visibilitychange→hidden`, which is the one
 * moment the usual cadence would lose events entirely.
 */
export function shouldFlush(args: {
  readonly pending: number;
  readonly msSinceLastFlush: number;
  readonly pageHiding: boolean;
}): boolean {
  if (args.pending <= 0) return false;
  if (args.pageHiding) return true;
  return args.pending >= EVENT_FLUSH_COUNT || args.msSinceLastFlush >= EVENT_FLUSH_INTERVAL_MS;
}

// ── The wire shape ───────────────────────────────────────────────────────

/**
 * One client event. Shape only: SPEC §5 is absolute that this carries
 * "kind, timestamp, duration, byte size, sha256, cadence statistics. Never
 * clipboard text, never keystroke content."
 *
 * `.strict()` is what enforces that at the boundary — there is no field to
 * put text in, and an attempt to add one is rejected rather than ignored.
 * The database agrees: `ProctorEvent_hash_check` refuses anything in `hash`
 * that is not a sha256, so text cannot be smuggled through it either.
 */
export const clientProctorEventSchema = z
  .object({
    kind: proctorEventKindSchema,
    /** Monotonic per attempt; a hole in the run is a SEQUENCE_GAP. */
    clientSeq: z.number().int().min(0).max(2_147_483_647),
    /** Milliseconds from the attempt's start. Server-clamped on arrival. */
    atMs: z.number().int().min(0),
    durationMs: z.number().int().min(0).max(86_400_000).optional(),
    /** Byte size of a paste or copy — never its text. */
    size: z.number().int().min(0).max(EVENT_PAYLOAD_MAX_BYTES).optional(),
    hash: z
      .string()
      .regex(/^[a-f0-9]{64}$/, "hash must be a lowercase sha256")
      .optional(),
    /** Cadence statistics only: counts and windows, no content. */
    chars: z.number().int().min(0).optional(),
    windowMs: z.number().int().min(0).optional(),
    questionPosition: z.number().int().min(1).max(500).optional(),
  })
  .strict();
export type ClientProctorEvent = z.infer<typeof clientProctorEventSchema>;

export const proctorEventBatchSchema = z
  .object({
    events: z.array(clientProctorEventSchema).min(1).max(EVENT_FLUSH_COUNT * 4),
  })
  .strict();
export type ProctorEventBatch = z.infer<typeof proctorEventBatchSchema>;

/**
 * Kinds a CLIENT may report. The server-derived ones are not in this set:
 * a client claiming HEARTBEAT_GAP or CONCURRENT_SESSION is either broken or
 * trying to pollute its own record, and either way the server already knows
 * those from its own facts.
 */
export const SERVER_ONLY_EVENT_KINDS: readonly ProctorEventKind[] = Object.freeze([
  "HEARTBEAT_GAP",
  "IP_CHANGED",
  "UA_CHANGED",
  "SEQUENCE_GAP",
  "CONCURRENT_SESSION",
  "SUBMISSION_RATE_ANOMALY",
  "SNAPSHOT_JUMP",
  "INVIGILATOR_NOTE",
]);

export const CLIENT_EVENT_KINDS: readonly ProctorEventKind[] = Object.freeze(
  PROCTOR_EVENT_KINDS.filter((k) => !SERVER_ONLY_EVENT_KINDS.includes(k)),
);

export function isClientReportableKind(kind: ProctorEventKind): boolean {
  return !SERVER_ONLY_EVENT_KINDS.includes(kind);
}

/**
 * What the engine actually produces today, written down (Phase 11b).
 *
 * The vocabulary and the implementation had drifted: of twenty-five declared
 * kinds, seven were produced by nothing at all, and nothing said so. A
 * reviewer reading a flagged attempt had no way to tell a signal that was
 * absent because the candidate did not trigger it from one that was absent
 * because the product never emits it — and those mean opposite things.
 *
 * So the three lists below partition `PROCTOR_EVENT_KINDS`, and
 * `exam-telemetry.test.ts` holds them to it. Adding a kind now forces the
 * question "who emits this?" at the moment it is added, which is the only
 * moment anybody knows the answer.
 */

/** Emitted by the exam client (components/exam, lib/exam). */
export const CLIENT_EMITTED_KINDS: readonly ProctorEventKind[] = Object.freeze([
  "FOCUS_LOSS",
  "FULLSCREEN_EXIT",
  "EXTERNAL_PASTE",
  "INTERNAL_PASTE",
  "PROGRAMMATIC_INSERT",
  "COPY",
  "CUT",
  "CONTEXT_MENU",
  "CADENCE_BURST",
  "WINDOW_RESIZE",
  "MULTI_MONITOR",
  "AUTOMATION_HINT",
  // Phase 11b: declared since Phase 4, emitted from Phase 11b.
  "FIRST_KEYSTROKE",
  "IDLE_GAP",
  "NETWORK_DROP",
  "CLIENT_SCRIPT_ERROR",
]);

/** Derived by the server from its own facts (lib/exam, the invigilator surface). */
export const SERVER_DERIVED_KINDS: readonly ProctorEventKind[] = Object.freeze([
  "HEARTBEAT_GAP",
  "IP_CHANGED",
  "UA_CHANGED",
  "SEQUENCE_GAP",
  "CONCURRENT_SESSION",
  "SNAPSHOT_JUMP",
  // Phase 11b: an invigilator's own observation, which until then had no way
  // into the record a reviewer reads.
  "INVIGILATOR_NOTE",
]);

/**
 * Declared, produced by nothing, and why. A reason is the whole point: it
 * separates "not built yet" from "cannot mean anything here", and a
 * reviewer deserves to know which.
 */
export const RESERVED_EVENT_KINDS: Readonly<Partial<Record<ProctorEventKind, string>>> = Object.freeze({
  /**
   * The posture already says this one is near worthless, in its own words:
   * "Devtools detection is unreliable in both directions. Size heuristics
   * and debugger timing produce false positives (docked panels, zoom, slow
   * machines) and are trivially defeated (undocked or remote devtools)."
   * A signal that fires because a student zoomed to 150% to read the
   * question is worse than no signal: it costs them queue position and
   * tells a reviewer nothing. The band engine still scores it as context if
   * one ever arrives (an invigilator-reported case, say), so the weight
   * stays where it is.
   */
  DEVTOOLS_HEURISTIC:
    "Unreliable in both directions (docs/PROCTORING.md §2): the browser-visible heuristics misfire on zoom, docked panels and small screens, and are trivially defeated. Scored as context if one ever arrives; never emitted by us.",
  /**
   * A sitting submits ONCE, at the end: `lib/exam/submit.ts` writes every
   * Submission in one transaction. There is no rate within an attempt for
   * anything to be anomalous about. It stays in the enum because
   * `ProctorEventKind` and `Accommodation.exemptSignals` are shared with
   * live data, and removing an enum value is a migration that buys nothing.
   */
  SUBMISSION_RATE_ANOMALY:
    "A sitting submits once, at the end (lib/exam/submit.ts), so an attempt has no submission rate. Kept in the enum because it is shared with live data through Accommodation.exemptSignals.",
});

/**
 * What the events route answers. The overlay is the reason this is a
 * response and not a fire-and-forget: SPEC §5 requires the event to be
 * "written server-side BEFORE the overlay becomes dismissible", so the
 * client cannot know whether it may let the candidate continue until the
 * server has said so.
 */
export const proctorEventBatchResponseSchema = z
  .object({
    accepted: z.number().int().min(0),
    /** Noise (a focus flicker), a server-only kind, or past the raw cap. */
    dropped: z.number().int().min(0),
    /**
     * Set when this batch contained a focus-loss or fullscreen-exit the
     * overlay is about. Null otherwise — most batches are pastes and copies.
     */
    focusWarning: z
      .object({
        warningNumber: z.number().int().min(0),
        maxWarnings: z.number().int().min(1),
        atLimit: z.boolean(),
        action: z.enum(["NONE", "WARN", "AUTOSUBMIT", "FLAG_ONLY"]),
        /** The overlay's wording, composed server-side so it cannot drift. */
        body: z.string(),
      })
      .nullable(),
    /** True once the raw row cap is reached and only counters move. */
    aggregatesOnly: z.boolean(),
  })
  .strict();
export type ProctorEventBatchResponse = z.infer<typeof proctorEventBatchResponseSchema>;
