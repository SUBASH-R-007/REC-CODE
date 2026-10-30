/**
 * REC Code — development seed. Idempotent: run it as often as you like.
 *
 *   cd apps/web
 *   npx tsx --conditions=react-server scripts/seed.ts
 *
 * Why --conditions=react-server: the seed reuses the app's own modules —
 * hashPassword, env, audit, the test-data store — instead of copies, and
 * those modules carry the `server-only` marker. That package resolves to an
 * empty module under the react-server condition and throws under the default
 * one, so the seed checks for the condition first and says how to run it.
 *
 * Reads apps/web/.env.local when present: DATABASE_URL, IP_HASH_PEPPER,
 * TESTDATA_*, SEED_ADMIN_PASSWORD, SEED_STUDENT_PASSWORD, and optionally
 * JUDGE_DEV_NODE_ID / JUDGE_DEV_NODE_TOKEN. Passwords and tokens are never
 * printed.
 *
 * Seeded accounts (matched by collegeId): role, status and the password hash
 * are written only when an account is created. Re-running updates only the
 * profile fields the seed owns (first and last name, email, handle, batch
 * year, department, section) and never touches role, status or passwordHash,
 * so a promotion or demotion, a suspension or a password change made in the
 * app survives a re-seed. RECADMIN02's AdminScope grant is created only while
 * that admin has no AdminScope row at all (see seedAdminScope).
 *
 * Creates: two SUPER_ADMINs (RECADMIN01; RECSUPER02 for two-person
 * approval), one ADMIN (RECADMIN02, AdminScope CSE / every batch, granted
 * once), six students (four CSE 2027, two ECE 2026), a LanguageConfig row per
 * catalog language, the default PlatformTheme, the published two-sum
 * problem (blobs, bundle, tests, starters, reference solutions, hints,
 * editorial) and the dev judge node. Staff use SEED_ADMIN_PASSWORD, students
 * SEED_STUDENT_PASSWORD.
 *
 * Authored content lives in scripts/content/** (one module per problem,
 * plus the badge catalogue and the study plans) — all of it originally
 * written for REC Code. Problems other than two-sum are created as DRAFTS
 * that must pass the validation pipeline before they are published:
 *   - bracket-cleanup (REC-0002): CHECKER compare mode (testlib);
 *   - study-pairs (REC-0003): SUBTASK scoring with a deliberately-TLE brute force;
 *   - handle-maker (REC-0004): FUNCTION mode, Easy, Strings;
 *   - lab-power-budget (REC-0005): FUNCTION mode, Medium, Sliding Window;
 *   - second-swipe (REC-0006): STDIN mode, Easy, Arrays & Hashing.
 *
 * Hints and the editorial are frozen children of a version, so a published
 * version that lacks them gets a NEW draft revision (a clone of the live one
 * plus the authored help); the live revision stays frozen and every
 * submission pinned to it keeps showing it. Two-sum also gets its revision 2
 * on a fresh database (measured per-language limits).
 *
 * Phase 3 also keeps these in step: topic tags (ProblemTag, on the Problem —
 * no new revision needed), the badge catalogue, the seeded study plans
 * (only published problems; itemsTotal and enrollment counts maintained)
 * and today's daily challenge (campus day, only if absent). Company tags are
 * deliberately left empty: nothing here may claim that a company asked a
 * problem.
 *
 * The seed never publishes a draft: with a judge node up, run for each
 *   npx tsx --conditions=react-server scripts/validate-and-publish.ts <slug>
 * (it refreshes the seeded study plans after a publish). Without a judge the
 * drafts simply stay unvalidated.
 */
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Db, DbTx, Prisma } from "@recx/db";
// Type-only (erased): the module itself loads dynamically after the env file.
import type { BundleFile } from "../src/lib/testdata/bundle";
import {
  campusDay,
  campusDayDate,
  LANGUAGE_CATALOG,
  LANGUAGE_KEYS,
  SQL_LANGUAGE_KEY,
  SQL_LANGUAGE_LABEL,
  SQL_RUNTIME,
  SQL_TOOLCHAIN_ID,
  TESTLIB_ID,
} from "@recx/shared";
import {
  generateTwoSumTests,
  TWO_SUM,
  TWO_SUM_REFERENCE,
  TWO_SUM_STARTER,
} from "@recx/shared/samples/two-sum";
import { BADGES } from "./content/badges";
import { dailyChallengeIndex } from "./content/daily-challenge";
import { AUTHORED_PROBLEMS, HELP_BY_SLUG, TOPICS_BY_SLUG } from "./content/index";
import { syncSeededMockPatterns } from "./content/aptitude";
import { syncSeededCalendar } from "./content/calendar";
import { syncSeededInactivityPolicy } from "./content/inactivity";
import { syncSeededReadiness } from "./content/readiness";
import { syncSeededStudyPlans } from "./content/study-plans";
import type { AuthoredProblem, HelpContent } from "./content/types";

const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function fail(message: string): never {
  console.error(`[seed] ${message}`);
  process.exit(1);
}

function log(message: string) {
  console.log(`[seed] ${message}`);
}

function toJson(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}

function requireReactServerCondition() {
  let resolved = "";
  try {
    resolved = import.meta.resolve("server-only");
  } catch {
    fail("Cannot resolve the server-only package. Run `npx pnpm@9.15.9 install` first.");
  }
  if (!resolved.endsWith("/empty.js")) {
    fail(
      "Run the seed with the react-server condition (it reuses server-only app modules):\n" +
        "  cd apps/web && npx tsx --conditions=react-server scripts/seed.ts",
    );
  }
}

