import "server-only";
import {
  anonymousAuthor,
  companyTagNotice,
  companyTagSource,
  type CompanyTagSource,
  type InterviewMode,
  type InterviewOutcome,
  type InterviewPreparation,
  type InterviewRoundKind,
  type InterviewStatus,
  type Topic,
} from "@recx/shared";
import { db } from "@/lib/db";

/**
 * Reading the interview archive (Phase 12e).
 *
 * The student-facing reads never select the author. Not "select it and
 * drop it on the way out" — never select it, so there is no payload it
 * could survive in and no future refactor that accidentally renders it.
 * `anonymousAuthor()` is built from the batch and department the query
 * does take, and it drops the section on purpose: batch plus department
 * plus section is three or four people.
 */

export interface ExperienceView {
  id: string;
  company: string;
  companySlug: string | null;
  role: string;
  mode: InterviewMode;
  heldYear: number;
  heldMonth: number;
  rounds: number;
  longestRoundMinutes: number | null;
  outcome: InterviewOutcome;
  roundKinds: InterviewRoundKind[];
  topics: Topic[];
  preparation: InterviewPreparation[];
  /** "A CSE student, batch of 2026" — never a name. */
  by: string;
  problems: Array<{ slug: string; title: string; displayCode: string }>;
  createdAt: Date;
}

const PROBLEM_SELECT = { problem: { select: { slug: true, title: true, displayCode: true, status: true } } } as const;
const AUTHOR_SHAPE = { select: { batchYear: true, departmentCode: true } } as const;

function viewOf(row: {
  id: string;
  companyName: string;
  company: { slug: string } | null;
  role: string;
  mode: InterviewMode;
  heldYear: number;
  heldMonth: number;
  rounds: number;
  longestRoundMinutes: number | null;
  outcome: InterviewOutcome;
  roundKinds: InterviewRoundKind[];
  topics: string[];
  preparation: InterviewPreparation[];
  createdAt: Date;
  author: { batchYear: number | null; departmentCode: string | null } | null;
  problems: Array<{ problem: { slug: string; title: string; displayCode: string; status: string } }>;
}): ExperienceView {
  return {
    id: row.id,
    company: row.companyName,
    companySlug: row.company?.slug ?? null,
    role: row.role,
    mode: row.mode,
    heldYear: row.heldYear,
    heldMonth: row.heldMonth,
    rounds: row.rounds,
    longestRoundMinutes: row.longestRoundMinutes,
    outcome: row.outcome,
    roundKinds: row.roundKinds,
    topics: row.topics as Topic[],
    preparation: row.preparation,
    by: row.author
      ? anonymousAuthor(row.author)
      : // A pre-launch BOOTSTRAP row: collected from a graduated batch and
        // entered by the placement cell, with nobody to anonymise.
        "Collected before launch",
    problems: row.problems.filter((p) => p.problem.status === "PUBLISHED").map((p) => p.problem),
    createdAt: row.createdAt,
  };
}

export interface ArchivePage {
  experiences: ExperienceView[];
  /** Companies with at least one approved account, most first. */
  companies: Array<{ slug: string; name: string; count: number }>;
  /** The viewer's own submissions, whatever their state. */
  mine: Array<{
    id: string;
    company: string;
    status: InterviewStatus;
    decisionReason: string | null;
    createdAt: Date;
  }>;
}

