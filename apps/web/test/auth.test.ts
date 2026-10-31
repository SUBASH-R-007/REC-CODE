import { describe, expect, it } from "vitest";
import { ARGON2_PARAMS, dummyPasswordHash, hashPassword, verifyPassword } from "@/lib/auth/password";

/** @node-rs/argon2's `Algorithm` is an ambient const enum; Argon2id is 2. */
const ARGON2ID = 2;

describe("password hashing (Argon2id)", () => {
  it("uses the OWASP minimum parameters m=19456 t=2 p=1", () => {
    expect(ARGON2_PARAMS).toMatchObject({ memoryCost: 19_456, timeCost: 2, parallelism: 1 });
    // Under isolated transpilation (vitest, SWC) a const-enum member access
    // compiles to `undefined`, which the library treats as its default,
    // Argon2id. Either way the PHC string below is the real proof.
    expect([ARGON2ID, undefined]).toContain(ARGON2_PARAMS.algorithm as number | undefined);
  });

  it("produces a PHC string with those parameters, which verifies", async () => {
    const hash = await hashPassword("correct horse battery 42");
    expect(hash).toContain("$argon2id$v=19$m=19456,t=2,p=1$");
    expect(await verifyPassword("correct horse battery 42", hash)).toBe(true);
  });

  it("rejects a wrong password", async () => {
    const hash = await hashPassword("correct horse battery 42");
    expect(await verifyPassword("correct horse battery 43", hash)).toBe(false);
    expect(await verifyPassword("", hash)).toBe(false);
  });

  it("treats a malformed stored hash as a failed verification, not an error", async () => {
    expect(await verifyPassword("anything", "not-a-phc-string")).toBe(false);
  });

  it("keeps unknown-account timing uniform: the decoy is a real hash with the same cost", async () => {
    const decoy = await dummyPasswordHash();
    expect(decoy).toContain("$argon2id$v=19$m=19456,t=2,p=1$");
    expect(await dummyPasswordHash()).toBe(decoy);
    expect(await verifyPassword("guess", decoy)).toBe(false);
  });
});