// ── Loaded app modules (dynamic: they must load after the env file) ──────

async function loadApp() {
  const [password, dbModule, auditModule, store, blobs, bundle, nodeAuth, validation, derive, presets] = await Promise.all([
    import("../src/lib/auth/password"),
    import("../src/lib/db"),
    import("../src/lib/audit"),
    import("../src/lib/testdata/store"),
    import("../src/lib/testdata/blobs"),
    import("../src/lib/testdata/bundle"),
    import("../src/lib/judge/node-auth"),
    import("../src/lib/judge/validation"),
    import("@recx/design/derive"),
    import("@recx/design/presets"),
  ]);
  return {
    hashPassword: password.hashPassword,
    passwordIssues: password.passwordIssues,
    db: dbModule.db,
    audit: auditModule.audit,
    getTestDataStore: store.getTestDataStore,
    ensureTestBlob: blobs.ensureTestBlob,
    writeBundle: bundle.writeBundle,
    testBundleFiles: bundle.testBundleFiles,
    cloneVersionAsDraft: validation.cloneVersionAsDraft,
    hashNodeToken: nodeAuth.hashNodeToken,
    parseNodeId: nodeAuth.parseNodeId,
    parseBearer: nodeAuth.parseBearer,
    buildBrandCss: derive.buildBrandCss,
    REC_PURPLE_PALETTE: presets.REC_PURPLE_PALETTE,
    DEFAULT_THEME_INPUT: presets.DEFAULT_THEME_INPUT,
  };
}

type App = Awaited<ReturnType<typeof loadApp>>;

function seedPassword(app: App, name: "SEED_ADMIN_PASSWORD" | "SEED_STUDENT_PASSWORD"): string {
  const value = process.env[name];
  if (!value) fail(`${name} is not set. Add it to apps/web/.env.local (the value is never printed).`);
  const issues = app.passwordIssues(value);
  if (issues.length > 0) fail(`${name} does not meet the password policy: ${issues.join(", ")}.`);
  return value;
}

// ── Users ────────────────────────────────────────────────────────────────

interface SeedUser {
  collegeId: string;
  email: string;
  firstName: string;
  lastName: string;
  handle: string;
  role: "SUPER_ADMIN" | "ADMIN" | "STUDENT";
  batchYear: number | null;
  departmentCode: string | null;
  section: string | null;
}

const STAFF_DEFAULTS = { batchYear: null, departmentCode: null, section: null } as const;

/** The first super-admin: actor of the seeded content and grantor of the seeded admin scope. */
const ADMIN: SeedUser = {
  collegeId: "RECADMIN01",
  email: "admin@rec-code.example",
  firstName: "Admin",
  lastName: "User",
  handle: "rec-admin",
  role: "SUPER_ADMIN",
  ...STAFF_DEFAULTS,
};

/** A second super-admin, so two-person approval of privileged operations can be exercised. */
const SECOND_SUPER_ADMIN: SeedUser = {
  collegeId: "RECSUPER02",
  email: "super02@rec-code.example",
  firstName: "Senthil",
  lastName: "Kumaran",
  handle: "rec-super-02",
  role: "SUPER_ADMIN",
  ...STAFF_DEFAULTS,
};

/** A scoped ADMIN: sees CSE students of every batch (seedAdminScope). */
const SCOPED_ADMIN: SeedUser = {
  collegeId: "RECADMIN02",
  email: "admin02@rec-code.example",
  firstName: "Kavitha",
  lastName: "Raman",
  handle: "rec-admin-02",
  role: "ADMIN",
  ...STAFF_DEFAULTS,
};

/** The grant seeded for SCOPED_ADMIN: one department, every batch. */
const SCOPED_ADMIN_GRANT = { departmentCode: "CSE", batchYear: null, reason: "seed" } as const;

function students(rows: string[][], cohort: { batchYear: number; departmentCode: string; section: string }): SeedUser[] {
  return rows.map(([collegeId, firstName, lastName, handle]) => ({
    collegeId: collegeId!,
    email: `${collegeId}@rec-code.example`,
    firstName: firstName!,
    lastName: lastName!,
    handle: handle!,
    role: "STUDENT" as const,
    ...cohort,
  }));
}

const STUDENTS: SeedUser[] = [
  // CSE 2027 A. 2116231001004 is reserved for the authoring end-to-end spec.
  ...students(
    [
      ["2116231001001", "Priya", "Sharma", "priya-s"],
      ["2116231001002", "Arjun", "Kumar", "arjun-k"],
      ["2116231001003", "Meera", "Nair", "meera-n"],
      ["2116231001004", "Rohan", "Iyer", "rohan-i"],
    ],
    { batchYear: 2027, departmentCode: "CSE", section: "A" },
  ),
  // ECE 2026 A: outside RECADMIN02's CSE scope (admin-scope checks).
  ...students(
    [
      ["2116226002001", "Divya", "Venkatesan", "divya-v"],
      ["2116226002002", "Karthik", "Subramanian", "karthik-s"],
    ],
    { batchYear: 2026, departmentCode: "ECE", section: "A" },
  ),
];

