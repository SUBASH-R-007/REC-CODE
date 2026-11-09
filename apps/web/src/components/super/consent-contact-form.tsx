"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button, Field, Input, useToast } from "@recx/design";
import type { ConsentContact } from "@recx/shared";
import { setConsentContact } from "@/server/actions/super-settings";

/**
 * The named contact beside the consent points (Phase 16e).
 *
 * SPEC §6 asks for "the named Data Protection Officer / grievance contact on
 * screen". It is a setting rather than a constant because it is a person at
 * a college, and a person who leaves must be replaceable without a deploy.
 *
 * Until one is set the readiness page says so plainly rather than showing an
 * invented address: a student who writes to an address nobody reads is worse
 * off than one who is told to ask their department.
 */
export function ConsentContactForm({ current }: { current: ConsentContact | null }) {
  const router = useRouter();
  const { toast } = useToast();
  const [name, setName] = useState(current?.name ?? "");
  const [email, setEmail] = useState(current?.email ?? "");
  const [office, setOffice] = useState(current?.office ?? "");
  const [pending, startTransition] = useTransition();

  return (
    <form
      aria-label="Proctoring data contact"
      className="space-y-3"
      onSubmit={(e) => {
        e.preventDefault();
        startTransition(async () => {
          const result = await setConsentContact({
            name,
            email,
            office: office.trim() === "" ? null : office,
          });
          if (!result.ok) {
            toast(result.error, "error");
            return;
          }
          toast("Saved. Candidates see this on the readiness page.", "success");
          router.refresh();
        });
      }}
    >
      <Field label="Name and role" htmlFor="consent-name" hint="Shown to every candidate before a proctored sitting.">
        <Input
          id="consent-name"
          required
          maxLength={120}
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Dr A. Rao, Data Protection Officer"
        />
      </Field>
      <Field label="College email" htmlFor="consent-email" hint="An address somebody reads.">
        <Input
          id="consent-email"
          type="email"
          required
          maxLength={200}
          value={email}
          onChange={(e) => setEmail(e.target.value)}
        />
      </Field>
      <Field label="Office (optional)" htmlFor="consent-office">
        <Input
          id="consent-office"
          maxLength={200}
          value={office}
          onChange={(e) => setOffice(e.target.value)}
          placeholder="Admin block, room 12"
        />
      </Field>
      <div className="flex justify-end">
        <Button type="submit" className="min-h-11" loading={pending}>
          Save the contact
        </Button>
      </div>
    </form>
  );
}
