import { createHash } from "node:crypto";
import { z } from "zod";
import type { Prisma, PrivilegedOperationKind } from "@recx/db";
import { BULK_STATUS_DIRECT_MAX, BULK_STATUS_MAX, LANGUAGE_KEYS, PII_EXPORT_MAX_ACCOUNTS, VERDICTS } from "@recx/shared";
import { canonicalJson } from "@/lib/audit-chain";

/**
 * The payload of each PrivilegedOperation kind. The target set is resolved
 * when the operation is REQUESTED (a user filter becomes an id list), so the
 * approver approves an exact, hashed payload (payloadSha256) and the
 * executor runs exactly that. Pure module: no database, no server-only.
 */

export const ACCOUNT_STATUSES = ["ACTIVE", "SOFT_RESTRICTED", "DISABLED", "GRADUATED", "ARCHIVED"] as const;
export const ROLE_VALUES = ["STUDENT", "TA_MENTOR", "ADMIN", "PLACEMENT_OFFICER", "SUPER_ADMIN"] as const;

const idSchema = z.string().trim().min(1).max(64);

export const userFilterSchema = z
  .object({
    roles: z.array(z.enum(ROLE_VALUES)).max(ROLE_VALUES.length).optional(),
    statuses: z.array(z.enum(ACCOUNT_STATUSES)).max(ACCOUNT_STATUSES.length).optional(),
    batchYear: z.number().int().min(2000).max(2100).optional(),
    departmentCode: z.string().trim().min(1).max(16).optional(),
    section: z.string().trim().min(1).max(8).optional(),
  })
  .strict();
export type UserFilter = z.infer<typeof userFilterSchema>;

/** The Prisma where-clause of a user filter (empty filter = every account). */
export function userFilterWhere(filter: UserFilter): Prisma.UserWhereInput {
  return {
    ...(filter.roles?.length ? { role: { in: filter.roles } } : {}),
    ...(filter.statuses?.length ? { status: { in: filter.statuses } } : {}),
    ...(filter.batchYear !== undefined ? { batchYear: filter.batchYear } : {}),
    ...(filter.departmentCode ? { departmentCode: filter.departmentCode } : {}),
    ...(filter.section ? { section: filter.section } : {}),
  };
}

/** The minimised column set a PII export may contain. Never password hashes, sessions or IP hashes. */
export const PII_EXPORT_COLUMNS = [
  "collegeId",
  "firstName",
  "lastName",
  "email",
  "departmentCode",
  "batchYear",
  "section",
  "role",
  "status",
  "createdAt",
  "lastActiveAt",
] as const;
export type PiiExportColumn = (typeof PII_EXPORT_COLUMNS)[number];

export const privilegedPayloadSchemas = {
  BULK_STATUS_CHANGE: z
    .object({
      userIds: z
        .array(idSchema)
        .min(BULK_STATUS_DIRECT_MAX + 1)
        .max(BULK_STATUS_MAX)
        .refine((ids) => new Set(ids).size === ids.length, "Each account may appear only once."),
      toStatus: z.enum(ACCOUNT_STATUSES),
    })
    .strict(),
  SUBMISSION_PURGE: z
    .object({
      userId: idSchema,
      before: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use a yyyy-mm-dd date."),
      includeAccepted: z.boolean(),
    })
    .strict(),
  GLOBAL_REJUDGE: z
    .object({
      problemId: idSchema,
      problemVersionId: idSchema.nullable(),
      languages: z.array(z.enum(LANGUAGE_KEYS)).max(LANGUAGE_KEYS.length),
      verdicts: z.array(z.enum(VERDICTS)).max(VERDICTS.length),
    })
    .strict(),
  PII_EXPORT: z
    .object({
      /** The filter as entered (shown and audited); the export covers exactly `userIds`. */
      filter: userFilterSchema,
      userIds: z
        .array(idSchema)
        .min(1)
        .max(PII_EXPORT_MAX_ACCOUNTS)
        .refine((ids) => new Set(ids).size === ids.length, "Each account may appear only once."),
      columns: z
        .array(z.enum(PII_EXPORT_COLUMNS))
        .min(1)
        .max(PII_EXPORT_COLUMNS.length)
        .refine((c) => new Set(c).size === c.length, "Each column may appear only once."),
    })
    .strict(),
  PROBLEM_DELETE: z.object({ problemId: idSchema }).strict(),
  VERSION_DELETE: z.object({ problemVersionId: idSchema }).strict(),
} as const satisfies Record<PrivilegedOperationKind, z.ZodTypeAny>;

export type PrivilegedPayload<K extends PrivilegedOperationKind> = z.infer<(typeof privilegedPayloadSchemas)[K]>;

export function parsePrivilegedPayload<K extends PrivilegedOperationKind>(kind: K, value: unknown): PrivilegedPayload<K> {
  return privilegedPayloadSchemas[kind].parse(value) as PrivilegedPayload<K>;
}

/** sha256 over the canonical (key-sorted) JSON: what the approver approves. */
export function payloadDigest(payload: unknown): string {
  return createHash("sha256").update(canonicalJson(payload)).digest("hex");
}

export const PRIVILEGED_KIND_LABEL: Readonly<Record<PrivilegedOperationKind, string>> = {
  BULK_STATUS_CHANGE: "Bulk status change",
  SUBMISSION_PURGE: "Submission purge",
  GLOBAL_REJUDGE: "Global rejudge",
  PII_EXPORT: "PII export",
  PROBLEM_DELETE: "Problem deletion",
  VERSION_DELETE: "Version deletion",
};
