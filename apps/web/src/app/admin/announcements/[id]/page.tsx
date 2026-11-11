import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Card, CardHeader } from "@recx/design";
import { requireAdminScopePage } from "@/lib/auth/scope";
import { describeAudience } from "@/lib/admin/announcement-audience";
import { getAnnouncement } from "@/server/queries/admin-announcements";
import { AdminPageHeader, formatDateTime, istLocalInput } from "@/components/admin/admin-ui";
import { AnnouncementActions } from "@/components/admin/announcements/announcement-actions";
import { AnnouncementForm } from "@/components/admin/announcements/announcement-form";
import { AnnouncementStateBadge, ImportantBadge } from "@/components/admin/announcements/announcement-list";

export const metadata: Metadata = { title: "Announcement" };

type Params = Promise<{ id: string }>;

/**
 * One announcement. A draft can be edited (by its author or a super-admin)
 * and published; a published one is fixed and can be archived. One whose
 * audience is outside the viewer's scope is a 404.
 */
export default async function AnnouncementPage({ params }: { params: Params }) {
  const { user, scope } = await requireAdminScopePage();
  const { id } = await params;
  const a = await getAnnouncement(scope, id);
  if (!a) notFound();
  const audience = describeAudience(a.audience);
  const canEdit = a.state === "draft" && (a.createdById === user.id || user.role === "SUPER_ADMIN");

  return (
    <>
      <AdminPageHeader
        title={a.title}
        back={{ href: "/admin/announcements", label: "Announcements" }}
        description={
          <span className="inline-flex flex-wrap items-center gap-2">
            <AnnouncementStateBadge state={a.state} />
            {a.tone === "IMPORTANT" ? <ImportantBadge /> : null}
            <span>{audience}</span>
          </span>
        }
        actions={
          a.state === "draft" && !canEdit ? null : <AnnouncementActions id={a.id} state={a.state} audienceLabel={audience} />
        }
      />
      <div className="grid gap-6 lg:grid-cols-5">
        <Card className="lg:col-span-3">
          <CardHeader title={canEdit ? "Edit the draft" : "Message"} />
          <div className="px-5 pb-5 pt-4">
            {canEdit ? (
              <AnnouncementForm
                id={a.id}
                initial={{
                  title: a.title,
                  body: a.body,
                  tone: a.tone,
                  link: a.link ?? "",
                  batchYear: a.audience.batchYear?.toString() ?? "",
                  departmentCode: a.audience.departmentCode ?? "",
                  section: a.audience.section ?? "",
                  endsAt: istLocalInput(a.endsAt),
                }}
              />
            ) : (
              <>
                <p className="whitespace-pre-line text-sm">{a.body}</p>
                {a.link ? <p className="mt-3 font-mono text-xs text-text-secondary">Link: {a.link}</p> : null}
              </>
            )}
          </div>
        </Card>
        <Card className="lg:col-span-2">
          <CardHeader title="Details" />
          <dl className="grid gap-3 px-5 pb-5 pt-4 text-sm">
            <div>
              <dt className="text-text-secondary">Written by</dt>
              <dd>
                {a.authorName} · {formatDateTime(a.createdAt)}
              </dd>
            </div>
            <div>
              <dt className="text-text-secondary">Published</dt>
              <dd>{a.publishedAt ? `${a.publisherName ?? "Unknown account"} · ${formatDateTime(a.publishedAt)}` : "Not yet"}</dd>
            </div>
            <div>
              <dt className="text-text-secondary">Banner until</dt>
              <dd>{formatDateTime(a.endsAt)}</dd>
            </div>
            {a.state !== "draft" ? (
              <>
                <div>
                  <dt className="text-text-secondary">Sent to</dt>
                  <dd className="tabular-nums">{a.recipientCount} students</dd>
                </div>
                <div>
                  <dt className="text-text-secondary">Read by your students</dt>
                  <dd className="tabular-nums">
                    {a.readInScope} of {a.deliveredInScope}
                  </dd>
                </div>
              </>
            ) : null}
            {a.archivedAt ? (
              <div>
                <dt className="text-text-secondary">Archived</dt>
                <dd>{formatDateTime(a.archivedAt)}</dd>
              </div>
            ) : null}
          </dl>
        </Card>
      </div>
    </>
  );
}
