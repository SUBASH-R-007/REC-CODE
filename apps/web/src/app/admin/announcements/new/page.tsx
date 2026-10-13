import type { Metadata } from "next";
import { Card } from "@recx/design";
import { describeScope, requireAdminScopePage } from "@/lib/auth/scope";
import { AdminPageHeader, istLocalInput } from "@/components/admin/admin-ui";
import { AnnouncementForm } from "@/components/admin/announcements/announcement-form";

export const metadata: Metadata = { title: "New announcement" };

/** Write a draft. Nothing reaches students until it is published. */
export default async function NewAnnouncementPage() {
  const { scope } = await requireAdminScopePage();
  const endsAt = istLocalInput(new Date(Date.now() + 7 * 86_400_000));
  return (
    <>
      <AdminPageHeader
        title="New announcement"
        back={{ href: "/admin/announcements", label: "Announcements" }}
        description={`The audience must be inside your scope (${describeScope(scope)}). Saving creates a draft.`}
      />
      <Card className="p-5">
        <AnnouncementForm
          initial={{ title: "", body: "", tone: "INFO", link: "", batchYear: "", departmentCode: "", section: "", endsAt }}
        />
      </Card>
    </>
  );
}
