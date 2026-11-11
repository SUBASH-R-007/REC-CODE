import { z } from "zod";
import { TOPICS, type Topic } from "./topics";
import { READINESS_TIERS } from "./readiness";

/**
 * The signed profile export's payload (Phase 9f).
 *
 * SPEC §5 asks for an "HMAC-signed profile/resume export reusing the LMS
 * certificate + /verify pattern". This module is the payload and its
 * canonical form; the HMAC itself lives in
 * `apps/web/src/lib/export/signature.ts`, so `packages/shared` keeps no
 * `node:crypto` import and stays usable from anywhere.
 *
 * Two things make a signature worth having, and both are here rather than in
 * the route:
 *
 *   1. **A canonical form.** An HMAC over `JSON.stringify(payload)` verifies
 *      nothing across versions, because key order is an implementation
 *      detail of whatever built the object. `canonicalisePayload` sorts keys
 *      at every depth and drops nothing, so the same facts always produce the
 *      same bytes — which is what lets a verifier re-derive the signature
 *      years later from the stored row.
 *   2. **A closed shape.** The schema is `.strict()` all the way down: a
 *      field nobody declared cannot be signed, so a future feature cannot
 *      quietly widen what a public link attests to.
 *
 * What the payload may NOT contain is the privacy boundary, and it is
 * asserted by test rather than reviewed: never an email, never a roll number,
 * never a department or a section, never an integrity band, never a flag
 * count. A verification page is a PUBLIC page — anybody with the link reads
 * it — so the question is not "would a recruiter misuse this" but "is this
 * safe on the open web".
 */

/** Bumped when the SHAPE changes, so an old signature stays verifiable. */
export const EXPORT_PAYLOAD_VERSION = 1;

export const PROFILE_EXPORT_KINDS = ["PROFILE", "RESUME"] as const;
export type ProfileExportKind = (typeof PROFILE_EXPORT_KINDS)[number];

/**
 * One attested tier figure.
 *
 * `availableWeight` is in the payload and not optional. The whole phase turns
 * on a score being read against what was measurable, and a public page is the
 * last place that can be left out: a recruiter reading "62" with no
 * denominator will read 62 out of 100.
 */
export const attestedTierSchema = z
  .object({
    tier: z.enum(READINESS_TIERS),
    score: z.number().int().min(0).max(100).nullable(),
    availableWeight: z.number().int().min(0).max(100),
  })
  .strict();

export const profileExportPayloadSchema = z
  .object({
    v: z.literal(EXPORT_PAYLOAD_VERSION),
    kind: z.enum(PROFILE_EXPORT_KINDS),
    /** The student's display name and public handle. Nothing else about them. */
    name: z.string().min(1).max(120),
    handle: z.string().min(1).max(64),
    /** Batch year only. Not the department, not the section. */
    batchYear: z.number().int().min(1900).max(2200).nullable(),
    /** The campus day the readiness figures were computed, "yyyy-MM-dd". */
    computedOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable(),
    rulesVersion: z.number().int().positive(),
    tiers: z.array(attestedTierSchema).max(READINESS_TIERS.length),
    solvedTotal: z.number().int().min(0),
    solvedUnassisted: z.number().int().min(0),
    /** Unassisted solves per topic, for the breadth claim. */
    topics: z.record(z.enum(TOPICS), z.number().int().min(0)),
    rating: z.number().int().nullable(),
    contestsRated: z.number().int().min(0),
    /** How many RELEASED assessment scores exist, and their mean percentage. */
    releasedAssessments: z.number().int().min(0),
    assessmentScoreAverage: z.number().int().min(0).max(100).nullable(),
    /** The campus day the export was issued, "yyyy-MM-dd". */
    issuedOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  })
  .strict();

export type ProfileExportPayload = z.infer<typeof profileExportPayloadSchema>;

/** A JSON value with no `undefined` — what a canonical form is allowed to hold. */
type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

