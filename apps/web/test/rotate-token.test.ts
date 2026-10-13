import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Judge-node token rotation from /super/settings/judge: the returned token
 * matches the stored hash (nodeTokenMatches), the old one stops matching,
 * and neither the token nor its hash ever reaches the audit log.
 */

const h = vi.hoisted(() => ({
  actor: { id: "super_1", role: "SUPER_ADMIN" as string },
  node: { id: "judge-01", hostname: "judge-01.rec.local", tokenHash: "" },
  audit: vi.fn(),
}));

vi.mock("@/lib/auth/guards", async () => {
  const { ForbiddenError } = await import("@/lib/errors");
  return {
    requireSuperAdmin: async () => {
      if (h.actor.role !== "SUPER_ADMIN") throw new ForbiddenError();
      return h.actor;
    },
  };
});
vi.mock("@/lib/db", () => ({
  db: {
    judgeNode: {
      findUnique: async () => ({ id: h.node.id, hostname: h.node.hostname }),
      updateMany: async ({ data }: { data: { tokenHash: string } }) => {
        h.node.tokenHash = data.tokenHash;
        return { count: 1 };
      },
    },
  },
}));
vi.mock("@/lib/audit", () => ({ audit: h.audit }));
vi.mock("@/lib/ip", () => ({ requestIpHash: async () => "iphash" }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

const { rotateJudgeNodeToken } = await import("@/server/actions/super-judge");
const { generateNodeToken } = await import("@/lib/judge/node-token");
const { hashNodeToken, nodeTokenMatches } = await import("@/lib/judge/node-auth");

beforeEach(() => {
  h.audit.mockClear();
  h.actor.role = "SUPER_ADMIN";
});

describe("rotateJudgeNodeToken", () => {
  it("issues a token that matches, retires the old one and never audits a secret", async () => {
    const old = generateNodeToken();
    h.node.tokenHash = old.tokenHash;
    const result = await rotateJudgeNodeToken({ nodeId: "judge-01", reason: "Routine quarterly rotation" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const { token } = result.data;
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(nodeTokenMatches(token, h.node.tokenHash)).toBe(true);
    expect(nodeTokenMatches(old.token, h.node.tokenHash)).toBe(false);

    expect(h.audit).toHaveBeenCalledTimes(1);
    const entry = h.audit.mock.calls[0]![0] as { action: string; sensitivity: string; metadata: unknown };
    expect(entry.action).toBe("judge.node.token_rotated");
    expect(entry.sensitivity).toBe("SECURITY");
    const serialised = JSON.stringify(h.audit.mock.calls);
    expect(serialised).not.toContain(token);
    expect(serialised).not.toContain(h.node.tokenHash);
    expect(entry.metadata).toEqual({ hostname: "judge-01.rec.local", via: "ui", reason: "Routine quarterly rotation" });
  });

  it("is SUPER_ADMIN only", async () => {
    h.actor.role = "ADMIN";
    const before = h.node.tokenHash;
    const result = await rotateJudgeNodeToken({ nodeId: "judge-01", reason: "Routine quarterly rotation" });
    expect(result.ok).toBe(false);
    expect(h.node.tokenHash).toBe(before);
    expect(h.audit).not.toHaveBeenCalled();
  });
});

describe("generateNodeToken", () => {
  it("returns a fresh 32-byte token and its sha256", () => {
    const a = generateNodeToken();
    const b = generateNodeToken();
    expect(a.token).not.toBe(b.token);
    expect(a.tokenHash).toBe(hashNodeToken(a.token));
    expect(Buffer.from(a.token, "base64url")).toHaveLength(32);
  });
});
