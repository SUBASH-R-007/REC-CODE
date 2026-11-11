import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

/**
 * The consent record SPEC §6 asks for (Phase 16e), against the real table.
 *
 * Three rules are the database's, and each exists because a convention
 * would not survive the first person who needed an exception:
 *
 *   * **append-only** — a consent record that can be edited proves nothing,
 *     and what it has to prove is what a person agreed to before a
 *     proctored sitting;
 *   * **one per candidate per paper per policy version** — pressing the
 *     control twice is one decision;
 *   * **the hash is a sha256** — `policyVersion` alone is a pointer into a
 *     file that moves, so the record carries a hash of the exact words and
 *     the column refuses anything that is not one.
 *
 * Opt-in: RECX_DB_TESTS=1.
 */
const ENABLED = process.env.RECX_DB_TESTS === "1";

vi.hoisted(() => {
  if (process.env.RECX_DB_TESTS === "1") {
    process.env.DATABASE_URL =
      process.env.RECX_TEST_DATABASE_URL ?? "postgresql://recx:recx-dev-only@127.0.0.1:5433/recx_test";
    process.env.IP_HASH_PEPPER ??= "consent-test-pepper";
  }
});

vi.mock("next/headers", () => ({
  headers: async () => new Headers(),
  cookies: async () => ({ get: () => undefined, set: () => undefined, delete: () => undefined }),
}));
vi.mock("next/cache", () => ({ revalidatePath: () => undefined, revalidateTag: () => undefined }));

