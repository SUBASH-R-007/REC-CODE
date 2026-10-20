import { describe, expect, it } from "vitest";
import { findFiles, readRepoFile } from "./support/repo";

/**
 * The deployment artefacts (Phase 10e).
 *
 * None of these files has ever been started: there is one laptop and no
 * second host, and `docs/RUNBOOK.md` §3 says so for each of them. That is
 * exactly why they need a fence. A compose file nobody runs is reviewed once
 * and then edited for years, and the two mistakes it can make are the ones
 * no reviewer catches by eye:
 *
 *   - an image that is not pinned, so "redeploy the same version" silently
 *     means something new;
 *   - a port published to the world on a host whose whole design is that it
 *     has no public listener.
 *
 * The third rule is about secrets, and it is the one that would matter
 * immediately: a password written into a compose file is a password in git.
 */

const DEPLOY = ["deploy"];
const COMPOSE = findFiles({ under: DEPLOY, extensions: [".yml", ".yaml"] });

describe("the deployment files exist and say they have not been run", () => {
  it("has one compose file per host role, a Caddyfile and a pgBackRest config", () => {
    expect(COMPOSE.sort()).toEqual([
      "deploy/compose.app.yml",
      "deploy/compose.db.yml",
      "deploy/compose.judge.yml",
    ]);
    expect(readRepoFile("deploy/Caddyfile").length).toBeGreaterThan(500);
    expect(readRepoFile("deploy/pgbackrest.conf").length).toBeGreaterThan(500);
  });

  it("says in each file that it has not been run here", () => {
    /**
     * The phase's own standard: "a row that says NOT RUN is worth more than
     * a row that says PASS about a thing that was never tried." The same
     * applies to the file itself — somebody reading `compose.db.yml` for the
     * first time should learn from the file that nobody has started it.
     */
    for (const rel of [...COMPOSE, "deploy/Caddyfile", "deploy/pgbackrest.conf"]) {
      expect(readRepoFile(rel), `${rel} does not say whether it has been run`).toMatch(/[Nn]ot run here/);
    }
  });
});

describe("every image is pinned, and the file refuses to start otherwise", () => {
  it("takes every image from a required variable", () => {
    /**
     * `${VAR:?message}` makes compose fail with that message when the
     * variable is unset, instead of pulling a tag. A tag is not a pin:
     * `postgres:17` moves, and an image that moves under a running platform
     * is how a Tuesday becomes an incident.
     */
    const problems: string[] = [];
    for (const rel of COMPOSE) {
      for (const line of readRepoFile(rel).split("\n")) {
        const match = /^\s*image:\s*(.+?)\s*$/.exec(line);
        if (!match) continue;
        const image = match[1]!;
        if (!/^\$\{[A-Z_]+:\?/.test(image)) problems.push(`${rel}  image: ${image}`);
      }
    }
    expect(problems).toEqual([]);
  });

  it("names a digest in the message, so the refusal says what to do", () => {
    for (const rel of COMPOSE) {
      for (const match of readRepoFile(rel).matchAll(/image:\s*\$\{[A-Z_]+:\?([^}]*)\}/g)) {
        expect(match[1], `${rel}: ${match[1]}`).toContain("sha256:");
      }
    }
  });

  it("the deploy script refuses a tag, and says why", () => {
    // Demonstrated as well as asserted: docs/RUNBOOK.md §3 records the run
    // where `registry.example/recx-web:1.4.2` was refused.
    const deploy = readRepoFile("scripts/ops/deploy.sh");
    expect(deploy).toContain("@sha256:*");
    expect(deploy).toMatch(/must be pinned by digest/);
  });
});

describe("only the edge publishes a port to the world", () => {
  it("publishes nothing from the database host", () => {
    const published = [...readRepoFile("deploy/compose.db.yml").matchAll(/^\s*-\s*"(\d+:\d+)"/gm)];
    // Postgres is reached over the data network by the app hosts. A
    // published 5432 is a database on the internet, which is the one
    // configuration mistake in this file that could not be undone.
    expect(published.map((m) => m[1])).toEqual([]);
  });

  it("publishes the judge host's ports only on its monitoring address", () => {
    /**
     * Phase 2 established that a judge host has no public listener: the
     * worker calls out, and nothing calls in except the scrape. So every
     * published port here must be bound to an address, never to 0.0.0.0 —
     * which is what a bare `"9103:9103"` means.
     */
    const problems: string[] = [];
    for (const line of readRepoFile("deploy/compose.judge.yml").split("\n")) {
      const match = /^\s*-\s*"([^"]+)"\s*$/.exec(line);
      if (!match || !/\d+:\d+/.test(match[1]!)) continue;
      if (!match[1]!.startsWith("${RECX_MONITORING_IP")) problems.push(match[1]!);
    }
    expect(problems, "a judge host port bound to every interface").toEqual([]);
  });

  it("publishes 80, 443 and 443/udp from the app host, and nothing else", () => {
    const published = [...readRepoFile("deploy/compose.app.yml").matchAll(/^\s*-\s*"([^"]*\d+:\d+[^"]*)"/gm)].map(
      (m) => m[1]!,
    );
    expect(published.sort()).toEqual(["443:443", "443:443/udp", "80:80"]);
  });
});

