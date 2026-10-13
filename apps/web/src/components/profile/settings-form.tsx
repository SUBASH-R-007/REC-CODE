"use client";

import { useActionState, useId, useState } from "react";
import { CircleAlert, CircleCheck } from "lucide-react";
import { Button, Select, cn } from "@recx/design";
import type { ProfileVisibility } from "@recx/db";
import { saveProfileSettings } from "@/server/actions/profile";
import {
  BIO_MAX,
  FONT_SIZE_MAX,
  FONT_SIZE_MIN,
  TAB_SIZES,
  bioLength,
  type TabSize,
} from "@/components/profile/settings-schema";
import { VISIBILITY_OPTIONS } from "@/components/profile/visibility";

export interface SettingsFormValues {
  visibility: ProfileVisibility;
  leaderboardOptOut: boolean;
  bio: string;
  fontSize: number;
  tabSize: TabSize;
}

const FONT_SIZES = Array.from({ length: FONT_SIZE_MAX - FONT_SIZE_MIN + 1 }, (_, i) => FONT_SIZE_MIN + i);

const legendClass = "font-display text-base font-semibold tracking-tight text-text";
const optionRow =
  "flex min-h-11 cursor-pointer items-start gap-3 rounded-xl border border-border p-3 transition-colors hover:border-primary/40 has-[:checked]:border-primary has-[:checked]:bg-primary-subtle/50";

/**
 * Profile settings. A plain <form> bound to a server action through
 * useActionState, so it also works without JavaScript; the outcome is one
 * status message (announced once), not a toast.
 */
export function SettingsForm({ initial }: { initial: SettingsFormValues }) {
  const [state, formAction, pending] = useActionState(saveProfileSettings, null);
  // Controlled fields: React resets uncontrolled ones after every action, which
  // would discard a student's choices when a save fails.
  const [visibility, setVisibility] = useState(initial.visibility);
  const [optOut, setOptOut] = useState(initial.leaderboardOptOut);
  const [bio, setBio] = useState(initial.bio);
  const [fontSize, setFontSize] = useState(String(initial.fontSize));
  const [tabSize, setTabSize] = useState<TabSize>(initial.tabSize);
  const id = useId();
  const bioCount = bioLength(bio);

  return (
    <form action={formAction} className="space-y-8">
      <fieldset>
        <legend className={legendClass}>Who can see your profile</legend>
        <p className="mt-1 text-sm text-text-secondary">
          Your profile page shows your solved counts, badges, activity heatmap and skill radar — never your email, roll
          number, department or assessment results.
        </p>
        <div className="mt-3 grid gap-2">
          {VISIBILITY_OPTIONS.map((option) => (
            <label key={option.value} className={optionRow}>
              <input
                type="radio"
                name="visibility"
                value={option.value}
                checked={visibility === option.value}
                onChange={() => setVisibility(option.value)}
                aria-describedby={`${id}-vis-${option.value}`}
                className="mt-0.5 h-4 w-4 shrink-0 accent-primary"
              />
              <span>
                <span className="block text-sm font-medium text-text">{option.label}</span>
                <span id={`${id}-vis-${option.value}`} className="block text-xs text-text-secondary">
                  {option.description}
                </span>
              </span>
            </label>
          ))}
        </div>
      </fieldset>

      <fieldset>
        <legend className={legendClass}>Leaderboards</legend>
        <label className={cn(optionRow, "mt-3")}>
          <input
            type="checkbox"
            name="leaderboardOptOut"
            checked={optOut}
            onChange={(e) => setOptOut(e.target.checked)}
            aria-describedby={`${id}-optout`}
            className="mt-0.5 h-4 w-4 shrink-0 accent-primary"
          />
          <span>
            <span className="block text-sm font-medium text-text">Hide me from my classmates&apos; leaderboards</span>
            <span id={`${id}-optout`} className="block text-xs text-text-secondary">
              Other students will not see you on any leaderboard. You still see your own rank, privately. Faculty
              analytics are not affected: your progress stays visible to your faculty.
            </span>
          </span>
        </label>
      </fieldset>

      <div>
        <label htmlFor={`${id}-bio`} className={cn(legendClass, "block")}>
          Bio
        </label>
        <p id={`${id}-bio-hint`} className="mt-1 text-sm text-text-secondary">
          Optional. Shown on your profile page to everyone who can see it. Up to {BIO_MAX} characters.
        </p>
        <textarea
          id={`${id}-bio`}
          name="bio"
          value={bio}
          onChange={(e) => setBio(e.target.value)}
          maxLength={BIO_MAX}
          rows={3}
          aria-describedby={`${id}-bio-hint ${id}-bio-count`}
          className="mt-2 min-h-24 w-full resize-y rounded-xl border border-border-strong bg-surface px-3.5 py-2.5 text-sm text-text placeholder:text-muted focus:border-primary"
          placeholder="What are you practising for?"
        />
        <p id={`${id}-bio-count`} className={cn("mt-1 text-right text-xs", bioCount > BIO_MAX ? "text-danger" : "text-muted")}>
          {bioCount} of {BIO_MAX} characters
        </p>
      </div>

      <fieldset>
        <legend className={legendClass}>Code editor</legend>
        <p className="mt-1 text-sm text-text-secondary">Used by the coding workspace on every device you sign in on.</p>
        <div className="mt-3 grid gap-4 sm:grid-cols-2">
          <div>
            <label htmlFor={`${id}-font`} className="mb-1.5 block text-sm font-medium text-text">
              Font size
            </label>
            <Select
              id={`${id}-font`}
              name="fontSize"
              value={fontSize}
              onChange={(e) => setFontSize(e.target.value)}
              className="min-h-11"
            >
              {FONT_SIZES.map((size) => (
                <option key={size} value={size}>
                  {size} px
                </option>
              ))}
            </Select>
          </div>
          <fieldset>
            <legend className="mb-1.5 block text-sm font-medium text-text">Tab size</legend>
            <div className="flex gap-2">
              {TAB_SIZES.map((size) => (
                <label key={size} className={cn(optionRow, "flex-1 items-center")}>
                  <input
                    type="radio"
                    name="tabSize"
                    value={size}
                    checked={tabSize === size}
                    onChange={() => setTabSize(size)}
                    className="h-4 w-4 shrink-0 accent-primary"
                  />
                  <span className="text-sm font-medium text-text">{size} spaces</span>
                </label>
              ))}
            </div>
          </fieldset>
        </div>
      </fieldset>

      <div className="flex flex-wrap items-center gap-3 border-t border-border pt-5">
        <Button type="submit" loading={pending} className="min-h-11">
          {pending ? "Saving…" : "Save settings"}
        </Button>
        <div role="status" className="text-sm">
          {state && !pending ? (
            state.ok ? (
              <span className="flex items-center gap-1.5 text-success">
                <CircleCheck aria-hidden className="h-4 w-4" />
                Settings saved.
              </span>
            ) : (
              <span className="flex items-center gap-1.5 text-danger">
                <CircleAlert aria-hidden className="h-4 w-4" />
                {state.error}
              </span>
            )
          ) : null}
        </div>
      </div>
    </form>
  );
}
