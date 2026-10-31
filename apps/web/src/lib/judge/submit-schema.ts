import { z } from "zod";
import { LIMITS, isSubmitLanguage, utf8Length, type SubmitLanguageKey } from "@recx/shared";

/**
 * Input schemas for the workspace's Submit and Run actions. Pure (no I/O) so
 * the size rules are unit-tested exactly as the server enforces them.
 *
 * Sizes are UTF-8 bytes, not string length: "é" is one UTF-16 unit but two
 * bytes, and the database CHECK constraints (octet_length) count bytes too.
 */

/** 256 KB — the per-submission source cap from the limits table. */
export const MAX_SOURCE_BYTES = LIMITS.source.defaultBytes;
/** 64 KB — custom-run stdin cap. */
export const MAX_CUSTOM_INPUT_BYTES = LIMITS.customRun.stdinBytes;

/**
 * True when `text` fits in `maxBytes` of UTF-8. Every UTF-16 code unit
 * encodes to at least one byte, so an over-long string is rejected before
 * paying for the encode.
 */
export function fitsUtf8(text: string, maxBytes: number): boolean {
  return text.length <= maxBytes && utf8Length(text) <= maxBytes;
}

/** Postgres text columns cannot hold NUL, so it is refused up front. */
const hasNul = (text: string) => text.includes("\u0000");

export const slugSchema = z
  .string({ invalid_type_error: "Choose a problem." })
  .trim()
  .min(1, "Choose a problem.")
  .max(100, "That problem link is not valid.")
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "That problem link is not valid.");

/**
 * Every key a submission may carry: the toolchains, plus the two that are
 * not toolchains — `sql17` (Phase 12k) and `answer1` (Phase 12n). Each is
 * accepted here and paired with the problem's io mode by the submit action,
 * which is where the version is in hand.
 *
 * A refinement rather than `z.enum(SUBMIT_LANGUAGE_KEYS)`: the enum is
 * built when this module is evaluated, and Next's barrel optimisation can
 * evaluate this file before the module that defines the list — which is
 * exactly what happened in the Phase 12n live stage, where every
 * submission came back as an internal error. A function is called when the
 * input is parsed, by which time every module is initialised.
 */
export const languageSchema = z
  .string({ invalid_type_error: "Choose a supported language." })
  .refine(isSubmitLanguage, { message: "Choose a supported language." })
  .transform((key) => key as SubmitLanguageKey);

export const sourceSchema = z
  .string({ invalid_type_error: "Your code must be text." })
  .refine((s) => fitsUtf8(s, MAX_SOURCE_BYTES), {
    message: "Your code is larger than 256 KB. Trim it down and try again.",
  })
  .refine((s) => !hasNul(s), {
    message: "Your code contains a NUL character, which cannot be judged. Remove it and try again.",
  })
  .refine((s) => s.trim().length > 0, { message: "Write some code first." });

/** Null means "run the sample tests". */
export const customInputSchema = z
  .string({ invalid_type_error: "Custom input must be text." })
  .refine((s) => fitsUtf8(s, MAX_CUSTOM_INPUT_BYTES), {
    message: "Custom input is larger than 64 KB. Use a smaller input and try again.",
  })
  .refine((s) => !hasNul(s), {
    message: "Custom input contains a NUL character. Remove it and try again.",
  })
  .nullable();

export const submitSolutionSchema = z.object({
  slug: slugSchema,
  language: languageSchema,
  source: sourceSchema,
});

export const runCodeSchema = submitSolutionSchema.extend({
  customInput: customInputSchema,
});

export type SubmitSolutionInput = z.input<typeof submitSolutionSchema>;
export type RunCodeInput = z.input<typeof runCodeSchema>;
