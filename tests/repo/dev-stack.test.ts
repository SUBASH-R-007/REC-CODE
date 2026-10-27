import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { abs, findFiles, readRepoFile } from "./support/repo";

/**
 * The two facts about the development stack that an afternoon was spent
 * rediscovering (2026-10-21), fenced so the next person reads them instead.
 *
 * A sign-in that answered "Something went wrong … quote reference …" on every
 * attempt turned out not to be the product at all: `POST /api/auth/login`
 * logs a reference and returns `?error=unavailable` for ANY unexpected
 * exception, and the exception was Prisma's `P1001`. Two separate causes,
 * both specific to a Windows host with its services in WSL2, and both of
 * which make a healthy database look unreachable:
 *
 *   1. Windows resolves `localhost` to `::1` first, and WSL2 serves only the
 *      IPv4 loopback. `127.0.0.1:5433` connects; `localhost:5433` waits out
 *      a timeout and Prisma reports that the server cannot be reached. So
 *      the files a developer COPIES must not say `localhost` — if they do,
 *      every fresh checkout starts out broken in a way that reads as a bug
 *      in the sign-in page.
 *   2. WSL stops the distribution within seconds of its last session
 *      exiting, taking PostgreSQL, Redis and isolate with it — and any
 *      `wsl` command used to check restarts it, so it always looks healthy
 *      when asked. `scripts/dev/stack-up.ps1` holds it open, and the
 *      runbook has to point at it or nobody will run it.
 *
 * These are assertions about documentation and examples because that is
 * where the mistake lives. Nothing here touches the running stack.
 */

/** Files a developer copies into place, or runs commands out of, verbatim. */
const COPIED = [".env.example", "apps/web/.env.example", "docs/RUNBOOK.md"] as const;

const STACK_SCRIPT = "scripts/dev/stack-up.ps1";

describe("the development database address", () => {
  it.each(COPIED)("is the IPv4 loopback in %s, never localhost", (rel) => {
    const offenders = readRepoFile(rel)
      .split("\n")
      .map((line, index) => ({ line, at: index + 1 }))
      .filter(({ line }) => /@localhost:5433/.test(line));
    expect(
      offenders.map(({ at, line }) => `${rel}:${at}: ${line.trim()}`),
      "Windows resolves localhost to ::1, which WSL2 does not serve: use 127.0.0.1 (docs/RUNBOOK.md §1.1)",
    ).toEqual([]);
  });

  it("is explained where someone editing the example will see it", () => {
    for (const rel of [".env.example", "apps/web/.env.example"]) {
      expect(readRepoFile(rel), rel).toMatch(/::1/);
    }
  });
});

describe("holding the WSL2 distribution open", () => {
  it("has a script", () => {
    expect(existsSync(abs(STACK_SCRIPT)), `${STACK_SCRIPT} is missing`).toBe(true);
  });

  it("is checked from the Windows side, where the failure is", () => {
    const script = readRepoFile(STACK_SCRIPT);
    // The holder is the mechanism; dropping it would leave a script that
    // reports a stack which disappears the moment it exits.
    expect(script).toMatch(/sleep["',\s]+infinity/);
    // Both ports, dialled from Windows rather than asked about inside WSL2.
    expect(script).toMatch(/5433/);
    expect(script).toMatch(/6379/);
  });

  it("is where the runbook sends you", () => {
    const runbook = readRepoFile("docs/RUNBOOK.md");
    expect(runbook).toContain(STACK_SCRIPT);
    // §1.8 keeps the symptom searchable by the words the page actually shows.
    expect(runbook).toContain("quote reference");
  });
});

/**
 * The same restart, seen from the end-to-end suite (2026-10-21, CI run
 * 39480760114). `next dev` prints "Server is approaching the used memory
 * threshold, restarting..." and answers the request in flight with nothing,
 * so a `page.goto` that happens to be running fails with
 * `net::ERR_EMPTY_RESPONSE` — on that run, the global setup's very first
 * navigation, before a single assertion.
 *
 * `openPage()` retries that and only that. The rule is only useful if it
 * holds everywhere, and a `page.goto` added later would pass locally and
 * fail a run weeks afterwards, so the rule is a test rather than a note.
 */
describe("every navigation in the end-to-end suite", () => {
  const NAV = /\.goto\(/;
  /** The helper is where the one real `page.goto` lives. */
  const HELPER = "apps/web/e2e/support/page.ts";

  it("goes through openPage(), never page.goto()", () => {
    const files = findFiles({ under: ["apps/web/e2e"], extensions: [".ts"] }).filter((rel) => rel !== HELPER);
    const offenders = files.flatMap((rel) =>
      readRepoFile(rel)
        .split("\n")
        .map((line, index) => ({ rel, line: line.trim(), at: index + 1 }))
        .filter(({ line }) => NAV.test(line)),
    );
    expect(
      offenders.map(({ rel, at, line }) => `${rel}:${at}: ${line}`),
      `use openPage(page, …) from ${HELPER}: it survives the dev server restarting (apps/web/e2e/README.md)`,
    ).toEqual([]);
  });

  it("has the helper, and what the helper retries excludes timeouts", () => {
    const helper = readRepoFile(HELPER);
    expect(helper).toMatch(/export async function openPage/);
    // Only the retry PREDICATE is asserted, not the whole file: other
    // helpers here pass `timeout` options legitimately. A retry that
    // swallowed timeouts would turn a slow page — a finding — into a pass.
    const predicate = /const SERVER_WENT_AWAY =\s*([\s\S]*?);/.exec(helper)?.[1] ?? "";
    expect(predicate, "openPage must gate its retry on a named pattern").not.toBe("");
    expect(predicate).toMatch(/ERR_EMPTY_RESPONSE/);
    expect(predicate).not.toMatch(/timeout|timed out|ERR_TIMED/i);
  });
});
