import { z } from "zod";
import type { AccountStatus, Prisma } from "@recx/db";

/**
 * /admin/students filters from the URL. Every value is untrusted: anything
 * that does not parse is dropped (no filter), never an error page.
 * filtersToWhere() returns the `extra` part only — the caller passes it to
 * scopedStudentWhere(scope, extra), which adds the role and the scope.
 */

export const ACCOUNT_STATUSES = ["ACTIVE", "SOFT_RESTRICTED", "DISABLED", "GRADUATED", "ARCHIVED"] as const satisfies readonly AccountStatus[];

export const INACTIVE_DAYS = [7, 14, 30] as const;

export const STUDENT_PAGE_SIZE = 50;

const optional = <T extends z.ZodTypeAny>(schema: T) => schema.optional().catch(undefined);

export const studentFiltersSchema = z.object({
  q: optional(z.string().trim().min(1).max(100)),
  batch: optional(z.coerce.number().int().min(2000).max(2100)),
  dept: optional(z.string().trim().toUpperCase().regex(/^[A-Z]{2,10}$/)),
  section: optional(z.string().trim().toUpperCase().regex(/^[A-Z0-9]{1,4}$|^-$/)),
  status: optional(z.enum(ACCOUNT_STATUSES)),
  inactive: optional(z.coerce.number().pipe(z.union([z.literal(7), z.literal(14), z.literal(30)]))),
  after: optional(z.string().trim().regex(/^[A-Za-z0-9]{1,32}$/)),
});

export type StudentFilters = z.output<typeof studentFiltersSchema>;

type RawParams = Record<string, string | string[] | undefined>;

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

export function parseStudentFilters(params: RawParams): StudentFilters {
  const pick = (key: string) => {
    const v = first(params[key]);
    return v === undefined || v.trim() === "" ? undefined : v;
  };
  return studentFiltersSchema.parse({
    q: pick("q"),
    batch: pick("batch"),
    dept: pick("dept"),
    section: pick("section"),
    status: pick("status"),
    inactive: pick("inactive"),
    after: pick("after"),
  });
}

const ROLL_NUMBER = /^[A-Za-z0-9]{4,32}$/;
const EMAIL_LIKE = /^[^\s@]+@[^\s@]+$/;

/**
 * The User filter for the parsed filters (no scope, no role). The search box
 * matches an exact roll number or email, or a first/last-name prefix — at
 * about 5,000 students there is no trigram index (docs/OPEN-QUESTIONS.md).
 */
export function filtersToWhere(f: StudentFilters, now: Date = new Date()): Prisma.UserWhereInput {
  const and: Prisma.UserWhereInput[] = [];
  if (f.q) {
    const q = f.q;
    const or: Prisma.UserWhereInput[] = [];
    if (ROLL_NUMBER.test(q)) or.push({ collegeId: { equals: q, mode: "insensitive" } });
    if (EMAIL_LIKE.test(q)) or.push({ email: { equals: q.toLowerCase(), mode: "insensitive" } });
    const words = q.split(/\s+/).filter(Boolean);
    if (words.length === 1) {
      or.push({ firstName: { startsWith: q, mode: "insensitive" } }, { lastName: { startsWith: q, mode: "insensitive" } });
    } else if (words.length >= 2) {
      or.push({
        AND: [
          { firstName: { startsWith: words[0]!, mode: "insensitive" } },
          { lastName: { startsWith: words.slice(1).join(" "), mode: "insensitive" } },
        ],
      });
    }
    and.push({ OR: or });
  }
  if (f.batch !== undefined) and.push({ batchYear: f.batch });
  if (f.dept !== undefined) and.push({ departmentCode: f.dept });
  if (f.section !== undefined) and.push({ section: f.section === "-" ? null : f.section });
  if (f.status !== undefined) and.push({ status: f.status });
  if (f.inactive !== undefined) {
    const since = new Date(now.getTime() - f.inactive * 86_400_000);
    and.push({ OR: [{ lastActiveAt: null }, { lastActiveAt: { lt: since } }] });
  }
  return and.length === 0 ? {} : { AND: and };
}

/** The query string for a filtered page (empty values dropped). */
export function filtersToQuery(f: StudentFilters, overrides: Partial<Record<keyof StudentFilters, string | number | undefined>> = {}): string {
  const params = new URLSearchParams();
  const merged: Record<string, string | number | undefined> = { ...f, ...overrides };
  for (const key of ["q", "batch", "dept", "section", "status", "inactive", "after"] as const) {
    const v = merged[key];
    if (v !== undefined && v !== "") params.set(key, String(v));
  }
  const s = params.toString();
  return s ? `?${s}` : "";
}

export function hasFilters(f: StudentFilters): boolean {
  return [f.q, f.batch, f.dept, f.section, f.status, f.inactive].some((v) => v !== undefined);
}
