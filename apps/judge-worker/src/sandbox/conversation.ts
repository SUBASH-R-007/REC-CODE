/**
 * What the idle deadline of an interactive conversation actually means
 * (Phase 15f).
 *
 * The relay in `IsolateDriver.execPair` watches a conversation for silence:
 * no byte in either direction for `LIMITS.interactive.idleMs` stops the pair
 * with `"idle"`, and `interpretInteractive` turns that into TLE with
 * `DEADLOCK_MESSAGE` — the sentence about a missing flush.
 *
 * That sentence is only true of one situation: BOTH programs are running and
 * both are blocked reading, each waiting for a line the other will never
 * send. Silence while one of them has already exited is a different thing
 * entirely, and it is ordinary:
 *
 *   - the solution crashed, and the interactor has not finished reacting to
 *     the EOF it got as a result;
 *   - the interactor has decided and exited, and the solution is being torn
 *     down;
 *   - either program's own teardown — isolate writing its meta file, the
 *     cgroup being collected — happens to take a while.
 *
 * None of those is a deadlock, and on a loaded node any of them can take
 * longer than the deadline. The judge's precedence puts the idle stop ABOVE
 * the solution's crash (rule 3 before rule 5 in src/judge/interactive.ts),
 * for a good reason — a genuine deadlock must not be read as the crash that
 * the SIGTERM tearing it down produces — so an idle stop raised while one
 * side is already gone does not just add noise: it OUTRANKS the real
 * verdict. A segfault came back as "neither your program nor the interactor
 * wrote anything for 2 seconds … this is usually a missing flush", which is
 * a wrong verdict and wrong advice at the same time.
 *
 * Found on a loaded machine: `interactive problems on real isolate > a crash
 * mid-conversation` returned TLE instead of RE when the gate ran the whole
 * integration suite at once, and passed on its own. The load did not create
 * the defect, it only widened the window — the interactor's reaction to the
 * EOF had to arrive within 2 s of the solution's last byte, and nothing in
 * the design guarantees that.
 */
export interface ConversationSilence {
  /** The student's program is still running (its isolate has not exited). */
  readonly solutionRunning: boolean;
  /** The interactor is still running. */
  readonly interactorRunning: boolean;
  /** How long since a byte last crossed in either direction. */
  readonly silentMs: number;
  /** `LIMITS.interactive.idleMs`. */
  readonly idleMs: number;
}

/**
 * True only when the silence is a deadlock: both programs alive, and nothing
 * said for the whole deadline. A side that has exited cannot be waiting for
 * the other, so the deadline no longer applies to the pair.
 */
export function conversationDeadlocked(silence: ConversationSilence): boolean {
  if (!silence.solutionRunning || !silence.interactorRunning) return false;
  return silence.silentMs >= silence.idleMs;
}
