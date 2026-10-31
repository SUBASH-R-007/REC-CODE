import type { Verdict } from "@recx/shared";

/**
 * The twelve adversarial self-check fixtures. Each is a C program that, when
 * the sandbox holds, either exits cleanly printing SAFE (the attack failed) or
 * trips a resource verdict (the attack was contained by a limit). Printing
 * BREACH — or not tripping the expected verdict — means the containment this
 * node promises is not actually in force, and the node quarantines itself.
 *
 * The expected outcomes are asserted by a PURE evaluator (evaluateFixture), so
 * the whole suite is unit-testable on any platform with recorded outcomes; the
 * runtime (./runner.ts) is what produces those outcomes from the real sandbox.
 */

export type FixtureExpectation =
  | { kind: "safe" }
  | { kind: "verdict"; verdict: Extract<Verdict, "RE" | "OLE" | "MLE" | "TLE">; idle?: boolean };

export interface SelfCheckFixture {
  id: string;
  title: string;
  source: string;
  expect: FixtureExpectation;
  /** After the run, assert the host is clean (no stray box-uid process, cgroup gone). */
  requireHostClean?: boolean;
  /** Give this fixture a larger memory limit (the 4 GB allocator needs headroom to prove MLE, not ENOMEM). */
  memoryKb?: number;
  /** Run-box process limit (the fork bomb proves containment at the native limit of 1). */
  processes?: number;
  /** A short wall budget via a small CPU limit (the 3-hour sleep trips the wall net quickly). */
  cpuMs?: number;
}

const forkBomb = `#define _GNU_SOURCE
#include <unistd.h>
#include <sys/types.h>
#include <stdlib.h>
int main(void) {
  for (;;) {
    pid_t p = fork();
    if (p < 0) { _exit(1); }   /* the process limit stops the first fork: exit 1 -> RE */
  }
  return 0;
}
`;

const outputFlood = `#include <stdio.h>
int main(void) {
  for (;;) putchar('x');       /* grows stdout without bound -> early OLE trip */
  return 0;
}
`;

const memoryBomb = `#include <stdlib.h>
#include <string.h>
int main(void) {
  const size_t chunk = (size_t)64 * 1024 * 1024;
  size_t done = 0;
  const size_t total = (size_t)4 * 1024 * 1024 * 1024;   /* 4 GiB, pages touched */
  while (done < total) {
    char *p = (char *)malloc(chunk);
    if (!p) return 1;
    memset(p, 1, chunk);
    done += chunk;
  }
  return 0;
}
`;

const fallocateBomb = `#define _GNU_SOURCE
#include <fcntl.h>
#include <signal.h>
#include <stdio.h>
#include <unistd.h>
int main(void) {
  /* Ignore SIGXFSZ so the --fsize limit makes fallocate return EFBIG instead
     of killing the process: the attack fails cleanly inside the box. */
  signal(SIGXFSZ, SIG_IGN);
  int fd = open("big.bin", O_CREAT | O_WRONLY, 0644);
  if (fd < 0) { printf("SAFE\\n"); return 0; }
  long long size = 10LL * 1024 * 1024 * 1024;            /* 10 GiB */
  int r = fallocate(fd, 0, 0, size);
  close(fd);
  if (r != 0) { printf("SAFE\\n"); return 0; }            /* failed inside the box */
  printf("BREACH\\n");
  return 0;
}
`;

const network = `#include <stdio.h>
#include <string.h>
#include <sys/socket.h>
#include <netinet/in.h>
#include <arpa/inet.h>
static int attempt(const char *ip) {
  int s = socket(AF_INET, SOCK_STREAM, 0);
  if (s < 0) return -1;
  struct sockaddr_in a;
  memset(&a, 0, sizeof a);
  a.sin_family = AF_INET;
  a.sin_port = htons(80);
  inet_pton(AF_INET, ip, &a.sin_addr);
  int r = connect(s, (struct sockaddr *)&a, sizeof a);
  return r;
}
int main(void) {
  int out = attempt("1.1.1.1");
  int loop = attempt("127.0.0.1");
  if (out == 0 || loop == 0) { printf("BREACH\\n"); return 0; }
  printf("SAFE\\n");
  return 0;
}
`;

const shadow = `#include <stdio.h>
int main(void) {
  FILE *f = fopen("/etc/shadow", "r");
  if (f) { printf("BREACH\\n"); fclose(f); return 0; }
  printf("SAFE\\n");
  return 0;
}
`;

const ptraceAttach = `#include <stdio.h>
#include <sys/ptrace.h>
int main(void) {
  /* pid 1 is the box's own init inside its pid namespace; the supervisor is
     outside and unnamable. Either way an attach must be refused. */
  long r = ptrace(PTRACE_ATTACH, 1, 0, 0);
  if (r == 0) { printf("BREACH\\n"); return 0; }
  printf("SAFE\\n");
  return 0;
}
`;

const procEnviron = `#include <stdio.h>
#include <string.h>
int main(void) {
  FILE *f = fopen("/proc/1/environ", "r");
  if (!f) { printf("SAFE\\n"); return 0; }              /* hidepid: unreadable is safe */
  static char buf[65536];
  size_t n = fread(buf, 1, sizeof buf - 1, f);
  fclose(f);
  const char *needles[] = {"RECX_", "TOKEN", "SECRET", "DATABASE", "PASSWORD"};
  for (int i = 0; i < 5; i++) {
    if (memmem(buf, n, needles[i], strlen(needles[i]))) { printf("BREACH\\n"); return 0; }
  }
  printf("SAFE\\n");
  return 0;
}
`;

const setuidRoot = `#include <stdio.h>
#include <unistd.h>
int main(void) {
  if (setuid(0) == 0 && getuid() == 0) { printf("BREACH\\n"); return 0; }
  printf("SAFE\\n");
  return 0;
}
`;

