import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { EnvFileError, hydrateFileBackedSecrets, withFileBackedSecrets } from "../src/env-file";

/**
 * `KEY_FILE` indirection (Phase 10e's compose files pass every credential
 * as a Docker secret; nothing read them until this module existed).
 *
 * The cases that matter are the unhappy ones: a secret that silently fails
 * to load is how a deployment ends up signing with a development default,
 * which is exactly what apps/web refuses to start with.
 */

const dir = mkdtempSync(path.join(tmpdir(), "recx-env-file-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function secretFile(name: string, contents: string): string {
  const file = path.join(dir, name);
  writeFileSync(file, contents);
  return file;
}

const TOKEN = "a-token-that-is-long-enough-to-be-real";

describe("withFileBackedSecrets", () => {
  it("reads KEY from KEY_FILE when KEY is absent", () => {
    const file = secretFile("token", TOKEN);
    const resolved = withFileBackedSecrets(["RECX_NODE_TOKEN"], { RECX_NODE_TOKEN_FILE: file });
    expect(resolved.RECX_NODE_TOKEN).toBe(TOKEN);
  });

  it("trims the newline that writing a secret with echo leaves behind", () => {
    const file = secretFile("token-nl", `${TOKEN}\n`);
    const resolved = withFileBackedSecrets(["RECX_NODE_TOKEN"], { RECX_NODE_TOKEN_FILE: file });
    // Not a cosmetic detail: a token with a trailing newline is a token that
    // does not match, and the error it produces says "unauthorised".
    expect(resolved.RECX_NODE_TOKEN).toBe(TOKEN);
  });

  it("lets KEY win over KEY_FILE", () => {
    const file = secretFile("ignored", "from-the-file");
    const resolved = withFileBackedSecrets(["RECX_NODE_TOKEN"], {
      RECX_NODE_TOKEN: "from-the-variable",
      RECX_NODE_TOKEN_FILE: file,
    });
    expect(resolved.RECX_NODE_TOKEN).toBe("from-the-variable");
  });

  it("treats an empty KEY as absent", () => {
    const file = secretFile("empty-var", TOKEN);
    const resolved = withFileBackedSecrets(["RECX_NODE_TOKEN"], {
      RECX_NODE_TOKEN: "",
      RECX_NODE_TOKEN_FILE: file,
    });
    expect(resolved.RECX_NODE_TOKEN).toBe(TOKEN);
  });

  it("leaves keys it was not asked about alone, KEY_FILE and all", () => {
    const file = secretFile("other", TOKEN);
    const resolved = withFileBackedSecrets(["WANTED"], { OTHER_FILE: file, PLAIN: "kept" });
    expect(resolved.OTHER).toBeUndefined();
    expect(resolved.PLAIN).toBe("kept");
  });

  it("does not mutate the environment it was given", () => {
    const file = secretFile("pure", TOKEN);
    const source = { RECX_NODE_TOKEN_FILE: file };
    withFileBackedSecrets(["RECX_NODE_TOKEN"], source);
    expect(source).not.toHaveProperty("RECX_NODE_TOKEN");
  });

  it("throws, naming the variable and the path, when the file is not there", () => {
    const missing = path.join(dir, "not-created");
    let thrown: unknown;
    try {
      withFileBackedSecrets(["DATABASE_URL"], { DATABASE_URL_FILE: missing });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(EnvFileError);
    const error = thrown as EnvFileError;
    expect(error.variable).toBe("DATABASE_URL");
    expect(error.path).toBe(missing);
    expect(error.message).toContain("ENOENT");
  });

  it("throws on a file that is empty, rather than reporting success", () => {
    const file = secretFile("blank", "   \n");
    expect(() => withFileBackedSecrets(["DATABASE_URL"], { DATABASE_URL_FILE: file })).toThrow(/is empty/);
  });

  it("never puts the contents of a secret in the error", () => {
    const file = secretFile("perms", "s3cr3t-value-nobody-should-see");
    // A directory, read as a file: EISDIR on every platform this runs on.
    expect(() => withFileBackedSecrets(["DATABASE_URL"], { DATABASE_URL_FILE: dir })).toThrow(
      new RegExp(`DATABASE_URL_FILE: cannot be read`),
    );
    expect(() => withFileBackedSecrets(["DATABASE_URL"], { DATABASE_URL_FILE: dir })).not.toThrow(/s3cr3t/);
    expect(file).toContain("perms");
  });
});

describe("hydrateFileBackedSecrets", () => {
  it("writes the value into the environment, because Prisma reads it there", () => {
    const file = secretFile("db-url", "postgresql://recx@db:5432/recx");
    const target: NodeJS.ProcessEnv = { DATABASE_URL_FILE: file };
    const filled = hydrateFileBackedSecrets(["DATABASE_URL"], target);
    expect(target.DATABASE_URL).toBe("postgresql://recx@db:5432/recx");
    expect(filled).toEqual(["DATABASE_URL"]);
  });

  it("is idempotent, so start-up and the first env() call can both run it", () => {
    const file = secretFile("db-url-2", "postgresql://recx@db:5432/recx");
    const target: NodeJS.ProcessEnv = { DATABASE_URL_FILE: file };
    expect(hydrateFileBackedSecrets(["DATABASE_URL"], target)).toEqual(["DATABASE_URL"]);
    expect(hydrateFileBackedSecrets(["DATABASE_URL"], target)).toEqual([]);
  });

  it("returns names only — a caller that logs the result logs no secrets", () => {
    const file = secretFile("pepper", "pepper-at-least-16-characters");
    const target: NodeJS.ProcessEnv = { IP_HASH_PEPPER_FILE: file };
    const filled = hydrateFileBackedSecrets(["IP_HASH_PEPPER"], target);
    expect(filled.join(", ")).toBe("IP_HASH_PEPPER");
    expect(filled.join(", ")).not.toContain("pepper-at-least");
  });

  it("changes nothing on a platform that sets real variables (Vercel, Render)", () => {
    const target: NodeJS.ProcessEnv = { DATABASE_URL: "postgresql://hosted/recx", REDIS_URL: "rediss://hosted:6379" };
    expect(hydrateFileBackedSecrets(["DATABASE_URL", "REDIS_URL"], target)).toEqual([]);
    expect(target).toEqual({ DATABASE_URL: "postgresql://hosted/recx", REDIS_URL: "rediss://hosted:6379" });
  });
});
