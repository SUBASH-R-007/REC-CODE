import "server-only";
import { createReadStream } from "node:fs";
import { stat, readFile } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { z } from "zod";
import { db } from "@/lib/db";
import { env } from "@/lib/env";
import { EXAM_BROWSER_SETTING_KEY, examBrowserSettingSchema } from "@/lib/exam/exam-browser-setting";

/**
 * Handing a candidate the installer (Phase 14i).
 *
 * Until now `/exam-browser` told a candidate to ask their department for a
 * copy, and the deployment served the files from the edge as static paths.
 * That was fine for the bytes and wrong for the control: a static path
 * cannot be turned off from a screen, so the super-admin's switch would
 * have been a switch over the link and not over the download. One door,
 * one switch — so the application serves the file and the setting decides.
 *
 * The cost is honest: a download now occupies a worker for as long as it
 * takes. It is streamed rather than read into memory, and an installer is
 * already compressed so nothing re-compresses it, but a hall of two
 * hundred candidates downloading at once is load the edge used to absorb.
 * `docs/RUNBOOK.md` §2.20 says to have them install the day before, which
 * is the actual answer.
 *
 * **Nothing here takes a filename from a request.** The platform key is
 * matched against a fixed list, the filename comes out of the manifest the
 * college published, and the resolved path is checked to be inside the
 * directory before anything is opened. A download route that joins a
 * request string onto a directory is how a server ends up serving its own
 * environment file.
 */

/** The platforms a build may exist for. A request naming anything else is refused. */
export const EXAM_BROWSER_PLATFORMS = ["win-x64", "mac-arm64", "mac-x64", "linux-x64"] as const;
export type ExamBrowserPlatform = (typeof EXAM_BROWSER_PLATFORMS)[number];

export function isExamBrowserPlatform(value: string): value is ExamBrowserPlatform {
  return (EXAM_BROWSER_PLATFORMS as readonly string[]).includes(value);
}

/** What a candidate's machine most likely is, from its user agent. A hint, never a gate. */
export function likelyPlatform(userAgent: string | null): ExamBrowserPlatform | null {
  const ua = (userAgent ?? "").toLowerCase();
  if (ua.includes("windows")) return "win-x64";
  if (ua.includes("mac os") || ua.includes("macintosh")) {
    // Apple Silicon is not in the user agent at all: Safari and Chrome both
    // report Intel on an M-series Mac. So this guesses arm64, which is what
    // a Mac bought since 2020 is, and the page lists the other one plainly
    // rather than hiding it behind the guess.
    return "mac-arm64";
  }
  if (ua.includes("linux") && !ua.includes("android")) return "linux-x64";
  return null;
}

const platformEntrySchema = z.object({
  file: z
    .string()
    .trim()
    .min(1)
    /**
     * A plain filename and nothing else. No separator, no `..`, no drive
     * letter — the manifest is a file on the server and not a request, but
     * it is also the one input to a path join on this page, and a typo in
     * it should fail here rather than somewhere more interesting.
     */
    .refine((value) => /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value), "A plain filename, with no path in it."),
  bytes: z.number().int().nonnegative().optional(),
  sha256: z
    .string()
    .trim()
    .regex(/^[0-9a-f]{64}$/, "A sha256 hex digest.")
    .optional(),
  signed: z.boolean().optional(),
});

export const examBrowserManifestSchema = z.object({
  version: z.string().trim().min(1),
  releasedAt: z.string().trim().optional(),
  notes: z.string().trim().max(500).optional(),
  platforms: z.record(z.string(), platformEntrySchema),
});
export type ExamBrowserManifest = z.infer<typeof examBrowserManifestSchema>;

export interface DownloadOffer {
  readonly platform: ExamBrowserPlatform;
  readonly label: string;
  readonly file: string;
  readonly bytes: number | null;
  readonly sha256: string | null;
  readonly signed: boolean;
}

export const PLATFORM_LABELS: Readonly<Record<ExamBrowserPlatform, string>> = Object.freeze({
  "win-x64": "Windows",
  "mac-arm64": "macOS (Apple silicon)",
  "mac-x64": "macOS (Intel)",
  "linux-x64": "Linux",
});

export type DownloadsState =
  | { readonly available: true; readonly version: string; readonly offers: readonly DownloadOffer[] }
  | { readonly available: false; readonly reason: "switched_off" | "not_configured" | "no_build" };

/** Is the switch on? Off unless a super-admin turned it on. */
export async function downloadsSwitchedOn(): Promise<boolean> {
  const row = await db.platformSetting.findUnique({
    where: { key: EXAM_BROWSER_SETTING_KEY },
    select: { value: true },
  });
  if (!row) return false;
  const parsed = examBrowserSettingSchema.safeParse(row.value);
  // An unreadable setting means off, which is the opposite direction from
  // the version floor above it and right for the same reason: a floor that
  // cannot be read must not lock a hall out, and a download switch that
  // cannot be read must not publish files nobody chose to publish.
  return parsed.success ? parsed.data.downloadsEnabled === true : false;
}

