import { readFileSync } from "node:fs";

/**
 * `KEY_FILE` indirection for environment variables — the Docker-secret
 * convention, and the one every process here needs in production.
 *
 * NOT exported from the package index, for the same reason as
 * `metrics-server.ts`: the index is imported by client components, and a
 * top-level `node:fs` there would break the browser bundle. Import it as
 * `@recx/shared/env-file`.
 *
 * Why it exists: `deploy/compose.app.yml`, `compose.judge.yml` and the
 * scheduler service pass every credential as a FILE — `DATABASE_URL_FILE`,
 * `EXPORT_SIGNING_SECRET_FILE`, `RECX_NODE_TOKEN_FILE` — because
 * `tests/repo/deploy-topology.test.ts` refuses a credential written as a
 * value in the repository, and because an environment variable is readable
 * by anything that can list the container's processes while a file under
 * `/run/secrets` is not. Until this module existed, nothing read those
 * variables: the compose files set `EXPORT_SIGNING_SECRET_FILE` and the app
 * looked for `EXPORT_SIGNING_SECRET`, found the development default, and
 * refused to start in production. The artefacts were right and the
 * plumbing was missing.
 *
 * Where a platform hands the process real environment variables instead,
 * `KEY` is set, `KEY_FILE` is not, and this function changes nothing.
 */

/** Thrown when `KEY_FILE` is set and its file cannot be used. Never quotes the contents. */
export class EnvFileError extends Error {
  constructor(
    readonly variable: string,
    readonly path: string,
    reason: string,
  ) {
    super(`${variable}_FILE: ${reason} (${path})`);
    this.name = "EnvFileError";
  }
}

/**
 * A copy of `source` in which, for each of `keys`, a value read from
 * `KEY_FILE` fills in a `KEY` that is absent or empty.
 *
 * - `KEY` wins. A platform that sets the variable directly is never
 *   second-guessed, and a deployment can override one secret without
 *   touching the others.
 * - The file's contents are trimmed of surrounding whitespace, because
 *   `echo secret > file` leaves a newline and a token with a trailing
 *   newline is a token that does not match. A secret that genuinely ends in
 *   whitespace cannot be passed this way; pass it as a variable.
 * - An unreadable or (after trimming) empty file THROWS. The alternative is
 *   worse: a silently missing secret looks exactly like one that was never
 *   configured, which is how a deployment ends up signing with a
 *   development default.
 */
export function withFileBackedSecrets(
  keys: readonly string[],
  source: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const resolved: NodeJS.ProcessEnv = { ...source };
  for (const key of keys) {
    const direct = source[key];
    if (direct !== undefined && direct !== "") continue;
    const path = source[`${key}_FILE`];
    if (path === undefined || path === "") continue;

    let contents: string;
    try {
      contents = readFileSync(path, "utf8");
    } catch (error) {
      const code = (error as { code?: string }).code ?? "unreadable";
      throw new EnvFileError(key, path, `cannot be read: ${code}`);
    }
    const value = contents.trim();
    if (value === "") throw new EnvFileError(key, path, "is empty");
    resolved[key] = value;
  }
  return resolved;
}

/**
 * The same resolution, written back into `process.env`.
 *
 * A copy is not enough for every reader: Prisma resolves `DATABASE_URL`
 * from the real environment when a client is constructed, not from anything
 * we hand it (`packages/db/src/index.ts` passes a URL only when a caller
 * overrides one). So a process whose database URL arrives as a file has to
 * put it where Prisma will look, which means mutating `process.env` —
 * exactly what a dotenv-style loader does, and the reason this is a
 * separate, obviously-named function rather than a side effect of the pure
 * one above.
 *
 * Idempotent: a key that already has a value is skipped, so the two callers
 * that must both be safe — `env()` for everything, and
 * `apps/web/src/lib/db-client.ts` for `DATABASE_URL` immediately before it
 * constructs the Prisma client — can each run it without caring which went
 * first. Returns the keys it actually filled, so a caller may log which
 * secrets came from files: their names, never their values.
 */
export function hydrateFileBackedSecrets(keys: readonly string[], target: NodeJS.ProcessEnv = process.env): string[] {
  const resolved = withFileBackedSecrets(keys, target);
  const filled: string[] = [];
  for (const key of keys) {
    const value = resolved[key];
    if (value !== undefined && value !== target[key]) {
      target[key] = value;
      filled.push(key);
    }
  }
  return filled;
}
