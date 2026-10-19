import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { abs, findFiles, isTestPath, lexSource, lineAt, moduleSpecifiers, readRepoFile } from "./support/repo";

/**
 * The AdminScope fence (spec Phase 4: "AdminScope (department/batch) folded
 * into the where of every student-facing query an admin can run"; §7: app-layer
 * guards plus a build-breaking query-shape test are the fence, not RLS).
 *
 * Admin-reachable code — app/admin/**, components/admin/**, lib/admin/**,
 * server/actions/admin-*.ts, server/queries/admin-*.ts, any file that imports
 * the scope helpers or runs an admin role guard, and every @/server/** or
 * @/lib/admin/** module those import (transitively) — must shape every query
 * on a student model through lib/auth/scope-where.ts:
 *
 *   R1  reads, counts, aggregates and bulk writes on a student model carry
 *       scopedStudentWhere( (or staffOnlyWhere( on `user`, or a scopedId key)
 *   R2  raw SQL naming a student table interpolates ${scopedStudentSql(
 *   R3  no $queryRawUnsafe / $executeRawUnsafe
 *   R4  single-row writes on a student model are keyed by a scopedId or a
 *       where holding scopedStudentWhere(
 *   R5  notes, code drafts, submission sources and the audit log are never read
 *   R6  the scope filter is never spread (no later key can override it)
 *   R7  only lib/auth/scope*.ts builds a scope or mints a ScopedStudentId
 *   R8  every admin page/layout runs its guard (a page that reads students
 *       uses requireAdminScopePage); every exported action runs a guard
 *       before touching the database
 *   R9  admin pages and components never import @/lib/db
 *   R10 no hard delete of a user anywhere in apps/web/src
 *
 * SUPER_ADMIN-only code (app/super/**, components/super/**, super-* actions
 * and queries, lib/privileged/**, lib/accounts/**) is outside the fence: an
 * ADMIN cannot run it and a SUPER_ADMIN's scope is the whole college.
 * Exceptions are listed below with an exact count and a reason; a new call in
 * an exempt file, or a stale exemption, fails the test.
 */

const WEB_SRC = "apps/web/src";
const SCHEMA = "packages/db/prisma/schema.prisma";

// ── Schema: which models hold student data ──────────────────────────────

interface ModelField {
  name: string;
  type: string;
}

export function parseModels(schema: string): Map<string, ModelField[]> {
  const models = new Map<string, ModelField[]>();
  const text = schema.replace(/\/\/.*$/gm, "");
  for (const m of text.matchAll(/^model\s+(\w+)\s*\{([\s\S]*?)^\}/gm)) {
    const fields: ModelField[] = [];
    for (const line of m[2]!.split("\n")) {
      const f = /^\s*(\w+)\s+(\w+)(\[\])?\??/.exec(line);
      if (f && !line.trim().startsWith("@@")) fields.push({ name: f[1]!, type: f[2]! });
    }
    models.set(m[1]!, fields);
  }
  return models;
}

/** Models that reference a user but are not student data the fence must scope. */
const NON_STUDENT: Readonly<Record<string, string>> = {
  AdminScope: "an ADMIN's own grants, read only by lib/auth/scope.ts",
};

/** Models with a user reference other than userId / a User relation, and why they are not fenced. */
const OTHER_USER_REFERENCES: Readonly<Record<string, string>> = {
  AuditLog: "targetUserId; admin code may not read the audit log at all (R5)",
  ImpersonationSession: "targetUserId; super-admin only (governance)",
  EmailOutbox: "toUserId; written by governance, drained by the scheduler",
};

const schemaModels = parseModels(readRepoFile(SCHEMA));

function computeStudentModels(models: Map<string, ModelField[]>): Set<string> {
  const out = new Set<string>(["User"]);
  for (const [name, fields] of models) {
    if (name === "User" || name in NON_STUDENT) continue;
    if (fields.some((f) => f.name === "userId" || f.type === "User")) out.add(name);
  }
  return out;
}

const STUDENT_MODELS = computeStudentModels(schemaModels);
const delegateOf = (model: string) => model.charAt(0).toLowerCase() + model.slice(1);
const STUDENT_DELEGATES = new Set([...STUDENT_MODELS].map(delegateOf));

/** Never readable from admin code: private to the student, or super-only (full audit read). */
const FORBIDDEN_DELEGATES = ["note", "codeDraft", "submissionSource", "auditLog"] as const;

// ── Scanners (pure; self-tested below) ──────────────────────────────────

export interface Finding {
  rule: "R1" | "R2" | "R3" | "R4" | "R5" | "R6" | "R7" | "R8" | "R9" | "R10";
  line: number;
  /** "user.findMany", "raw:Submission", … — the exemption key. */
  call: string;
  message: string;
}

