#!/usr/bin/env node
/**
 * Build a DEVELOPMENT installer of REC Exam Browser (Phase 14k).
 *
 *   pnpm --filter @recx/exam-browser release:dev
 *   pnpm --filter @recx/exam-browser release:dev --origin http://localhost:3100
 *   pnpm --filter @recx/exam-browser release:dev --dir      (unpacked, no installer)
 *
 * What this is for: testing the REAL installed shape -- the NSIS installer,
 * the system-wide `recx-exam://` registration, a cold start from a Launch
 * button -- against a server on this laptop. `pnpm dev` runs the same code
 * and is faster, so reach for this only when the thing being tested is the
 * install itself.
 *
 * What it is NOT for: a hall. A development build accepts origins a
 * release build refuses, so nothing it shows is proof of anything. Four
 * things keep the two apart, and all four are here rather than in a
 * comment somebody can ignore:
 *
 *   * a different `appId` and its own install directory, so it installs
 *     BESIDE a release build and uninstalls without taking that build's
 *     files with it;
 *   * a different `productName`, so the Start menu and the uninstall list
 *     say which one it is;
 *   * a different `artifactName`, so the file on disk says so too;
 *   * a modal dialog before the window opens, from `config.ts`.
 *
 * It is never signed and it is never published: `deploy/exam-browser/`
 * takes what CI built, and `deploy/exam-browser/README.md` says to publish
 * what CI produced rather than what a laptop did.
 */
import { spawnSync } from "node:child_process";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const APP_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const argv = process.argv.slice(2);
const originIndex = argv.indexOf("--origin");
const origin = originIndex === -1 ? "http://localhost:3000" : argv[originIndex + 1];
const unpackedOnly = argv.includes("--dir");

if (!origin) {
  console.error("--origin needs a value, e.g. --origin http://localhost:3100");
  process.exit(1);
}
for (const entry of origin.split(",")) {
  try {
    const parsed = new URL(entry.trim());
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error("scheme");
  } catch {
    console.error(`Not a usable origin: ${entry.trim()}`);
    process.exit(1);
  }
}

/**
 * The overrides, as `-c.key=value` rather than a second configuration
 * file. One file is the one `tests/repo/exam-browser-posture.test.ts`
 * reads, and a second one would be a second place for the posture to drift
 * out of -- the fence would go on passing while the thing a college
 * installs quietly stopped matching it.
 */
const OVERRIDES = [
  "-c.appId=in.edu.rec.code.exam-browser.dev",
  /**
   * Its own install directory, and this one is not cosmetic. NSIS derives
   * the directory from the PACKAGE name rather than the product name, so
   * without this both builds land in the same folder, share one copy of
   * Chromium, and uninstalling either one deletes the files the other
   * still needs. Found by installing them side by side and reading the
   * directory.
   */
  "-c.extraMetadata.name=recx-exam-browser-dev",
  "-c.productName=REC Exam Browser (development)",
  "-c.artifactName=REC-Exam-Browser-${version}-dev-${os}-${arch}.${ext}",
  // A desktop shortcut is right here and wrong in a release: this one is
  // started by hand while something is being tested.
  "-c.nsis.createDesktopShortcut=true",
];

const environment = {
  ...process.env,
  RECX_EXAM_BUILD_CHANNEL: "development",
  RECX_EXAM_DEV_ORIGIN: origin,
};

console.log(`[build-dev] development build, allowed origins: ${origin} (plus the compiled release origins)`);

/**
 * `shell: true` is needed on Windows, where `npx` is a `.cmd` shim and
 * cannot be spawned without one -- and a shell does its own word
 * splitting, so an override carrying spaces has to be quoted or
 * electron-builder sees `Exam`, `Browser` and `(development)` as three
 * unknown arguments. The first run of this script did exactly that.
 */
const quoted = (argument) => (/[\s()]/.test(argument) ? `"${argument}"` : argument);

const run = (command, args) => {
  const result = spawnSync(command, args.map(quoted), {
    cwd: APP_DIR,
    env: environment,
    stdio: "inherit",
    shell: true,
  });
  if (result.status !== 0) process.exit(result.status ?? 1);
};

run("npx", ["tsup"]);
run("npx", ["electron-builder", ...(unpackedOnly ? ["--dir"] : []), ...OVERRIDES]);

console.log(
  "[build-dev] done. This build is NOT for an exam hall and is never published; " +
    "deploy/exam-browser/README.md publishes what CI built.",
);
