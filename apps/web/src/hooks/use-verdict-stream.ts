"use client";

import { useEffect, useReducer, useState } from "react";
import { progressEventSchema, type JobKind, type Verdict } from "@recx/shared";
import type { StudentView } from "@/lib/judge/view";

/**
 * Live verdict for one submission or run.
 *
 * EventSource first (GET …/stream). If the stream errors or closes before
 * its "done" event — Redis down, a proxy cutting idle connections, the
 * server's 5-minute hard close — fall back to polling the JSON endpoint on
 * the schedule below. Polling is NEVER faster than 2 s: 5,000 students
 * refreshing a verdict must not become a self-inflicted load test.
 */

/** Poll delays: 2 s, 3 s, then every 5 s. */
export const POLL_SCHEDULE_MS: readonly number[] = [2_000, 3_000, 5_000];
export const MIN_POLL_DELAY_MS = 2_000;
/** After this many polls the hook stops and offers "Check again". */
export const MAX_POLLS = 60;

/** Delay before poll number `attempt` (0-based). Pure; never below 2 s. */
export function pollDelayMs(attempt: number): number {
  const n = Number.isFinite(attempt) ? Math.max(0, Math.floor(attempt)) : 0;
  const last = POLL_SCHEDULE_MS[POLL_SCHEDULE_MS.length - 1] ?? MIN_POLL_DELAY_MS;
  return Math.max(MIN_POLL_DELAY_MS, POLL_SCHEDULE_MS[n] ?? last);
}

/** True while another poll is allowed after `pollsSoFar` polls. */
export function canPoll(pollsSoFar: number): boolean {
  return pollsSoFar < MAX_POLLS;
}

export interface JudgeTarget {
  kind: JobKind;
  id: string;
}

export interface LiveProgress {
  state: "QUEUED" | "COMPILING" | "RUNNING";
  done: number;
  total: number;
  tests: { i: number; v: Verdict }[];
  /** SUBTASK problems: each subtask's verdict as soon as it is decided (index ascending). */
  subtasks: { index: number; v: Verdict }[];
}

export type StreamPhase = "idle" | "connecting" | "live" | "polling" | "done" | "stalled" | "error";

export interface VerdictStreamState {
  view: StudentView | null;
  progress: LiveProgress | null;
  phase: StreamPhase;
  error: string | null;
}

type Action =
  | { type: "reset"; phase: StreamPhase }
  | { type: "snapshot"; view: StudentView }
  | { type: "progress"; event: unknown }
  | { type: "phase"; phase: StreamPhase }
  | { type: "done" }
  | { type: "error"; message: string };

const IDLE: VerdictStreamState = { view: null, progress: null, phase: "idle", error: null };
const NO_PROGRESS: LiveProgress = { state: "QUEUED", done: 0, total: 0, tests: [], subtasks: [] };

/** The hook's state machine (exported for tests). */
export type VerdictStreamAction = Action;

export function verdictStreamReducer(state: VerdictStreamState, action: Action): VerdictStreamState {
  switch (action.type) {
    case "reset":
      return { ...IDLE, phase: action.phase };
    case "snapshot":
      return {
        ...state,
        view: action.view,
        // A terminal snapshot supersedes live progress.
        progress: action.view.terminal ? null : state.progress,
      };
    case "progress": {
      const parsed = progressEventSchema.safeParse(action.event);
      if (!parsed.success || state.view?.terminal) return state;
      const prev = state.progress ?? NO_PROGRESS;
      const ev = parsed.data;
      if (ev.type === "state") return { ...state, progress: { ...prev, state: ev.state } };
      if (ev.type === "test") {
        const tests = prev.tests.filter((t) => t.i !== ev.i).concat({ i: ev.i, v: ev.v });
        return {
          ...state,
          progress: { ...prev, state: "RUNNING", done: Math.max(prev.done, ev.done), total: ev.total, tests },
        };
      }
      if (ev.type === "subtask") {
        if (ev.index < 0) return state;
        const subtasks = prev.subtasks
          .filter((st) => st.index !== ev.index)
          .concat({ index: ev.index, v: ev.v })
          .sort((a, b) => a.index - b.index);
        return { ...state, progress: { ...prev, state: "RUNNING", subtasks } };
      }
      return state;
    }
    case "phase":
      return { ...state, phase: action.phase };
    case "done":
      return { ...state, phase: "done", progress: null };
    case "error":
      return { ...state, phase: "error", error: action.message };
  }
}