const READ_METHODS = new Set([
  "findMany",
  "findFirst",
  "findFirstOrThrow",
  "findUnique",
  "findUniqueOrThrow",
  "count",
  "aggregate",
  "groupBy",
  "updateMany",
  "updateManyAndReturn",
  "deleteMany",
]);
const WRITE_METHODS = new Set(["create", "createMany", "createManyAndReturn", "update", "delete", "upsert"]);

const SCOPED = /\bscopedStudentWhere\s*\(/;
const STAFF = /\bstaffOnlyWhere\s*\(/;
const SCOPED_ID = /\bscopedId\b/;

/** The code with every string and template literal blanked (quotes kept), so a call shape inside a string never counts. */
function blankStrings(code: string, strings: { start: number; end: number }[]): string {
  const out = code.split("");
  for (const s of strings) for (let i = s.start + 1; i < s.end - 1; i++) if (out[i] !== "\n") out[i] = " ";
  return out.join("");
}

/** The argument text of the call whose "(" is at `open` (strings already blanked). */
function balancedArgs(code: string, open: number): string {
  let depth = 0;
  for (let i = open; i < code.length; i++) {
    const c = code[i];
    if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]" || c === "}") {
      depth--;
      if (depth === 0) return code.slice(open + 1, i);
    }
  }
  return code.slice(open + 1);
}