const sleepLong = `#include <unistd.h>
int main(void) {
  sleep(3 * 60 * 60);          /* 3 hours; the wall-time net trips first -> TLE (idle) */
  return 0;
}
`;

const ioUring = `#include <stdio.h>
#include <sys/syscall.h>
#include <unistd.h>
#ifndef __NR_io_uring_setup
#define __NR_io_uring_setup 425
#endif
int main(void) {
  long r = syscall(__NR_io_uring_setup, 1, 0);
  if (r >= 0) { printf("BREACH\\n"); return 0; } /* ENOSYS (seccomp) / EPERM (host) -> safe */
  printf("SAFE\\n");
  return 0;
}
`;

const crossBox = `#include <stdio.h>
#include <dirent.h>
int main(void) {
  /* The host box root is not bound into this box's mount namespace, so none of
     these can be opened; ".." stays inside /box and escapes nothing. A BREACH
     would mean another slot's box (or the host) became reachable. */
  const char *paths[] = {
    "/var/local/lib/isolate",
    "/var/local/lib/isolate/0/box",
    "/var/local/lib/isolate/1/box",
    "/box/../0/box",
    "/box/../../etc/shadow",
  };
  for (int i = 0; i < 5; i++) {
    DIR *d = opendir(paths[i]);
    if (d) { printf("BREACH %s\\n", paths[i]); closedir(d); return 0; }
  }
  printf("SAFE\\n");
  return 0;
}
`;

export const SELF_CHECK_FIXTURES: readonly SelfCheckFixture[] = [
  { id: "fork-bomb", title: "fork() under the process limit", source: forkBomb, expect: { kind: "verdict", verdict: "RE" }, requireHostClean: true, processes: 1 },
  { id: "output-flood", title: "while(1) putchar", source: outputFlood, expect: { kind: "verdict", verdict: "OLE" } },
  { id: "memory-4gb", title: "4 GiB allocation, pages touched", source: memoryBomb, expect: { kind: "verdict", verdict: "MLE" } },
  { id: "fallocate-10gb", title: "fallocate 10 GiB", source: fallocateBomb, expect: { kind: "safe" } },
  { id: "network", title: "socket()+connect() out and to loopback", source: network, expect: { kind: "safe" } },
  { id: "etc-shadow", title: 'open("/etc/shadow")', source: shadow, expect: { kind: "safe" } },
  { id: "ptrace", title: "ptrace(PTRACE_ATTACH)", source: ptraceAttach, expect: { kind: "safe" } },
  { id: "proc-environ", title: "read /proc/1/environ for secrets", source: procEnviron, expect: { kind: "safe" } },
  { id: "setuid-root", title: "setuid(0)", source: setuidRoot, expect: { kind: "safe" } },
  { id: "sleep-3h", title: "3-hour sleep (wall net)", source: sleepLong, expect: { kind: "verdict", verdict: "TLE", idle: true }, cpuMs: 1_000 },
  { id: "io-uring", title: "io_uring_setup syscall", source: ioUring, expect: { kind: "safe" } },
  { id: "cross-box", title: "read another box / escape via ..", source: crossBox, expect: { kind: "safe" } },
];

/** What a single fixture run observed, from the sandbox and (for fork-bomb) the host. */
export interface FixtureObservation {
  verdict: Verdict;
  stdout: string;
  idle?: boolean;
  /** Present only for fixtures with requireHostClean. */
  hostResidue?: {
    /** Processes still running as the box uid on the host after cleanup. */
    boxUidProcesses: number;
    /** The box cgroup still exists with member processes. */
    cgroupPopulated: boolean;
  };
}

export interface FixtureVerdict {
  id: string;
  ok: boolean;
  /** Present when ok is false. */
  reason?: string;
}

/** PURE: does this observation match the fixture's asserted expectation? */
export function evaluateFixture(fixture: SelfCheckFixture, obs: FixtureObservation): FixtureVerdict {
  const fail = (reason: string): FixtureVerdict => ({ id: fixture.id, ok: false, reason });

  if (obs.stdout.includes("BREACH")) return fail(`printed BREACH: ${obs.stdout.trim().slice(0, 120)}`);

  if (fixture.expect.kind === "safe") {
    if (obs.verdict !== "AC") return fail(`expected a clean exit, got ${obs.verdict}`);
    if (!obs.stdout.includes("SAFE")) return fail(`expected SAFE in the output, got ${obs.stdout.trim().slice(0, 120) || "(nothing)"}`);
  } else {
    if (obs.verdict !== fixture.expect.verdict) return fail(`expected ${fixture.expect.verdict}, got ${obs.verdict}`);
    if (fixture.expect.idle && obs.idle !== true) return fail("expected a wall-clock (idle) time limit, but the CPU was not idle");
  }

  if (fixture.requireHostClean) {
    if (!obs.hostResidue) return fail("host residue was not checked for a fixture that requires it");
    if (obs.hostResidue.boxUidProcesses > 0) return fail(`${obs.hostResidue.boxUidProcesses} process(es) with the box uid survived on the host`);
    if (obs.hostResidue.cgroupPopulated) return fail("the box cgroup still had member processes after cleanup");
  }

  return { id: fixture.id, ok: true };
}

/** PURE: roll the per-fixture verdicts into the heartbeat selfCheck report. */
export function summarizeSelfCheck(verdicts: readonly FixtureVerdict[], at: string): { ok: boolean; at: string; failures: string[] } {
  const failures = verdicts.filter((v) => !v.ok).map((v) => `${v.id}: ${v.reason ?? "failed"}`);
  return { ok: failures.length === 0, at, failures };
}
