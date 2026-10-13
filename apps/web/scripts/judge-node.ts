/**
 * Register a judge node or rotate its token.
 *
 *   cd apps/web
 *   npx tsx --conditions=react-server scripts/judge-node.ts add <id> <hostname>
 *   npx tsx --conditions=react-server scripts/judge-node.ts rotate <id>
 *
 * The fresh token is printed exactly once; only its sha256 is stored. Give
 * it to the worker on that host and nowhere else — it can claim jobs, fetch
 * the blobs of a job it holds, post that job's result, release it and
 * heartbeat, nothing more. Rotating invalidates the old token immediately
 * (the worker's next request gets 401). Both commands are audited.
 *
 * --conditions=react-server: see scripts/seed.ts — the script reuses the
 * app's server-only modules (db, audit, node-auth).
 */
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const HOSTNAME_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9.-]{0,253}[A-Za-z0-9])?$/;
const USAGE = [
  "Usage (from apps/web):",
  "  npx tsx --conditions=react-server scripts/judge-node.ts add <id> <hostname>",
  "  npx tsx --conditions=react-server scripts/judge-node.ts rotate <id>",
].join("\n");

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

function requireReactServerCondition() {
  let resolved = "";
  try {
    resolved = import.meta.resolve("server-only");
  } catch {
    fail("Cannot resolve the server-only package. Run `npx pnpm@9.15.9 install` first.");
  }
  if (!resolved.endsWith("/empty.js")) fail(`This script needs the react-server condition.\n${USAGE}`);
}

function printToken(token: string) {
  console.log("");
  console.log("Node token (shown once; it is not stored, only its sha256 is):");
  console.log("");
  console.log(`  ${token}`);
  console.log("");
  console.log("Configure it on the judge host now. It authenticates as this node only.");
}

async function main() {
  process.chdir(APP_ROOT);
  const envFile = path.join(APP_ROOT, ".env.local");
  if (existsSync(envFile)) process.loadEnvFile(envFile);
  requireReactServerCondition();

  const [command, id, hostname] = process.argv.slice(2);
  if (command !== "add" && command !== "rotate") fail(USAGE);

  const [{ db }, { audit }, nodeAuth, { generateNodeToken }] = await Promise.all([
    import("../src/lib/db"),
    import("../src/lib/audit"),
    import("../src/lib/judge/node-auth"),
    import("../src/lib/judge/node-token"),
  ]);
  if (!id || !nodeAuth.parseNodeId(id)) fail(`Node id must be 1–64 characters of letters, digits, '.', '_' or '-'.\n${USAGE}`);

  // 32 random bytes, base64url: 43 characters, accepted by the bearer parser.
  const { token, tokenHash } = generateNodeToken();
  let operator = "unknown";
  try {
    operator = os.userInfo().username;
  } catch {
    // No passwd entry for this uid (containers); the audit row still records the action.
  }

  try {
    if (command === "add") {
      if (!hostname || !HOSTNAME_PATTERN.test(hostname)) fail(`A valid hostname is required.\n${USAGE}`);
      const existing = await db.judgeNode.findUnique({ where: { id }, select: { id: true } });
      if (existing) fail(`Judge node ${id} already exists. Use "rotate ${id}" to issue a new token.`);
      // OFFLINE until the worker's first heartbeat brings it ONLINE.
      await db.judgeNode.create({ data: { id, hostname, tokenHash, status: "OFFLINE" } });
      await audit({
        actorId: null,
        action: "judge.node.created",
        entityType: "JudgeNode",
        entityId: id,
        sensitivity: "SECURITY",
        metadata: { hostname, via: "cli", operator },
      });
      console.log(`Judge node ${id} (${hostname}) registered. Status OFFLINE until its first heartbeat.`);
      printToken(token);
    } else {
      const updated = await db.judgeNode.updateMany({ where: { id }, data: { tokenHash } });
      if (updated.count === 0) fail(`Judge node ${id} does not exist. Use "add ${id} <hostname>" first.`);
      await audit({
        actorId: null,
        action: "judge.node.token_rotated",
        entityType: "JudgeNode",
        entityId: id,
        sensitivity: "SECURITY",
        metadata: { via: "cli", operator },
      });
      console.log(`Judge node ${id}: token rotated. The previous token no longer authenticates.`);
      printToken(token);
    }
  } finally {
    await db.$disconnect();
  }
}

main().catch((error: unknown) => {
  console.error("judge-node failed:", error);
  process.exit(1);
});
