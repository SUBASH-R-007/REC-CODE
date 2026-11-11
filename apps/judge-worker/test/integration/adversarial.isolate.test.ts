import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { LANGUAGE_CATALOG, type ResultRequest } from "@recx/shared";
import { BlobCache } from "../../src/cache";
import { boxIdsForSlot, maintenanceBoxIds } from "../../src/config";
import { IsolateDriver, resolveExecutable } from "../../src/drivers/isolate";
import { createLogger } from "../../src/logger";
import { processJob, type ProcessorDeps } from "../../src/processor";
import { MemoryPublisher } from "../../src/publisher";
import { IsolateSandbox } from "../../src/sandbox/isolate";
import { C_RUNTIME, compileProgram, nativeRunLimits, runProgram } from "../../src/selfcheck/exec";
import { runSelfCheck } from "../../src/selfcheck/runner";
import { SlotPool } from "../../src/slots";
import { FakeJudgeApi } from "../support/fake-api";
import { buildJob } from "../support/jobs";

/**
 * The Phase 2 containment gate, exercised through REAL isolate boxes and the
 * pinned toolchains on a Linux host. Gated on RECX_ISOLATE_INTEGRATION=1.
 *
 *   cd ~/recx/apps/judge-worker && RECX_ISOLATE_INTEGRATION=1 \
 *     npx vitest run --config vitest.integration.config.ts test/integration/adversarial.isolate.test.ts
 *
 * Box ids in use on a judge host and in these suites:
 *   live worker jobs   run N, compile 100+N, checker 200+N (RECX_BOX_BASE 0)
 *   live maintenance   900–909 (RECX_SELFCHECK_BOX_BASE; self-check 900–902)
 *   verify-toolchains  800–899
 *   isolate suites     bases 40 (two-sum), 50 (judging), 60 (this file),
 *                      70 (golden), 80 (function-harness), 90 (compile-errors),
 *                      each with its compile (+100) and checker (+200) box
 * The adversarial job boxes use base 60 (60, 160, 260). The self-check suite
 * here runs on maintenance-style boxes 950–952: outside every range above, so
 * it never shares a box (or its uid and cgroup) with a running judge's own
 * self-check or calibration.
 */

const execFileAsync = promisify(execFile);
const enabled = process.platform === "linux" && process.env.RECX_ISOLATE_INTEGRATION === "1";
const hasGcc = existsSync("/opt/toolchains/gcc-13.2.0/bin/g++");

const BOX_BASE = 60;
const SELFCHECK_BASE = Number(process.env.RECX_ADVERSARIAL_SELFCHECK_BOX_BASE ?? 950);
const ISOLATE_BIN = process.env.RECX_ISOLATE_BIN ?? "isolate";
const SYNTHETIC_ETC = process.env.RECX_SYNTHETIC_ETC ?? "/var/lib/recjudge/etc";
const FIRST_UID = 60000;

function isolateCgRoot(): string {
  return readFileSync("/run/isolate/cgroup", "utf8").trim();
}

async function boxUidProcesses(uid: number): Promise<number> {
  const { stdout } = await execFileAsync("ps", ["-e", "-o", "uid="], { timeout: 5_000 });
  return stdout.split("\n").map((l) => Number(l.trim())).filter((v) => Number.isInteger(v) && v === uid).length;
}

