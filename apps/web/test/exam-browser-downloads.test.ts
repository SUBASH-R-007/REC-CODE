import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Handing a candidate the installer (Phase 14i).
 *
 * Two things are worth pinning here and they pull in opposite directions.
 * The switch must genuinely govern the DOWNLOAD — a control that only hid
 * a link would look identical on the settings screen and be worth almost
 * nothing — and the route must never let anything from a request, or from
 * a hand-edited manifest, reach a path.
 */

const state = vi.hoisted(() => ({
  setting: null as unknown,
  dir: undefined as string | undefined,
}));

vi.mock("@/lib/db", () => ({
  db: { platformSetting: { findUnique: async () => (state.setting === null ? null : { value: state.setting }) } },
}));
vi.mock("@/lib/env", () => ({ env: () => ({ EXAM_BROWSER_DOWNLOAD_DIR: state.dir }) }));

const {
  EXAM_BROWSER_PLATFORMS,
  examBrowserBuilds,
  examBrowserDownloads,
  isExamBrowserPlatform,
  likelyPlatform,
  openExamBrowserDownload,
} = await import("@/lib/exam/exam-browser-downloads");

const root = await mkdtemp(path.join(tmpdir(), "recx-downloads-"));
const INSTALLER = "REC-Exam-Browser-1.0.0-win-x64.exe";
const BYTES = Buffer.from("not really an installer, but it is a file");

async function publish(manifest: unknown, files: Record<string, Buffer> = { [INSTALLER]: BYTES }): Promise<string> {
  const dir = await mkdtemp(path.join(root, "pub-"));
  await writeFile(path.join(dir, "latest.json"), JSON.stringify(manifest), "utf8");
  for (const [name, body] of Object.entries(files)) await writeFile(path.join(dir, name), body);
  return dir;
}

const manifest = (over: Record<string, unknown> = {}) => ({
  version: "1.0.0",
  platforms: { "win-x64": { file: INSTALLER, bytes: BYTES.length, signed: true } },
  ...over,
});