describe.skipIf(!ENABLED)("proctoring consent against recx_test", () => {
  const tag = `cons-${Date.now().toString(36)}-${randomBytes(3).toString("hex")}`;
  let db: (typeof import("@/lib/db"))["db"];
  let consent: typeof import("@/lib/exam/consent");
  let shared: typeof import("@recx/shared");

  let studentId = "";
  let otherId = "";
  let staffId = "";
  let assessmentId = "";

  beforeAll(async () => {
    ({ db } = await import("@/lib/db"));
    consent = await import("@/lib/exam/consent");
    shared = await import("@recx/shared");

    const mk = async (suffix: string, role: "STUDENT" | "SUPER_ADMIN") => {
      const row = await db.user.create({
        data: {
          collegeId: `${tag}-${suffix}`.toUpperCase().slice(0, 32),
          email: `${tag}-${suffix}@rajalakshmi.edu.invalid`,
          firstName: "Consent",
          lastName: suffix,
          handle: `${tag}-${suffix}`.slice(0, 30),
          role,
          status: "ACTIVE",
        },
        select: { id: true },
      });
      return row.id;
    };
    studentId = await mk("stud", "STUDENT");
    otherId = await mk("other", "STUDENT");
    staffId = await mk("staff", "SUPER_ADMIN");

    const assessment = await db.assessment.create({
      data: {
        slug: `${tag}-paper`,
        title: "A proctored paper",
        instructions: "Answer everything.",
        status: "DRAFT",
        proctorMode: "ADVISORY",
        opensAt: new Date(Date.now() + 86_400_000),
        closesAt: new Date(Date.now() + 90_000_000),
        durationSec: 3_600,
        createdById: staffId,
      } as never,
      select: { id: true },
    });
    assessmentId = assessment.id;
  }, 120_000);

  afterAll(async () => {
    if (!ENABLED) return;
    await db.$executeRawUnsafe(`ALTER TABLE "ConsentRecord" DISABLE TRIGGER "ConsentRecord_append_only"`);
    await db.$executeRawUnsafe(`DELETE FROM "ConsentRecord" WHERE "assessmentId" = $1`, assessmentId);
    await db.$executeRawUnsafe(`ALTER TABLE "ConsentRecord" ENABLE TRIGGER "ConsentRecord_append_only"`);
    await db.assessment.deleteMany({ where: { id: assessmentId } });
    await db.user.deleteMany({ where: { id: { in: [studentId, otherId, staffId].filter(Boolean) } } });
  }, 120_000);

  it("records what was shown, and says so by its hash", async () => {
    expect(await consent.hasConsented(studentId, assessmentId)).toBe(false);
    const first = await consent.recordConsent({ userId: studentId, assessmentId, ipHash: "a".repeat(64) });
    expect(first.recorded).toBe(true);
    expect(await consent.hasConsented(studentId, assessmentId)).toBe(true);

    const row = await db.consentRecord.findFirstOrThrow({
      where: { userId: studentId, assessmentId },
      select: { policyVersion: true, policyHash: true, ipHash: true },
    });
    expect(row.policyVersion).toBe(shared.PROCTORING_CONSENT_VERSION);
    // The hash is of the words, not of the version: changing a point
    // changes it, which is the whole reason it is stored.
    expect(row.policyHash).toBe(consent.consentPolicyHash());
    expect(row.policyHash).toMatch(/^[0-9a-f]{64}$/);
    expect(row.ipHash).toBe("a".repeat(64));
  }, 60_000);

  it("is one record however many times the control is pressed", async () => {
    const again = await consent.recordConsent({ userId: studentId, assessmentId, ipHash: null });
    expect(again.recorded).toBe(false);
    expect(await db.consentRecord.count({ where: { userId: studentId, assessmentId } })).toBe(1);
  }, 60_000);

  it("is per candidate", async () => {
    expect(await consent.hasConsented(otherId, assessmentId)).toBe(false);
    await consent.recordConsent({ userId: otherId, assessmentId, ipHash: null });
    expect(await db.consentRecord.count({ where: { assessmentId } })).toBe(2);
  }, 60_000);

  describe("what the database refuses", () => {
    it("an edit", async () => {
      const row = await db.consentRecord.findFirstOrThrow({ where: { userId: studentId }, select: { id: true } });
      await expect(
        db.consentRecord.update({ where: { id: row.id }, data: { policyVersion: 99 } }),
      ).rejects.toThrow(/append-only/i);
    }, 60_000);

    it("a delete", async () => {
      const row = await db.consentRecord.findFirstOrThrow({ where: { userId: studentId }, select: { id: true } });
      await expect(db.consentRecord.delete({ where: { id: row.id } })).rejects.toThrow(/append-only/i);
    }, 60_000);

    it("a hash that is not one", async () => {
      await expect(
        db.consentRecord.create({
          data: { userId: staffId, assessmentId, policyVersion: 1, policyHash: "not-a-hash" },
        }),
      ).rejects.toThrow();
    }, 60_000);

    it("a version that is not positive", async () => {
      await expect(
        db.consentRecord.create({
          data: { userId: staffId, assessmentId, policyVersion: 0, policyHash: "b".repeat(64) },
        }),
      ).rejects.toThrow();
    }, 60_000);

    it("a raw address in the ipHash column", async () => {
      await expect(
        db.consentRecord.create({
          data: { userId: staffId, assessmentId, policyVersion: 1, policyHash: "c".repeat(64), ipHash: "10.21.0.4" },
        }),
      ).rejects.toThrow();
    }, 60_000);

    it("TRUNCATE", async () => {
      await expect(db.$executeRawUnsafe(`TRUNCATE "ConsentRecord"`)).rejects.toThrow(/TRUNCATE/i);
    }, 60_000);
  });

  it("names a contact only when a super-admin has set one", async () => {
    const before = await consent.consentContact();
    // Whatever the deployment holds, the shape is the contract.
    if (before !== null) expect(before.email).toContain("@");

    // The WRITE lives in the settings action, where the platform-setting
    // fence keeps every such write; this is the validation half plus the
    // read, which is what the readiness page actually depends on.
    const saved = consent.parseConsentContact({
      name: `${tag} Data Protection Officer`,
      email: `${tag}@rajalakshmi.edu.invalid`,
      office: "Admin block, room 12",
    });
    expect(saved.name).toContain("Data Protection Officer");
    await db.platformSetting.upsert({
      where: { key: shared.CONSENT_SETTING_KEY },
      create: { key: shared.CONSENT_SETTING_KEY, value: saved },
      update: { value: saved },
    });
    const read = await consent.consentContact();
    expect(read?.email).toBe(`${tag}@rajalakshmi.edu.invalid`);

    expect(() => consent.parseConsentContact({ name: "", email: "not-an-email", office: null })).toThrow();

    // Put back whatever was there, so this suite leaves the deployment's
    // own setting alone.
    if (before) {
      await db.platformSetting.update({ where: { key: shared.CONSENT_SETTING_KEY }, data: { value: before } });
    } else {
      await db.platformSetting.deleteMany({ where: { key: shared.CONSENT_SETTING_KEY } });
    }
  }, 60_000);
});
