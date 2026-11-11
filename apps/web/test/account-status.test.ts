import { describe, expect, it } from "vitest";
import { planRoleChange, planStatusChange, type ChangeContext } from "@/lib/accounts/status";

/** The account-status and role rules behind /super/users and /super/roles (pure). */

const ctx = (target: Partial<ChangeContext["target"]> = {}, activeSuperAdmins = 2): ChangeContext => ({
  actorId: "super_1",
  target: { id: "user_1", role: "STUDENT", status: "ACTIVE", ...target },
  activeSuperAdmins,
});

describe("planStatusChange", () => {
  it("refuses changing your own status, and a no-op", () => {
    expect(planStatusChange("DISABLED", ctx({ id: "super_1", role: "SUPER_ADMIN" }))).toEqual({
      ok: false,
      reason: "You cannot change your own account's status.",
    });
    expect(planStatusChange("ACTIVE", ctx()).ok).toBe(false);
  });

  it("protects the last active super-admin", () => {
    const last = ctx({ id: "super_2", role: "SUPER_ADMIN" }, 1);
    expect(planStatusChange("DISABLED", last).ok).toBe(false);
    expect(planStatusChange("DISABLED", ctx({ id: "super_2", role: "SUPER_ADMIN" }, 2)).ok).toBe(true);
  });

  it("ends sessions when the account can no longer sign in", () => {
    for (const to of ["DISABLED", "GRADUATED", "ARCHIVED"] as const) {
      expect(planStatusChange(to, ctx())).toMatchObject({ ok: true, endsSessions: true, from: "ACTIVE" });
    }
    expect(planStatusChange("SOFT_RESTRICTED", ctx())).toMatchObject({ ok: true, endsSessions: false });
    expect(planStatusChange("ACTIVE", ctx({ status: "DISABLED" }))).toMatchObject({ ok: true, endsSessions: false });
  });

  it("is SECURITY for DISABLED/ARCHIVED or staff, SENSITIVE otherwise", () => {
    expect(planStatusChange("DISABLED", ctx())).toMatchObject({ sensitivity: "SECURITY" });
    expect(planStatusChange("ACTIVE", ctx({ status: "ARCHIVED" }))).toMatchObject({ sensitivity: "SECURITY" });
    expect(planStatusChange("GRADUATED", ctx())).toMatchObject({ sensitivity: "SENSITIVE" });
    expect(planStatusChange("GRADUATED", ctx({ role: "ADMIN" }))).toMatchObject({ sensitivity: "SECURITY" });
  });
});

describe("planRoleChange", () => {
  it("refuses yourself, a no-op and removing the last active super-admin", () => {
    expect(planRoleChange("ADMIN", ctx({ id: "super_1", role: "SUPER_ADMIN" })).ok).toBe(false);
    expect(planRoleChange("STUDENT", ctx()).ok).toBe(false);
    expect(planRoleChange("ADMIN", ctx({ id: "super_2", role: "SUPER_ADMIN" }, 1)).ok).toBe(false);
    expect(planRoleChange("ADMIN", ctx({ id: "super_2", role: "SUPER_ADMIN" }, 2)).ok).toBe(true);
  });

  it("gives staff roles to active accounts only, and leaving ADMIN drops scopes", () => {
    expect(planRoleChange("ADMIN", ctx({ status: "DISABLED" })).ok).toBe(false);
    expect(planRoleChange("ADMIN", ctx())).toEqual({ ok: true, dropsScopes: false });
    expect(planRoleChange("STUDENT", ctx({ role: "ADMIN" }))).toEqual({ ok: true, dropsScopes: true });
    expect(planRoleChange("SUPER_ADMIN", ctx({ role: "ADMIN" }))).toEqual({ ok: true, dropsScopes: true });
  });
});