beforeEach(() => {
  state.setting = { downloadsEnabled: true };
  state.dir = undefined;
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("the switch governs the download, not the link", () => {
  it("offers nothing when it is off", async () => {
    state.dir = await publish(manifest());
    state.setting = { downloadsEnabled: false };
    expect(await examBrowserDownloads()).toEqual({ available: false, reason: "switched_off" });
  });

  it("refuses the file itself when it is off, not merely the listing", async () => {
    /**
     * The whole point. A candidate who kept yesterday's link, or a script
     * with the URL in it, must get nothing — otherwise turning the switch
     * off would take away the button and leave the download.
     */
    state.dir = await publish(manifest());
    state.setting = { downloadsEnabled: false };
    expect(await openExamBrowserDownload("win-x64")).toBeNull();
  });

  it("is off when the setting has never been written", async () => {
    state.dir = await publish(manifest());
    state.setting = null;
    expect(await examBrowserDownloads()).toMatchObject({ available: false, reason: "switched_off" });
  });

  it("is off when the stored setting cannot be read", async () => {
    /**
     * The opposite direction from the version floor, deliberately. A floor
     * that cannot be read must not lock a hall out, so it means no floor; a
     * download switch that cannot be read must not publish files nobody
     * chose to publish, so it means off.
     */
    state.dir = await publish(manifest());
    state.setting = { downloadsEnabled: "yes please" };
    expect(await examBrowserDownloads()).toMatchObject({ available: false, reason: "switched_off" });
  });

  it("offers the build when it is on", async () => {
    state.dir = await publish(manifest());
    const result = await examBrowserDownloads();
    expect(result.available).toBe(true);
    expect(result.available === true && result.version).toBe("1.0.0");
    expect(result.available === true && result.offers[0]).toMatchObject({
      platform: "win-x64",
      label: "Windows",
      file: INSTALLER,
      bytes: BYTES.length,
      signed: true,
    });
  });
});

describe("what the settings screen can see that the public page cannot", () => {
  it("reads the disk with the switch ignored", async () => {
    /**
     * `examBrowserBuilds` exists so a super-admin about to turn the switch
     * on can be told there is nothing behind it. Folded into the function
     * above, a deployment with the switch off reports only "switched_off".
     */
    state.dir = await publish(manifest());
    state.setting = { downloadsEnabled: false };
    expect(await examBrowserDownloads()).toMatchObject({ reason: "switched_off" });
    expect(await examBrowserBuilds()).toMatchObject({ available: true, version: "1.0.0" });
  });

  it("says nothing is configured when no directory is set", async () => {
    state.dir = undefined;
    expect(await examBrowserBuilds()).toEqual({ available: false, reason: "not_configured" });
  });

  it("says nothing is configured when the manifest is missing or unreadable", async () => {
    state.dir = await mkdtemp(path.join(root, "empty-"));
    expect(await examBrowserBuilds()).toMatchObject({ reason: "not_configured" });

    const broken = await mkdtemp(path.join(root, "broken-"));
    await writeFile(path.join(broken, "latest.json"), "{ not json", "utf8");
    state.dir = broken;
    expect(await examBrowserBuilds()).toMatchObject({ reason: "not_configured" });
  });

  it("says no build when the manifest names a file that is not there", async () => {
    /**
     * Listed only if the file exists. A button that 404s on a candidate the
     * morning of a paper is worse than no button.
     */
    state.dir = await publish(manifest(), {});
    expect(await examBrowserBuilds()).toEqual({ available: false, reason: "no_build" });
  });
});

describe("nothing from a request, or a manifest, reaches a path", () => {
  it("refuses a platform key it does not know", async () => {
    for (const bad of ["../../etc", "win", "WIN-X64", "", "win-x64/../.."]) {
      expect(isExamBrowserPlatform(bad), bad).toBe(false);
    }
    for (const good of EXAM_BROWSER_PLATFORMS) expect(isExamBrowserPlatform(good), good).toBe(true);
  });

  it("refuses a manifest whose filename contains a path", async () => {
    /**
     * The manifest is a file on the server rather than a request, and it is
     * still the one input to a path join on this page. A separator in it
     * fails here, where the whole manifest is rejected, rather than
     * somewhere more interesting.
     */
    for (const file of ["../latest.json", "sub/dir.exe", "/etc/passwd", "..\\\\windows", ".hidden"]) {
      state.dir = await publish(manifest({ platforms: { "win-x64": { file } } }));
      expect(await examBrowserBuilds(), file).toMatchObject({ reason: "not_configured" });
    }
  });

  it("serves the bytes of the file the manifest names", async () => {
    state.dir = await publish(manifest());
    const open = await openExamBrowserDownload("win-x64");
    expect(open).not.toBeNull();
    expect(open?.filename).toBe(INSTALLER);
    expect(open?.bytes).toBe(BYTES.length);

    const chunks: Uint8Array[] = [];
    const reader = open!.stream.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) chunks.push(value);
    }
    expect(Buffer.concat(chunks).toString("utf8")).toBe(BYTES.toString("utf8"));
  });

  it("returns nothing for a platform with no build, even when others have one", async () => {
    state.dir = await publish(manifest());
    expect(await openExamBrowserDownload("linux-x64")).toBeNull();
  });

  it("does not follow a file outside the directory through a subdirectory", async () => {
    /**
     * Belt and braces over the filename pattern: even if a filename of
     * `sub` existed and pointed out of the tree, the resolved path is
     * checked to be inside the directory before anything is opened.
     */
    const dir = await mkdtemp(path.join(root, "nested-"));
    await mkdir(path.join(dir, "sub"), { recursive: true });
    await writeFile(path.join(dir, "secret.txt"), "not yours", "utf8");
    await writeFile(
      path.join(dir, "latest.json"),
      JSON.stringify({ version: "1.0.0", platforms: { "win-x64": { file: "sub" } } }),
      "utf8",
    );
    state.dir = dir;
    // `sub` is a directory, not a file, so it is not offered either way.
    expect(await examBrowserBuilds()).toMatchObject({ reason: "no_build" });
    expect(await openExamBrowserDownload("win-x64")).toBeNull();
  });
});

describe("which build to put first", () => {
  it("guesses from the user agent, and gives up rather than guessing wrongly", () => {
    expect(likelyPlatform("Mozilla/5.0 (Windows NT 10.0; Win64; x64)")).toBe("win-x64");
    expect(likelyPlatform("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)")).toBe("mac-arm64");
    expect(likelyPlatform("Mozilla/5.0 (X11; Linux x86_64)")).toBe("linux-x64");
    expect(likelyPlatform("Mozilla/5.0 (Linux; Android 14)")).toBeNull();
    expect(likelyPlatform(null)).toBeNull();
    expect(likelyPlatform("curl/8.5.0")).toBeNull();
  });
});