describe.skipIf(!enabled || !hasGcc)("adversarial containment on real isolate", () => {
  const logger = createLogger({ level: process.env.LOG_LEVEL ?? "warn", nodeId: "adversarial" });
  let metaDir: string;
  let sandbox: IsolateSandbox;

  beforeAll(() => {
    metaDir = mkdtempSync(path.join(os.tmpdir(), "recjudge-adv-"));
    sandbox = new IsolateSandbox({
      isolateBin: resolveExecutable(ISOLATE_BIN),
      boxIds: boxIdsForSlot(BOX_BASE, 0),
      syntheticEtc: SYNTHETIC_ETC,
      metaDir,
      logger,
    });
  });

  // ── Job-based cases (the real compile + sanitiser path) ──────────────────
  async function judge(language: "cpp20" | "c17", source: string, overrides = {}): Promise<ResultRequest> {
    const api = new FakeJudgeApi();
    const driver = await IsolateDriver.create({ isolateBin: ISOLATE_BIN, boxBase: BOX_BASE, syntheticEtc: SYNTHETIC_ETC, logger });
    const cacheDir = mkdtempSync(path.join(os.tmpdir(), "recjudge-advcache-"));
    const deps: ProcessorDeps = {
      api,
      driver,
      cache: new BlobCache({ dir: cacheDir, maxBytes: 256 * 1024 * 1024, logger }),
      publisher: new MemoryPublisher(),
      slots: new SlotPool(1),
      logger,
      nodeId: "adversarial",
    };
    const job = buildJob({ language, source, cases: [{ input: "", output: "ignored", isSample: true }], ...overrides });
    api.add(job.spec, job.blobs);
    const outcome = await processJob({ kind: job.spec.kind, id: job.spec.id }, deps);
    if (outcome.outcome !== "posted") throw new Error(`unexpected processor outcome ${outcome.outcome}`);
    const result = api.results.find((r) => r.id === job.spec.id);
    if (!result) throw new Error("no result posted");
    return result;
  }

  it("a C++ template-instantiation bomb compiles to CE 'compilation exceeded resource limits'", async () => {
    // A balanced binary recursion over 2^20 leaves: ~2M distinct instantiations,
    // which exhausts the compile box's memory or CPU — a resource CE, not a
    // normal compiler error.
    const source = [
      "template<long long Lo, long long Hi> struct Sum {",
      "  static const long long value = Sum<Lo, (Lo+Hi)/2>::value + Sum<(Lo+Hi)/2+1, Hi>::value;",
      "};",
      "template<long long X> struct Sum<X, X> { static const long long value = X; };",
      "static const long long R = Sum<1, (1LL<<20)>::value;",
      "int main(){ return (int)R; }",
      "",
    ].join("\n");
    const result = await judge("cpp20", source);
    expect(result.verdict).toBe("CE");
    expect(result.compile?.resourceExceeded).toBe(true);
    expect(result.compile?.output).toBe("compilation exceeded resource limits");
  }, 120_000);

  it("a compile error's output carries no /box/ or /opt/toolchains/ path", async () => {
    const source = [
      "class Solution {",
      "public:",
      "    int bad() { return undeclared_symbol + 1; }",
      "};",
      "int main(){ return 0; }",
      "",
    ].join("\n");
    const result = await judge("cpp20", source);
    expect(result.verdict).toBe("CE");
    const output = result.compile!.output;
    expect(output).not.toContain("/box/");
    expect(output).not.toContain("/opt/toolchains/");
    expect(output).toMatch(/undeclared_symbol/);
  });

  // ── Direct-sandbox cases (verdicts + host teardown) ─────────────────────
  async function runC(source: string, overrides: Parameters<typeof nativeRunLimits>[0] = {}, outputLimitBytes: number | null = null) {
    const artifacts = await compileProgram(sandbox, C_RUNTIME, source);
    return runProgram(sandbox, C_RUNTIME, artifacts, { limits: nativeRunLimits(overrides), outputLimitBytes });
  }

  it("a busy loop is TLE with reported CPU ≥ the limit, and the box + cgroup are torn down", async () => {
    const run = await runC("int main(){ for(;;){} return 0; }", { cpuMs: 1_000 });
    expect(run.verdict).toBe("TLE");
    expect(run.timeMs).toBeGreaterThanOrEqual(1_000);
    // runProgram cleans the run box; nothing must survive on the host.
    const runBox = boxIdsForSlot(BOX_BASE, 0).run;
    expect(existsSync(`/var/local/lib/isolate/${runBox}/box`)).toBe(false);
    expect(existsSync(`${isolateCgRoot()}/box-${runBox}`)).toBe(false);
    expect(await boxUidProcesses(FIRST_UID + runBox)).toBe(0);
  }, 60_000);

  it("a 4 GiB allocation is MLE via the memory cgroup (cg-oom-killed), not RE", async () => {
    const source = [
      "#include <stdlib.h>",
      "#include <string.h>",
      "int main(){",
      "  const size_t chunk=(size_t)64*1024*1024; size_t done=0;",
      "  while(done < (size_t)4*1024*1024*1024){ char*p=(char*)malloc(chunk); if(!p) return 1; memset(p,1,chunk); done+=chunk; }",
      "  return 0;",
      "}",
      "",
    ].join("\n");
    const run = await runC(source);
    expect(run.verdict).toBe("MLE");
  }, 60_000);

  it("socket()+connect() cannot reach the network (no connection succeeds)", async () => {
    const source = [
      "#include <stdio.h>",
      "#include <string.h>",
      "#include <sys/socket.h>",
      "#include <netinet/in.h>",
      "#include <arpa/inet.h>",
      "static int c(const char*ip){int s=socket(AF_INET,SOCK_STREAM,0);if(s<0)return -1;struct sockaddr_in a;memset(&a,0,sizeof a);a.sin_family=AF_INET;a.sin_port=htons(80);inet_pton(AF_INET,ip,&a.sin_addr);return connect(s,(struct sockaddr*)&a,sizeof a);}",
      "int main(){ if(c(\"1.1.1.1\")==0||c(\"127.0.0.1\")==0){printf(\"BREACH\\n\");return 0;} printf(\"SAFE\\n\"); return 0; }",
      "",
    ].join("\n");
    const run = await runC(source);
    expect(run.stdout).toContain("SAFE");
    expect(run.stdout).not.toContain("BREACH");
    expect(run.verdict).toBe("AC");
  }, 60_000);

  it("a fork bomb is RE and leaves no process with the box uid, cgroup torn down", async () => {
    const source = "#define _GNU_SOURCE\n#include <unistd.h>\n#include <sys/types.h>\n#include <stdlib.h>\nint main(){ for(;;){ pid_t p=fork(); if(p<0) _exit(1); } }\n";
    const run = await runC(source, { processes: 1 });
    expect(run.verdict).toBe("RE");
    const runBox = boxIdsForSlot(BOX_BASE, 0).run;
    expect(existsSync(`${isolateCgRoot()}/box-${runBox}`)).toBe(false);
    expect(await boxUidProcesses(FIRST_UID + runBox)).toBe(0);
  }, 60_000);

  it("an output flood is OLE from the early trip, within ~1 s of tripping", async () => {
    const started = Date.now();
    const run = await runC("#include <stdio.h>\nint main(){ for(;;) putchar('x'); }", { cpuMs: 5_000 }, 1024 * 1024);
    expect(run.verdict).toBe("OLE");
    expect(Date.now() - started).toBeLessThan(4_000); // well before the 5 s CPU / wall net
  }, 60_000);

  it("fallocate 10 GiB fails inside the 256 MB-bounded box", async () => {
    const source = [
      "#define _GNU_SOURCE",
      "#include <fcntl.h>",
      "#include <signal.h>",
      "#include <stdio.h>",
      "#include <unistd.h>",
      "int main(){ signal(SIGXFSZ,SIG_IGN); int fd=open(\"big.bin\",O_CREAT|O_WRONLY,0644); if(fd<0){printf(\"SAFE\\n\");return 0;} int r=fallocate(fd,0,0,10LL*1024*1024*1024); close(fd); printf(r!=0?\"SAFE\\n\":\"BREACH\\n\"); return 0; }",
      "",
    ].join("\n");
    const run = await runC(source);
    expect(run.stdout).toContain("SAFE");
    expect(run.stdout).not.toContain("BREACH");
  }, 60_000);

  it('open("/etc/shadow") fails inside the synthetic /etc', async () => {
    const run = await runC('#include <stdio.h>\nint main(){ FILE*f=fopen("/etc/shadow","r"); printf(f?"BREACH\\n":"SAFE\\n"); if(f)fclose(f); return 0; }');
    expect(run.stdout).toContain("SAFE");
  }, 60_000);

  it("a cross-slot box read fails (another box's path, and .. escapes)", async () => {
    const source = [
      "#include <stdio.h>",
      "#include <dirent.h>",
      "int main(){ const char*p[]={\"/var/local/lib/isolate\",\"/var/local/lib/isolate/0/box\",\"/var/local/lib/isolate/1/box\",\"/box/../0/box\"};",
      "  for(int i=0;i<4;i++){ DIR*d=opendir(p[i]); if(d){ printf(\"BREACH %s\\n\",p[i]); closedir(d); return 0; } }",
      "  printf(\"SAFE\\n\"); return 0; }",
      "",
    ].join("\n");
    const run = await runC(source);
    expect(run.stdout).toContain("SAFE");
    expect(run.stdout).not.toContain("BREACH");
  }, 60_000);

  // ── The whole self-check suite, through the real sandbox ────────────────
  it("the full adversarial self-check suite passes", async () => {
    const selfCheckSandbox = new IsolateSandbox({
      isolateBin: resolveExecutable(ISOLATE_BIN),
      boxIds: maintenanceBoxIds(SELFCHECK_BASE),
      syntheticEtc: SYNTHETIC_ETC,
      metaDir,
      logger,
    });
    const report = await runSelfCheck({
      sandbox: selfCheckSandbox,
      runBoxId: maintenanceBoxIds(SELFCHECK_BASE).run,
      firstUid: FIRST_UID,
      logger,
    });
    if (!report.ok) console.error("[adversarial] self-check failures:\n" + report.failures.join("\n"));
    expect(report.failures).toEqual([]);
    expect(report.ok).toBe(true);
  }, 300_000);

  afterAll(() => {
    expect(LANGUAGE_CATALOG.c17.sourceFile).toBe("main.c"); // the fixtures compile as C
  });
});