/**
 * The payload as deterministic bytes.
 *
 * Keys sorted at every depth, arrays left in order (their order is data),
 * `undefined` members dropped from objects and turned into `null` inside
 * arrays — because an array's length is part of what was signed and silently
 * shortening it would change the claim.
 *
 * Pure and total: it throws on nothing, so a verifier handed a stored row it
 * cannot parse gets "the signature does not match" rather than an exception
 * on a public page.
 */
export function canonicalise(value: unknown): Json {
  if (value === null || value === undefined) return null;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "boolean" || typeof value === "string") return value;
  if (Array.isArray(value)) return value.map((item) => canonicalise(item));
  if (typeof value === "object") {
    const out: { [key: string]: Json } = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      const item = (value as Record<string, unknown>)[key];
      if (item === undefined) continue;
      out[key] = canonicalise(item);
    }
    return out;
  }
  // A function, a symbol or a bigint is not signable data.
  return null;
}

/** The exact string an HMAC is taken over. */
export function canonicalisePayload(payload: unknown): string {
  return JSON.stringify(canonicalise(payload));
}

/**
 * Fields a payload must never carry, as data.
 *
 * Checked by a test over the schema AND over a built payload, because the two
 * can disagree: a schema may forbid a key while a builder puts it in a nested
 * object the schema happens to accept as a record.
 */
export const FORBIDDEN_PAYLOAD_KEYS: readonly string[] = Object.freeze([
  "email",
  "collegeId",
  "rollNumber",
  "departmentCode",
  "section",
  "integrityScore",
  "integrityBand",
  "band",
  "flagCount",
  "flags",
  "ipHash",
  "phone",
  "address",
]);

/** The forbidden keys, at any depth, in a built payload. */
export function forbiddenKeysIn(payload: unknown): string[] {
  const found = new Set<string>();
  const walk = (value: unknown): void => {
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value)) {
      for (const item of value) walk(item);
      return;
    }
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      if (FORBIDDEN_PAYLOAD_KEYS.includes(key)) found.add(key);
      walk(item);
    }
  };
  walk(payload);
  return [...found].sort();
}

/** How many of the fourteen topics the payload attests any unassisted solve on. */
export function topicsTouched(payload: Pick<ProfileExportPayload, "topics">): number {
  return TOPICS.filter((topic) => (payload.topics[topic as Topic] ?? 0) > 0).length;
}

/**
 * How long a link lasts by default.
 *
 * Ninety days, and it is a real decision rather than a round number: a
 * recruiter checks a link within days of being sent it, and a readiness
 * figure three months old is no longer the student's. A student who wants a
 * fresh one issues a fresh one, which costs them a click; a link that never
 * expired would outlive the facts it attests to.
 */
export const EXPORT_DEFAULT_DAYS = 90;

/**
 * At most this many live links per student.
 *
 * Not a rate limit: a bound on how much of a student's own record is in
 * circulation at once. A link they have forgotten about is a link they cannot
 * withdraw, and five is enough for a CV, two applications and a spare while
 * still being a number somebody can hold in their head.
 */
export const MAX_LIVE_EXPORTS = 5;

/** The public code's length. 24 url-safe characters, as the design says. */
export const EXPORT_CODE_LENGTH = 24;

export const EXPORT_CODE_PATTERN = /^[A-Za-z0-9_-]{24}$/;

export function isExportCode(value: unknown): value is string {
  return typeof value === "string" && EXPORT_CODE_PATTERN.test(value);
}

/** What the verify page says, as constants a copy test can assert. */
export const VERIFY_COPY = {
  valid: "This record was issued by REC Code and has not been changed since.",
  revoked: "The student has withdrawn this link. Nothing here should be relied on.",
  expired: "This link has expired. Ask the student for a current one.",
  unknown: "No record matches this link.",
  tampered:
    "This link does not verify. The record it points at does not match its signature, so it may have been altered.",
  framing:
    "Readiness measures how much of a preparation syllabus the student has covered. It is not a prediction of job performance, and REC Code does not use it to decide who may sit a drive.",
  denominator:
    "Each figure is out of the weight that could actually be measured for this student, not out of 100. Components with no source yet are left out of both numbers rather than counted as zero.",
} as const;
