import { describe, expect, it } from "vitest";
import { CODE_EXTENSIONS, findFiles, isTestPath, lexSource, lineAt, readRepoFile } from "./support/repo";

/**
 * Caching cannot be allowed to serve one student another student's data
 * (Phase 10c).
 *
 * Every other caching mistake is staleness: somebody sees an old statement,
 * an old company filter, a leaderboard a minute behind. This one is a
 * disclosure, and it has a specific shape. `unstable_cache` keys an entry on
 * the cache's key parts plus **the arguments the cached function was called
 * with** — and on nothing else. So a cached function that reads the caller's
 * identity ITSELF, rather than taking it as an argument, stores the first
 * caller's data under a key that every later caller shares. The page still
 * renders, the test still passes, and a student sees somebody else's
 * progress.
 *
 * Hence the rules below are about what a cached callback may READ, not about
 * what its key looks like: a `userId` the function receives as an argument is
 * already part of the key, and a `userId` it fetches from the session is not.
 *
 * Comments never count: the lexer blanks them before anything is matched.
 */

const WEB_SRC = "apps/web/src";

/**
 * Every module in apps/web that caches across requests, and why it is safe
 * to.
 *
 * An allowlist rather than a pattern, for the same reason the guard catalogue
 * is one: a new cross-request cache is a decision about what may be shown to
 * the wrong person, and it should be made once, in writing, rather than by
 * copying a line from a neighbouring file.
 */
const CACHED_READS: ReadonlyArray<{ file: string; why: string }> = [
  {
    file: "apps/web/src/lib/brand/theme.ts",
    why: "the single PlatformTheme row — the same bytes for every visitor, revalidated when a super admin saves it",
  },
  {
    file: "apps/web/src/server/queries/judge-languages.ts",
    why: "the enabled LanguageConfig rows: public toolchain facts, no user, node, problem or test data",
  },
  {
    file: "apps/web/src/server/queries/problems.ts",
    why: "a problem's live pointer, one frozen version's content under problem:{id}:v{n}, and the company filter options — all shared, with solve state and bookmarks read per request outside the cache",
  },
];

/**
 * What a cached callback may not read.
 *
 * Each of these answers "who is asking", and the answer would be frozen into
 * an entry keyed without it. `cookies(` and `headers(` are here as well as
 * the guards, because a cached function that reads a header needs no guard
 * to leak: the first caller's locale, device or address becomes everybody's.
 */
const IDENTITY_READS = [
  "requireUser",
  "requireActionUser",
  "requirePageRole",
  "requireAdmin",
  "requireSuperAdmin",
  "requireStudent",
  "requireMentorScope",
  "requirePlacement",
  "currentUser",
  "getSession",
  "sessionUser",
  "requestIpHash",
  "cookies(",
  "headers(",
] as const;

/** The call text of every `unstable_cache(…)` in a lexed source. */
function cachedCalls(code: string): Array<{ text: string; at: number }> {
  const calls: Array<{ text: string; at: number }> = [];
  const needle = "unstable_cache(";
  for (let i = code.indexOf(needle); i !== -1; i = code.indexOf(needle, i + 1)) {
    let depth = 0;
    let end = i + needle.length - 1;
    for (let k = end; k < code.length; k++) {
      const c = code[k];
      if (c === "(") depth++;
      else if (c === ")") {
        depth--;
        if (depth === 0) {
          end = k;
          break;
        }
      }
    }
    calls.push({ text: code.slice(i, end + 1), at: i });
  }
  return calls;
}

function webFiles(): string[] {
  return findFiles({ under: [WEB_SRC], extensions: CODE_EXTENSIONS }).filter((rel) => !isTestPath(rel));
}

describe("every cross-request cache is a decision somebody wrote down", () => {
  const callers = webFiles().filter((rel) => cachedCalls(lexSource(readRepoFile(rel)).code).length > 0);

  it("only the allowlisted modules cache across requests", () => {
    const allowed = new Set(CACHED_READS.map((entry) => entry.file));
    expect(callers.filter((rel) => !allowed.has(rel)), "a new unstable_cache call: add it to CACHED_READS with a reason").toEqual(
      [],
    );
  });

  it("every allowlisted module still caches, and says why", () => {
    // A stale allowlist entry is worse than none: it reads as a reviewed
    // decision about code that has moved.
    for (const entry of CACHED_READS) {
      expect(callers, `${entry.file} is allowlisted but no longer calls unstable_cache`).toContain(entry.file);
      expect(entry.why.length, entry.file).toBeGreaterThan(40);
    }
  });
});

describe("a cached callback may not read who is asking", () => {
  it("no unstable_cache call touches the session, a guard or a header", () => {
    const problems: string[] = [];
    for (const rel of webFiles()) {
      const { code } = lexSource(readRepoFile(rel));
      for (const call of cachedCalls(code)) {
        for (const read of IDENTITY_READS) {
          if (call.text.includes(read)) {
            problems.push(`${rel}:${lineAt(code, call.at)}  unstable_cache reads ${read}`);
          }
        }
      }
    }
    expect(problems).toEqual([]);
  });

  it("mutation check: the rule catches what it is meant to", () => {
    /**
     * The shape this fence exists for, written out: a cached read that takes
     * no user argument and fetches the user itself. Keyed on nothing, so the
     * first student's dashboard is served to the next one.
     */
    const leak = `
      const readMyProgress = unstable_cache(
        async () => {
          const user = await requireUser();
          return db.userProblemStatus.findMany({ where: { userId: user.id } });
        },
        ["my-progress"],
      );
    `;
    const { code } = lexSource(leak);
    const calls = cachedCalls(code);
    expect(calls).toHaveLength(1);
    expect(IDENTITY_READS.some((read) => calls[0]!.text.includes(read))).toBe(true);

    // And the safe shape, which takes the id as an argument — already part
    // of the cache key, because unstable_cache hashes its arguments.
    const safe = `
      const readProgress = unstable_cache(
        async (userId: string) => db.userProblemStatus.findMany({ where: { userId } }),
        ["progress"],
      );
    `;
    const safeCalls = cachedCalls(lexSource(safe).code);
    expect(safeCalls).toHaveLength(1);
    expect(IDENTITY_READS.some((read) => safeCalls[0]!.text.includes(read))).toBe(false);
  });
});