/**
 * Create a seeded account, or refresh an existing one (matched by collegeId).
 *
 * On create: every field — profile, role, status ACTIVE (the default) and a
 * password hash from the seed password.
 * On update: ONLY the profile fields the seed owns — firstName, lastName,
 * email, handle, batchYear, departmentCode, section. Never role, status or
 * passwordHash: a role change, a suspension or a password change made in the
 * app survives a re-seed. An existing account keeps exactly the role it has
 * (a differing seed role is only logged).
 */
async function upsertUser(app: App, user: SeedUser, password: string): Promise<string> {
  const { db } = app;
  const profile = {
    email: user.email,
    firstName: user.firstName,
    lastName: user.lastName,
    handle: user.handle,
    batchYear: user.batchYear,
    departmentCode: user.departmentCode,
    section: user.section,
  };
  const existing = await db.user.findUnique({
    where: { collegeId: user.collegeId },
    select: { id: true, role: true },
  });
  if (existing) {
    await db.user.update({ where: { id: existing.id }, data: profile });
    if (existing.role !== user.role) {
      log(`kept ${user.collegeId}'s role ${existing.role} (the seed would create ${user.role}; it never changes an existing role)`);
    }
    return existing.id;
  }
  const created = await db.user.create({
    data: { collegeId: user.collegeId, ...profile, role: user.role, passwordHash: await app.hashPassword(password) },
    select: { id: true },
  });
  await app.audit({
    actorId: null,
    action: "seed.user.created",
    entityType: "User",
    entityId: created.id,
    targetUserId: created.id,
    sensitivity: user.role === "STUDENT" ? "NORMAL" : "SECURITY",
    metadata: { collegeId: user.collegeId, role: user.role },
  });
  log(`created ${user.role} ${user.collegeId} (${user.firstName} ${user.lastName})`);
  return created.id;
}

/**
 * RECADMIN02's student visibility: one active AdminScope row (CSE, every
 * batch), granted by RECADMIN01. Granted only while the admin has no scope
 * row at all, so re-seeding never duplicates it and never undoes a revoke or
 * re-scope made in the app. A duplicate active grant is also refused by the
 * AdminScope_active_grant_key partial index, and an AdminScope row is never
 * edited or deleted (trigger AdminScope_grant_immutable).
 */
async function seedAdminScope(app: App, adminId: string, grantedById: string): Promise<void> {
  const { db } = app;
  const existing = await db.adminScope.count({ where: { adminId } });
  if (existing > 0) {
    const active = await db.adminScope.count({ where: { adminId, revokedAt: null } });
    log(`admin scope ${SCOPED_ADMIN.collegeId}: ${existing} grant(s), ${active} active — kept`);
    return;
  }
  const grant = await db.adminScope.create({
    data: { adminId, grantedById, ...SCOPED_ADMIN_GRANT },
    select: { id: true },
  });
  await app.audit({
    actorId: null,
    action: "seed.admin_scope.granted",
    entityType: "AdminScope",
    entityId: grant.id,
    targetUserId: adminId,
    sensitivity: "SECURITY",
    metadata: { departmentCode: SCOPED_ADMIN_GRANT.departmentCode, batchYear: SCOPED_ADMIN_GRANT.batchYear },
  });
  log(`admin scope ${SCOPED_ADMIN.collegeId}: granted ${SCOPED_ADMIN_GRANT.departmentCode}, every batch`);
}

// ── Languages ────────────────────────────────────────────────────────────

async function seedLanguages(db: Db) {
  for (const key of LANGUAGE_KEYS) {
    const rt = LANGUAGE_CATALOG[key];
    const fields = {
      label: rt.label,
      version: rt.version,
      runtime: toJson(rt),
      enabled: rt.enabledByDefault,
      isCurrent: true,
    };
    await db.$transaction([
      // Exactly one current row per language.
      db.languageConfig.updateMany({
        where: { key, isCurrent: true, NOT: { toolchainId: rt.toolchainId } },
        data: { isCurrent: false },
      }),
      db.languageConfig.upsert({
        where: { key_toolchainId: { key, toolchainId: rt.toolchainId } },
        create: { key, toolchainId: rt.toolchainId, ...fields },
        update: fields,
      }),
    ]);
  }
  /**
   * SQL (Phase 12k) is a language a student writes in but not a toolchain:
   * its runtime is `SQL_RUNTIME`, not a `LanguageRuntime`, and the engine
   * that judges it is the sandbox service rather than an isolate box. The
   * row exists for the same reason every other one does — a submission
   * points at a LanguageConfig — which is what let SQL problems join the
   * pipeline without a single change to `Submission`.
   */
  const sqlFields = {
    label: SQL_LANGUAGE_LABEL,
    version: "17",
    runtime: toJson(SQL_RUNTIME),
    enabled: true,
    isCurrent: true,
  };
  await db.languageConfig.upsert({
    where: { key_toolchainId: { key: SQL_LANGUAGE_KEY, toolchainId: SQL_TOOLCHAIN_ID } },
    create: { key: SQL_LANGUAGE_KEY, toolchainId: SQL_TOOLCHAIN_ID, ...sqlFields },
    update: sqlFields,
  });

  const enabled = LANGUAGE_KEYS.filter((k) => LANGUAGE_CATALOG[k].enabledByDefault);
  log(`language configs: ${LANGUAGE_KEYS.length} + sql (enabled: ${enabled.join(", ")}, ${SQL_LANGUAGE_KEY})`);
}

