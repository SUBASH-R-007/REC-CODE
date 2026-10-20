import { z } from "zod";

/**
 * Profile settings: the zod schema the server action parses with, plus the
 * limits the form renders from. User.editorPrefs is plain JSON that other
 * keys (e.g. a keymap) may share; only fontSize and tabSize are owned here.
 */

export const BIO_MAX = 280;
export const FONT_SIZE_MIN = 12;
export const FONT_SIZE_MAX = 20;
export const TAB_SIZES = [2, 4] as const;
export type TabSize = (typeof TAB_SIZES)[number];

export interface EditorPrefs {
  fontSize: number;
  tabSize: TabSize;
}

export const EDITOR_PREFS_DEFAULT: Readonly<EditorPrefs> = Object.freeze({ fontSize: 14, tabSize: 4 });

const fontSizeSchema = z.coerce
  .number({ invalid_type_error: "Choose an editor font size." })
  .int("Choose a whole-number font size.")
  .min(FONT_SIZE_MIN, `The editor font size must be between ${FONT_SIZE_MIN} and ${FONT_SIZE_MAX}.`)
  .max(FONT_SIZE_MAX, `The editor font size must be between ${FONT_SIZE_MIN} and ${FONT_SIZE_MAX}.`);

const tabSizeSchema = z.coerce
  .number({ invalid_type_error: "Choose a tab size." })
  .refine((v): v is TabSize => (TAB_SIZES as readonly number[]).includes(v), "The tab size must be 2 or 4 spaces.")
  .transform((v) => v as TabSize);

/** Read User.editorPrefs leniently: each valid key is kept, anything else falls back to the default. */
export function readEditorPrefs(json: unknown): EditorPrefs {
  const obj = json && typeof json === "object" && !Array.isArray(json) ? (json as Record<string, unknown>) : {};
  const fontSize = fontSizeSchema.safeParse(obj.fontSize);
  const tabSize = tabSizeSchema.safeParse(obj.tabSize);
  return {
    fontSize: fontSize.success ? fontSize.data : EDITOR_PREFS_DEFAULT.fontSize,
    tabSize: tabSize.success ? tabSize.data : EDITOR_PREFS_DEFAULT.tabSize,
  };
}

/** Merge new editor prefs into the stored JSON, keeping keys this form does not own. */
export function mergeEditorPrefs(stored: unknown, prefs: EditorPrefs): Record<string, unknown> {
  const base = stored && typeof stored === "object" && !Array.isArray(stored) ? (stored as Record<string, unknown>) : {};
  return { ...base, fontSize: prefs.fontSize, tabSize: prefs.tabSize };
}

// Control characters other than tab and newline never belong in a bio.
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u0008\u000B-\u001F\u007F]/g;

/** Normalise a bio: unify newlines, drop control characters, at most one blank line in a row, trim. */
export function normalizeBio(raw: string): string {
  return raw
    .replace(/\r\n?/g, "\n")
    .replace(CONTROL_CHARS, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Length as a person counts it (code points, so an emoji is one character). */
export function bioLength(bio: string): number {
  return Array.from(bio).length;
}

const checkbox = z.preprocess((v) => v === true || v === "on" || v === "true", z.boolean());

export const settingsSchema = z.object({
  visibility: z.enum(["PUBLIC", "REC_ONLY", "PRIVATE"], {
    errorMap: () => ({ message: "Choose who can see your profile." }),
  }),
  leaderboardOptOut: checkbox,
  bio: z
    .string({ invalid_type_error: "Your bio must be text." })
    .max(4_000, `Keep your bio to ${BIO_MAX} characters or fewer.`)
    .transform(normalizeBio)
    .refine((bio) => bioLength(bio) <= BIO_MAX, `Keep your bio to ${BIO_MAX} characters or fewer.`),
  fontSize: fontSizeSchema,
  tabSize: tabSizeSchema,
});

export type SettingsInput = z.input<typeof settingsSchema>;
export type Settings = z.output<typeof settingsSchema>;

/** The raw form fields, for settingsSchema.parse(). */
export function settingsFromForm(form: FormData): Record<string, unknown> {
  return {
    visibility: form.get("visibility"),
    leaderboardOptOut: form.get("leaderboardOptOut"),
    bio: form.get("bio") ?? "",
    fontSize: form.get("fontSize"),
    tabSize: form.get("tabSize"),
  };
}
