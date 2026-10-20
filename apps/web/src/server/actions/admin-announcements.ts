"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { audit } from "@/lib/audit";
import {
  ACTIVE_STUDENT_STATUSES,
  listScopedStudentIds,
  requireAdminScopeAction,
  scopeCovers,
  type StudentScope,
} from "@/lib/auth/scope";
import { db } from "@/lib/db";
import { ConflictError, ForbiddenError, NotFoundError, RateLimitError, ValidationError, runAction, type ActionResult } from "@/lib/errors";
import { requestIpHash } from "@/lib/ip";
import { hitRateLimit } from "@/lib/rate-limit";
import { audienceCohort, audienceSchema, audienceWhere, type Audience } from "@/lib/admin/announcement-audience";
import { safeNotificationHref } from "@/app/(student)/notifications/model";

/**
 * /admin/announcements mutations. Plain text, no scheduling.
 *
 *   saveAnnouncementDraft  ADMIN  create or edit a draft (author or SUPER_ADMIN)
 *   publishAnnouncement    ADMIN  fan out one Notification per in-scope, current student of the audience
 *   archiveAnnouncement    ADMIN  hide a published announcement's banner (notifications stay)
 *
 * The audience must lie inside the author's scope. Once published the text,
 * audience and recipient count are fixed (the database refuses changes).
 */

const MAX_DAYS = 30;
const FANOUT_CHUNK = 1000;

const idSchema = z.string().trim().min(1).max(64);

const draftSchema = z.object({
  id: idSchema.optional(),
  title: z.string().trim().min(1, "Give the announcement a title.").max(120, "Keep the title under 120 characters."),
  body: z.string().trim().min(1, "Write the announcement.").max(2000, "Keep the announcement under 2,000 characters."),
  tone: z.enum(["INFO", "IMPORTANT"]),
  link: z
    .string()
    .trim()
    .max(512)
    .optional()
    .transform((v, ctx) => {
      if (!v) return null;
      const safe = safeNotificationHref(v);
      if (!safe) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "The link must be a path on this site, such as /sheets/rec-starter-sheet.",
        });
        return z.NEVER;
      }
      return safe;
    }),
  audience: audienceSchema,
  endsAt: z.coerce.date({ invalid_type_error: "Enter when the banner should stop." }),
});
export type SaveAnnouncementDraftInput = z.input<typeof draftSchema>;

function assertCovered(scope: StudentScope, audience: Pick<Audience, "batchYear" | "departmentCode">) {
  if (!scopeCovers(scope, audienceCohort(audience))) throw new ForbiddenError("That audience is outside your scope.");
}

function assertEndsAt(endsAt: Date, now: Date) {
  if (Number.isNaN(endsAt.getTime()) || endsAt <= now) throw new ValidationError("The banner must stop at a future time.");
  if (endsAt.getTime() > now.getTime() + MAX_DAYS * 86_400_000) {
    throw new ValidationError(`An announcement can run for at most ${MAX_DAYS} days.`);
  }
}

export async function saveAnnouncementDraft(input: SaveAnnouncementDraftInput): Promise<ActionResult<{ id: string }>> {
  return runAction(async () => {
    const { user, scope } = await requireAdminScopeAction();
    const parsed = draftSchema.parse(input);
    assertCovered(scope, parsed.audience);
    assertEndsAt(parsed.endsAt, new Date());
    const data = {
      title: parsed.title,
      body: parsed.body,
      tone: parsed.tone,
      link: parsed.link,
      audienceBatchYear: parsed.audience.batchYear,
      audienceDepartmentCode: parsed.audience.departmentCode,
      audienceSection: parsed.audience.section,
      endsAt: parsed.endsAt,
    };
    let id: string;
    if (parsed.id) {
      const existing = await db.announcement.findUnique({
        where: { id: parsed.id },
        select: { id: true, createdById: true, publishedAt: true, audienceBatchYear: true, audienceDepartmentCode: true },
      });
      if (!existing || (existing.createdById !== user.id && user.role !== "SUPER_ADMIN")) {
        throw new NotFoundError("That announcement was not found.");
      }
      assertCovered(scope, { batchYear: existing.audienceBatchYear, departmentCode: existing.audienceDepartmentCode });
      const saved = await db.announcement.updateMany({ where: { id: existing.id, publishedAt: null }, data });
      if (saved.count !== 1) throw new ConflictError("This announcement is already published; its text can no longer change.");
      id = existing.id;
    } else {
      const created = await db.announcement.create({ data: { ...data, createdById: user.id }, select: { id: true } });
      id = created.id;
    }
    await audit({
      actorId: user.id,
      action: "announcement.draft_saved",
      entityType: "Announcement",
      entityId: id,
      sensitivity: "NORMAL",
      metadata: { audience: { ...parsed.audience }, tone: parsed.tone, endsAt: parsed.endsAt.toISOString() },
      ipHash: await requestIpHash(),
    });
    revalidatePath("/admin/announcements");
    revalidatePath(`/admin/announcements/${id}`);
    return { id };
  }, "saveAnnouncementDraft");
}

