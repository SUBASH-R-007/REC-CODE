/**
 * What the workspace says about where the student's code is saved. Pure
 * (unit-tested); the draft hook owns the state, the status bar shows the
 * label. Wording is deliberately plain: a student must be able to tell at a
 * glance whether a wifi drop could cost them work.
 */

export type LocalSaveState = "idle" | "saved" | "unavailable";
/**
 *   saved        the server holds exactly this code
 *   superseded   the server already holds a NEWER copy (another tab or device)
 *   failed       the last save did not reach the server (offline, rate limited, 5xx); retrying
 *   unsyncable   this code cannot be stored on the server (over 256 KB, or a NUL character)
 */
export type ServerSaveState = "idle" | "saved" | "superseded" | "failed" | "unsyncable";

export interface DraftSync {
  local: LocalSaveState;
  server: ServerSaveState;
}

export type SaveTone = "ok" | "warn";

export function saveStatus(sync: DraftSync): { label: string; tone: SaveTone } | null {
  const onDevice = sync.local === "saved";
  switch (sync.server) {
    case "saved":
      return { label: "Saved to your account", tone: "ok" };
    case "superseded":
      return { label: "A newer copy was saved from another tab or device", tone: "warn" };
    case "failed":
      return onDevice
        ? { label: "Saved on this device · syncing when you are back online", tone: "warn" }
        : { label: "Not saved yet · check your connection", tone: "warn" };
    case "unsyncable":
      return onDevice
        ? { label: "Saved on this device only (too large to sync)", tone: "warn" }
        : { label: "Not saved · this code is too large to store", tone: "warn" };
    case "idle":
      return onDevice ? { label: "Saved on this device", tone: "ok" } : null;
  }
}

const TIME_ZONE = "Asia/Kolkata";

/** "10:42 am" today, "9 Oct, 10:42 am" otherwise (campus time); null for an unknown time. */
export function formatSavedAt(ms: number | null, now: number = Date.now()): string | null {
  if (ms === null || !Number.isFinite(ms) || ms <= 0) return null;
  const date = new Date(ms);
  const day = (d: Date) => d.toLocaleDateString("en-IN", { timeZone: TIME_ZONE });
  const time = date.toLocaleTimeString("en-IN", { hour: "numeric", minute: "2-digit", timeZone: TIME_ZONE });
  if (day(date) === day(new Date(now))) return time;
  const when = date.toLocaleDateString("en-IN", { day: "numeric", month: "short", timeZone: TIME_ZONE });
  return `${when}, ${time}`;
}