// ── Theme ────────────────────────────────────────────────────────────────

async function seedTheme(app: App) {
  const { db } = app;
  const palette = app.REC_PURPLE_PALETTE;
  const css = app.buildBrandCss(palette);
  const existing = await db.platformTheme.findUnique({ where: { id: "default" } });
  if (!existing) {
    await db.platformTheme.create({
      data: {
        id: "default",
        presetKey: "rec-purple",
        brandSeed: app.DEFAULT_THEME_INPUT.brandSeed,
        accentSeed: app.DEFAULT_THEME_INPUT.accentSeed,
        radius: palette.radius,
        palette: toJson(palette),
        css,
      },
    });
    log("platform theme: rec-purple");
  } else if (existing.presetKey === "rec-purple" && existing.css !== css) {
    // Keep the canonical theme in step with the token source; an admin's
    // custom theme is never touched.
    await db.platformTheme.update({
      where: { id: "default" },
      data: { palette: toJson(palette), css, paletteVersion: { increment: 1 } },
    });
    log("platform theme: refreshed rec-purple");
  }
}

// ── Practice help (hints + editorial) ────────────────────────────────────

/**
 * Add the authored hints and editorial to a DRAFT version, filling only what
 * is missing (a tier or the editorial an earlier run or an author already
 * wrote is left alone). Callers pass draft versions only: the repository
 * guard and the database trigger refuse writes to a frozen one.
 */
async function addHelpToDraft(
  tx: DbTx,
  versionId: string,
  help: HelpContent,
): Promise<{ tiersAdded: number[]; editorialAdded: boolean }> {
  const existing = await tx.hint.findMany({ where: { problemVersionId: versionId }, select: { tier: true } });
  const have = new Set(existing.map((h) => h.tier));
  const missing = help.hints.flatMap((contentMd, i) => (have.has(i + 1) ? [] : [{ tier: i + 1, contentMd }]));
  if (missing.length > 0) {
    await tx.hint.createMany({ data: missing.map((h) => ({ problemVersionId: versionId, ...h })) });
  }
  const editorial = await tx.editorial.findUnique({ where: { problemVersionId: versionId }, select: { id: true } });
  if (!editorial) await tx.editorial.create({ data: { problemVersionId: versionId, contentMd: help.editorial } });
  return { tiersAdded: missing.map((h) => h.tier), editorialAdded: !editorial };
}

function requireHelp(slug: string): HelpContent {
  const help = HELP_BY_SLUG.get(slug);
  if (!help) fail(`No authored hints/editorial for ${slug} in scripts/content.`);
  return help;
}

// ── Two Sum ──────────────────────────────────────────────────────────────

