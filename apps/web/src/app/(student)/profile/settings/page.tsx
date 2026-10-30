import type { Metadata } from "next";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { Card, CardBody, CardHeader } from "@recx/design";
import { requireUser } from "@/lib/auth/guards";
import { PASSWORD_MIN_LENGTH } from "@/lib/auth/password";
import { profileSettingsOf } from "@/server/queries/profile";
import { ChangePasswordForm } from "@/components/profile/change-password-form";
import { SettingsForm } from "@/components/profile/settings-form";

export const metadata: Metadata = { title: "Profile settings" };

export default async function ProfileSettingsPage() {
  const user = await requireUser();
  const settings = profileSettingsOf(user);

  return (
    <div className="mx-auto max-w-2xl">
      <Link
        href="/profile"
        className="inline-flex min-h-10 items-center gap-1.5 text-sm font-medium text-text-secondary hover:text-text"
      >
        <ArrowLeft aria-hidden className="h-4 w-4" />
        Back to your profile
      </Link>
      <h1 className="mt-2 font-display text-2xl font-bold tracking-tight">Profile settings</h1>
      <p className="mt-1 text-sm text-text-secondary">
        Your public profile lives at{" "}
        <Link
          href={`/u/${encodeURIComponent(settings.handle)}`}
          className="font-medium text-text underline decoration-primary decoration-2 underline-offset-4 hover:decoration-text"
        >
          /u/{settings.handle}
        </Link>
        .
      </p>

      <Card className="mt-6">
        <CardBody>
          <SettingsForm
            initial={{
              visibility: settings.visibility,
              leaderboardOptOut: settings.leaderboardOptOut,
              bio: settings.bio,
              fontSize: settings.editor.fontSize,
              tabSize: settings.editor.tabSize,
              keymap: settings.editor.keymap,
            }}
          />
        </CardBody>
      </Card>

      {/*
        Phase 11b. Until now nobody could change a password they knew — a
        student, an admin or a super-admin who suspected theirs was known
        had to ask for a reset link to replace it.
      */}
      <Card className="mt-6">
        <CardHeader title="Password" subtitle="Change the password you sign in with" />
        <CardBody>
          <ChangePasswordForm minLength={PASSWORD_MIN_LENGTH} />
        </CardBody>
      </Card>
    </div>
  );
}