describe("a tag nobody revalidates is not a cache tag", () => {
  it("every tags: [X] has a revalidateTag(X) somewhere in apps/web", () => {
    /**
     * `tags` plus a 60-second `revalidate` reads as "event-driven, with a
     * backstop". If nothing ever revalidates the tag it is just a
     * 60-second cache, and a publish that should be visible at once is
     * visible in a minute — which is exactly the "the student saw the old
     * statement" bug, slowed down rather than removed.
     */
    const tagged: string[] = [];
    const revalidated = new Set<string>();
    for (const rel of webFiles()) {
      const { code } = lexSource(readRepoFile(rel));
      for (const match of code.matchAll(/tags:\s*\[([^\]]*)\]/g)) {
        for (const part of (match[1] ?? "").split(",")) {
          const name = part.trim();
          if (/^[A-Za-z_$][\w$]*$/.test(name)) tagged.push(name);
        }
      }
      for (const match of code.matchAll(/revalidateTag\(\s*([A-Za-z_$][\w$]*)\s*\)/g)) {
        revalidated.add(match[1]!);
      }
    }
    expect(tagged.length, "no cache tags found at all — this fence checked nothing").toBeGreaterThanOrEqual(3);
    expect([...new Set(tagged)].filter((tag) => !revalidated.has(tag))).toEqual([]);
  });
});

describe("the problem statement key is the version", () => {
  /**
   * The key builder lives in `lib/`, not in the query module: a cache tag
   * and a key builder are not queries, and the exposure sweep over
   * `server/queries/*` calls every export it finds as a student.
   */
  const key = lexSource(readRepoFile("apps/web/src/lib/problems/cache.ts")).code;
  const source = lexSource(readRepoFile("apps/web/src/server/queries/problems.ts")).code;

  it("builds problem:{id}:v{version}", () => {
    // SPEC §10's key. The version in it is what makes the entry immutable:
    // nothing is ever invalidated, only orphaned.
    expect(key).toMatch(/export function problemCacheKey\(problemId: string, version: number\): string/);
    expect(key, "the key must carry the version").toMatch(/problem:\$\{problemId\}:v\$\{version\}/);
  });

  it("is what the content read is keyed by", () => {
    expect(source).toMatch(/readWorkspaceContent\(problemCacheKey\(problem\.id, problem\.version\)/);
  });

  it("holds no hidden test data", () => {
    // The cached read loads sample test cases only, as the uncached one did.
    // A cache is a second place a hidden test could end up, and this is the
    // one that is not access-controlled at all.
    const content = source.slice(source.indexOf("const readWorkspaceContent"), source.indexOf("export const getProblemWorkspace"));
    expect(content).toContain("where: { isSample: true }");
    expect(content).not.toMatch(/isSample:\s*false/);
  });
});

describe("the leaderboard reads the table, so it renders with Redis down", () => {
  it("the leaderboard query touches no cache at all", () => {
    /**
     * SPEC §10 asks for a Redis ZSET for `ZREVRANK`; Phase 10c measured the
     * count it would replace at 5 ms over 50,000 rows — sixteen times this
     * campus — and did not build it (`docs/OPEN-QUESTIONS.md` has the
     * numbers and the thresholds that would change the decision).
     *
     * This test is the durable half of that decision. The day somebody adds
     * the ZSET, it fails, and the two things that must come with it are the
     * fallback to `XpBucket` when Redis is down — a leaderboard that 500s
     * because a cache is cold is worse than a slow one — and an answer for
     * the opt-out subtraction and the `lastXpAt` tiebreak, which one score
     * cannot express.
     */
    const source = lexSource(readRepoFile("apps/web/src/server/queries/leaderboard.ts")).code;
    expect(source, "a ZSET would need a documented fallback").not.toContain("@/lib/redis");
    expect(source).not.toContain("unstable_cache");
    expect(source, "the board is read from XpBucket").toContain('"XpBucket"');
  });
});

describe("`Cache-Control: public` and a session guard are mutually exclusive", () => {
  it("no route or page sets a public cache header behind a guard", () => {
    /**
     * `public` means a shared cache may store the response and hand it to
     * the next person who asks. On a route that just checked who is asking,
     * that is the same disclosure as a mis-keyed cache entry, one layer out
     * — and this one is served by a proxy nobody in this repository
     * controls.
     *
     * The platform currently sets no `public` header anywhere (statements
     * are not anonymous content here, and there is no CDN in the
     * topology — see docs/OPEN-QUESTIONS.md), so this fence is also the
     * record of that decision: the first `public` header added has to
     * justify itself against this test.
     */
    const problems: string[] = [];
    for (const rel of webFiles()) {
      const { code } = lexSource(readRepoFile(rel));
      const lower = code.toLowerCase();
      if (!/cache-control["'\s:]+[^"']*public/.test(lower)) continue;
      const guard = IDENTITY_READS.find((read) => code.includes(read));
      problems.push(guard ? `${rel}  sets Cache-Control: public and reads ${guard}` : `${rel}  sets Cache-Control: public`);
    }
    expect(problems).toEqual([]);
  });
});