async function seedTwoSum(app: App, adminId: string) {
  const { db } = app;
  const found = await db.problem.findUnique({
    where: { slug: TWO_SUM.slug },
    select: { id: true, liveVersionId: true },
  });
  if (found?.liveVersionId) {
    log(`problem ${TWO_SUM.slug}: already published, skipped`);
    return;
  }
  const problem =
    found ??
    (await db.problem.create({
      data: {
        slug: TWO_SUM.slug,
        displayCode: TWO_SUM.displayCode,
        title: TWO_SUM.title,
        difficulty: TWO_SUM.difficulty,
        status: "DRAFT",
        createdById: adminId,
      },
      select: { id: true, liveVersionId: true },
    }));
  const help = requireHelp(TWO_SUM.slug);

  // Blobs and bundle first (content-addressed / write-once, so safe to repeat).
  const store = app.getTestDataStore();
  const tests = generateTwoSumTests();
  const rows: { index: number; isSample: boolean; inputSha256: string; outputSha256: string }[] = [];
  const files: BundleFile[] = [];
  for (const t of tests) {
    const input = Buffer.from(t.input, "utf8");
    const output = Buffer.from(t.output, "utf8");
    const inBlob = await app.ensureTestBlob(db, store, input);
    const outBlob = await app.ensureTestBlob(db, store, output);
    rows.push({ index: t.index, isSample: t.isSample, inputSha256: inBlob.sha256, outputSha256: outBlob.sha256 });
    const base = `tests/${String(t.index).padStart(3, "0")}`;
    files.push(
      { name: `${base}.in`, bytes: input, testIndex: t.index, role: "input", isSample: t.isSample, subtask: null },
      { name: `${base}.out`, bytes: output, testIndex: t.index, role: "output", isSample: t.isSample, subtask: null },
    );
  }
  const bundle = await app.writeBundle({ problemId: problem.id, revision: 1, files }, store);
  const blobCount = new Set(rows.flatMap((r) => [r.inputSha256, r.outputSha256])).size;
  const samples = tests.filter((t) => t.isSample).length;
  log(`two-sum: ${tests.length} tests (${samples} samples), ${blobCount} distinct blobs, bundle ${bundle.bundleKey}`);

  const versionId = await db.$transaction(
    async (tx) => {
      // A crashed earlier run may have left an unpublished revision 1: rebuild it.
      const stale = await tx.problemVersion.findUnique({
        where: { problemId_revision: { problemId: problem.id, revision: 1 } },
        select: { id: true, frozenAt: true },
      });
      if (stale?.frozenAt) {
        throw new Error("two-sum revision 1 is frozen but not live; inspect the Problem row by hand.");
      }
      if (stale) {
        await tx.testCase.deleteMany({ where: { problemVersionId: stale.id } });
        await tx.starterCode.deleteMany({ where: { problemVersionId: stale.id } });
        await tx.referenceSolution.deleteMany({ where: { problemVersionId: stale.id } });
        await tx.hint.deleteMany({ where: { problemVersionId: stale.id } });
        await tx.editorial.deleteMany({ where: { problemVersionId: stale.id } });
        await tx.problemVersion.delete({ where: { id: stale.id } });
      }

      const version = await tx.problemVersion.create({
        data: {
          problemId: problem.id,
          revision: 1,
          status: "DRAFT",
          title: TWO_SUM.title,
          difficulty: TWO_SUM.difficulty,
          statementMd: TWO_SUM.statement,
          constraints: toJson(TWO_SUM.constraints),
          ioMode: "FUNCTION",
          functionSignature: toJson(TWO_SUM.signature),
          compareMode: "TOKEN",
          scoringMode: "ICPC",
          stopOnFirstFailure: true,
          timeLimitMs: TWO_SUM.timeLimitMs,
          memoryLimitKb: TWO_SUM.memoryLimitKb,
          createdById: adminId,
        },
        select: { id: true },
      });
      await tx.testCase.createMany({
        data: [...rows].sort((a, b) => a.index - b.index).map((r) => ({ problemVersionId: version.id, ...r })),
      });
      await tx.starterCode.createMany({
        data: Object.entries(TWO_SUM_STARTER).map(([language, code]) => ({
          problemVersionId: version.id,
          language,
          code: code!,
        })),
      });
      await tx.referenceSolution.createMany({
        data: Object.entries(TWO_SUM_REFERENCE).flatMap(([language, entries]) =>
          (entries ?? []).map((entry, i) => ({
            problemVersionId: version.id,
            language,
            label: entry.expected === "AC" ? `Model solution ${i + 1}` : `Deliberately ${entry.expected} ${i + 1}`,
            source: entry.source,
            expectedVerdict: entry.expected,
          })),
        ),
      });
      await addHelpToDraft(tx, version.id, help);

      // Publish: freeze the version (the only permitted write to it), then
      // flip the live pointer.
      const now = new Date();
      await tx.problemVersion.update({
        where: { id: version.id },
        data: {
          bundleKey: bundle.bundleKey,
          manifestSha256: bundle.manifestSha256,
          status: "PUBLISHED",
          frozenAt: now,
          publishedAt: now,
        },
      });
      await tx.problem.update({
        where: { id: problem.id },
        data: {
          liveVersionId: version.id,
          status: "PUBLISHED",
          title: TWO_SUM.title,
          difficulty: TWO_SUM.difficulty,
          version: { increment: 1 },
        },
      });
      return version.id;
    },
    { timeout: 30_000 },
  );

  await app.audit({
    actorId: adminId,
    action: "problem.published",
    entityType: "Problem",
    entityId: problem.id,
    metadata: { slug: TWO_SUM.slug, revision: 1, versionId, via: "seed" },
  });
  log(`problem ${TWO_SUM.slug}: published revision 1`);
}

/**
 * Two-sum revision 2: a DRAFT clone of the live revision 1, to be validated
 * and published with measured per-language limits. Revision 1 stays frozen
 * and every submission pinned to it keeps showing it.
 */
async function seedTwoSumRevision(app: App, adminId: string): Promise<void> {
  const problem = await app.db.problem.findUnique({
    where: { slug: TWO_SUM.slug },
    select: { liveVersionId: true, versions: { select: { revision: true }, orderBy: { revision: "desc" }, take: 1 } },
  });
  if (!problem?.liveVersionId) return;
  const latest = problem.versions[0]?.revision ?? 1;
  if (latest >= 2) {
    log(`problem ${TWO_SUM.slug}: revision ${latest} exists, revision-2 clone skipped`);
    return;
  }
  const created = await app.cloneVersionAsDraft(problem.liveVersionId, { createdById: adminId, via: "seed" });
  log(`problem ${TWO_SUM.slug}: draft revision ${created.revision} cloned from the live revision — not published`);
}

// ── Authored problems (scripts/content) ──────────────────────────────────

/**
 * Create an authored problem as a DRAFT revision 1, hints and editorial
 * included (never published here — publishing goes through the validation
 * pipeline). Skipped when the problem already has any revision, so re-running
 * the seed never touches a draft that is being validated or a published
 * version.
 */
