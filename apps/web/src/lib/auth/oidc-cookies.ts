/**
 * The three cookies an LMS sign-in carries between its two routes
 * (Phase 16i).
 *
 * In their own module rather than in `start/route.ts`, where they were
 * first written, for a reason worth recording: a Next.js `route.ts` may
 * export only route fields (`GET`, `POST`, `dynamic`, `revalidate`, …), and
 * anything else is a build error —
 *
 *     Type error: Route "src/app/api/auth/oidc/start/route.ts" does not
 *     match the required types of a Next.js Route.
 *       "OIDC_STATE_COOKIE" is not a valid Route export field.
 *
 * `tsc --noEmit` does not see it, because the check lives in the types Next
 * GENERATES during a build; only `next build` and the gate's typecheck
 * after it do. So a constant shared between two route handlers belongs
 * beside them and not inside one.
 *
 * What each value is for is in `start/route.ts`, where they are minted.
 */

export const OIDC_STATE_COOKIE = "recx_oidc_state";
export const OIDC_NONCE_COOKIE = "recx_oidc_nonce";
export const OIDC_VERIFIER_COOKIE = "recx_oidc_verifier";

/** Every one of them, for a callback that spends all three on arrival. */
export const OIDC_COOKIES = [OIDC_STATE_COOKIE, OIDC_NONCE_COOKIE, OIDC_VERIFIER_COOKIE] as const;

/** How long a sign-in has to come back. Longer than that, start again. */
export const OIDC_COOKIE_SECONDS = 600;

/** The path all three are scoped to: the two routes, and nothing else. */
export const OIDC_COOKIE_PATH = "/api/auth/oidc";
