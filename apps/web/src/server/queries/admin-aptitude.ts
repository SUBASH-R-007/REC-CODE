import "server-only";
import {
  APTITUDE_AREAS,
  APTITUDE_TOPICS,
  APTITUDE_TOPIC_LABEL,
  aptitudeCsvHeader,
  questionToRow,
  type AptitudeArea,
  type AptitudeTopic,
} from "@recx/shared";
import { db } from "@/lib/db";
import { APTITUDE_ANSWER_SELECT } from "@/server/queries/aptitude-select";

/**
 * Staff reads of the aptitude question bank (Phase 7d).
 *
 * The `admin-` filename prefix is what carries the sensitive-path rule
 * (`docs/CONVENTIONS.md`), and it is what keeps this module out of the
 * student sweep in `apps/web/test/student-exposure.db.test.ts` and out of
 * `tests/repo/aptitude-answer-exposure.test.ts`'s student closure. The name
 * is not optional.
 *
 * Every list here is PAGED. SPEC §7: "Do not render 5,000 DOM rows.
 * Virtualise." The bank is sized at ~2,000 questions, and the sibling this
 * copies — `admin-problems.ts` — already settled the shape with
 * `PAGE_SIZE = 50`, `skip`/`take` and a page count.
 */

const PAGE_SIZE = 50;

export interface QuestionListRow {
  readonly id: string;
  readonly displayCode: string;
  readonly area: AptitudeArea;
  readonly topic: AptitudeTopic;
  readonly topicLabel: string;
  readonly kind: string;
  readonly difficulty: string;
  readonly status: string;
  readonly hasExplanation: boolean;
  readonly timesServed: number;
  readonly timesAnswered: number;
  readonly accuracyPercent: number | null;
  readonly updatedAt: Date;
}

export interface QuestionListFilters {
  readonly area?: AptitudeArea;
  readonly topic?: AptitudeTopic;
  readonly status?: "DRAFT" | "IN_REVIEW" | "PUBLISHED" | "RETIRED";
  readonly q?: string;
  readonly page?: number;
}

export interface QuestionList {
  readonly rows: QuestionListRow[];
  readonly page: number;
  readonly pageCount: number;
  readonly total: number;
  readonly pageSize: number;
}

export async function listAptitudeQuestions(filters: QuestionListFilters = {}): Promise<QuestionList> {
  const where = {
    ...(filters.area ? { area: filters.area } : {}),
    ...(filters.topic ? { topic: filters.topic } : {}),
    ...(filters.status ? { status: filters.status } : {}),
    ...(filters.q && filters.q.trim().length > 0
      ? {
          OR: [
            { displayCode: { contains: filters.q.trim(), mode: "insensitive" as const } },
            { stem: { contains: filters.q.trim(), mode: "insensitive" as const } },
          ],
        }
      : {}),
  };

  const total = await db.aptitudeQuestion.count({ where });
  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const page = Math.min(Math.max(1, Math.floor(filters.page ?? 1)), pageCount);

  const rows = await db.aptitudeQuestion.findMany({
    where,
    orderBy: [{ updatedAt: "desc" }, { displayCode: "asc" }],
    skip: (page - 1) * PAGE_SIZE,
    take: PAGE_SIZE,
    select: {
      id: true,
      displayCode: true,
      area: true,
      topic: true,
      kind: true,
      difficulty: true,
      status: true,
      explanation: true,
      updatedAt: true,
      stat: { select: { timesServed: true, timesAnswered: true, timesCorrect: true } },
    },
  });

  return {
    rows: rows.map((row) => ({
      id: row.id,
      displayCode: row.displayCode,
      area: row.area,
      topic: row.topic,
      topicLabel: APTITUDE_TOPIC_LABEL[row.topic],
      kind: row.kind,
      difficulty: row.difficulty,
      status: row.status,
      // The list never carries the explanation itself — a staff LIST does not
      // need 50 worked solutions, and the page is 50 rows, not 50 essays.
      hasExplanation: row.explanation.trim().length > 0,
      timesServed: row.stat?.timesServed ?? 0,
      timesAnswered: row.stat?.timesAnswered ?? 0,
      accuracyPercent:
        row.stat && row.stat.timesAnswered > 0
          ? Math.round((row.stat.timesCorrect / row.stat.timesAnswered) * 1000) / 10
          : null,
      updatedAt: row.updatedAt,
    })),
    page,
    pageCount,
    total,
    pageSize: PAGE_SIZE,
  };
}

/** One question, with its key and its working — staff only. */
export async function getAptitudeQuestion(id: string) {
  return db.aptitudeQuestion.findUnique({
    where: { id },
    select: {
      ...APTITUDE_ANSWER_SELECT,
      status: true,
      origin: true,
      sourceBatch: true,
      authorId: true,
      reviewedById: true,
      publishedAt: true,
      retiredAt: true,
      contentHash: true,
      createdAt: true,
      updatedAt: true,
      passage: { select: { id: true, title: true, body: true, wordCount: true } },
      stat: { select: { timesServed: true, timesAnswered: true, timesCorrect: true, totalSeconds: true } },
    },
  });
}

/**
 * The counts an author needs before publishing a pattern: how many PUBLISHED
 * questions each topic actually has.
 *
 * Grouped in one query rather than 29, and it is what makes
 * `BlueprintUnfillable` avoidable at authoring time instead of discovered by
 * a candidate mid-sitting.
 */
