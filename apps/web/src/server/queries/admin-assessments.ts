import "server-only";
import {
  normalisePaperLanguages,
  paperLanguageViews,
  paperQuestionCount,
  sebSettingKey,
  type PaperLanguageView,
} from "@recx/shared";
import { scopedStudentWhere, type StudentScope } from "@/lib/auth/scope";
import { db } from "@/lib/db";

/**
 * What the assessment admin reads (Phase 12a). Staff-only by construction:
 * every caller is a page behind `requireActionRole("ADMIN","SUPER_ADMIN")`'s
 * page equivalent, and nothing here is reachable from a student surface.
 */

export interface AssessmentRow {
  id: string;
  slug: string;
  title: string;
  status: string;
  proctorMode: string;
  affectsPlacementEligibility: boolean;
  opensAt: Date;
  closesAt: Date;
  durationSec: number;
  questions: number;
  halls: number;
  /**
   * Sittings by THIS reader's own students (Phase 13j).
   *
   * It used to be every sitting in the college, which disagreed with the
   * results page -- scoped since 12y -- for any administrator who does
   * not cover the whole college. Two numbers for the same word on two
   * screens is how somebody concludes that marks are missing.
   */
  attempts: number;
  /**
   * Of those, the ones in progress right now. The number an invigilator
   * opens this page for during an exam.
   */
  sitting: number;
  /** Phase 13j: whether the marks have been let out to the candidates. */
  resultsPublishedAt: Date | null;
}

/** Phase 13j: one page of the list, and how to ask for the next. */
export interface AssessmentPage {
  readonly rows: readonly AssessmentRow[];
  /** Every paper matching the filters, not just this page. */
  readonly total: number;
  readonly page: number;
  readonly pageSize: number;
  readonly pageCount: number;
}

export const ASSESSMENT_PAGE_SIZE = 25;

/** The statuses the filter offers, in the order a paper moves through them. */
export const ASSESSMENT_STATUSES = ["DRAFT", "PUBLISHED", "OPEN", "CLOSED", "ARCHIVED"] as const;
export type AssessmentStatusFilter = (typeof ASSESSMENT_STATUSES)[number];

export interface AssessmentQuery {
  /** Matched against the title and the address, case-insensitively. */
  readonly search?: string;
  readonly status?: AssessmentStatusFilter | null;
  /** 1-based. Out-of-range pages clamp rather than 404. */
  readonly page?: number;
}

/**
 * One page of the assessment list (Phase 13j).
 *
 * It used to be `take: 200` and nothing else: no search, no filter, and a
 * silent cap that would quietly stop showing a department's older papers
 * in the third year of use -- with nothing on the page saying so, which is
 * the part that makes a cap worse than a page break. A college runs
 * hundreds of papers a year and the one somebody wants is usually named,
 * so the list is searched, filtered by status and paged, and says how many
 * matched.
 *
 * `mode: "insensitive"` on both fields: staff type a paper's name the way
 * they say it, not the way it was capitalised when it was created.
 */