const idInput = z.object({ id: idSchema });
export type AnnouncementIdInput = z.input<typeof idInput>;

/**
 * Publish a draft: in one transaction (row locked), one Notification per
 * in-scope ACTIVE or SOFT_RESTRICTED student of the audience, then the
 * publish UPDATE with the recipient count. Students who join later do not
 * receive it.
 */
export async function publishAnnouncement(input: AnnouncementIdInput): Promise<ActionResult<{ recipientCount: number }>> {
  return runAction(async () => {
    const { user, scope } = await requireAdminScopeAction();
    const { id } = idInput.parse(input);
    const hit = await hitRateLimit(`admin-bulk:${user.id}`, { limit: 10, windowMs: 60_000 });
    if (!hit.allowed) throw new RateLimitError();
    const now = new Date();

    const published = await db.$transaction(
      async (tx) => {
        const locked = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM "Announcement" WHERE id = ${id} FOR UPDATE`;
        if (locked.length === 0) throw new NotFoundError("That announcement was not found.");
        const a = await tx.announcement.findUniqueOrThrow({
          where: { id },
          select: {
            id: true,
            title: true,
            body: true,
            link: true,
            tone: true,
            createdById: true,
            publishedAt: true,
            endsAt: true,
            audienceBatchYear: true,
            audienceDepartmentCode: true,
            audienceSection: true,
          },
        });
        if (a.createdById !== user.id && user.role !== "SUPER_ADMIN") throw new NotFoundError("That announcement was not found.");
        if (a.publishedAt) throw new ConflictError("This announcement is already published.");
        if (a.endsAt <= now) throw new ValidationError("This draft's end time has passed. Edit it before publishing.");
        const audience: Audience = {
          batchYear: a.audienceBatchYear,
          departmentCode: a.audienceDepartmentCode,
          section: a.audienceSection,
        };
        assertCovered(scope, audience);

        const recipients = await listScopedStudentIds(tx, scope, {
          AND: [audienceWhere(audience), { status: { in: [...ACTIVE_STUDENT_STATUSES] } }],
        });
        for (let i = 0; i < recipients.length; i += FANOUT_CHUNK) {
          await tx.notification.createMany({
            data: recipients.slice(i, i + FANOUT_CHUNK).map((scopedId) => ({
              userId: scopedId,
              kind: "announcement",
              title: a.title,
              body: a.body,
              link: a.link,
              announcementId: a.id,
            })),
          });
        }
        await tx.announcement.update({
          where: { id: a.id },
          data: { publishedAt: now, publishedById: user.id, recipientCount: recipients.length },
        });
        return { recipientCount: recipients.length, audience, tone: a.tone };
      },
      { timeout: 60_000, maxWait: 10_000 },
    );

    await audit({
      actorId: user.id,
      action: "announcement.published",
      entityType: "Announcement",
      entityId: id,
      sensitivity: "SENSITIVE",
      metadata: { recipientCount: published.recipientCount, audience: { ...published.audience }, tone: published.tone },
      ipHash: await requestIpHash(),
    });
    revalidatePath("/", "layout");
    return { recipientCount: published.recipientCount };
  }, "publishAnnouncement");
}

/** Stop a published announcement's banner early. Its notifications stay in each student's history. */
export async function archiveAnnouncement(input: AnnouncementIdInput): Promise<ActionResult<{ id: string }>> {
  return runAction(async () => {
    const { user, scope } = await requireAdminScopeAction();
    const { id } = idInput.parse(input);
    const a = await db.announcement.findUnique({
      where: { id },
      select: { id: true, publishedAt: true, archivedAt: true, audienceBatchYear: true, audienceDepartmentCode: true },
    });
    if (!a) throw new NotFoundError("That announcement was not found.");
    assertCovered(scope, { batchYear: a.audienceBatchYear, departmentCode: a.audienceDepartmentCode });
    if (!a.publishedAt) throw new ValidationError("Only a published announcement can be archived.");
    const archived = await db.announcement.updateMany({
      where: { id, archivedAt: null, publishedAt: { not: null } },
      data: { archivedAt: new Date(), archivedById: user.id },
    });
    if (archived.count !== 1) throw new ConflictError("This announcement is already archived.");
    await audit({
      actorId: user.id,
      action: "announcement.archived",
      entityType: "Announcement",
      entityId: id,
      sensitivity: "NORMAL",
      metadata: { announcementId: id },
      ipHash: await requestIpHash(),
    });
    revalidatePath("/", "layout");
    return { id };
  }, "archiveAnnouncement");
}
