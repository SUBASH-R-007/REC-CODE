import { z } from "zod";

/**
 * The named contact SPEC §6 asks to be on screen beside the consent points
 * (Phase 16e), as a schema.
 *
 * It is a module of its own, and that is a bundle decision rather than a
 * taste one. `consent.ts` holds the WORDS, and the readiness page — a client
 * component — imports them. A `zod` import anywhere in that module travels
 * with those words through the barrel and lands in the browser: measured, it
 * put `/assessments/[slug]/readiness` 41.6 KB over its 130 KB budget and the
 * attempt page 20.9 KB over its own. Nothing on screen needs the schema; the
 * server does.
 */
export const consentContactSchema = z
  .object({
    /** The role and name, e.g. "Dr A. Rao, Data Protection Officer". */
    name: z.string().trim().min(1).max(120),
    /** A college address somebody actually reads. */
    email: z.string().trim().email().max(200),
    /** Optional: an office or a phone extension. */
    office: z.string().trim().max(200).nullable().default(null),
  })
  .strict();
export type ConsentContact = z.infer<typeof consentContactSchema>;