export async function listAssessments(scope: StudentScope, query: AssessmentQuery = {}): Promise<AssessmentPage> {
  const search = (query.search ?? "").trim();
  const where = {
    ...(query.status ? { status: query.status } : {}),
    ...(search
      ? {
          OR: [
            { title: { contains: search, mode: "insensitive" as const } },
            { slug: { contains: search, mode: "insensitive" as const } },
          ],
        }
      : {}),
  };
  const total = await db.assessment.count({ where });
  const pageCount = Math.max(1, Math.ceil(total / ASSESSMENT_PAGE_SIZE));
  // Clamped rather than refused: a stale "page 9" link after somebody
  // archives half the list should show the last page, not an error.
  const page = Math.min(Math.max(1, Math.trunc(query.page ?? 1)), pageCount);

  const rows = await db.assessment.findMany({
    where,
    orderBy: [{ opensAt: "desc" }],
    skip: (page - 1) * ASSESSMENT_PAGE_SIZE,
    take: ASSESSMENT_PAGE_SIZE,
    select: {
      id: true,
      slug: true,
      title: true,
      status: true,
      proctorMode: true,
      affectsPlacementEligibility: true,
      opensAt: true,
      closesAt: true,
      durationSec: true,
      resultsPublishedAt: true,
      // Both kinds (Phase 12v): the Questions column read `problems` alone,
      // so an all-multiple-choice paper showed 0 to the staff member who
      // had just authored it.
      _count: { select: { problems: true, mcqs: true, sessions: true } },
    },
  });

  /**
   * The sittings, for the papers on THIS page only and for the reader's
   * own students, in one grouped query.
   *
   * Not `_count: { attempts: true }`, for two reasons: it holds one count
   * per relation, so the total and the in-progress count cannot both live
   * there, and it cannot carry the AdminScope filter at all -- which is
   * how this column came to show a department administrator the whole
   * college's sittings beside a results page showing them their own.
   *
   * DISCONNECTED counts as sitting: a candidate whose connection dropped
   * is still in the hall with the clock running, and an invigilator
   * reading "12 sitting now" needs them in the number.
   */
  const sat = new Map<string, { total: number; live: number }>();
  if (rows.length > 0) {
    const grouped = await db.assessmentAttempt.groupBy({
      by: ["assessmentId", "status"],
      where: { assessmentId: { in: rows.map((r) => r.id) }, user: scopedStudentWhere(scope) },
      _count: { _all: true },
    });
    for (const row of grouped) {
      const entry = sat.get(row.assessmentId) ?? { total: 0, live: 0 };
      entry.total += row._count._all;
      if (row.status === "IN_PROGRESS" || row.status === "DISCONNECTED") entry.live += row._count._all;
      sat.set(row.assessmentId, entry);
    }
  }

  return {
    rows: rows.map((r) => ({
      id: r.id,
      slug: r.slug,
      title: r.title,
      status: r.status,
      proctorMode: r.proctorMode,
      affectsPlacementEligibility: r.affectsPlacementEligibility,
      opensAt: r.opensAt,
      closesAt: r.closesAt,
      durationSec: r.durationSec,
      questions: paperQuestionCount({ problems: { length: r._count.problems }, mcqs: { length: r._count.mcqs } }),
      halls: r._count.sessions,
      attempts: sat.get(r.id)?.total ?? 0,
      sitting: sat.get(r.id)?.live ?? 0,
      resultsPublishedAt: r.resultsPublishedAt,
    })),
    total,
    page,
    pageSize: ASSESSMENT_PAGE_SIZE,
    pageCount,
  };
}

/**
 * `sitting` is the list's own column (Phase 13j) and costs a grouped query
 * over the page's ids; the detail page is one paper and has the hall
 * dashboard beside it, so it is omitted here rather than computed twice.
 */
export interface AssessmentDetail extends Omit<AssessmentRow, "sitting"> {
  instructions: string;
  maxAttempts: number;
  maxFocusWarnings: number;
  onLimit: string;
  strictMode: boolean;
  /** Phase 12s: the two per-paper watching options. */
  refuseOutsidePaste: boolean;
  sitInPopup: boolean;
  /**
   * Which languages the paper may be answered in (Phase 13a), as the
   * administrator saved it: EMPTY means every enabled language, and the
   * page says so rather than showing an empty list that reads like a
   * paper nobody can sit.
   */
  allowedLanguages: string[];
  /**
   * Every language this platform can actually judge right now -- the
   * enabled, current `LanguageConfig` keys. The checkbox list is drawn
   * from these, so an administrator can only promise candidates something
   * the judge can run.
   *
   * As views, with their labels already resolved: the catalog they come
   * from carries every compiler argv for eleven toolchains and has no
   * business in a browser bundle (see `PaperLanguageView`).
   */
  availableLanguages: PaperLanguageView[];
  audienceBatchYear: number | null;
  audienceDepartmentCode: string | null;
  audienceSection: string | null;
  problems: Array<{
    id: string;
    position: number;
    points: number;
    slug: string;
    displayCode: string;
    title: string;
    revision: number;
    /**
     * Which of the paper's languages this question narrows to (Phase
     * 13c). Empty -- the usual case -- means all of them.
     */
    allowedLanguages: string[];
  }>;
  /**
   * The multiple-choice half (Phase 12r). `correctIndex` is here and not
   * on the candidate's view: an author has to be able to see which option
   * they marked right, and this page is behind requireActionRole.
   */
  mcqs: Array<{
    id: string;
    position: number;
    points: number;
    stem: string;
    options: string[];
    correctIndex: number;
  }>;
  /**
   * Which SEB scopes have keys (Phase 12z). Booleans, never the keys: this
   * is a page, and "is it set" is the only thing a person reads.
   */
  sebCollegeKeys: { configKey: boolean; browserExamKey: boolean };
  sessions: Array<{
    id: string;
    label: string;
    room: string | null;
    startsAt: Date;
    endsAt: Date;
    capacity: number;
    allowedCidrs: string[];
    seated: number;
    sebKeys: { configKey: boolean; browserExamKey: boolean };
  }>;
}

