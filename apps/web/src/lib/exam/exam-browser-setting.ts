import { z } from "zod";
import { parseVersion } from "@recx/shared";

/**
 * The deployment's REC Exam Browser setting (Phase 14f).
 *
 * One key, one field so far: the lowest application version this
 * deployment will accept. It is a `PlatformSetting` rather than an
 * environment variable because cutting off a known-bad build is a thing
 * somebody does at nine in the morning from a screen, and a redeploy is
 * not available then (`docs/EXAM-BROWSER.md` §8).
 *
 * Deliberately NOT in `packages/shared/src/exam-browser.ts`, even though
 * that is where the rest of the protocol lives. The Electron application
 * imports that module, zod is not small, and Phase 14c already shipped the
 * version of this mistake where a barrel import put 290 KB of unrelated
 * string tables into a binary that installs on a student's laptop. The
 * application never reads this setting — it is told its version is too old
 * by the server — so the schema stays on the server side.
 */

export const EXAM_BROWSER_SETTING_KEY = "exam-browser";

/**
 * A floor is either a version or absent. The empty string means "accept
 * any version" and is stored as an absent field rather than as `""`, so
 * there is one representation of "no floor" rather than two.
 */
export const examBrowserSettingSchema = z.object({
  minVersion: z
    .string()
    .trim()
    .refine((value) => parseVersion(value) !== null, "Give a version like 1.2.0.")
    .optional(),
});

export type ExamBrowserSetting = z.infer<typeof examBrowserSettingSchema>;

export interface VersionFloor {
  /** The floor to apply, or null for "accept any version". */
  readonly floor: string | null;
  /** True when a stored value existed and could not be read. */
  readonly unreadable: boolean;
}

/**
 * What floor a stored setting means.
 *
 * A function over a plain value rather than three lines inside the
 * containment check, because the one thing that matters here is the
 * direction it fails in and that is exactly the kind of decision nothing
 * reaches when it is inline. `meetsVersionFloor` compares three numbers, so
 * a floor that is not three numbers would refuse every build in the hall --
 * an unreadable setting must therefore mean NO floor, not a floor nothing
 * can satisfy. It says so out loud as well, because a setting somebody saved
 * and that is being ignored should not be ignored silently.
 */
export function versionFloorOf(value: unknown): VersionFloor {
  if (value === null || value === undefined) return { floor: null, unreadable: false };
  const parsed = examBrowserSettingSchema.safeParse(value);
  if (!parsed.success) return { floor: null, unreadable: true };
  return { floor: parsed.data.minVersion ?? null, unreadable: false };
}
