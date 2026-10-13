import { z } from "zod";
import { NOTE_MAX_BYTES, NOTE_TITLE_MAX, utf8ByteLength } from "@/components/notes/limits";

/**
 * The notes server boundary (src/server/actions/notes.ts). A "use server"
 * module may export only async functions, so the schemas live here; unit
 * tests in test/notes-*.test.ts.
 */

const ID = /^[A-Za-z0-9_-]+$/;
// Controls (tab and newline included: a title is one line) and invisible format characters.
const TITLE_UNSAFE = /[\p{Cc}\p{Cf}]/gu;

export const noteIdSchema = z
  .string({ required_error: "Choose a note.", invalid_type_error: "Choose a note." })
  .trim()
  .min(1, "Choose a note.")
  .max(64, "That note is not valid.")
  .regex(ID, "That note is not valid.");

const titleSchema = z
  .string({ invalid_type_error: "The title must be text." })
  .transform((value) => value.replace(TITLE_UNSAFE, " ").replace(/\s+/g, " ").trim())
  .refine((value) => value.length <= NOTE_TITLE_MAX, `Keep the title to ${NOTE_TITLE_MAX} characters or fewer.`)
  .nullish()
  .transform((value) => (value ? value : null));

export const contentSchema = z
  .string({ required_error: "Write something before saving.", invalid_type_error: "The note must be text." })
  .transform((value) => value.replace(/\r\n?/g, "\n"))
  .refine((value) => value.trim().length > 0, "Write something before saving.")
  .refine(
    (value) => utf8ByteLength(value) <= NOTE_MAX_BYTES,
    `Notes are limited to ${NOTE_MAX_BYTES / 1024} KB. Split this one into two.`,
  );

const problemIdSchema = z
  .string({ invalid_type_error: "Choose a problem from the list." })
  .trim()
  .max(64, "Choose a problem from the list.")
  .regex(/^[A-Za-z0-9_-]*$/, "Choose a problem from the list.")
  .nullish()
  .transform((value) => (value ? value : null));

export const noteInputSchema = z.object({
  title: titleSchema,
  contentMd: contentSchema,
  /** Optional link to a published problem. */
  problemId: problemIdSchema,
});
export type NoteInput = z.input<typeof noteInputSchema>;

export const noteUpdateSchema = noteInputSchema.extend({ id: noteIdSchema });
export type NoteUpdateInput = z.input<typeof noteUpdateSchema>;

export const notePreviewSchema = z.object({
  contentMd: z
    .string({ invalid_type_error: "The note must be text." })
    .refine((value) => utf8ByteLength(value) <= NOTE_MAX_BYTES, `Notes are limited to ${NOTE_MAX_BYTES / 1024} KB.`),
});

/**
 * A short plain-text excerpt of a Markdown note for the list view (the
 * full note is rendered through the sanitised helper on its own page).
 */
export function noteExcerpt(markdown: string, max = 180): string {
  const text = markdown
    .replace(/```[\s\S]*?(```|$)/g, " ") // fenced code
    .replace(/<[^>]*>/g, " ") // raw HTML
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1") // images → alt text
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1") // links → text
    .replace(/^\s{0,3}(#{1,6}\s+|>\s?|[-*+]\s+|\d+[.)]\s+)/gm, "") // block markers
    .replace(/[*_~`|]+/g, "") // inline marks, table pipes
    .replace(/\s+/g, " ")
    .trim();
  const chars = Array.from(text);
  return chars.length <= max ? text : `${chars.slice(0, max - 1).join("").trimEnd()}…`;
}
