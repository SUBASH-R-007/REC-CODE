import { z } from "zod";

/**
 * The proctoring signal vocabulary. Proctoring is monitored and recorded:
 * every kind is evidence for a human reviewer, never an automatic verdict.
 *
 * Declared in Phase 4 so Accommodation.exemptSignals is typed; the
 * ProctorEvent model and the client that emits these arrive in Phase 6.
 * Mirror: the Prisma enum ProctorEventKind (same members, same order —
 * packages/db/test/enum-parity.test.ts).
 */
export const PROCTOR_EVENT_KINDS = [
  "FOCUS_LOSS",
  "FULLSCREEN_EXIT",
  "EXTERNAL_PASTE",
  "INTERNAL_PASTE",
  "PROGRAMMATIC_INSERT",
  "COPY",
  "CUT",
  "CONTEXT_MENU",
  "CADENCE_BURST",
  "IDLE_GAP",
  "FIRST_KEYSTROKE",
  "WINDOW_RESIZE",
  "MULTI_MONITOR",
  "DEVTOOLS_HEURISTIC",
  "AUTOMATION_HINT",
  "NETWORK_DROP",
  "HEARTBEAT_GAP",
  "IP_CHANGED",
  "UA_CHANGED",
  "SEQUENCE_GAP",
  "CONCURRENT_SESSION",
  "SUBMISSION_RATE_ANOMALY",
  "CLIENT_SCRIPT_ERROR",
  "INVIGILATOR_NOTE",
] as const;

export type ProctorEventKind = (typeof PROCTOR_EVENT_KINDS)[number];

export const proctorEventKindSchema = z.enum(PROCTOR_EVENT_KINDS);

/**
 * Short plain-language names for the admin accommodation form and pages.
 * A label never implies a verdict: every signal is a reviewer's evidence.
 */
export const PROCTOR_EVENT_LABELS: Readonly<Record<ProctorEventKind, string>> = Object.freeze({
  FOCUS_LOSS: "Window focus lost",
  FULLSCREEN_EXIT: "Left full screen",
  EXTERNAL_PASTE: "Paste from outside the editor",
  INTERNAL_PASTE: "Paste from inside the editor",
  PROGRAMMATIC_INSERT: "Text inserted by software",
  COPY: "Copy",
  CUT: "Cut",
  CONTEXT_MENU: "Right-click menu",
  CADENCE_BURST: "Typing-speed burst",
  IDLE_GAP: "Long idle gap",
  FIRST_KEYSTROKE: "Time to first keystroke",
  WINDOW_RESIZE: "Window resized",
  MULTI_MONITOR: "More than one screen",
  DEVTOOLS_HEURISTIC: "Developer tools likely open",
  AUTOMATION_HINT: "Browser automation hint",
  NETWORK_DROP: "Network dropped",
  HEARTBEAT_GAP: "Heartbeat gap",
  IP_CHANGED: "Network address changed",
  UA_CHANGED: "Browser changed",
  SEQUENCE_GAP: "Missing event sequence",
  CONCURRENT_SESSION: "Signed in elsewhere at the same time",
  SUBMISSION_RATE_ANOMALY: "Unusual submission rate",
  CLIENT_SCRIPT_ERROR: "Page script error",
  INVIGILATOR_NOTE: "Invigilator note",
});