function endpoint(target: JudgeTarget): string {
  const collection = target.kind === "submission" ? "submissions" : "runs";
  return `/api/${collection}/${encodeURIComponent(target.id)}`;
}

function parseJson(data: unknown): unknown {
  if (typeof data !== "string") return null;
  try {
    return JSON.parse(data) as unknown;
  } catch {
    return null;
  }
}

function isView(value: unknown): value is StudentView {
  return (
    typeof value === "object" &&
    value !== null &&
    "kind" in value &&
    "terminal" in value &&
    "display" in value
  );
}

export function useVerdictStream(target: JudgeTarget | null): VerdictStreamState & { retry: () => void } {
  const [state, dispatch] = useReducer(verdictStreamReducer, IDLE);
  const [attempt, setAttempt] = useState(0);
  const kind = target?.kind ?? null;
  const id = target?.id ?? null;

  useEffect(() => {
    if (!kind || !id) {
      dispatch({ type: "reset", phase: "idle" });
      return;
    }
    const url = endpoint({ kind, id });
    let cancelled = false;
    let finished = false;
    let source: EventSource | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let polls = 0;

    dispatch({ type: "reset", phase: "connecting" });

    const finish = () => {
      finished = true;
      source?.close();
      source = null;
      dispatch({ type: "done" });
    };

    const schedulePoll = () => {
      if (cancelled || finished) return;
      if (!canPoll(polls)) {
        dispatch({ type: "phase", phase: "stalled" });
        return;
      }
      timer = setTimeout(poll, pollDelayMs(polls));
      polls += 1;
    };

    const poll = async () => {
      try {
        const res = await fetch(url, { cache: "no-store", headers: { accept: "application/json" } });
        if (cancelled) return;
        if (res.status === 401) {
          dispatch({ type: "error", message: "Your session has ended. Sign in again to see this result." });
          return;
        }
        if (res.status === 404) {
          dispatch({ type: "error", message: "This result is no longer available." });
          return;
        }
        if (!res.ok) {
          schedulePoll();
          return;
        }
        const body = (await res.json()) as unknown;
        if (cancelled) return;
        if (!isView(body)) {
          schedulePoll();
          return;
        }
        dispatch({ type: "snapshot", view: body });
        if (body.terminal) finish();
        else schedulePoll();
      } catch {
        // Offline or a transient network error: keep to the schedule.
        if (!cancelled) schedulePoll();
      }
    };

    const startPolling = () => {
      if (cancelled || finished) return;
      dispatch({ type: "phase", phase: "polling" });
      schedulePoll();
    };

    if (typeof EventSource === "undefined") {
      startPolling();
    } else {
      source = new EventSource(`${url}/stream`);
      source.addEventListener("open", () => {
        if (!cancelled && !finished) dispatch({ type: "phase", phase: "live" });
      });
      source.addEventListener("snapshot", (e) => {
        const view = parseJson((e as MessageEvent).data);
        if (!cancelled && isView(view)) dispatch({ type: "snapshot", view });
      });
      // {type:"state" | "test" | "subtask"} worker events.
      source.addEventListener("progress", (e) => {
        const event = parseJson((e as MessageEvent).data);
        if (!cancelled && event) dispatch({ type: "progress", event });
      });
      source.addEventListener("done", () => {
        if (!cancelled) finish();
      });
      source.onerror = () => {
        // Closed or failed before "done": the browser would retry the stream
        // on its own; we poll on a known schedule instead.
        source?.close();
        source = null;
        if (!finished) startPolling();
      };
    }

    return () => {
      cancelled = true;
      source?.close();
      if (timer) clearTimeout(timer);
    };
  }, [kind, id, attempt]);

  return { ...state, retry: () => setAttempt((n) => n + 1) };
}
