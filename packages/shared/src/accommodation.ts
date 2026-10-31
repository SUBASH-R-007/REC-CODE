import { z } from "zod";
import { PROCTOR_EVENT_KINDS, proctorEventKindSchema, type ProctorEventKind } from "./proctor";

/**
 * Exam accommodation kinds. A kind is a disability label: it is shown only on
 * the accommodation's own admin page and to the student, never to a reviewer
 * or invigilator and never in audit metadata.
 *
 * Mirror: the Prisma enum AccommodationKind (same members, same order —
 * packages/db/test/enum-parity.test.ts). The admin stream extends this module
 * with the terms schema and limits.
 */
export const ACCOMMODATION_KINDS = [
  "SCREEN_READER",
  "MAGNIFIER",
  "SPEECH_INPUT",
  "EXTRA_TIME",
  "BREAKS",
  "SEPARATE_ROOM",
] as const;

export type AccommodationKind = (typeof ACCOMMODATION_KINDS)[number];

export const accommodationKindSchema = z.enum(ACCOMMODATION_KINDS);

/** Plain names for the admin accommodation pages (never shown to a reviewer). */
export const ACCOMMODATION_KIND_LABELS: Readonly<Record<AccommodationKind, string>> = Object.freeze({
  SCREEN_READER: "Screen reader",
  MAGNIFIER: "Screen magnifier",
  SPEECH_INPUT: "Speech input",
  EXTRA_TIME: "Extra time",
  BREAKS: "Rest breaks",
  SEPARATE_ROOM: "Separate room",
});

/**
 * Bounds of the granted terms. The database CHECKs hold the same numbers
 * (migration 20261010100000). extraTimeMinutes ≤ 240, breakMinutes ≤ 120 and
 * a validity of at most 400 days are Phase 4 readings (docs/OPEN-QUESTIONS.md).
 */
export const ACCOMMODATION_LIMITS = Object.freeze({
  extraTimePercent: Object.freeze({ min: 0, max: 100 }),
  extraTimeMinutes: Object.freeze({ min: 0, max: 240 }),
  breakMinutes: Object.freeze({ min: 0, max: 120 }),
  fontScalePercent: Object.freeze({ min: 100, max: 200 }),
  maxValidityDays: 400,
} as const);

const DAY_MS = 86_400_000;

function bounded(label: string, limits: { min: number; max: number }) {
  return z
    .number({ invalid_type_error: `${label} must be a whole number.`, required_error: `${label} is required.` })
    .int(`${label} must be a whole number.`)
    .min(limits.min, `${label} must be at least ${limits.min}.`)
    .max(limits.max, `${label} can be at most ${limits.max}.`);
}

function duplicates<T>(values: readonly T[]): T[] {
  const seen = new Set<T>();
  const dupes = new Set<T>();
  for (const v of values) (seen.has(v) ? dupes : seen).add(v);
  return [...dupes];
}

/**
 * The terms of an accommodation (everything a SUPER_ADMIN grants), as the
 * admin form submits them. Cross-field rules:
 *   - at least one kind, no kind twice;
 *   - EXTRA_TIME is listed exactly when extra time (percent or minutes) is given;
 *   - BREAKS is listed exactly when breaks are allowed, and break minutes are
 *     0 unless breaks are allowed;
 *   - no exempt signal twice;
 *   - validUntil is in the future and at most ACCOMMODATION_LIMITS.maxValidityDays ahead.
 */
export const accommodationTermsSchema = z
  .object({
    kinds: z.array(accommodationKindSchema).min(1, "Choose at least one accommodation.").max(ACCOMMODATION_KINDS.length),
    exemptSignals: z.array(proctorEventKindSchema).max(PROCTOR_EVENT_KINDS.length),
    extraTimePercent: bounded("Extra time (percent)", ACCOMMODATION_LIMITS.extraTimePercent),
    extraTimeMinutes: bounded("Extra time (minutes)", ACCOMMODATION_LIMITS.extraTimeMinutes),
    allowBreaks: z.boolean(),
    breakMinutes: bounded("Break minutes", ACCOMMODATION_LIMITS.breakMinutes),
    fontScalePercent: bounded("Font scale (percent)", ACCOMMODATION_LIMITS.fontScalePercent),
    allowScribe: z.boolean(),
    highContrast: z.boolean(),
    validUntil: z.coerce.date({ invalid_type_error: "Enter a valid date.", required_error: "Enter a valid date." }),
  })
  .superRefine((t, ctx) => {
    if (duplicates(t.kinds).length > 0) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["kinds"], message: "Each accommodation can be chosen once." });
    }
    const extraTime = t.extraTimePercent > 0 || t.extraTimeMinutes > 0;
    if (t.kinds.includes("EXTRA_TIME") !== extraTime) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["kinds"],
        message: extraTime
          ? "Extra time is given, so choose “Extra time” as an accommodation."
          : "“Extra time” is chosen, so give a percentage or minutes of extra time.",
      });
    }
    if (t.kinds.includes("BREAKS") !== t.allowBreaks) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["kinds"],
        message: t.allowBreaks
          ? "Breaks are allowed, so choose “Rest breaks” as an accommodation."
          : "“Rest breaks” is chosen, so allow breaks.",
      });
    }
    if (!t.allowBreaks && t.breakMinutes !== 0) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["breakMinutes"], message: "Break minutes must be 0 unless breaks are allowed." });
    }
    if (duplicates(t.exemptSignals).length > 0) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["exemptSignals"], message: "Each exempt signal can be chosen once." });
    }
    const now = Date.now();
    const until = t.validUntil.getTime();
    if (Number.isNaN(until) || until <= now) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["validUntil"], message: "The accommodation must be valid until a future date." });
    } else if (until > now + ACCOMMODATION_LIMITS.maxValidityDays * DAY_MS) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["validUntil"],
        message: `An accommodation can be granted for at most ${ACCOMMODATION_LIMITS.maxValidityDays} days at a time.`,
      });
    }
  });

