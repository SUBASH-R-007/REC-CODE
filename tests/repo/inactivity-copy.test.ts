import { describe, expect, it } from "vitest";
import { CODE_EXTENSIONS, findFiles, lexSource, lineAt, readRepoFile } from "./support/repo";

/**
 * Two fences over Phase 8's most dangerous surfaces.
 *
 * ── 1. The route out stays reachable ─────────────────────────────────────
 *
 * SPEC §7 says plainly: "do not require admin approval to clear a soft
 * restriction", and the spec's reason is that anything requiring approval
 * turns a ten-day lapse into a permanent exit — the administrator is busy,
 * and the student gives up.
 *
 * So `account#selfClearRestriction` must be guarded by `requireActionUser()`
 * and NOTHING stronger. This is exactly the kind of rule a later, well-meant
 * "hardening" pass breaks: adding a role check reads like an improvement and
 * is in fact the removal of the only route out of a restriction. A comment
 * would not survive that pass. A failing test will.
 *
 * ── 2. "Disabled" never reaches a student ────────────────────────────────
 *
 * SPEC §5: "Keep the word 'disabled' out of student-facing copy." Not
 * squeamishness: a student who reads that they are disabled believes they
 * have been thrown off the platform and stops trying, which is the exact
 * outcome a policy about non-progress must not cause. Every one of these
 * states is reversible, and the top one is reversible by a human who can be
 * asked — so "paused" is both gentler AND more accurate.
 *
 * The fence reads the student surfaces as SOURCE TEXT, because that is what
 * a reader of the rendered page sees. `RESTRICTION_STAGE_ADMIN_LABEL` is
 * allowed to say "Disabled" and lives in a module these surfaces do not
 * render from; the fence checks the student files, not the whole repo.
 */

const SRC = "apps/web/src";

/** Student-facing Phase 8 surfaces: the copy a restricted student reads. */
const STUDENT_SURFACES = [
  `${SRC}/app/(student)/account/reactivate/page.tsx`,
  `${SRC}/app/(student)/account/leave/page.tsx`,
  `${SRC}/components/account/reactivate-button.tsx`,
  `${SRC}/components/account/leave-form.tsx`,
  `${SRC}/components/account/dormancy-chip.tsx`,
  `${SRC}/server/queries/account.ts`,
  "packages/shared/src/inactivity-copy.ts",
];

describe("the route out of a restriction stays reachable", () => {
  const file = `${SRC}/server/actions/account.ts`;
  const source = readRepoFile(file);

  it("exists, and exports selfClearRestriction", () => {
    expect(source).toContain("export async function selfClearRestriction");
  });

  it("guards selfClearRestriction with requireActionUser() and nothing stronger", () => {
    /**
     * The body of the action, from its signature to the closing
     * `}, "selfClearRestriction");`. Scoped so a guard in a NEIGHBOURING
     * action in the same file cannot satisfy this by accident.
     */
    const start = source.indexOf("export async function selfClearRestriction");
    expect(start, "selfClearRestriction is gone").toBeGreaterThan(-1);
    const end = source.indexOf('}, "selfClearRestriction");', start);
    expect(end, "selfClearRestriction no longer names itself to runAction").toBeGreaterThan(start);
    const body = source.slice(start, end);

    expect(body, "the one permitted guard is missing").toContain("await requireActionUser()");

    const stronger = [
      "requireActionRole",
      "requireSuperAdmin",
      "requireAdminScopeAction",
      "requireScopedStudent",
      "requirePageRole",
      "requireImpersonator",
    ];
    for (const guard of stronger) {
      expect(
        body.includes(guard),
        [
          `${file} guards selfClearRestriction with ${guard}.`,
          "",
          "That is the removal of the only route out of an inactivity restriction.",
          'SPEC §7: "do not require admin approval to clear a soft restriction" —',
          "because approval turns a ten-day lapse into a permanent exit: the",
          "administrator is busy and the student gives up.",
          "",
          "If a restriction genuinely needs staff to lift it, that is the DISABLED",
          "rung, which this action already refuses (canSelfClear), and which a",
          "super-admin lifts through super-users.",
        ].join("\n"),
      ).toBe(false);
    }
  });

  it("acts only on the caller's own row — no id is accepted", () => {
    const start = source.indexOf("export async function selfClearRestriction");
    const end = source.indexOf('}, "selfClearRestriction");', start);
    const body = source.slice(start, end);
    // No parameter at all: the signature takes nothing, so there is no id to
    // tamper with and nothing to validate.
    expect(source.slice(start, start + 120)).toContain("selfClearRestriction():");
    expect(body).toContain("user.id");
  });

  it("mutation check: a stronger guard in the body WOULD be caught", () => {
    // Without this, the loop above could pass because the slice is empty.
    const fake = [
      "export async function selfClearRestriction(): Promise<void> {",
      "  return runAction(async () => {",
      "    const user = await requireActionRole('ADMIN');",
      '  }, "selfClearRestriction");',
      "}",
    ].join("\n");
    const start = fake.indexOf("export async function selfClearRestriction");
    const end = fake.indexOf('}, "selfClearRestriction");', start);
    expect(fake.slice(start, end)).toContain("requireActionRole");
  });
});