async function seedAuthoredProblem(app: App, adminId: string, def: AuthoredProblem): Promise<void> {
  const { db } = app;
  const found = await db.problem.findUnique({
    where: { slug: def.slug },
    select: { id: true, liveVersionId: true, versions: { select: { revision: true }, orderBy: { revision: "desc" }, take: 1 } },
  });
  if (found?.liveVersionId) {
    log(`problem ${def.slug}: already published, skipped`);
    return;
  }
  if (found && found.versions.length > 0) {
    log(`problem ${def.slug}: draft revision ${found.versions[0]!.revision} exists, skipped`);
    return;
  }
  if ((def.ioMode === "FUNCTION") !== (def.signature !== null)) {
    fail(`${def.slug}: a FUNCTION-mode problem needs a signature, and only FUNCTION mode may have one.`);
  }
  const problem =
    found ??
    (await db.problem.create({
      data: {
        slug: def.slug,
        displayCode: def.displayCode,
        title: def.title,
        difficulty: def.difficulty,
        status: "DRAFT",
        createdById: adminId,
      },
      select: { id: true },
    }));

  // Blobs and checker first (content-addressed, so safe to repeat). No bundle:
  // drafts never write one — publishing writes it once, after the freeze.
  const store = app.getTestDataStore();
  const tests = def.generateTests();
  const rows: { index: number; isSample: boolean; subtaskIndex: number | null; inputSha256: string; outputSha256: string }[] = [];
  for (const [index, t] of tests.entries()) {
    const inBlob = await app.ensureTestBlob(db, store, Buffer.from(t.input, "utf8"));
    const outBlob = await app.ensureTestBlob(db, store, Buffer.from(t.output, "utf8"));
    rows.push({ index, isSample: t.isSample, subtaskIndex: t.subtask, inputSha256: inBlob.sha256, outputSha256: outBlob.sha256 });
  }
  const checker = def.checkerSource ? await app.ensureTestBlob(db, store, Buffer.from(def.checkerSource, "utf8")) : null;

  const versionId = await db.$transaction(
    async (tx) => {
      const version = await tx.problemVersion.create({
        data: {
          problemId: problem.id,
          revision: 1,
          status: "DRAFT",
          title: def.title,
          difficulty: def.difficulty,
          statementMd: def.statement,
          constraints: toJson(def.constraints),
          ioMode: def.ioMode,
          ...(def.signature ? { functionSignature: toJson(def.signature) } : {}),
          compareMode: def.compareMode,
          scoringMode: def.scoringMode,
          stopOnFirstFailure: def.stopOnFirstFailure,
          timeLimitMs: def.timeLimitMs,
          memoryLimitKb: def.memoryLimitKb,
          checkerSha256: checker?.sha256 ?? null,
          testlibId: checker ? TESTLIB_ID : null,
          createdById: adminId,
        },
        select: { id: true },
      });
      await tx.testCase.createMany({ data: rows.map((r) => ({ problemVersionId: version.id, ...r })) });
      if (def.subtasks.length > 0) {
        await tx.subtask.createMany({
          data: def.subtasks.map((s) => ({ problemVersionId: version.id, aggregation: "MIN" as const, ...s })),
        });
      }
      await tx.starterCode.createMany({
        data: Object.entries(def.starters).map(([language, code]) => ({ problemVersionId: version.id, language, code: code! })),
      });
      await tx.referenceSolution.createMany({
        data: def.references.map((r) => ({
          problemVersionId: version.id,
          language: r.language,
          label: r.label,
          source: r.source,
          expectedVerdict: r.expected,
        })),
      });
      await addHelpToDraft(tx, version.id, def.help);
      return version.id;
    },
    { timeout: 30_000 },
  );

  await app.audit({
    actorId: adminId,
    action: "problem.draft.created",
    entityType: "ProblemVersion",
    entityId: versionId,
    metadata: { slug: def.slug, revision: 1, via: "seed" },
  });
  const samples = tests.filter((t) => t.isSample).length;
  log(
    `problem ${def.slug}: draft revision 1 (${def.ioMode}, ${tests.length} tests, ${samples} samples, ` +
      `${def.compareMode}, ${def.scoringMode}${def.subtasks.length ? `, ${def.subtasks.length} subtasks` : ""}, ` +
      `3 hints + editorial) — not published`,
  );
}

/**
 * Give a problem its authored hints and editorial. They are frozen children
 * of a version, so:
 *   - a draft revision exists → fill in whatever help it lacks;
 *   - otherwise, the live revision lacks help → clone it into a new DRAFT
 *     revision (every child, by reference) and add the help there;
 *   - otherwise (the live revision has all three tiers and an editorial) →
 *     nothing to do.
 */
async function seedHelpRevision(app: App, adminId: string, slug: string, help: HelpContent): Promise<void> {
  const { db } = app;
  const problem = await db.problem.findUnique({
    where: { slug },
    select: {
      id: true,
      liveVersionId: true,
      versions: { where: { frozenAt: null }, orderBy: { revision: "desc" }, take: 1, select: { id: true, revision: true } },
    },
  });
  if (!problem) return;

  let draft = problem.versions[0] ?? null;
  let cloned = false;
  if (!draft) {
    if (!problem.liveVersionId) return;
    const live = await db.problemVersion.findUniqueOrThrow({
      where: { id: problem.liveVersionId },
      select: { revision: true, hints: { select: { tier: true } }, editorial: { select: { id: true } } },
    });
    const tiers = new Set(live.hints.map((h) => h.tier));
    if (tiers.size >= help.hints.length && live.editorial) {
      log(`problem ${slug}: live revision ${live.revision} has hints and an editorial, skipped`);
      return;
    }
    const created = await app.cloneVersionAsDraft(problem.liveVersionId, { createdById: adminId, via: "seed" });
    draft = { id: created.versionId, revision: created.revision };
    cloned = true;
  }

  const target = draft;
  const added = await db.$transaction((tx) => addHelpToDraft(tx, target.id, help), { timeout: 30_000 });
  if (added.tiersAdded.length === 0 && !added.editorialAdded) {
    log(`problem ${slug}: draft revision ${target.revision} already has hints and an editorial`);
    return;
  }
  await app.audit({
    actorId: adminId,
    action: "problem.draft.help_added",
    entityType: "ProblemVersion",
    entityId: target.id,
    metadata: { slug, revision: target.revision, tiers: added.tiersAdded, editorial: added.editorialAdded, via: "seed" },
  });
  log(
    `problem ${slug}: ${cloned ? "new " : ""}draft revision ${target.revision}` +
      `${cloned ? " (cloned from the live revision)" : ""} + hints ${added.tiersAdded.join("/") || "—"}` +
      `${added.editorialAdded ? " + editorial" : ""} — not published`,
  );
}