export type AccommodationTerms = z.infer<typeof accommodationTermsSchema>;

/**
 * Signals to pre-fill as exempt for the chosen kinds. Only a suggestion: the
 * SUPER_ADMIN confirms the final list. SCREEN_READER → focus loss and
 * full-screen exit (the spec's own example); MAGNIFIER → full-screen exit and
 * SPEECH_INPUT → typing bursts and software-inserted text are inferences
 * (docs/OPEN-QUESTIONS.md). Returned in PROCTOR_EVENT_KINDS order, without
 * duplicates.
 */
const SUGGESTED: Readonly<Partial<Record<AccommodationKind, readonly ProctorEventKind[]>>> = {
  SCREEN_READER: ["FOCUS_LOSS", "FULLSCREEN_EXIT"],
  MAGNIFIER: ["FULLSCREEN_EXIT"],
  SPEECH_INPUT: ["CADENCE_BURST", "PROGRAMMATIC_INSERT"],
};

export function suggestedExemptSignals(kinds: readonly AccommodationKind[]): ProctorEventKind[] {
  const wanted = new Set<ProctorEventKind>();
  for (const kind of kinds) for (const signal of SUGGESTED[kind] ?? []) wanted.add(signal);
  return PROCTOR_EVENT_KINDS.filter((k) => wanted.has(k));
}

/**
 * The only projection of an accommodation a Phase 6 reviewer or invigilator
 * receives: which signals to discount. Never the kinds, the reason or the
 * other terms.
 */
export interface ReviewerAccommodationView {
  readonly exemptSignals: readonly ProctorEventKind[];
}

export function reviewerAccommodationView(t: Pick<AccommodationTerms, "exemptSignals">): ReviewerAccommodationView {
  return Object.freeze({ exemptSignals: Object.freeze([...t.exemptSignals]) });
}

/**
 * An attempt's duration with the granted extra time:
 * floor(durationSec × (1 + percent/100)) + minutes × 60. Phase 6 still caps
 * the end at the window's closesAt.
 */
export function accommodatedDurationSec(
  durationSec: number,
  t: Pick<AccommodationTerms, "extraTimePercent" | "extraTimeMinutes">,
): number {
  if (!Number.isFinite(durationSec) || durationSec < 0) throw new RangeError("durationSec must be a non-negative number");
  const percent = Math.min(Math.max(t.extraTimePercent, 0), ACCOMMODATION_LIMITS.extraTimePercent.max);
  const minutes = Math.min(Math.max(t.extraTimeMinutes, 0), ACCOMMODATION_LIMITS.extraTimeMinutes.max);
  return Math.floor(durationSec * (1 + percent / 100)) + minutes * 60;
}

/**
 * A one-line summary of the terms for list views. It never names a kind
 * (a disability label): only time, breaks, display and the number of exempt
 * signals.
 */
export function accommodationTermsSummary(
  t: Pick<
    AccommodationTerms,
    "extraTimePercent" | "extraTimeMinutes" | "allowBreaks" | "breakMinutes" | "fontScalePercent" | "allowScribe" | "highContrast"
  > & { exemptSignals: readonly unknown[] },
): string {
  const parts: string[] = [];
  if (t.extraTimePercent > 0) parts.push(`+${t.extraTimePercent}% time`);
  if (t.extraTimeMinutes > 0) parts.push(`+${t.extraTimeMinutes} min`);
  if (t.allowBreaks) parts.push(t.breakMinutes > 0 ? `breaks (${t.breakMinutes} min)` : "breaks");
  if (t.fontScalePercent !== 100) parts.push(`text ${t.fontScalePercent}%`);
  if (t.allowScribe) parts.push("scribe");
  if (t.highContrast) parts.push("high contrast");
  if (t.exemptSignals.length > 0) parts.push(`${t.exemptSignals.length} exempt ${t.exemptSignals.length === 1 ? "signal" : "signals"}`);
  return parts.length > 0 ? parts.join(" · ") : "No timing or display changes";
}