export async function getAssessmentDetail(id: string): Promise<AssessmentDetail | null> {
  const row = await db.assessment.findUnique({
    where: { id },
    select: {
      id: true,
      slug: true,
      title: true,
      instructions: true,
      resultsPublishedAt: true,
      status: true,
      proctorMode: true,
      affectsPlacementEligibility: true,
      opensAt: true,
      closesAt: true,
      durationSec: true,
      maxAttempts: true,
      maxFocusWarnings: true,
      onLimit: true,
      strictMode: true,
      refuseOutsidePaste: true,
      sitInPopup: true,
      allowedLanguages: true,
      audienceBatchYear: true,
      audienceDepartmentCode: true,
      audienceSection: true,
      _count: { select: { problems: true, mcqs: true, sessions: true, attempts: true } },
      problems: {
        orderBy: { position: "asc" },
        select: {
          id: true,
          position: true,
          points: true,
          allowedLanguages: true,
          problemVersion: {
            select: { revision: true, title: true, problem: { select: { slug: true, displayCode: true } } },
          },
        },
      },
      mcqs: {
        orderBy: { position: "asc" },
        select: { id: true, position: true, points: true, stem: true, options: true, correctIndex: true },
      },
      sessions: {
        orderBy: { startsAt: "asc" },
        select: {
          id: true,
          label: true,
          room: true,
          startsAt: true,
          endsAt: true,
          capacity: true,
          allowedCidrs: true,
          sebConfigKey: true,
          sebBrowserExamKey: true,
          _count: { select: { attempts: true } },
        },
      },
    },
  });
  if (!row) return null;

  /**
   * Which SEB scopes hold a key (Phase 12z).
   *
   * Read as BOOLEANS and never returned: the page shows "set" or "not
   * set", and a 64-character digest that reached the browser would be a
   * copy of it in every proxy log between here and there for no reason
   * anybody needs.
   */
  /**
   * What the judge can run right now (Phase 13a). Read here rather than in
   * the page so the two lists -- what this paper accepts and what exists --
   * come from one query and cannot disagree.
   */
  const installed = await db.languageConfig.findMany({
    where: { enabled: true, isCurrent: true },
    select: { key: true },
  });

  const collegeRow = await db.platformSetting.findUnique({ where: { key: sebSettingKey(null) }, select: { value: true } });
  const collegeValue = collegeRow?.value as { configKey?: unknown; browserExamKey?: unknown } | null | undefined;
  const sebCollegeKeys = {
    configKey: typeof collegeValue?.configKey === "string" && collegeValue.configKey !== "",
    browserExamKey: typeof collegeValue?.browserExamKey === "string" && collegeValue.browserExamKey !== "",
  };

  return {
    id: row.id,
    slug: row.slug,
    title: row.title,
    instructions: row.instructions,
    resultsPublishedAt: row.resultsPublishedAt,
    status: row.status,
    proctorMode: row.proctorMode,
    affectsPlacementEligibility: row.affectsPlacementEligibility,
    opensAt: row.opensAt,
    closesAt: row.closesAt,
    durationSec: row.durationSec,
    maxAttempts: row.maxAttempts,
    maxFocusWarnings: row.maxFocusWarnings,
    onLimit: row.onLimit,
    strictMode: row.strictMode,
    refuseOutsidePaste: row.refuseOutsidePaste,
    sitInPopup: row.sitInPopup,
    allowedLanguages: normalisePaperLanguages(row.allowedLanguages),
    availableLanguages: paperLanguageViews(normalisePaperLanguages(installed.map((language) => language.key))),
    audienceBatchYear: row.audienceBatchYear,
    audienceDepartmentCode: row.audienceDepartmentCode,
    audienceSection: row.audienceSection,
    questions: paperQuestionCount({
      problems: { length: row._count.problems },
      mcqs: { length: row._count.mcqs },
    }),
    halls: row._count.sessions,
    attempts: row._count.attempts,
    problems: row.problems.map((p) => ({
      id: p.id,
      position: p.position,
      points: p.points,
      slug: p.problemVersion.problem.slug,
      displayCode: p.problemVersion.problem.displayCode,
      title: p.problemVersion.title,
      revision: p.problemVersion.revision,
      allowedLanguages: normalisePaperLanguages(p.allowedLanguages),
    })),
    mcqs: row.mcqs.map((m) => ({
      id: m.id,
      position: m.position,
      points: m.points,
      stem: m.stem,
      options: m.options,
      correctIndex: m.correctIndex,
    })),
    sessions: row.sessions.map((s) => ({
      id: s.id,
      label: s.label,
      room: s.room,
      startsAt: s.startsAt,
      endsAt: s.endsAt,
      capacity: s.capacity,
      allowedCidrs: s.allowedCidrs,
      seated: s._count.attempts,
      sebKeys: { configKey: s.sebConfigKey !== null, browserExamKey: s.sebBrowserExamKey !== null },
    })),
    sebCollegeKeys,
  };
}
