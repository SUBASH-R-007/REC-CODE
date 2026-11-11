import { existsSync, readFileSync, statSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { abs, findFiles, isTestPath, readRepoFile } from "./support/repo";

/**
 * The college's mark: one asset, one component, and two places it must
 * not appear (Phase 13b).
 *
 * Three things can go quietly wrong with a logo, and all three are the
 * kind nobody notices until somebody outside the college is looking at
 * the page.
 *
 *   1. **The file goes away.** An `<img>` whose source 404s renders as a
 *      broken mark or as nothing at all, and no test in this repository
 *      would have failed. So the asset's existence is asserted here.
 *   2. **The file is replaced by a different shape.** The component hard
 *      codes the artwork's intrinsic width and height so the browser
 *      reserves the box before the bytes arrive; swap in a square logo
 *      and every page using it shifts as it loads. So the dimensions are
 *      asserted too, which is also the prompt to update them deliberately.
 *   3. **Somebody writes the path by hand** somewhere else, and then the
 *      white plaque, the alt text and the sizing are a copy that drifts.
 *
 * And the two places it must not appear:
 *
 *   - **inside a sitting.** SPEC §5 keeps that screen to the question,
 *     the clock and the answer. The readiness page carries the mark; the
 *     attempt page and the exam components carry nothing decorative.
 *   - **as the product's mark.** `Wordmark` says which application you
 *     are in; this says whose institution it is. A component that used
 *     the college's artwork as the app's own icon would be a different
 *     claim, and the tab icon deliberately stays the product's.
 */

const ASSET = "apps/web/public/brand/rec-college-logo.png";
const COMPONENT = "apps/web/src/components/brand/college-logo.tsx";
/** The artwork's own pixels, which the component writes as width/height. */
const INTRINSIC = { width: 288, height: 93 };

/** Read a PNG's IHDR, which is always the first chunk. */
function pngSize(rel: string): { width: number; height: number } {
  const bytes = readFileSync(abs(rel));
  const signature = bytes.subarray(0, 8).toString("hex");
  expect(signature, `${rel} is not a PNG`).toBe("89504e470d0a1a0a");
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

describe("the college mark", () => {
  it("is in the repository, as a PNG, and small enough to ship on a sign-in page", () => {
    expect(existsSync(abs(ASSET)), `${ASSET} is missing`).toBe(true);
    // 60 KB is generous for a wordmark and still catches somebody dropping
    // in a 2 MB export: this loads on the one page that must work on the
    // worst connection a student owns.
    expect(statSync(abs(ASSET)).size).toBeLessThan(60 * 1024);
  });

  it("has the dimensions the component reserves space for", () => {
    const actual = pngSize(ASSET);
    expect(actual).toEqual(INTRINSIC);
    const source = readRepoFile(COMPONENT);
    expect(source).toContain(`width: ${INTRINSIC.width}`);
    expect(source).toContain(`height: ${INTRINSIC.height}`);
  });

  it("is referenced by exactly one file, which is the component", () => {
    const users = findFiles({
      under: ["apps/web/src"],
      extensions: [".ts", ".tsx"],
      exclude: isTestPath,
    }).filter((file) => readRepoFile(file).includes("rec-college-logo"));
    expect(users).toEqual([COMPONENT]);
  });

  it("is not rendered inside a sitting", () => {
    /**
     * The readiness page is where a candidate confirms what they are
     * about to sit, and the mark belongs there. The sitting itself is
     * the question, the clock and the answer.
     */
    const inExam = findFiles({
      under: ["apps/web/src/components/exam", "apps/web/src/app/(exam)"],
      extensions: [".ts", ".tsx"],
      exclude: isTestPath,
    }).filter((file) => readRepoFile(file).includes("CollegeLogo"));
    expect(inExam).toEqual(["apps/web/src/app/(exam)/assessments/[slug]/readiness/page.tsx"]);
  });

  it("is not the product's mark, and the tab icon stays the product's", () => {
    // `Wordmark` draws the application's own mark and must not reach for
    // the college's artwork; the icon served to browsers is the product's
    // rounded square, because a wide wordmark is illegible at 16 px.
    expect(readRepoFile("apps/web/src/components/shell/wordmark.tsx")).not.toContain("rec-college-logo");
    expect(readRepoFile("apps/web/src/app/icon.svg")).not.toContain("rec-college-logo");
  });
});
