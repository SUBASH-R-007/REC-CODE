import "server-only";
import { randomBytes } from "node:crypto";
import { hashNodeToken } from "@/lib/judge/node-auth";

/**
 * A fresh judge-node token: 32 random bytes, base64url (43 characters,
 * accepted by the bearer parser), and the sha256 that JudgeNode.tokenHash
 * stores. The raw token is shown once to the operator and never stored,
 * logged or audited. Shared by scripts/judge-node.ts and
 * super-judge#rotateJudgeNodeToken.
 */
export function generateNodeToken(): { token: string; tokenHash: string } {
  const token = randomBytes(32).toString("base64url");
  return { token, tokenHash: hashNodeToken(token) };
}
