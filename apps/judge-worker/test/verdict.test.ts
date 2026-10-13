import { describe, expect, it } from "vitest";
import type { LanguageKey } from "@recx/shared";
import { classifyCompile, classifyRun, signalName, type RunContext } from "../src/judge/verdict";
import { isMetaEmpty, parseIsolateMeta } from "../src/sandbox/meta";

/**
 * Meta fixtures are verbatim isolate 2.7 output captured on the WSL2 judge
 * box (cgroup v2), one fresh box per run.
 */
const META = {
  ok: "time:0.034\ntime-wall:0.053\nmax-rss:9600\ncsw-voluntary:61\ncsw-forced:1\ncg-mem:10256\nexitcode:0\n",
  oomKilled:
    "time:0.110\ntime-wall:0.112\nmax-rss:67360\ncsw-voluntary:5\ncsw-forced:240\ncg-mem:65536\ncg-oom-killed:1\nexitsig:9\nstatus:SG\nmessage:Caught fatal signal 9\n",
  cpuTimeout: "status:TO\nmessage:Time limit exceeded\nkilled:1\ntime:1.008\ntime-wall:1.001\nmax-rss:800\ncsw-voluntary:3\ncsw-forced:0\ncg-mem:3200\n",
  wallTimeout:
    "status:TO\nmessage:Time limit exceeded (wall clock)\nkilled:1\ntime:0.019\ntime-wall:5.100\nmax-rss:800\ncsw-voluntary:3\ncsw-forced:0\ncg-mem:2100\n",
  exit3: "time:0.013\ntime-wall:0.012\nmax-rss:9600\ncsw-voluntary:4\ncsw-forced:1\ncg-mem:10000\nexitcode:3\nstatus:RE\nmessage:Exited with error status 3\n",
  exit1: "time:0.200\ntime-wall:0.250\nmax-rss:40000\ncg-mem:50000\nexitcode:1\nstatus:RE\nmessage:Exited with error status 1\n",
  segv: "time:0.024\ntime-wall:0.060\nmax-rss:10880\ncsw-voluntary:474\ncsw-forced:2\ncg-mem:11000\nexitsig:11\nstatus:SG\nmessage:Caught fatal signal 11\n",
  xfsz: "time:0.051\ntime-wall:0.051\nmax-rss:11540\ncg-mem:20000\nexitsig:25\nstatus:SG\nmessage:Caught fatal signal 25\n",
  internal: "status:XX\nmessage:Cannot run proxy, clone failed: Resource temporarily unavailable\n",
  atLimitExit0: "time:0.300\ntime-wall:0.310\nmax-rss:260000\ncg-mem:262144\nexitcode:0\n",
};

const ctx = (patch: Partial<RunContext> = {}): RunContext => ({
  timeLimitMs: 1000,
  memoryLimitKb: 262_144,
  language: "cpp20",
  stderr: "",
  outputLimitExceeded: false,
  ...patch,
});

describe("parseIsolateMeta", () => {
  it("parses every field isolate writes", () => {
    expect(parseIsolateMeta(META.oomKilled)).toEqual({
      status: "SG",
      timeSec: 0.11,
      wallSec: 0.112,
      maxRssKb: 67_360,
      cgMemKb: 65_536,
      cgOomKilled: true,
      exitCode: null,
      exitSignal: 9,
      killed: false,
      message: "Caught fatal signal 9",
    });
  });

  it("keeps colons inside the message", () => {
    expect(parseIsolateMeta(META.internal).message).toBe("Cannot run proxy, clone failed: Resource temporarily unavailable");
  });

  it("recognises an empty meta file", () => {
    expect(isMetaEmpty(parseIsolateMeta(""))).toBe(true);
    expect(isMetaEmpty(parseIsolateMeta(META.ok))).toBe(false);
  });
});

