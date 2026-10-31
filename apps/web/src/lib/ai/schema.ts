import { z } from "zod";
import { AI_ASK_KINDS, type AiAskKind } from "@recx/shared";
import { problemIdSchema } from "@/lib/help/schema";

/**
 * The AI helper's boundary. Strict, for the same reason every help schema
 * is: the context is decided on the server, so a client that sends one is
 * refused outright rather than having it quietly dropped. The student does
 * not send their code either — the server reads the draft it already holds,
 * so a forged request cannot make the college pay to summarise an arbitrary
 * document.
 */
export const askAiSchema = z
  .object({
    problemId: problemIdSchema,
    kind: z.enum(AI_ASK_KINDS as unknown as [AiAskKind, ...AiAskKind[]], {
      errorMap: () => ({ message: "Ask either what is wrong, or how to approach it." }),
    }),
  })
  .strict();
export type AskAiInput = z.infer<typeof askAiSchema>;
