import { createHmac, randomBytes } from "node:crypto";
import {
  EXAM_BROWSER_PROTOCOL_VERSION,
  RECX_NONCE_HEADER,
  RECX_PROTOCOL_HEADER,
  RECX_SIGNATURE_HEADER,
  RECX_SITTING_HEADER,
  RECX_TIMESTAMP_HEADER,
  RECX_VERSION_HEADER,
  examBrowserSigningInput,
} from "@recx/shared/exam-browser";
import { APP_VERSION } from "./config";

/**
 * The sitting this copy of the application is holding, and the headers it
 * signs with.
 *
 * **In memory and nowhere else.** Not `localStorage`, not a file beside
 * the executable, not Electron's `safeStorage`. A sitting lasts one paper
 * and the key is derived again next time, so persisting it would add a
 * thing to steal and buy nothing — and `docs/EXAM-BROWSER.md` §4's "leaves
 * nothing behind" is easiest to keep true by never writing anything down.
 */

export interface Sitting {
  readonly sittingId: string;
  readonly sittingKey: string;
  readonly origin: string;
  readonly assessmentId: string;
  readonly assessmentSlug: string;
}

let current: Sitting | null = null;

export function holdSitting(sitting: Sitting): void {
  current = sitting;
}

export function heldSitting(): Sitting | null {
  return current;
}

/**
 * Forget the key. Called when the sitting ends and on the way out, so a
 * window that somehow outlives its paper cannot sign anything.
 */
export function releaseSitting(): void {
  current = null;
}

/**
 * The attestation headers for one request.
 *
 * A fresh nonce per request is what makes a captured signature worth one
 * request — 16 random bytes, which is far past collision inside a
 * four-minute window, and the server refuses a repeat under the same
 * sitting.
 *
 * The timestamp is this machine's clock, which is the candidate's clock
 * and may be wrong. That is why the server tolerates two minutes either
 * way rather than requiring agreement: refusing a candidate at 9am over
 * clock drift is a worse outcome than a two-minute window a nonce already
 * closes.
 */
export function attestationHeaders(args: {
  readonly method: string;
  readonly url: string;
  readonly sitting: Sitting;
  readonly now?: number;
  readonly nonce?: string;
}): Record<string, string> {
  const nonce = args.nonce ?? randomBytes(16).toString("base64url");
  const timestamp = args.now ?? Date.now();
  const signature = createHmac("sha256", args.sitting.sittingKey)
    .update(
      examBrowserSigningInput({
        method: args.method,
        url: args.url,
        nonce,
        timestamp,
        sittingId: args.sitting.sittingId,
      }),
    )
    .digest("hex");

  return {
    [RECX_PROTOCOL_HEADER]: String(EXAM_BROWSER_PROTOCOL_VERSION),
    [RECX_VERSION_HEADER]: APP_VERSION,
    [RECX_SITTING_HEADER]: args.sitting.sittingId,
    [RECX_NONCE_HEADER]: nonce,
    [RECX_TIMESTAMP_HEADER]: String(timestamp),
    [RECX_SIGNATURE_HEADER]: signature,
  };
}
