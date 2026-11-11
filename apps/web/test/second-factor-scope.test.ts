import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * WHERE the second-factor requirement bites, read off the guards themselves
 * (Phase 16j).
 *
 * This is a fence over a DECISION rather than over an implementation
 * detail, and the decision was made twice. The check was in `requireUser`
 * first, which covered every authenticated page — and
 * `capability-matrix.test.ts` refused it, correctly: the base guard of the
 * whole product would have read the database BEFORE deciding the caller's
 * role, so a caller it was about to send away cost a query. Moving it after
 * the role check also moved it onto the ACTION guard, which matters more
 * than any page, and left open the pages every signed-in account has.
 *
 * Which means two things have to stay true together, and neither is visible
 * from the other: the guards enforce it where they do, and the copy on
 * `/super/settings/policy` and `/account/two-factor` describes exactly
 * that. A source-level fence is the right shape for it — the behavioural
 * halves are covered (the role guards by `capability-matrix.test.ts`, the
 * policy itself by `second-factor.db.test.ts`), and what is NOT otherwise
 * provable is the absence of a check in `requireUser`.
 */

const GUARDS = path.join(__dirname, "..", "src", "lib", "auth", "guards.ts");

/** A guard's body: from its signature to the next top-level `}`. */
function bodyOf(source: string, name: string): string {
  const start = source.indexOf(`export async function ${name}(`);
  expect(start, `${name} is exported from guards.ts`).toBeGreaterThan(-1);
  const end = source.indexOf("\n}", start);
  expect(end, `${name} has a body`).toBeGreaterThan(start);
  return source.slice(start, end);
}

/** Comments stripped, so a doc comment naming a call does not count as one. */
function codeOf(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
}

describe("the second-factor requirement is enforced after the role check", () => {
  const source = readFileSync(GUARDS, "utf8");

  it.each(["requirePageRole", "requireActionRole"])("%s enforces it", (name) => {
    const body = codeOf(bodyOf(source, name));
    expect(body, `${name} calls mustEnrolSecondFactor`).toContain("mustEnrolSecondFactor");
    // AFTER the role check: a guard that read the database before deciding
    // the role would touch it for a caller it was about to send away.
    const role = body.indexOf("roles.includes(user.role)");
    const check = body.indexOf("mustEnrolSecondFactor");
    expect(role, `${name} checks the role`).toBeGreaterThan(-1);
    expect(check, `${name} checks the factor after the role`).toBeGreaterThan(role);
  });

  it("requireUser does NOT, which is what leaves the dashboard and profile open", () => {
    const body = codeOf(bodyOf(source, "requireUser"));
    expect(body).not.toContain("mustEnrolSecondFactor");
    // It still bounces an initial password, which is the restriction this
    // one was modelled on and the reason the two are easy to confuse.
    expect(body).toContain("mustChangePassword");
  });

  it("the composite guards delegate, so none of them needs its own copy", () => {
    // `requireSuperAdminPage`, `requireSuperAdmin`, the placement pair and
    // the mentor pair all await one of the two above, so they inherit the
    // check. If one ever stopped delegating, it would lose it silently —
    // which is what this asserts.
    for (const name of [
      "requireSuperAdminPage",
      "requireSuperAdmin",
      "requirePlacementPage",
      "requirePlacementAction",
      "requireMentorPage",
      "requireMentorAction",
    ]) {
      const body = codeOf(bodyOf(source, name));
      expect(body, `${name} delegates to a role guard`).toMatch(/require(Page|Action)Role\(/);
    }
  });
});

describe("the copy says what the guards do, and no more", () => {
  const read = (...parts: string[]) => readFileSync(path.join(__dirname, "..", "src", ...parts), "utf8");

  it("the policy card does not claim the enrolment page is the only page reachable", () => {
    const card = read("components", "super", "second-factor-policy-form.tsx");
    // The sentence this replaced said "reaches only /account/two-factor",
    // which stopped being true the moment the check moved off `requireUser`.
    expect(card).not.toMatch(/reaches only/i);
    expect(card.replace(/\s+/g, " ")).toContain("every admin page and every staff action refuses");
    expect(card.replace(/\s+/g, " ")).toContain("their dashboard and profile — still open");
  });

  it("the enrolment page does not either", () => {
    const page = read("app", "(onboarding)", "account", "two-factor", "page.tsx");
    expect(page).not.toMatch(/the only page you can reach/i);
    // Whitespace-insensitive: the formatter wraps this sentence across
    // lines, and a fence that cared where would fail on a reflow.
    expect(page.replace(/\s+/g, " ")).toContain("every admin page and every admin action sends you back here");
    expect(page.replace(/\s+/g, " ")).toContain("Your own dashboard and profile still work");
  });
});