describe("no secret is in the repository", () => {
  const files = [...COMPOSE, "deploy/Caddyfile", "deploy/pgbackrest.conf"];

  it("passes every credential by file or by variable, never by value", () => {
    /**
     * `*_FILE` indirection (Docker secrets, decrypted on the host from
     * sops+age at deploy time) or `${VAR}`. A literal after `PASSWORD:` or
     * `SECRET:` would be a credential in git, which tests/repo already
     * refuses for `.env` and which would be no better in YAML.
     */
    const problems: string[] = [];
    for (const rel of files) {
      readRepoFile(rel)
        .split("\n")
        .forEach((line, index) => {
          if (/^\s*[#;]/.test(line)) return;
          const match = /(PASSWORD|SECRET|TOKEN|_KEY|PASSPHRASE)[A-Z_]*\s*[:=]\s*(.+)$/.exec(line);
          if (!match) return;
          const value = match[2]!.trim();
          const safe =
            value.startsWith("${") ||
            value.startsWith("/run/") ||
            /^\$\{?[A-Z_]+\}?$/.test(value) ||
            /_FILE\b/.test(match[1]! + match[0]!.split(/[:=]/)[0]) ||
            value === "" ||
            value.startsWith("file:");
          if (!safe) problems.push(`${rel}:${index + 1}  ${line.trim().slice(0, 80)}`);
        });
    }
    expect(problems).toEqual([]);
  });

  it("encrypts the backup repository before it leaves the host", () => {
    /**
     * An offsite backup is a copy of every submission, every attempt and
     * every audit row on somebody else's disk. Encrypting it at the
     * destination would mean trusting the destination; `repo*-cipher-type`
     * encrypts it here.
     */
    const conf = readRepoFile("deploy/pgbackrest.conf");
    expect(conf).toContain("repo1-cipher-type=aes-256-cbc");
    expect(conf).toContain("repo2-cipher-type=aes-256-cbc");
    // The passphrase is an environment variable, never a line in this file.
    expect(conf).not.toMatch(/^repo\d-cipher-pass=/m);
    expect(conf).toContain("PGBACKREST_REPO1_CIPHER_PASS");
  });
});

describe("the ops scripts", () => {
  const scripts = findFiles({ under: ["scripts/ops"], extensions: [".sh"] });

  it("are the five the phase names", () => {
    expect(scripts.sort()).toEqual([
      "scripts/ops/backup.sh",
      "scripts/ops/deploy.sh",
      "scripts/ops/restore-drill.sh",
      "scripts/ops/restore.sh",
      "scripts/ops/verify-backup.sh",
    ]);
  });

  it("stop on an error rather than carrying on", () => {
    // A backup script that ignores a failed step writes a half set; a deploy
    // script that ignores one restarts the next replica anyway.
    for (const rel of scripts) {
      expect(readRepoFile(rel), rel).toMatch(/^set -[eu]/m);
    }
  });

  it("verify before restoring, and refuse a target that is not obviously scratch", () => {
    const restore = readRepoFile("scripts/ops/restore.sh");
    // The verification is not optional and not a flag: the moment somebody
    // is restoring is the moment they are least likely to check by hand.
    expect(restore).toContain("verify-backup.sh");
    expect(restore).toMatch(/_scratch\|\*_restore\|\*_drill\|\*_test/);
    expect(restore).toMatch(/refusing to restore into/);
  });

  it("takes a backup before applying migrations", () => {
    const deploy = readRepoFile("scripts/ops/deploy.sh");
    const migrations = deploy.slice(deploy.indexOf('RUN_MIGRATIONS" = "true"'));
    expect(migrations.indexOf("backup.sh"), "the backup comes before the migrate").toBeLessThan(
      migrations.indexOf("migrate deploy"),
    );
    // Off by default: SPEC's reason is that auto-migrating on boot runs them
    // N times concurrently during a rolling deploy.
    expect(deploy).toContain('RUN_MIGRATIONS="${RUN_MIGRATIONS:-false}"');
  });

  it("is backed by a drift check in CI, so a deploy's migration step is safe", () => {
    /**
     * `deploy.sh` can apply migrations; it cannot tell whether they produce
     * the schema the code expects. CI can: migrations are applied to an
     * empty database and `prisma migrate diff --exit-code` must then find
     * nothing.
     *
     * The mistake it catches is invisible locally. `prisma migrate dev`
     * keeps the developer's own database correct, so a change to
     * schema.prisma committed WITHOUT its migration passes every test on
     * their machine and produces a schema the code cannot use the first
     * time somebody runs `migrate deploy`.
     */
    const workflow = readRepoFile(".github/workflows/ci.yml").replace(/\r\n/g, "\n");
    expect(workflow).toContain("prisma migrate diff");
    expect(workflow).toContain("--exit-code");
    const verify = workflow.slice(workflow.indexOf("\n  verify:"), workflow.indexOf("\n  e2e:"));
    expect(verify, "the drift check belongs in the gate job, after the migrations are applied").toContain(
      "prisma migrate diff",
    );
    expect(verify.indexOf("pnpm db:migrate")).toBeLessThan(verify.indexOf("prisma migrate diff"));
  });

  it("refuses to deploy during a live contest unless it is told to", () => {
    const deploy = readRepoFile("scripts/ops/deploy.sh");
    expect(deploy).toContain("activeContest");
    expect(deploy).toContain("FORCE_DEPLOY");
    expect(deploy, "the override has to announce itself in the log").toMatch(
      /FORCE_DEPLOY=1: deploying DURING a live/,
    );
  });
});