/** Where the published installers live, or null when the deployment has none. */
function downloadDir(): string | null {
  const dir = env().EXAM_BROWSER_DOWNLOAD_DIR;
  return dir && dir.trim() !== "" ? path.resolve(dir.trim()) : null;
}

async function readManifest(dir: string): Promise<ExamBrowserManifest | null> {
  try {
    const raw = await readFile(path.join(dir, "latest.json"), "utf8");
    const parsed = examBrowserManifestSchema.safeParse(JSON.parse(raw) as unknown);
    if (!parsed.success) {
      console.error("[exam-browser] latest.json does not parse; downloads are unavailable");
      return null;
    }
    return parsed.data;
  } catch {
    return null;
  }
}

/**
 * What the page should offer, and why it offers nothing when it does not.
 *
 * Three separate "no"s, because they need three different sentences: the
 * switch is off (somebody chose that), nothing is configured (an ops
 * problem), or the manifest names no build (a publishing problem).
 */
export async function examBrowserDownloads(): Promise<DownloadsState> {
  if (!(await downloadsSwitchedOn())) return { available: false, reason: "switched_off" };
  return examBrowserBuilds();
}

/**
 * What is on the disk, with the switch ignored.
 *
 * Separate from the question above it because the super-admin screen has
 * to answer a third thing: whether turning the switch ON would offer
 * anything. Folded together, a deployment with the switch off reports
 * "switched_off" and nothing else, and the screen could not warn somebody
 * about to publish a download of nothing.
 */
export async function examBrowserBuilds(): Promise<DownloadsState> {
  const dir = downloadDir();
  if (!dir) return { available: false, reason: "not_configured" };
  const manifest = await readManifest(dir);
  if (!manifest) return { available: false, reason: "not_configured" };

  const offers: DownloadOffer[] = [];
  for (const platform of EXAM_BROWSER_PLATFORMS) {
    const entry = manifest.platforms[platform];
    if (!entry) continue;
    // Listed only if the file is actually there. A button that 404s on a
    // candidate the morning of a paper is worse than no button.
    const resolved = resolveInside(dir, entry.file);
    if (!resolved) continue;
    const size = await stat(resolved).catch(() => null);
    if (!size?.isFile()) continue;
    offers.push({
      platform,
      label: PLATFORM_LABELS[platform],
      file: entry.file,
      bytes: entry.bytes ?? size.size,
      sha256: entry.sha256 ?? null,
      signed: entry.signed ?? false,
    });
  }

  if (offers.length === 0) return { available: false, reason: "no_build" };
  return { available: true, version: manifest.version, offers };
}

/**
 * Join a manifest filename onto the directory and refuse anything that
 * escapes it.
 *
 * The filename is already pattern-checked by the schema, so this is the
 * second of two locks on the same door. It is here because the first lock
 * lives in a file a person edits on a server, and "the manifest is
 * trusted" is exactly the assumption that stops being true once somebody
 * generates one with a script.
 */
function resolveInside(dir: string, file: string): string | null {
  const resolved = path.resolve(dir, file);
  const root = dir.endsWith(path.sep) ? dir : dir + path.sep;
  return resolved.startsWith(root) ? resolved : null;
}

export interface DownloadFile {
  readonly stream: ReadableStream<Uint8Array>;
  readonly bytes: number;
  readonly filename: string;
}

/**
 * Open the installer for a platform, or null for every reason there is not
 * one — the route turns all of them into the same 404 on purpose, because
 * the difference between "switched off" and "not published" is not a
 * candidate's business and is on the page above the button anyway.
 */
export async function openExamBrowserDownload(platform: ExamBrowserPlatform): Promise<DownloadFile | null> {
  const state = await examBrowserDownloads();
  if (!state.available) return null;
  const offer = state.offers.find((candidate) => candidate.platform === platform);
  const dir = downloadDir();
  if (!offer || !dir) return null;
  const resolved = resolveInside(dir, offer.file);
  if (!resolved) return null;
  const size = await stat(resolved).catch(() => null);
  if (!size?.isFile()) return null;

  /**
   * Streamed, never read into memory: these are tens of megabytes and a
   * hall downloads them at the same time. `Readable.toWeb` rather than a
   * cast — a Node stream is not a web one, and handing a `Response` the
   * wrong object fails at run time on the one path nothing here exercises
   * until a candidate is standing in front of it.
   */
  const stream = Readable.toWeb(createReadStream(resolved)) as ReadableStream<Uint8Array>;
  return { stream, bytes: size.size, filename: offer.file };
}
