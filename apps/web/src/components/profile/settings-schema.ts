import { z } from "zod";
import { EDITOR_KEYMAPS, EDITOR_KEYMAP_DEFAULT, type EditorKeymap } from "@recx/shared";

/**
 * Profile settings: the zod schema the server action parses with, plus the
 * limits the form renders from. User.editorPrefs is plain JSON; fontSize,
 * tabSize and (Phase 12j) keymap are owned here, and any other key a later
 * phase adds is kept rather than overwritten.
 */

export const BIO_MAX = 280;
export const FONT_SIZE_MIN = 12;
export const FONT_SIZE_MAX = 20;
export const TAB_SIZES = [2, 4] as const;
export type TabSize = (typeof TAB_SIZES)[number];

export interface EditorPrefs {
  fontSize: number;
  tabSize: TabSize;
  /** Phase 12j. Applied in practice and contests; never in a proctored exam. */
  keymap: EditorKeymap;
}

export const EDITOR_PREFS_DEFAULT: Readonly<EditorPrefs> = Object.freeze({
  fontSize: 14,
  tabSize: 4,
  keymap: EDITOR_KEYMAP_DEFAULT,
});

/**
 * The line height for a font size, in CSS px.
 *
 * One function, because three editors have to agree on it: Monaco's own
 * option, CodeMirror's theme, and the plain textarea that stands in before
 * either has loaded. A caret-reveal calculation against the wrong line
 * height scrolls to the wrong place.
 */
export function editorLineHeight(fontSize: number): number {
  return Math.round(fontSize * 1.5);
}

const fontSizeSchema = z.coerce
  .number({ invalid_type_error: "Choose an editor font size." })
  .int("Choose a whole-number font size.")
  .min(FONT_SIZE_MIN, `The editor font size must be between ${FONT_SIZE_MIN} and ${FONT_SIZE_MAX}.`)
  .max(FONT_SIZE_MAX, `The editor font size must be between ${FONT_SIZE_MIN} and ${FONT_SIZE_MAX}.`);

const keymapSchema = z.enum(EDITOR_KEYMAPS, {
  errorMap: () => ({ message: "Choose an editor keymap." }),
});

const tabSizeSchema = z.coerce
  .number({ invalid_type_error: "Choose a tab size." })
  .refine((v): v is TabSize => (TAB_SIZES as readonly number[]).includes(v), "The tab size must be 2 or 4 spaces.")
  .transform((v) => v as TabSize);

/** Read User.editorPrefs leniently: each valid key is kept, anything else falls back to the default. */
export function readEditorPrefs(json: unknown): EditorPrefs {
  const obj = json && typeof json === "object" && !Array.isArray(json) ? (json as Record<string, unknown>) : {};
  const fontSize = fontSizeSchema.safeParse(obj.fontSize);
  const tabSize = tabSizeSchema.safeParse(obj.tabSize);
  const keymap = keymapSchema.safeParse(obj.keymap);
  return {
    fontSize: fontSize.success ? fontSize.data : EDITOR_PREFS_DEFAULT.fontSize,
    tabSize: tabSize.success ? tabSize.data : EDITOR_PREFS_DEFAULT.tabSize,
    keymap: keymap.success ? keymap.data : EDITOR_PREFS_DEFAULT.keymap,
  };
}

/** Merge new editor prefs into the stored JSON, keeping keys this form does not own. */
export function mergeEditorPrefs(stored: unknown, prefs: EditorPrefs): Record<string, unknown> {
  const base = stored && typeof stored === "object" && !Array.isArray(stored) ? (stored as Record<string, unknown>) : {};
  return { ...base, fontSize: prefs.fontSize, tabSize: prefs.tabSize, keymap: prefs.keymap };
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
  keymap: keymapSchema,
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
    keymap: form.get("keymap") ?? EDITOR_PREFS_DEFAULT.keymap,
  };
}