// ── Topic tags, badges, daily challenge ──────────────────────────────────

/** Topic tags live on the Problem (no new revision). Only missing tags are added. */
async function seedTopicTags(db: Db): Promise<void> {
  let added = 0;
  for (const [slug, topics] of TOPICS_BY_SLUG) {
    const problem = await db.problem.findUnique({ where: { slug }, select: { id: true } });
    if (!problem) continue;
    const result = await db.problemTag.createMany({
      data: topics.map((topic) => ({ problemId: problem.id, topic })),
      skipDuplicates: true,
    });
    added += result.count;
  }
  log(`topic tags: ${added} added`);
}

async function seedBadges(db: Db): Promise<void> {
  for (const badge of BADGES) {
    const { key, ...fields } = badge;
    await db.badge.upsert({ where: { key }, create: badge, update: fields });
  }
  log(`badges: ${BADGES.length} (${BADGES.map((b) => b.key).join(", ")})`);
}

/** Today's (campus day) daily challenge, only when none is set: a rotation over published problems. */
async function seedDailyChallenge(db: Db, adminId: string): Promise<void> {
  const now = new Date();
  const day = campusDay(now);
  const date = campusDayDate(now);
  const existing = await db.dailyChallenge.findUnique({ where: { date }, select: { problem: { select: { slug: true } } } });
  if (existing) {
    log(`daily challenge ${day}: ${existing.problem.slug} (already set)`);
    return;
  }
  const published = await db.problem.findMany({
    where: { status: "PUBLISHED", liveVersionId: { not: null } },
    orderBy: { displayCode: "asc" },
    select: { id: true, slug: true },
  });
  if (published.length === 0) {
    log(`daily challenge ${day}: no published problem yet, skipped`);
    return;
  }
  const pick = published[dailyChallengeIndex(day, published.length)]!;
  await db.dailyChallenge.createMany({ data: [{ date, problemId: pick.id, createdById: adminId }], skipDuplicates: true });
  log(`daily challenge ${day}: ${pick.slug}`);
}

// ── Dev judge node ───────────────────────────────────────────────────────

async function seedJudgeNode(app: App) {
  const { db } = app;
  const id = process.env.JUDGE_DEV_NODE_ID;
  const token = process.env.JUDGE_DEV_NODE_TOKEN;
  if (!id || !token) {
    log("JUDGE_DEV_NODE_ID / JUDGE_DEV_NODE_TOKEN not set: no dev judge node registered");
    return;
  }
  if (!app.parseNodeId(id)) fail("JUDGE_DEV_NODE_ID must be 1–64 characters of letters, digits, '.', '_' or '-'.");
  if (!app.parseBearer(`Bearer ${token}`)) {
    fail("JUDGE_DEV_NODE_TOKEN must be 16–512 characters of letters, digits or ._~+/=- (it is never printed).");
  }
  const tokenHash = app.hashNodeToken(token);
  const existing = await db.judgeNode.findUnique({ where: { id }, select: { tokenHash: true } });
  if (!existing) {
    // OFFLINE until its first heartbeat brings it ONLINE.
    await db.judgeNode.create({ data: { id, hostname: "unregistered", tokenHash, status: "OFFLINE" } });
    await app.audit({
      actorId: null,
      action: "judge.node.created",
      entityType: "JudgeNode",
      entityId: id,
      sensitivity: "SECURITY",
      metadata: { via: "seed" },
    });
    log(`judge node ${id}: registered (OFFLINE until it heartbeats)`);
  } else if (existing.tokenHash !== tokenHash) {
    await db.judgeNode.update({ where: { id }, data: { tokenHash } });
    await app.audit({
      actorId: null,
      action: "judge.node.token_rotated",
      entityType: "JudgeNode",
      entityId: id,
      sensitivity: "SECURITY",
      metadata: { via: "seed" },
    });
    log(`judge node ${id}: token updated from JUDGE_DEV_NODE_TOKEN`);
  }
}

// ── Summary ──────────────────────────────────────────────────────────────

async function logSummary(db: Db): Promise<void> {
  const problems = await db.problem.findMany({
    orderBy: { displayCode: "asc" },
    select: {
      slug: true,
      displayCode: true,
      difficulty: true,
      liveVersion: { select: { revision: true } },
      tags: { select: { topic: true } },
      versions: {
        where: { frozenAt: null },
        orderBy: { revision: "desc" },
        take: 1,
        select: { revision: true, _count: { select: { hints: true } }, editorial: { select: { id: true } } },
      },
    },
  });
  log("problems:");
  for (const p of problems) {
    const live = p.liveVersion ? `live r${p.liveVersion.revision}` : "not published";
    const draft = p.versions[0];
    const draftText = draft ? `, draft r${draft.revision} (${draft._count.hints} hints${draft.editorial ? " + editorial" : ""})` : "";
    log(`  ${p.displayCode} ${p.slug.padEnd(17)} ${p.difficulty.padEnd(6)} ${live}${draftText}; topics ${p.tags.map((t) => t.topic).join(", ") || "—"}`);
  }
  const plans = await db.studyPlan.findMany({
    orderBy: { sortOrder: "asc" },
    select: { slug: true, kind: true, published: true, itemsTotal: true, _count: { select: { sections: true } } },
  });
  for (const p of plans) {
    log(`study plan ${p.slug} (${p.kind}${p.published ? "" : ", unpublished"}): ${p.itemsTotal} items in ${p._count.sections} sections`);
  }
  const companyTags = await db.problemCompanyTag.count();
  log(`company tags: ${companyTags} (none are seeded: no claims about what a company asked)`);
}

