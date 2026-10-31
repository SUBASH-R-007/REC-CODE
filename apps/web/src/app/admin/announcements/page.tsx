import type { Metadata } from "next";
import { Megaphone } from "lucide-react";
import { ButtonLink, Card, EmptyState } from "@recx/design";
import { requireAdminScopePage } from "@/lib/auth/scope";
import { listAnnouncements } from "@/server/queries/admin-announcements";
import { AdminPageHeader } from "@/components/admin/admin-ui";
import { AnnouncementList } from "@/components/admin/announcements/announcement-list";

export const metadata: Metadata = { title: "Announcements" };

/**
 * Announcements to students in the viewer's scope. Publishing sends each
 * current student of the audience a notification and a dashboard banner.
 */
export default async function AdminAnnouncementsPage() {
  const { scope } = await requireAdminScopePage();
  const rows = await listAnnouncements(scope);
  return (
    <>
      <AdminPageHeader
        title="Announcements"
        description="Plain-text notices for your students: a notification, plus a dashboard banner until it ends or is archived."
        actions={<ButtonLink href="/admin/announcements/new">New announcement</ButtonLink>}
      />
      <Card className="overflow-hidden">
        {rows.length === 0 ? (
          <EmptyState
            icon={<Megaphone className="h-6 w-6" />}
            title="No announcements yet"
            description="Write a draft, check it, then publish it to your students."
          />
        ) : (
          <div className="pb-4 pt-3">
            <AnnouncementList rows={rows} />
          </div>
        )}
      </Card>
    </>
  );
}