describe('no student-facing copy says "disabled"', () => {
  it.each(STUDENT_SURFACES)("%s", (file) => {
    /**
     * STRING LITERALS and JSX text, not identifiers and not comments.
     *
     * A prop named `disabledReason` is code, and a comment explaining this
     * very rule has to be able to use the word. What a student reads is the
     * literals and the text between tags — so that is what is checked, which
     * also means a comment cannot be used to smuggle copy past the fence.
     */
    const source = readRepoFile(file);
    const lexed = lexSource(source);
    const offenders: string[] = [];

    /**
     * An all-caps bare token is a VALUE, not copy: `"DISABLED"` is the
     * RestrictionStage/AccountStatus member, written in a case label or a
     * map key. Copy is prose — it has lower case, or spaces, or both. Any
     * literal that is exactly one SCREAMING_SNAKE token is therefore
     * exempt, and nothing else is.
     */
    const isEnumToken = (body: string) => /^[A-Z][A-Z0-9_]*$/.test(body.trim());

    for (const span of lexed.strings) {
      if (isEnumToken(span.body)) continue;
      if (/disabl/i.test(span.body)) {
        offenders.push(`${file}:${lineAt(source, span.start)}: ${span.body.trim().slice(0, 100)}`);
      }
    }
    // JSX text: whatever sits between > and <, with comments already blanked.
    for (const match of lexed.code.matchAll(/>([^<>{}]+)</g)) {
      if (/disabl/i.test(match[1] ?? "")) {
        offenders.push(`${file}:${lineAt(source, match.index ?? 0)}: ${(match[1] ?? "").trim().slice(0, 100)}`);
      }
    }
    expect(
      offenders,
      [
        "A student-facing surface uses the word \"disabled\".",
        "",
        'SPEC §5: "Keep the word \'disabled\' out of student-facing copy." A student',
        "who reads it believes they have been thrown off the platform and stops",
        "trying, which is the exact outcome a policy about non-progress must not",
        "cause. Every one of these states is reversible — the top one by a human",
        'who can be asked — so "paused" is both gentler and more accurate.',
        "",
        'For administrative reporting, use RESTRICTION_STAGE_ADMIN_LABEL, which says',
        '"Disabled" because that is the accurate word where no student reads it.',
        "",
        offenders.join("\n"),
      ].join("\n"),
    ).toEqual([]);
  });

  it("covers every student-facing Phase 8 file that exists", () => {
    // A new file under components/account or app/(student)/account must be
    // added to the list above, or this fence quietly stops covering it.
    const found = findFiles({
      under: [`${SRC}/components/account`, `${SRC}/app/(student)/account`],
      extensions: CODE_EXTENSIONS,
    }).sort();
    const listed = new Set(STUDENT_SURFACES);
    const missing = found.filter((file) => !listed.has(file));
    expect(
      missing,
      `add these to STUDENT_SURFACES in ${"tests/repo/inactivity-copy.test.ts"}:\n${missing.join("\n")}`,
    ).toEqual([]);
  });

  it("mutation check: the enum exemption does not swallow real copy", () => {
    // Without this, `isEnumToken` could be widened until the whole fence
    // passed vacuously. Three shapes that must still be caught, and the one
    // that must not be.
    const isEnumToken = (body: string) => /^[A-Z][A-Z0-9_]*$/.test(body.trim());
    const caught = (body: string) => !isEnumToken(body) && /disabl/i.test(body);

    expect(caught("Your account is disabled."), "plain copy").toBe(true);
    expect(caught("DISABLED — contact us"), "a value with prose after it").toBe(true);
    expect(caught("account disabled"), "lower case").toBe(true);
    expect(caught("DISABLED"), "the bare enum member").toBe(false);
  });

  it("the ADMIN label map is allowed to say it, and does", () => {
    // The other half of the rule: administrative reporting uses the accurate
    // word. If this ever stopped saying "Disabled", staff would be reading
    // student-facing euphemism in a context where precision matters.
    const source = readRepoFile("packages/shared/src/inactivity-policy.ts");
    expect(source).toContain("RESTRICTION_STAGE_ADMIN_LABEL");
    expect(source).toMatch(/DISABLED:\s*"Disabled"/);
  });
});
