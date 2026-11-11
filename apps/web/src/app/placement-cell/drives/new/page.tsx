import type { Metadata } from "next";
import Link from "next/link";
import { ELIGIBILITY_FRAMING } from "@recx/shared";
import { requirePlacementPage } from "@/lib/auth/guards";
import { DriveForm } from "@/components/placement/drive-form";

export const metadata: Metadata = { title: "Add a drive" };

export default async function NewDrivePage() {
  await requirePlacementPage();
  return (
    <div className="space-y-6">
      <header className="space-y-2">
        <p className="text-sm">
          <Link href="/placement-cell/drives" className="text-primary underline">
            Back to drives
          </Link>
        </p>
        <h1 className="font-display text-2xl font-bold tracking-tight">Add a drive</h1>
        <p className="max-w-3xl text-sm text-text-secondary">{ELIGIBILITY_FRAMING}</p>
      </header>
      <DriveForm />
    </div>
  );
}