export async function loadArchive(userId: string, companySlug?: string | null): Promise<ArchivePage> {
  const where = {
    status: "APPROVED" as const,
    ...(companySlug ? { company: { slug: companySlug } } : {}),
  };
  const [rows, grouped, mine] = await Promise.all([
    db.interviewExperience.findMany({
      where,
      orderBy: [{ heldYear: "desc" }, { heldMonth: "desc" }, { createdAt: "desc" }],
      take: 60,
      select: {
        id: true,
        companyName: true,
        company: { select: { slug: true } },
        role: true,
        mode: true,
        heldYear: true,
        heldMonth: true,
        rounds: true,
        longestRoundMinutes: true,
        outcome: true,
        roundKinds: true,
        topics: true,
        preparation: true,
        createdAt: true,
        author: AUTHOR_SHAPE,
        problems: { select: PROBLEM_SELECT },
      },
    }),
    db.company.findMany({
      where: { interviews: { some: { status: "APPROVED" } } },
      select: { slug: true, name: true, _count: { select: { interviews: { where: { status: "APPROVED" } } } } },
      orderBy: { name: "asc" },
    }),
    db.interviewExperience.findMany({
      where: { authorId: userId },
      orderBy: { createdAt: "desc" },
      take: 20,
      select: { id: true, companyName: true, status: true, decisionReason: true, createdAt: true },
    }),
  ]);

  return {
    experiences: rows.map((row) => viewOf(row)),
    companies: grouped
      .map((company) => ({ slug: company.slug, name: company.name, count: company._count.interviews }))
      .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name)),
    mine: mine.map((row) => ({
      id: row.id,
      company: row.companyName,
      status: row.status,
      decisionReason: row.decisionReason,
      createdAt: row.createdAt,
    })),
  };
}

// ── The moderation queue ────────────────────────────────────────────────

export interface PendingExperience extends ExperienceView {
  /** Moderators see who wrote it: a row nobody stands behind cannot be followed up. */
  author: string | null;
  /** A catalogue company whose slug matches what they typed, if there is one. */
  suggestedCompanyId: string | null;
  linkedCompanyId: string | null;
}

export async function loadPendingExperiences(): Promise<{ pending: PendingExperience[]; companies: Array<{ id: string; name: string }> }> {
  const [rows, companies] = await Promise.all([
    db.interviewExperience.findMany({
      where: { status: "PENDING" },
      orderBy: { createdAt: "asc" },
      take: 60,
      select: {
        id: true,
        companyName: true,
        companyId: true,
        company: { select: { slug: true } },
        role: true,
        mode: true,
        heldYear: true,
        heldMonth: true,
        rounds: true,
        longestRoundMinutes: true,
        outcome: true,
        roundKinds: true,
        topics: true,
        preparation: true,
        createdAt: true,
        author: { select: { firstName: true, lastName: true, batchYear: true, departmentCode: true } },
        problems: { select: PROBLEM_SELECT },
      },
    }),
    db.company.findMany({ select: { id: true, name: true, slug: true }, orderBy: { name: "asc" } }),
  ]);

  const bySlug = new Map(companies.map((company) => [company.slug, company.id]));
  return {
    pending: rows.map((row) => ({
      ...viewOf(row),
      author: row.author ? `${row.author.firstName} ${row.author.lastName}`.trim() : null,
      suggestedCompanyId: bySlug.get(slugOf(row.companyName)) ?? null,
      linkedCompanyId: row.companyId,
    })),
    companies: companies.map(({ id, name }) => ({ id, name })),
  };
}

function slugOf(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

// ── What a company tag is, on the catalogue ─────────────────────────────

export interface CompanyTagLabel {
  source: CompanyTagSource;
  notice: string;
}

/**
 * The label SPEC §11 requires: "placement-cell-curated company tracks
 * explicitly labelled as curated".
 *
 * A curated tag is somebody's best guess at what a company asks; an
 * EXPERIENCE tag is a count of what students reported. A student choosing
 * what to revise the night before a drive is entitled to know which one
 * they are looking at, so the catalogue says it rather than showing a
 * number with no provenance.
 */
export async function companyTagLabel(companySlug: string): Promise<CompanyTagLabel | null> {
  const company = await db.company.findUnique({
    where: { slug: companySlug },
    select: {
      id: true,
      _count: { select: { interviews: { where: { status: "APPROVED" } } } },
      problems: { select: { source: true }, take: 200 },
    },
  });
  if (!company) return null;
  const approved = company._count.interviews;
  const source: CompanyTagSource = companyTagSource(approved);
  const alsoCurated = company.problems.some((tag) => tag.source === "CURATED");
  return { source, notice: companyTagNotice(source, approved, alsoCurated) };
}