const CALL = /\b(?:db|tx|client)\s*\.\s*([A-Za-z_$][\w$]*)\s*\.\s*([A-Za-z]+)\s*\(/g;

/** R1, R4 and R5: model-delegate calls. */
export function scanQueries(source: string, delegates: ReadonlySet<string> = STUDENT_DELEGATES): Finding[] {
  const lexed = lexSource(source);
  const code = blankStrings(lexed.code, lexed.strings);
  const findings: Finding[] = [];
  for (const m of code.matchAll(CALL)) {
    const [, delegate, method] = m as unknown as [string, string, string];
    const line = lineAt(code, m.index);
    if ((FORBIDDEN_DELEGATES as readonly string[]).includes(delegate)) {
      findings.push({ rule: "R5", line, call: `${delegate}.${method}`, message: `${delegate} is never read from admin code` });
      continue;
    }
    if (!delegates.has(delegate)) continue;
    const open = m.index + m[0].length - 1;
    const args = balancedArgs(code, open);
    const call = `${delegate}.${method}`;
    if (READ_METHODS.has(method)) {
      const ok = SCOPED.test(args) || SCOPED_ID.test(args) || (delegate === "user" && STAFF.test(args));
      if (!ok) findings.push({ rule: "R1", line, call, message: `${call}() without scopedStudentWhere(…)` });
    } else if (WRITE_METHODS.has(method)) {
      if (!SCOPED_ID.test(args) && !SCOPED.test(args)) {
        findings.push({ rule: "R4", line, call, message: `${call}() not keyed by a scopedId or scopedStudentWhere(…)` });
      }
    }
  }
  return findings;
}

const RAW_TAG = /(?:\$(?:queryRaw|executeRaw)(?:\s*<[^`]*>)?|\bPrisma\s*\.\s*sql)\s*$/;

/** R2 and R3: raw SQL. */
export function scanRaw(source: string, models: ReadonlySet<string> = STUDENT_MODELS): Finding[] {
  const { code, strings } = lexSource(source);
  const findings: Finding[] = [];
  for (const m of code.matchAll(/\$(?:queryRawUnsafe|executeRawUnsafe)\b/g)) {
    findings.push({ rule: "R3", line: lineAt(code, m.index), call: m[0], message: `${m[0]} is not allowed in admin code` });
  }
  for (const s of strings) {
    if (code[s.start] !== "`") continue;
    if (!RAW_TAG.test(code.slice(Math.max(0, s.start - 200), s.start))) continue;
    const tables = [...models].filter((t) => s.body.includes(`"${t}"`));
    if (tables.length === 0) continue;
    if (/\$\{\s*scopedStudentSql\s*\(/.test(s.body)) continue;
    findings.push({
      rule: "R2",
      line: lineAt(code, s.start),
      call: `raw:${tables.sort().join("+")}`,
      message: `raw SQL over ${tables.join(", ")} without \${scopedStudentSql(…)}`,
    });
  }
  return findings;
}

/** R6: the scope filter is passed whole, never spread. */
export function scanSpread(source: string): Finding[] {
  const { code } = lexSource(source);
  return [...code.matchAll(/\.\.\.\s*(scopedStudentWhere|staffOnlyWhere)\s*\(/g)].map((m) => ({
    rule: "R6" as const,
    line: lineAt(code, m.index),
    call: `...${m[1]}`,
    message: `do not spread ${m[1]}(…)`,
  }));
}

/** R7: building a scope or minting a scoped id. */
export function scanBrands(source: string): Finding[] {
  const { code } = lexSource(source);
  return [...code.matchAll(/\bas\s+(ScopedStudentId|StudentScope)\b|\bbuildStudentScope\s*\(/g)].map((m) => ({
    rule: "R7" as const,
    line: lineAt(code, m.index),
    call: m[1] ? `as ${m[1]}` : "buildStudentScope",
    message: "only lib/auth/scope-where.ts and lib/auth/scope.ts may build a scope or a ScopedStudentId",
  }));
}

/** R10: never hard-delete a user. */
export function scanUserDelete(source: string): Finding[] {
  const { code } = lexSource(source);
  return [...code.matchAll(/\buser\s*\.\s*(delete|deleteMany)\s*\(/g)].map((m) => ({
    rule: "R10" as const,
    line: lineAt(code, m.index),
    call: `user.${m[1]}`,
    message: "a user is never hard-deleted (archive or anonymise instead)",
  }));
}

const ACTION_GUARD = /\b(?:requireAdminScopeAction|requireSuperAdmin|requireActionRole)\s*\(/;
const DB_TOUCH = /\b(?:db|tx)\s*\.\s*\$?\w+/;

/** The body text of each `export async function` (null body when it cannot be found). */
function exportedAsyncFunctions(code: string): { name: string; line: number; body: string | null }[] {
  const out: { name: string; line: number; body: string | null }[] = [];
  for (const m of code.matchAll(/\bexport\s+async\s+function\s+([A-Za-z_$][\w$]*)\s*(?:<[^(]*>)?\s*\(/g)) {
    const name = m[1]!;
    const line = lineAt(code, m.index);
    // Skip the parameter list.
    let i = m.index + m[0].length - 1;
    let depth = 0;
    for (; i < code.length; i++) {
      if (code[i] === "(") depth++;
      else if (code[i] === ")" && --depth === 0) break;
    }
    // Skip a return type: the body is the first "{" outside angle brackets.
    let angle = 0;
    let start = -1;
    for (i = i + 1; i < code.length; i++) {
      const c = code[i];
      if (c === "=" && code[i + 1] === ">") {
        i++;
        continue;
      }
      if (c === "<") angle++;
      else if (c === ">") angle--;
      else if (c === "{" && angle === 0) {
        start = i;
        break;
      }
    }
    if (start < 0) {
      out.push({ name, line, body: null });
      continue;
    }
    depth = 0;
    let end = code.length;
    for (let k = start; k < code.length; k++) {
      if (code[k] === "{") depth++;
      else if (code[k] === "}" && --depth === 0) {
        end = k;
        break;
      }
    }
    out.push({ name, line, body: code.slice(start + 1, end) });
  }
  return out;
}

/** R8 (actions): every exported action runs a guard before it touches the database. */
export function scanActionGuards(source: string): Finding[] {
  const { code } = lexSource(source);
  const findings: Finding[] = [];
  for (const fn of exportedAsyncFunctions(code)) {
    const guard = fn.body ? fn.body.search(ACTION_GUARD) : -1;
    const touch = fn.body ? fn.body.search(DB_TOUCH) : -1;
    if (guard < 0) {
      findings.push({ rule: "R8", line: fn.line, call: `action:${fn.name}`, message: `${fn.name}() has no role guard` });
    } else if (touch >= 0 && touch < guard) {
      findings.push({ rule: "R8", line: fn.line, call: `action:${fn.name}`, message: `${fn.name}() touches the database before its guard` });
    }
  }
  return findings;
}

const PAGE_SCOPE_GUARD = /\brequireAdminScopePage\s*\(/;
const PAGE_ROLE_GUARD = /\brequirePageRole\s*\(\s*["']ADMIN["']\s*,\s*["']SUPER_ADMIN["']\s*\)/;

export function pageGuards(source: string): { scoped: boolean; role: boolean } {
  const { code } = lexSource(source);
  return { scoped: PAGE_SCOPE_GUARD.test(code), role: PAGE_ROLE_GUARD.test(code) };
}

/** Does this source run a student query (other than a pure staff-name lookup)? */
export function touchesStudents(source: string): boolean {
  const { code, strings } = lexSource(source);
  const blanked = blankStrings(code, strings);
  for (const m of blanked.matchAll(CALL)) {
    const delegate = m[1]!;
    if (!STUDENT_DELEGATES.has(delegate)) continue;
    const args = balancedArgs(blanked, m.index + m[0].length - 1);
    if (delegate === "user" && STAFF.test(args) && !SCOPED.test(args)) continue;
    return true;
  }
  return strings.some(
    (s) =>
      code[s.start] === "`" &&
      RAW_TAG.test(code.slice(Math.max(0, s.start - 200), s.start)) &&
      [...STUDENT_MODELS].some((t) => s.body.includes(`"${t}"`)),
  );
}

// ── Which files are admin-reachable ─────────────────────────────────────

const ADMIN_PREFIXES = [
  `${WEB_SRC}/app/admin/`,
  `${WEB_SRC}/components/admin/`,
  `${WEB_SRC}/lib/admin/`,
];
const ADMIN_PATTERNS = [/^apps\/web\/src\/server\/actions\/admin-[^/]+\.ts$/, /^apps\/web\/src\/server\/queries\/admin-[^/]+\.ts$/];

/** SUPER_ADMIN-only code: guarded by requireSuperAdmin / requireSuperAdminPage, scope = whole college. */
const SUPER_ONLY = [
  /^apps\/web\/src\/app\/super\//,
  /^apps\/web\/src\/components\/super\//,
  /^apps\/web\/src\/server\/(?:actions|queries)\/super-[^/]+\.ts$/,
  /^apps\/web\/src\/lib\/privileged\//,
  /^apps\/web\/src\/lib\/accounts\//,
];

const GUARD_CALL = /\b(?:requireActionRole|requirePageRole|requireSuperAdmin)\s*\(/;
const ADMIN_LITERAL = /["'](?:SUPER_)?ADMIN["']/;
const SCOPE_IMPORT = /^@\/lib\/auth\/scope(?:-where)?$/;
const FOLLOW = /^@\/(?:server|lib\/admin)\//;

const webFiles = findFiles({ under: [WEB_SRC], extensions: [".ts", ".tsx"], exclude: isTestPath });
const sources = new Map(webFiles.map((f) => [f, readRepoFile(f)] as const));
const isSuperOnly = (f: string) => SUPER_ONLY.some((re) => re.test(f));

function resolveAlias(spec: string): string | null {
  const base = `${WEB_SRC}/${spec.slice(2)}`;
  for (const candidate of [`${base}.ts`, `${base}.tsx`, `${base}/index.ts`, `${base}/index.tsx`]) {
    if (sources.has(candidate) || existsSync(abs(candidate))) return candidate;
  }
  return null;
}

function seedReason(file: string, source: string): boolean {
  if (ADMIN_PREFIXES.some((p) => file.startsWith(p)) || ADMIN_PATTERNS.some((re) => re.test(file))) return true;
  if (moduleSpecifiers(source).some((r) => SCOPE_IMPORT.test(r.specifier))) return true;
  const { code } = lexSource(source);
  return GUARD_CALL.test(code) && ADMIN_LITERAL.test(code);
}

function followedImports(file: string): string[] {
  const source = sources.get(file) ?? readRepoFile(file);
  return moduleSpecifiers(source)
    .filter((r) => FOLLOW.test(r.specifier))
    .map((r) => resolveAlias(r.specifier))
    .filter((f): f is string => f !== null && !isTestPath(f));
}

function adminReachable(): Set<string> {
  const reached = new Set<string>();
  const queue = webFiles.filter((f) => !isSuperOnly(f) && seedReason(f, sources.get(f)!));
  while (queue.length > 0) {
    const f = queue.pop()!;
    if (reached.has(f) || isSuperOnly(f)) continue;
    reached.add(f);
    for (const next of followedImports(f)) if (!reached.has(next)) queue.push(next);
  }
  return reached;
}

/** Everything a file pulls in through @/server/** and @/lib/admin/** (itself included). */
function closure(file: string): Set<string> {
  const seen = new Set<string>();
  const queue = [file];
  while (queue.length > 0) {
    const f = queue.pop()!;
    if (seen.has(f)) continue;
    seen.add(f);
    for (const next of followedImports(f)) queue.push(next);
  }
  return seen;
}

// ── Exemptions (exact counts) ───────────────────────────────────────────

interface Exemption {
  file: string;
  rule: Finding["rule"];
  call: string;
  count: number;
  reason: string;
}

const EXEMPTIONS: readonly Exemption[] = [
  {
    file: "apps/web/src/server/queries/admin-judge.ts",
    rule: "R1",
    call: "submission.findMany",
    count: 2,
    reason: "fleet stuck / internal-error lists; they select no identity (names come from a scoped lookup, else 'Outside your scope')",
  },
  {
    file: "apps/web/src/server/queries/admin-judge.ts",
    rule: "R1",
    call: "submission.count",
    count: 2,
    reason: "totals of the same fleet lists",
  },
  {
    file: "apps/web/src/server/queries/admin-judge.ts",
    rule: "R1",
    call: "submission.groupBy",
    count: 1,
    reason: "fleet verdict distribution over 24 h; an aggregate with no per-student rows",
  },
  {
    file: "apps/web/src/server/queries/admin-judge.ts",
    rule: "R2",
    call: "raw:Submission",
    count: 2,
    reason: "fleet queue-latency and language-mix aggregates; no per-student rows",
  },
  {
    file: "apps/web/src/server/queries/admin-judge.ts",
    rule: "R2",
    call: "raw:RunRequest",
    count: 1,
    reason: "fleet run-lane latency aggregate; no per-student rows",
  },
  {
    file: "apps/web/src/lib/admin/roster.ts",
    rule: "R1",
    call: "user.findMany",
    count: 2,
    reason:
      "roster key lookup (conflicts with accounts outside the scope must be detected; selects keys and cohort only, an out-of-scope match becomes OUTSIDE_SCOPE without detail) and the global handle-uniqueness lookup",
  },
  {
    file: "apps/web/src/server/queries/admin-invigilator.ts",
    rule: "R1",
    call: "assessmentAttempt.findMany",
    count: 1,
    reason:
      "an exam hall is a physical room: the invigilator standing in it has to see EVERY candidate seated there, and a hall scoped to one department's grant would show them half the room. The boundary here is the ExamSession, which the query filters on, not the AdminScope grant. The page is behind requireAdminScopePage() and the view returns no band, no points and no photograph",
  },
  {
    file: "apps/web/src/server/actions/invigilate.ts",
    rule: "R1",
    call: "assessmentAttempt.findUnique",
    count: 1,
    reason:
      "the same room: an invigilator acts on the candidate in front of them. Every action writes a reason and an audit row, and terminate takes a second staff member (a CHECK)",
  },
  {
    file: "apps/web/src/server/actions/invigilate.ts",
    rule: "R1",
    call: "assessmentAttempt.updateMany",
    count: 2,
    reason:
      "granting time (pausedMs, never expiresAt) and ending a sitting, both on a candidate in the invigilator's own hall; both audited with a written reason",
  },
  {
    file: "apps/web/src/server/actions/integrity.ts",
    rule: "R4",
    call: "integrityReview.create",
    count: 1,
    reason:
      "integrity review is a COLLEGE-level function, not a departmental one: SPEC section 5 requires two INDEPENDENT reviewers at the HIGH band, and a department with one administrator could not supply them. The row is keyed by the flag, the reviewer is the signed-in staff member, and the verdict carries a written rationale the student reads",
  },
  {
    file: "apps/web/src/server/actions/integrity.ts",
    rule: "R1",
    call: "integrityAppeal.findUnique",
    count: 1,
    reason: "the appeal being decided, read by flag; the same college-level reviewer pool as above",
  },
  {
    file: "apps/web/src/server/actions/integrity.ts",
    rule: "R1",
    call: "integrityAppeal.findUniqueOrThrow",
    count: 1,
    reason: "re-reading the two recorded verdicts to decide the appeal, after the second one is written",
  },
  {
    file: "apps/web/src/server/actions/integrity.ts",
    rule: "R1",
    call: "integrityAppeal.updateMany",
    count: 2,
    reason:
      "recording one decider's verdict, then the appeal's outcome; both conditional on outcome = PENDING, and the two-deciders-are-different rule is a CHECK",
  },
  {
    file: "apps/web/src/lib/admin/roster.ts",
    rule: "R4",
    call: "user.createManyAndReturn",
    count: 1,
    reason: "the LMS roster copy; planRosterImport() checked every target cohort with scopeCovers() first",
  },
];

function applyExemptions(file: string, findings: Finding[]): { violations: Finding[]; stale: string[] } {
  const mine = EXEMPTIONS.filter((e) => e.file === file);
  const violations: Finding[] = [];
  const stale: string[] = [];
  const byKey = new Map<string, Finding[]>();
  for (const f of findings) byKey.set(`${f.rule}|${f.call}`, [...(byKey.get(`${f.rule}|${f.call}`) ?? []), f]);
  for (const [key, list] of byKey) {
    const ex = mine.find((e) => `${e.rule}|${e.call}` === key);
    if (!ex) violations.push(...list);
    else if (ex.count !== list.length) {
      violations.push(...list.map((f) => ({ ...f, message: `${f.message} (exempt count is ${ex.count}, found ${list.length})` })));
    }
  }
  for (const e of mine) if (!byKey.has(`${e.rule}|${e.call}`)) stale.push(`${e.rule} ${e.call} (exempt ×${e.count}, found none)`);
  return { violations, stale };
}

const fmt = (file: string, fs: Finding[]) => fs.map((f) => `${file}:${f.line}  ${f.rule}  ${f.message}`);

// ── Tests ───────────────────────────────────────────────────────────────

describe("AdminScope fence", () => {
  describe("self-test", () => {
    const flagged: Array<[string, Finding["rule"], string]> = [
      ["R1 unscoped findMany", "R1", "const rows = await db.user.findMany({ where: { batchYear: 2027 } });"],
      ["R1 unscoped count on a relation model", "R1", "await db.submission.count({ where: { verdict: 'AC' } });"],
      ["R1 unscoped groupBy through tx", "R1", "await tx.studyPlanEnrollment.groupBy({ by: ['planId'], _count: true });"],
      ["R1 unscoped bulk update", "R1", "await db.notification.updateMany({ where: { readAt: null }, data: { readAt: now } });"],
      ["R1 staffOnlyWhere on a non-user model", "R1", "await db.submission.findMany({ where: { user: staffOnlyWhere({}) } });"],
      ["R1 scope only inside a string", "R1", "await db.user.findMany({ where: { note: 'scopedStudentWhere(' } });"],
      ["R1 where built elsewhere", "R1", "const where = scopedStudentWhere(scope);\nawait db.user.findMany({ where });"],
      ["R2 raw over User", "R2", 'await db.$queryRaw`SELECT count(*) FROM "User" u WHERE u."batchYear" = ${b}`;'],
      ["R2 raw with a generic", "R2", 'await tx.$queryRaw<{ n: number }[]>`SELECT 1 FROM "Accommodation" WHERE id = ${id} FOR UPDATE`;'],
      ["R2 Prisma.sql fragment over a student table", "R2", 'const q = Prisma.sql`SELECT * FROM "UserStats" s`;'],
      ["R3 queryRawUnsafe", "R3", 'await db.$queryRawUnsafe("SELECT 1");'],
      ["R3 executeRawUnsafe", "R3", 'await tx.$executeRawUnsafe(`UPDATE "Problem" SET x = 1`);'],
      ["R4 create keyed by a raw id", "R4", "await db.judgeQuotaOverride.create({ data: { userId: user.id } });"],
      ["R4 update without scope", "R4", "await tx.user.update({ where: { id }, data: { section: 'B' } });"],
      ["R5 reads a note", "R5", "await db.note.findMany({ where: { userId: scopedId } });"],
      ["R5 reads a code draft", "R5", "await tx.codeDraft.findFirst({ where: { user: scopedStudentWhere(scope) } });"],
      ["R5 reads a submission source", "R5", "await db.submissionSource.findUnique({ where: { submissionId } });"],
      ["R5 reads the audit log", "R5", "await db.auditLog.findMany({ take: 10 });"],
    ];
    it.each(flagged)("flags %s", (_name, rule, snippet) => {
      const found = [...scanQueries(snippet), ...scanRaw(snippet)];
      expect(found.map((f) => f.rule)).toContain(rule);
    });

    const clean: Array<[string, string]> = [
      ["scoped user query", "await db.user.findMany({ where: scopedStudentWhere(scope, { batchYear: 2027 }) });"],
      ["scoped relation filter", "await db.accommodation.count({ where: { status: 'REQUESTED', user: scopedStudentWhere(scope) } });"],
      ["staff names on user", "await db.user.findMany({ where: staffOnlyWhere({ id: { in: ids } }) });"],
      ["keyed by a ScopedStudent", "await db.userStats.findUnique({ where: { userId: student.scopedId } });"],
      ["write keyed by scopedId", "await tx.notification.createMany({ data: ids.map((scopedId) => ({ userId: scopedId })) });"],
      ["scoped bulk write", "await tx.user.updateMany({ where: scopedStudentWhere(scope, { id }), data });"],
      ["non-student model", "await db.problem.findMany({ where: { status: 'PUBLISHED' } });"],
      ["AdminScope is not student data", "await db.adminScope.findMany({ where: { adminId, revokedAt: null } });"],
      ["commented out", "// await db.user.findMany({ where: {} });"],
      ["scoped raw SQL", 'await db.$queryRaw`SELECT 1 FROM "User" u WHERE ${scopedStudentSql(scope, "u")}`;'],
      ["raw SQL over a non-student table", 'await tx.$queryRaw`SELECT id FROM "Announcement" WHERE id = ${id} FOR UPDATE`;'],
      ["a plain template literal", 'const label = `"User" is a table name`;'],
    ];
    it.each(clean)("does not flag %s", (_name, snippet) => {
      expect([...scanQueries(snippet), ...scanRaw(snippet)]).toEqual([]);
    });

    it("R6 flags a spread scope and not a whole one", () => {
      expect(scanSpread("const where = { ...scopedStudentWhere(scope), id };").map((f) => f.rule)).toEqual(["R6"]);
      expect(scanSpread("const where = { AND: [x], ...staffOnlyWhere({}) };").map((f) => f.rule)).toEqual(["R6"]);
      expect(scanSpread("const where = scopedStudentWhere(scope, { id });")).toEqual([]);
    });

    it("R7 flags a brand cast or a scope built outside lib/auth/scope*.ts", () => {
      expect(scanBrands("const id = raw as ScopedStudentId;").map((f) => f.call)).toEqual(["as ScopedStudentId"]);
      expect(scanBrands("const s = { kind: 'ALL' } as StudentScope;").map((f) => f.call)).toEqual(["as StudentScope"]);
      expect(scanBrands("const s = buildStudentScope(user, []);").map((f) => f.call)).toEqual(["buildStudentScope"]);
      expect(scanBrands("const s = await loadStudentScope(user);")).toEqual([]);
      expect(scanBrands("function f(id: ScopedStudentId, s: StudentScope) {}")).toEqual([]);
    });

    it("R8 checks that every exported action guards before touching the database", () => {
      const good = `export async function a(input: X): Promise<ActionResult<{ id: string }>> {
        return runAction(async () => { const { user, scope } = await requireAdminScopeAction(); await db.user.count({}); });
      }
      export async function b() { return runAction(async () => { const u = await requireSuperAdmin(); return u; }); }`;
      expect(scanActionGuards(good)).toEqual([]);
      const none = `export async function c(): Promise<ActionResult<number>> { return runAction(async () => db.user.count()); }`;
      expect(scanActionGuards(none).map((f) => f.call)).toEqual(["action:c"]);
      const late = `export async function d() { return runAction(async () => { await db.problem.count(); await requireActionRole("ADMIN"); }); }`;
      expect(scanActionGuards(late).map((f) => f.message)).toEqual(["d() touches the database before its guard"]);
      expect(scanActionGuards("async function helper() { await db.user.count(); }")).toEqual([]);
    });

    it("R8 recognises the two page guards", () => {
      expect(pageGuards("const { scope } = await requireAdminScopePage();")).toEqual({ scoped: true, role: false });
      expect(pageGuards('await requirePageRole("ADMIN", "SUPER_ADMIN");')).toEqual({ scoped: false, role: true });
      expect(pageGuards('await requirePageRole("SUPER_ADMIN");')).toEqual({ scoped: false, role: false });
      expect(pageGuards("// await requireAdminScopePage();")).toEqual({ scoped: false, role: false });
    });

    it("R10 flags a hard delete of a user", () => {
      expect(scanUserDelete("await db.user.delete({ where: { id } });").map((f) => f.rule)).toEqual(["R10"]);
      expect(scanUserDelete("await tx.user.deleteMany({ where: { id: { in: ids } } });").map((f) => f.rule)).toEqual(["R10"]);
      expect(scanUserDelete("await db.session.deleteMany({ where: { userId } });")).toEqual([]);
    });

    it("touchesStudents ignores pure staff-name lookups", () => {
      expect(touchesStudents("await db.user.findMany({ where: staffOnlyWhere({ id: { in: ids } }) });")).toBe(false);
      expect(touchesStudents("await db.problem.findMany({});")).toBe(false);
      expect(touchesStudents("await db.user.findMany({ where: scopedStudentWhere(scope) });")).toBe(true);
      expect(touchesStudents('await db.$queryRaw`SELECT 1 FROM "Submission"`;')).toBe(true);
    });

    it("exemptions are exact: an extra call or a stale entry fails", () => {
      const file = "apps/web/src/lib/admin/roster.ts";
      const f = (call: string): Finding => ({ rule: "R1", line: 1, call, message: call });
      expect(applyExemptions(file, [f("user.findMany"), f("user.findMany")]).violations).toEqual([]);
      expect(applyExemptions(file, [f("user.findMany"), f("user.findMany"), f("user.findMany")]).violations).toHaveLength(3);
      const r4: Finding = { rule: "R4", line: 2, call: "user.createManyAndReturn", message: "x" };
      expect(applyExemptions(file, [f("user.findMany"), f("user.findMany"), r4]).stale).toEqual([]);
      expect(applyExemptions(file, [r4]).stale).toEqual(["R1 user.findMany (exempt ×2, found none)"]);
    });
  });

  describe("student models (from schema.prisma)", () => {
    it("include every model with a userId or a User relation", () => {
      for (const model of ["User", "Submission", "UserStats", "StudyPlanEnrollment", "Notification", "Accommodation", "Session", "XpBucket"]) {
        expect(STUDENT_MODELS.has(model), model).toBe(true);
      }
      expect(STUDENT_MODELS.has("AdminScope")).toBe(false);
      expect(STUDENT_MODELS.has("Problem")).toBe(false);
      expect(STUDENT_MODELS.has("Announcement")).toBe(false);
    });

    it("every NON_STUDENT exemption still exists and references a user", () => {
      for (const model of Object.keys(NON_STUDENT)) {
        const fields = schemaModels.get(model);
        expect(fields, `${model} is listed in NON_STUDENT but no longer exists`).toBeDefined();
        expect(fields!.some((f) => f.name === "userId" || f.type === "User"), model).toBe(true);
      }
    });

    it("a model that references a user any other way is classified", () => {
      const unclassified = [...schemaModels]
        .filter(([name, fields]) => name !== "User" && fields.some((f) => /UserId$/.test(f.name) && f.name !== "userId"))
        .map(([name]) => name)
        .filter((name) => !STUDENT_MODELS.has(name) && !(name in OTHER_USER_REFERENCES) && !(name in NON_STUDENT));
      expect(unclassified, "Add the model to the fence (a userId / User relation) or to OTHER_USER_REFERENCES with a reason.").toEqual([]);
      for (const model of Object.keys(OTHER_USER_REFERENCES)) expect(schemaModels.has(model), model).toBe(true);
    });
  });

  const reachable = adminReachable();
  const reachableList = [...reachable].sort();

  it("finds the admin surface (sanity)", () => {
    for (const f of [
      `${WEB_SRC}/app/admin/page.tsx`,
      `${WEB_SRC}/app/admin/judge/page.tsx`,
      `${WEB_SRC}/server/actions/admin-roster.ts`,
      `${WEB_SRC}/server/actions/admin-judge.ts`,
      `${WEB_SRC}/server/queries/admin-judge.ts`,
      `${WEB_SRC}/lib/admin/roster.ts`,
      `${WEB_SRC}/lib/auth/scope.ts`,
    ]) {
      expect(reachable.has(f), f).toBe(true);
    }
    expect(reachable.has(`${WEB_SRC}/server/queries/dashboard.ts`)).toBe(false);
  });

  it.each(reachableList)("%s: student queries are scoped (R1–R6)", (file) => {
    const source = sources.get(file)!;
    const findings = [...scanQueries(source), ...scanRaw(source), ...scanSpread(source)];
    const { violations, stale } = applyExemptions(file, findings);
    expect(fmt(file, violations), "Shape the query with scopedStudentWhere / scopedStudentSql (lib/auth/scope).").toEqual([]);
    expect(stale, "Remove or correct the stale exemption in tests/repo/admin-scope.test.ts.").toEqual([]);
  });

  it("every exemption names an admin-reachable file", () => {
    for (const e of EXEMPTIONS) expect(reachable.has(e.file), e.file).toBe(true);
  });

  it("R7: only lib/auth/scope*.ts builds a scope or a ScopedStudentId", () => {
    const allowed = new Set([`${WEB_SRC}/lib/auth/scope.ts`, `${WEB_SRC}/lib/auth/scope-where.ts`]);
    const hits = webFiles.filter((f) => !allowed.has(f)).flatMap((f) => fmt(f, scanBrands(sources.get(f)!)));
    expect(hits).toEqual([]);
  });

  const adminPages = webFiles.filter((f) => /^apps\/web\/src\/app\/admin\/(?:.+\/)?(?:page|layout)\.tsx$/.test(f));

  it("R8: the admin tree has pages to check (sanity)", () => {
    expect(adminPages).toContain(`${WEB_SRC}/app/admin/page.tsx`);
    expect(adminPages).toContain(`${WEB_SRC}/app/admin/layout.tsx`);
  });

  it.each(adminPages)("R8: %s runs its own admin guard (scoped when it reads students)", (file) => {
    const guards = pageGuards(sources.get(file)!);
    expect(guards.scoped || guards.role, `${file} must call requireAdminScopePage() or requirePageRole("ADMIN", "SUPER_ADMIN")`).toBe(
      true,
    );
    const readsStudents = [...closure(file)].some((f) => touchesStudents(sources.get(f) ?? readRepoFile(f)));
    if (readsStudents && file.endsWith("page.tsx")) {
      expect(guards.scoped, `${file} reads student data, so it must call requireAdminScopePage()`).toBe(true);
    }
  });

  const actionFiles = webFiles.filter((f) => /^apps\/web\/src\/server\/actions\/admin-[^/]+\.ts$/.test(f));

  it.each(actionFiles)("R8: every exported action in %s guards first", (file) => {
    expect(fmt(file, scanActionGuards(sources.get(file)!))).toEqual([]);
  });

  it("R9: admin pages and components never import @/lib/db", () => {
    const hits = webFiles
      .filter((f) => f.startsWith(`${WEB_SRC}/app/admin/`) || f.startsWith(`${WEB_SRC}/components/admin/`))
      .flatMap((f) =>
        moduleSpecifiers(sources.get(f)!)
          .filter((r) => r.specifier === "@/lib/db" || r.specifier === "@/lib/db-client")
          .map((r) => `${f}:${r.line}  imports ${r.specifier}`),
      );
    expect(hits, "Read through a server/queries module or write through a server action.").toEqual([]);
  });

  it("R10: no file in apps/web/src hard-deletes a user", () => {
    const hits = webFiles.flatMap((f) => fmt(f, scanUserDelete(sources.get(f)!)));
    expect(hits).toEqual([]);
  });
});
