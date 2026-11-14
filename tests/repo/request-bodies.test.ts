import { describe, expect, it } from "vitest";
import { findFiles, isTestPath, lexSource, lineAt, readRepoFile } from "./support/repo";

/**
 * Every route handler that reads a request body bounds it first (Phase 17
 * security audit).
 *
 * **A route handler has no body limit of its own.** The 1 MB default belongs
 * to server actions; a `route.ts` will buffer whatever arrives. Worse,
 * `request.json()`, `request.text()`, `request.formData()` and
 * `request.arrayBuffer()` each consume the WHOLE stream before they resolve,
 * so a size check written after one of them bounds what is processed and not
 * what is allocated.
 *
 * The audit that produced this fence found, on a product that runs
 * invigilated exams:
 *
 *   * **eight** route handlers reading a body with no cap at all, including
 *     every live-exam route (`hb`, `mcq`, `run`), the mock-interview
 *     snapshot that fires from a candidate's editor every few seconds, and
 *     the unauthenticated exam-browser token exchange;
 *   * **two** more (`activity`, `vitals`) that awaited `request.text()` and
 *     then measured `text.length` — UTF-16 code units rather than bytes, and
 *     only reachable once the body was already in memory;
 *   * **five** separate copies of a correct streaming reader, which is why
 *     nobody noticed the routes that had none.
 *
 * One candidate posting one very large body could have exhausted the web
 * process serving the sitting to everybody else in the hall.
 *
 * So: the raw readers are banned in route handlers, and the bounded helpers
 * in `lib/http/body.ts` are the only way in. The helpers themselves are
 * exempt — they are where the raw read belongs.
 */

const API = "apps/web/src/app/api";

/** The only file allowed to call a raw body reader. */
const THE_HELPER = "apps/web/src/lib/http/body.ts";

/**
 * The bounded readers. A route that names one of these has gone through the
 * cap; `readJudgeBody` is the judge protocol's own, which caps before it
 * parses and is tested by the judge suites.
 */
const BOUNDED = ["readJsonBody", "readBoundedText", "readBoundedBody", "readFormBody", "readJudgeBody", "spoolRequestBody"];

/** A hand-rolled stream: `request.body` reached for directly. */
const BARE_BODY = new RegExp(String.raw`\b(?:request|req)\s*\.\s*body\b`);

/** Consuming the whole stream in one call, with no cap of any kind. */
const RAW_READ = /\b(?:request|req)\s*\.\s*(json|text|formData|arrayBuffer|blob)\s*\(\s*\)/g;

function routeHandlers(): string[] {
  return findFiles({ under: [API], extensions: [".ts"], exclude: isTestPath }).filter((f) => f.endsWith("/route.ts"));
}

export interface RawRead {
  readonly file: string;
  readonly line: number;
  readonly method: string;
}

/** Raw body reads in a file, ignoring comments and string literals. */
export function rawBodyReads(file: string, source: string): RawRead[] {
  const lexed = lexSource(source);
  // `lexSource` strips comments but keeps string bodies, and a doc example
  // in a string is not a call. Blank them, keeping every offset.
  const chars = [...lexed.code];
  for (const span of lexed.strings) {
    for (let i = span.start; i < span.end && i < chars.length; i++) chars[i] = " ";
  }
  const code = chars.join("");
  const out: RawRead[] = [];
  RAW_READ.lastIndex = 0;
  for (const m of code.matchAll(RAW_READ)) {
    out.push({ file, line: lineAt(source, m.index), method: m[1]! });
  }
  return out;
}

describe("Phase 17: a route handler never reads an unbounded body", () => {
  it("finds the route handlers it claims to (sanity)", () => {
    const routes = routeHandlers();
    expect(routes.length).toBeGreaterThan(20);
    expect(routes).toContain(`${API}/exam/[attemptId]/hb/route.ts`);
    expect(routes).toContain(`${API}/judge/result/route.ts`);
  });

  it("flags a raw read and ignores one in a comment or a string", () => {
    const flagged = rawBodyReads(
      "x.ts",
      ["const a = await request.json();", "// await request.text()", 'const s = "request.formData()";'].join("\n"),
    );
    expect(flagged.map((f) => f.method)).toEqual(["json"]);
  });

  it("no route handler calls a raw body reader", () => {
    const findings: string[] = [];
    for (const file of routeHandlers()) {
      for (const read of rawBodyReads(file, readRepoFile(file))) {
        findings.push(`${read.file}:${read.line} calls request.${read.method}() directly`);
      }
    }
    expect(
      findings,
      "Read the body through lib/http/body.ts: a raw reader buffers the whole stream before any size check can run.",
    ).toEqual([]);
  });

  it("no route handler streams request.body by hand", () => {
    /**
     * The other half: rule one bans the one-call readers, this bans rolling
     * your own loop. Four routes each had an identical copy of that loop
     * before this fence; one of them is `lib/http/body.ts` now, and
     * `spoolRequestBody` is the other legitimate consumer — it streams a
     * problem archive to disk under its own cap, so it never holds one in
     * memory at all.
     */
    const findings: string[] = [];
    for (const file of routeHandlers()) {
      const source = readRepoFile(file);
      const { code } = lexSource(source);
      if (!BARE_BODY.test(code)) continue;
      if (BOUNDED.some((name) => code.includes(name))) continue;
      findings.push(file);
    }
    expect(findings, "Stream the body through lib/http/body.ts, or spool it with its own cap.").toEqual([]);
  });

  it("the bounded helpers live in exactly one module", () => {
    const owners = findFiles({
      under: ["apps/web/src"],
      extensions: [".ts"],
      exclude: isTestPath,
    }).filter((f) => /^\s*export async function readBounded(?:Body|Text)\b/m.test(readRepoFile(f)));
    expect(owners, "The streaming cap is a security primitive: one copy, one place.").toEqual([THE_HELPER]);
  });
});