export async function publishedPoolByTopic(): Promise<Array<{ topic: AptitudeTopic; label: string; count: number }>> {
  const grouped = await db.aptitudeQuestion.groupBy({
    by: ["topic"],
    where: { status: "PUBLISHED" },
    _count: { _all: true },
  });
  const counts = new Map(grouped.map((row) => [row.topic, row._count._all]));
  return APTITUDE_TOPICS.map((topic) => ({
    topic,
    label: APTITUDE_TOPIC_LABEL[topic],
    count: counts.get(topic) ?? 0,
  }));
}

/** The import history, newest first, paged. */
export async function listAptitudeImports(page = 1) {
  const total = await db.aptitudeImport.count();
  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const current = Math.min(Math.max(1, Math.floor(page)), pageCount);
  const rows = await db.aptitudeImport.findMany({
    orderBy: { startedAt: "desc" },
    skip: (current - 1) * PAGE_SIZE,
    take: PAGE_SIZE,
    select: {
      id: true,
      fileName: true,
      sizeBytes: true,
      via: true,
      status: true,
      defaultArea: true,
      defaultTopic: true,
      total: true,
      created: true,
      revised: true,
      unchanged: true,
      failed: true,
      error: true,
      startedAt: true,
      finishedAt: true,
    },
  });
  return {
    rows: rows.map((row) => ({ ...row, sizeBytes: Number(row.sizeBytes) })),
    page: current,
    pageCount,
    total,
    pageSize: PAGE_SIZE,
  };
}

/** One import with its rows — every line, applied or not, with every reason. */
export async function getAptitudeImport(id: string, page = 1) {
  const record = await db.aptitudeImport.findUnique({
    where: { id },
    select: {
      id: true,
      fileName: true,
      sizeBytes: true,
      via: true,
      status: true,
      defaultArea: true,
      defaultTopic: true,
      total: true,
      created: true,
      revised: true,
      unchanged: true,
      failed: true,
      error: true,
      startedAt: true,
      finishedAt: true,
      uploadedById: true,
    },
  });
  if (!record) return null;

  const rowTotal = await db.aptitudeImportRow.count({ where: { importId: id } });
  const pageCount = Math.max(1, Math.ceil(rowTotal / PAGE_SIZE));
  const current = Math.min(Math.max(1, Math.floor(page)), pageCount);
  const rows = await db.aptitudeImportRow.findMany({
    where: { importId: id },
    // Failures first: an operator opening this page is here to fix them.
    orderBy: [{ status: "asc" }, { line: "asc" }],
    skip: (current - 1) * PAGE_SIZE,
    take: PAGE_SIZE,
    select: {
      line: true,
      status: true,
      questionId: true,
      displayCode: true,
      errors: true,
      warnings: true,
    },
  });

  return {
    import: { ...record, sizeBytes: Number(record.sizeBytes) },
    rows,
    page: current,
    pageCount,
    total: rowTotal,
    pageSize: PAGE_SIZE,
  };
}

/**
 * The whole bank as a CSV.
 *
 * It carries the answer key and the worked explanations, which is the one
 * artefact that must never reach a student mailbox — so the only route to it
 * is staff-only and audited on every download
 * (`docs/OPEN-QUESTIONS.md`). A bank with the keys stripped is not a bank a
 * faculty member can review, which is why it carries them at all.
 *
 * Streamed in pages rather than read whole: 2,000 questions with worked
 * explanations is several megabytes, and holding it all in memory to join it
 * would be the one place this product reads an unbounded table.
 */
export async function* aptitudeExportCsv(filters: { area?: AptitudeArea; status?: string } = {}): AsyncGenerator<string> {
  yield aptitudeCsvHeader();
  const where = {
    ...(filters.area ? { area: filters.area } : {}),
    ...(filters.status ? { status: filters.status as "DRAFT" } : {}),
  };
  // Offset paging rather than a keyset cursor: ordered by id over a bank the
  // spec sizes at ~2,000 questions, that is ten queries, and a conditionally
  // spread `cursor` makes Prisma's own return type circular. Keyset would
  // matter at a million rows; this table will not have them.
  let skip = 0;
  for (;;) {
    const page = await db.aptitudeQuestion.findMany({
      where,
      orderBy: { id: "asc" },
      skip,
      take: 200,
      select: {
        ...APTITUDE_ANSWER_SELECT,
        displayCode: true,
        origin: true,
        passage: { select: { title: true, body: true } },
      },
    });
    if (page.length === 0) return;
    for (const question of page) {
      yield questionToRow({
        kind: question.kind,
        displayCode: question.displayCode,
        area: question.area,
        topic: question.topic,
        difficulty: question.difficulty,
        stem: question.stem,
        options: question.options,
        correctOptionIndexes: question.correctOptionIndexes,
        numericAnswer: question.numericAnswer === null ? null : question.numericAnswer.toString(),
        numericTolerance: question.numericTolerance === null ? null : question.numericTolerance.toString(),
        numericUnit: question.numericUnit,
        explanation: question.explanation,
        expectedSeconds: question.expectedSeconds,
        origin: question.origin,
        passage: question.passage,
      });
    }
    skip += page.length;
  }
}

/** The filter vocabulary the pages render, so a page invents none of it. */
export const APTITUDE_FILTER_OPTIONS = Object.freeze({
  areas: APTITUDE_AREAS,
  topics: APTITUDE_TOPICS.map((topic) => ({ topic, label: APTITUDE_TOPIC_LABEL[topic] })),
  statuses: ["DRAFT", "IN_REVIEW", "PUBLISHED", "RETIRED"] as const,
});