describe("classifyRun", () => {
  it("exit 0 within limits → compare the output", () => {
    const r = classifyRun(parseIsolateMeta(META.ok), ctx());
    expect(r).toMatchObject({ verdict: null, timeMs: 34, memoryKb: 10_256, exitCode: 0, signal: null, idle: false });
  });

  it("status XX → IE (infrastructure)", () => {
    expect(classifyRun(parseIsolateMeta(META.internal), ctx()).verdict).toBe("IE");
  });

  it("TO with CPU time ≥ limit → TLE", () => {
    const r = classifyRun(parseIsolateMeta(META.cpuTimeout), ctx());
    expect(r).toMatchObject({ verdict: "TLE", idle: false, timeMs: 1008 });
  });

  it("TO with the CPU idle (wall clock exceeded) → TLE plus the admin idle flag", () => {
    const r = classifyRun(parseIsolateMeta(META.wallTimeout), ctx());
    expect(r).toMatchObject({ verdict: "TLE", idle: true, timeMs: 19 });
  });

  it("CPU over the limit but ended inside --extra-time (isolate reports RE / SG, not TO) → TLE", () => {
    // isolate checks the exit status before the time: a program that crashes
    // or exits non-zero after 1.2 s of a 1 s limit is reported RE / SG.
    const lateExit = "time:1.200\ntime-wall:1.210\ncg-mem:9000\nexitcode:1\nstatus:RE\nmessage:Exited with error status 1\n";
    const lateSegv = "time:1.350\ntime-wall:1.360\ncg-mem:9000\nexitsig:11\nstatus:SG\nmessage:Caught fatal signal 11\n";
    expect(classifyRun(parseIsolateMeta(lateExit), ctx())).toMatchObject({ verdict: "TLE", idle: false, timeMs: 1200, exitCode: null });
    expect(classifyRun(parseIsolateMeta(lateSegv), ctx())).toMatchObject({ verdict: "TLE", signal: null });
    // Exactly at the limit is within it (isolate's own rule is time > limit).
    const atLimit = "time:1.000\ntime-wall:1.010\ncg-mem:9000\nexitcode:0\n";
    expect(classifyRun(parseIsolateMeta(atLimit), ctx()).verdict).toBeNull();
  });

  it("the early output trip outranks a timeout; a timeout outranks an OOM kill", () => {
    expect(classifyRun(parseIsolateMeta(META.cpuTimeout), ctx({ outputLimitExceeded: true })).verdict).toBe("OLE");
    const toAndOom = "status:TO\nkilled:1\ntime:1.100\ntime-wall:1.2\ncg-mem:262144\ncg-oom-killed:1\n";
    expect(classifyRun(parseIsolateMeta(toAndOom), ctx()).verdict).toBe("TLE");
  });

  it("an OOM kill reports the cgroup peak as memory", () => {
    expect(classifyRun(parseIsolateMeta(META.oomKilled), ctx({ memoryLimitKb: 65_536 }))).toMatchObject({
      verdict: "MLE",
      memoryKb: 65_536,
    });
  });

  it("cg-oom-killed → MLE (not RE for the SIGKILL)", () => {
    expect(classifyRun(parseIsolateMeta(META.oomKilled), ctx({ memoryLimitKb: 65_536 })).verdict).toBe("MLE");
  });

  it("cg-mem at the limit → MLE even with exit 0", () => {
    expect(classifyRun(parseIsolateMeta(META.atLimitExit0), ctx()).verdict).toBe("MLE");
  });

  it("SIGSEGV → RE with the signal name", () => {
    const r = classifyRun(parseIsolateMeta(META.segv), ctx());
    expect(r).toMatchObject({ verdict: "RE", signal: "SIGSEGV", message: "Killed by SIGSEGV." });
  });

  it("SIGXFSZ (25) → OLE", () => {
    expect(classifyRun(parseIsolateMeta(META.xfsz), ctx()).verdict).toBe("OLE");
  });

  it("the supervisor's early output trip → OLE, whatever isolate saw", () => {
    const interrupted = "exitsig:15\nstatus:SG\nmessage:Interrupted\nkilled:1\ntime:0.400\ntime-wall:0.410\ncg-mem:9000\n";
    expect(classifyRun(parseIsolateMeta(interrupted), ctx({ outputLimitExceeded: true })).verdict).toBe("OLE");
  });

  it("non-zero exit → RE with the exit code", () => {
    const r = classifyRun(parseIsolateMeta(META.exit3), ctx());
    expect(r).toMatchObject({ verdict: "RE", exitCode: 3, message: "Exit code 3." });
  });

  it.each<[LanguageKey, string]>([
    ["java21", 'Exception in thread "main" java.lang.OutOfMemoryError: Java heap space\n\tat Main.main(Main.java:5)'],
    ["kotlin20", "Exception in thread \"main\" java.lang.OutOfMemoryError: Java heap space"],
  ])("%s exit 1 with java.lang.OutOfMemoryError → MLE", (language, stderr) => {
    expect(classifyRun(parseIsolateMeta(META.exit1), ctx({ language, stderr })).verdict).toBe("MLE");
  });

  it("JVM java.lang.StackOverflowError → RE labelled as such", () => {
    const r = classifyRun(
      parseIsolateMeta(META.exit1),
      ctx({ language: "java21", stderr: 'Exception in thread "main" java.lang.StackOverflowError\n\tat Main.f(Main.java:3)' }),
    );
    expect(r).toMatchObject({ verdict: "RE", message: "java.lang.StackOverflowError" });
  });

  it("Python MemoryError → MLE", () => {
    const stderr = 'Traceback (most recent call last):\n  File "/box/main.py", line 3, in <module>\n    x = [0] * 10**12\nMemoryError\n';
    expect(classifyRun(parseIsolateMeta(META.exit1), ctx({ language: "py312", stderr })).verdict).toBe("MLE");
    expect(classifyRun(parseIsolateMeta(META.exit1), ctx({ language: "pypy310", stderr })).verdict).toBe("MLE");
    // A message that merely mentions MemoryError is not the exception.
    const mention = "print('no MemoryError here')\nValueError: bad\n";
    expect(classifyRun(parseIsolateMeta(META.exit1), ctx({ language: "py312", stderr: mention })).verdict).toBe("RE");
  });

  it("SIGABRT and SIGFPE → RE labelled with the signal", () => {
    const abort = "time:0.010\ncg-mem:9000\nexitsig:6\nstatus:SG\nmessage:Caught fatal signal 6\n";
    const fpe = "time:0.010\ncg-mem:9000\nexitsig:8\nstatus:SG\nmessage:Caught fatal signal 8\n";
    expect(classifyRun(parseIsolateMeta(abort), ctx())).toMatchObject({ verdict: "RE", signal: "SIGABRT" });
    expect(classifyRun(parseIsolateMeta(fpe), ctx())).toMatchObject({ verdict: "RE", signal: "SIGFPE", message: "Killed by SIGFPE." });
  });

  it("the JVM refinement applies to JVM languages only", () => {
    const stderr = "java.lang.OutOfMemoryError";
    expect(classifyRun(parseIsolateMeta(META.exit1), ctx({ language: "cpp20", stderr })).verdict).toBe("RE");
  });

  it("names signals", () => {
    expect(signalName(6)).toBe("SIGABRT");
    expect(signalName(8)).toBe("SIGFPE");
    expect(signalName(64)).toBe("SIG64");
  });
});

describe("classifyCompile", () => {
  it.each([
    [META.ok, "ok"],
    [META.exit1, "error"],
    [META.cpuTimeout, "resource"],
    [META.wallTimeout, "resource"],
    [META.oomKilled, "resource"],
    [META.xfsz, "resource"],
    [META.internal, "infra"],
    // g++ exits 1 after cc1plus is OOM-killed: still the caps, not the student's syntax.
    ["exitcode:1\nstatus:RE\ncg-oom-killed:1\ncg-mem:1048576\ntime:3.2\n", "resource"],
  ])("%#", (meta, expected) => {
    expect(classifyCompile(parseIsolateMeta(meta))).toBe(expected);
  });
});