// ── Main ─────────────────────────────────────────────────────────────────

async function main() {
  // Relative paths (TESTDATA_DIR) resolve against apps/web, wherever we were started.
  process.chdir(APP_ROOT);
  const envFile = path.join(APP_ROOT, ".env.local");
  if (existsSync(envFile)) process.loadEnvFile(envFile);
  requireReactServerCondition();

  const app = await loadApp();
  const adminPassword = seedPassword(app, "SEED_ADMIN_PASSWORD");
  const studentPassword = seedPassword(app, "SEED_STUDENT_PASSWORD");

  try {
    const adminId = await upsertUser(app, ADMIN, adminPassword);
    await upsertUser(app, SECOND_SUPER_ADMIN, adminPassword);
    const scopedAdminId = await upsertUser(app, SCOPED_ADMIN, adminPassword);
    await seedAdminScope(app, scopedAdminId, adminId);
    for (const student of STUDENTS) await upsertUser(app, student, studentPassword);
    log(
      `users: 2 super admins (${ADMIN.collegeId}, ${SECOND_SUPER_ADMIN.collegeId}), 1 admin (${SCOPED_ADMIN.collegeId}), ` +
        `${STUDENTS.length} students`,
    );
    await seedLanguages(app.db);
    await seedTheme(app);
    await seedTwoSum(app, adminId);
    for (const def of AUTHORED_PROBLEMS) await seedAuthoredProblem(app, adminId, def);
    await seedTwoSumRevision(app, adminId);
    for (const [slug, help] of HELP_BY_SLUG) await seedHelpRevision(app, adminId, slug, help);
    await seedTopicTags(app.db);
    await seedBadges(app.db);
    for (const r of await syncSeededStudyPlans(app.db)) {
      log(
        `study plan ${r.slug}: ${r.created ? "created, " : ""}${r.itemsTotal} items` +
          ` (+${r.added} −${r.removed}, ${r.moved} moved, ${r.enrollmentsUpdated} enrollments updated)`,
      );
    }
    // Phase 7: the six mock patterns. The QUESTIONS are a content programme
    // with named owners (docs/OPEN-QUESTIONS.md, "Content is the binding
    // constraint") and are imported from CSV rather than seeded — a pattern
    // whose pool is short reports it as an authoring error on the pattern
    // page, which is where somebody can act on it.
    for (const r of await syncSeededMockPatterns(app.db, adminId)) {
      log(`mock pattern ${r.slug}: ${r.action}, ${r.sections} sections`);
    }
    // Phase 8: an academic calendar. The inactivity counter escalates nobody
    // while the calendar does not cover its window, so a dev database with no
    // calendar is one where the whole policy engine is a silent no-op.
    {
      const cal = await syncSeededCalendar(app.db, adminId);
      log(`calendar: ${cal.written} days, ${cal.from} to ${cal.to}`);
    }
    {
      const pol = await syncSeededInactivityPolicy(app.db, adminId);
      log(
        `inactivity policy: ${pol.action}, version ${pol.version}, auto-disable ${pol.autoDisableEnabled ? "ON" : "off"}`,
      );
    }
    // Phase 9: one readiness run, through the real 02:30 pipeline. Without
    // it /placement shows only its "not worked out yet" state, which also
    // means the accessibility scan would be scanning an empty page and
    // reporting it as a pass.
    {
      const r = await syncSeededReadiness(app.db);
      log(
        `readiness: ${r.snapshots} snapshot(s) for ${r.students} student(s) on ${r.computedOn}` +
          ` (unmeasurable tiers: service ${r.unmeasurable.service}, product ${r.unmeasurable.product}, top ${r.unmeasurable.top})`,
      );
      if (r.cohortsTooSmall.length > 0) {
        log(`  cohorts too small to rank in: ${r.cohortsTooSmall.join(", ")}`);
      }
    }
    await seedDailyChallenge(app.db, adminId);
    await seedJudgeNode(app);
    await logSummary(app.db);
    const drafts = await app.db.problem.findMany({
      where: { versions: { some: { frozenAt: null } } },
      select: { slug: true },
      orderBy: { displayCode: "asc" },
    });
    if (drafts.length > 0) {
      log(`drafts awaiting validation: ${drafts.map((d) => d.slug).join(", ")}`);
      log("  with a judge node up, run for each: npx tsx --conditions=react-server scripts/validate-and-publish.ts <slug>");
    }
    log("done");
  } finally {
    await app.db.$disconnect();
  }
}

main().catch((error: unknown) => {
  console.error("[seed] failed:", error);
  process.exit(1);
});
