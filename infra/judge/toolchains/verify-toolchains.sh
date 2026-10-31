#!/usr/bin/env bash
# Prove every pinned toolchain works INSIDE isolate exactly as the judge
# worker uses it: for each catalog language, a hello-world is compiled in one
# box and run (with stdin) in a fresh second box, using
#   - the catalog's exact compile/run argv and environment
#     (LANGUAGE_CATALOG, packages/shared/src/languages.ts),
#   - the worker's own isolate command-line builder, binds and limits
#     (buildIsolateArgv, compileLimits, runLimits in apps/judge-worker),
#   - the worker's artifact hand-off (every regular file left at the top of
#     the compile box, executable bit preserved).
# Also checked:
#   - every /opt/toolchains/<id> is root-owned with no writable path;
#   - Java: the AppCDS archive maps inside a box (-Xshare:on), and the CPU
#     time with and without it;
#   - Go: the binary is static (CGO_ENABLED=0), and install-go.sh's
#     cache-free build (bin/recx-go-build) as an extra row "go123*" — a
#     PROPOSED compile argv, reported but never counted as the catalog's
#     result;
#   - testlib: a checker compiled with the worker's checker argv returns the
#     expected exit codes for ok / wa / _pc(37) / fail.
#
# To try a proposed catalog environment change before making it:
#   RECX_VERIFY_EXTRA_ENV="py312:OPENBLAS_NUM_THREADS=1" bash …/verify-toolchains.sh py312
# Such rows are labelled NOT THE CATALOG and the script then exits 3.
#
# Box ids RECX_VERIFY_BOX_BASE .. +99 (default 800-899): outside the range any
# worker slot uses (run 0-99, compile 100-199, checker 200-299).
#
# usage (from a checkout with node_modules installed — the WSL mirror, a CI
# runner, or /opt/recjudge on a judge host):
#   bash infra/judge/toolchains/verify-toolchains.sh              # all languages + testlib
#   bash infra/judge/toolchains/verify-toolchains.sh java21 go123 # a subset
# Root is not required (isolate is setuid); a judge host runs it as root.
set -uo pipefail

REPO="$(cd "$(dirname "$0")/../../.." && pwd)"
BASE="${RECX_VERIFY_BOX_BASE:-800}"
ISOLATE="${RECX_ISOLATE_BIN:-$(command -v isolate || echo /usr/local/bin/isolate)}"
SYNTHETIC_ETC="${RECX_SYNTHETIC_ETC:-/var/lib/recjudge/etc}"
TSX="${TSX:-$REPO/apps/judge-worker/node_modules/.bin/tsx}"

die() { echo "verify-toolchains: $*" >&2; exit 2; }
[[ -x "$ISOLATE" ]] || die "isolate not found (set RECX_ISOLATE_BIN)"
[[ -x "$TSX" ]] || die "tsx not found at $TSX (install the workspace dependencies first)"
[[ -f "$SYNTHETIC_ETC/passwd" ]] || die "synthetic /etc missing at $SYNTHETIC_ETC (run infra/judge/install-isolate.sh)"
(( BASE >= 300 && BASE + 99 <= 999 )) || die "RECX_VERIFY_BOX_BASE must be 300..900"

work="$(mktemp -d /tmp/recx-verify-toolchains.XXXXXX)"
mkdir -p "$work/meta" "$work/src"
chmod 0755 "$work" "$work/meta"
cleanup_boxes() {
  local id
  for ((id = BASE; id < BASE + 100; id++)); do
    [[ -d "/var/local/lib/isolate/$id" ]] && "$ISOLATE" --cg --box-id="$id" --cleanup >/dev/null 2>&1
  done
  rm -rf "$work"
}
trap cleanup_boxes EXIT

# ── The plan: every isolate command line, built by the worker's own code ──
cat > "$work/plan.mts" <<'TS'
import { writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const repo = process.env.RECX_REPO!;
const base = Number(process.env.RECX_VERIFY_BOX_BASE);
const metaDir = process.env.RECX_META_DIR!;
const syntheticEtc = process.env.RECX_SYNTHETIC_ETC!;
const load = (rel: string) => import(pathToFileURL(`${repo}/${rel}`).href);

const shared = await load("packages/shared/src/index.ts");
const { buildIsolateArgv } = await load("apps/judge-worker/src/sandbox/isolate.ts");
const { compileLimits, runLimits, checkerLimits } = await load("apps/judge-worker/src/judge/limits.ts");
const checker = await load("apps/judge-worker/src/judge/checker.ts");
for (const [name, value] of Object.entries({ buildIsolateArgv, compileLimits, runLimits, checkerLimits,
  checkerCompileArgv: checker.checkerCompileArgv, checkerToolchainIds: checker.checkerToolchainIds, CHECKER_ARGV: checker.CHECKER_ARGV })) {
  if (value === undefined) throw new Error(`the judge worker no longer exports ${name}: update infra/judge/toolchains/verify-toolchains.sh`);
}

const q = (s: string) => `'${s.replaceAll("'", `'\\''`)}'`;
const arr = (name: string, items: readonly string[]) => `${name}=(${items.map(q).join(" ")})`;
const out: string[] = [];
const meta = (box: number) => `${metaDir}/box-${box}.meta`;
const MEMORY_KB = shared.LIMITS.memory.defaultKb;

// RECX_VERIFY_EXTRA_ENV="py312:NAME=value go123:NAME=value": try a proposed
// catalog environment change before making it. Reported loudly as NOT the catalog.
const extraEnv = new Map<string, Record<string, string>>();
for (const item of (process.env.RECX_VERIFY_EXTRA_ENV ?? "").split(/\s+/).filter(Boolean)) {
  // Mixed case after the first character: .NET's knobs are spelled that way.
  const m = /^([a-z0-9]+):([A-Z_][A-Za-z0-9_]*)=(.*)$/.exec(item);
  if (!m) throw new Error(`RECX_VERIFY_EXTRA_ENV item ${JSON.stringify(item)} is not lang:NAME=value`);
  extraEnv.set(m[1]!, { ...extraEnv.get(m[1]!), [m[2]!]: m[3]! });
}

const keys: string[] = [...shared.LANGUAGE_KEYS];
out.push(arr("LANGS", keys));
keys.forEach((key, i) => {
  const catalogRt = shared.LANGUAGE_CATALOG[key];
  const extra = extraEnv.get(key);
  const rt = extra ? { ...catalogRt, env: { ...catalogRt.env, ...extra } } : catalogRt;
  out.push(`EXTRA_${key}=${q(extra ? Object.entries(extra).map(([k, v]) => `${k}=${v}`).join(" ") : "")}`);
  const compileBox = base + 2 * i;
  const runBox = compileBox + 1;
  const toolchainIds = [rt.toolchainId, ...rt.extraToolchainIds];
  // A problem whose base (C++) limit is 1 s, at this language's fallback limit.
  const timeLimitMs = shared.fallbackTimeLimitMs(1000, rt.fallbackMultiplier, rt.fallbackExtraMs);
  const run = (argv: readonly string[]) =>
    buildIsolateArgv({
      action: "run", boxId: runBox, metaFile: meta(runBox), syntheticEtc, toolchainIds, env: rt.env,
      limits: runLimits({ timeLimitMs, memoryLimitKb: MEMORY_KB, language: rt }),
      stdin: "input.txt", stdout: "output.txt", stderr: "error.txt", argv,
    });
  out.push(`SRC_${key}=${q(rt.sourceFile)}`, `BOXC_${key}=${compileBox}`, `BOXR_${key}=${runBox}`,
    `TL_${key}=${timeLimitMs}`, arr(`TC_${key}`, toolchainIds));
  out.push(arr(`COMPILE_${key}`, rt.compile === null ? [] : buildIsolateArgv({
    action: "run", boxId: compileBox, metaFile: meta(compileBox), syntheticEtc, toolchainIds, env: rt.env,
    limits: compileLimits(rt), stdin: null, stdout: "compile.stdout", stderr: "compile.stderr", argv: rt.compile.argv,
  })));
  out.push(arr(`RUN_${key}`, run(rt.run.argv)));
  if (key === "java21") {
    const variant = (flag: string) => rt.run.argv.map((a: string) => (a === "-Xshare:auto" ? flag : a));
    if (!rt.run.argv.includes("-Xshare:auto")) throw new Error("java21 run argv has no -Xshare:auto to vary");
    out.push(arr("RUN_java21_cds_on", run(variant("-Xshare:on"))), arr("RUN_java21_cds_off", run(variant("-Xshare:off"))));
  }
  if (key === "go123") {
    // install-go.sh's cache-free build (prebuilt standard library): reported
    // as a separate PROPOSED row, never as the catalog's result.
    const argv = [`${shared.TOOLCHAIN_ROOT}/${rt.toolchainId}/bin/recx-go-build`];
    out.push(arr("PROPOSED_COMPILE_go123", buildIsolateArgv({
      action: "run", boxId: compileBox, metaFile: meta(compileBox), syntheticEtc, toolchainIds, env: rt.env,
      limits: compileLimits({ ...rt, compile: { argv, slow: false } }), stdin: null,
      stdout: "compile.stdout", stderr: "compile.stderr", argv,
    })));
  }
});

// testlib checker, compiled and run exactly as the worker does it.
const testlibId = process.env.RECX_TESTLIB_ID!;
const checkerCompileBox = base + 40;
const checkerRunBox = base + 41;
const ccArgv: string[] = checker.checkerCompileArgv({ testlibId });
out.push(`CHK_TESTLIB=${q(testlibId)}`, `CHK_BOXC=${checkerCompileBox}`, `CHK_BOXR=${checkerRunBox}`,
  `CHK_SOURCE=${q(ccArgv[ccArgv.length - 1]!)}`, `CHK_BINARY=${q(ccArgv[ccArgv.indexOf("-o") + 1]!)}`);
out.push(arr("CHK_COMPILE", buildIsolateArgv({
  action: "run", boxId: checkerCompileBox, metaFile: meta(checkerCompileBox), syntheticEtc,
  toolchainIds: checker.checkerToolchainIds({ testlibId }), env: shared.LANGUAGE_CATALOG.cpp20.env,
  limits: compileLimits({ compile: { argv: ccArgv, slow: true }, openFiles: shared.LANGUAGE_CATALOG.cpp20.openFiles }),
  stdin: null, stdout: "compile.stdout", stderr: "compile.stderr", argv: ccArgv,
})));
out.push(arr("CHK_RUN", buildIsolateArgv({
  // A static checker needs nothing from PATH; the worker passes this minimal one.
  action: "run", boxId: checkerRunBox, metaFile: meta(checkerRunBox), syntheticEtc, toolchainIds: [],
  env: { PATH: "/usr/bin:/bin" }, limits: checkerLimits(), stdin: null,
  stdout: "checker.stdout", stderr: "checker.stderr", argv: [...checker.CHECKER_ARGV],
})));

writeFileSync(process.env.RECX_PLAN_OUT!, out.join("\n") + "\n");
TS

RECX_REPO="$REPO" RECX_VERIFY_BOX_BASE="$BASE" RECX_META_DIR="$work/meta" RECX_SYNTHETIC_ETC="$SYNTHETIC_ETC" \
  RECX_TESTLIB_ID="${RECX_TESTLIB_ID:-testlib-0.9.41}" RECX_PLAN_OUT="$work/plan.sh" \
  "$TSX" "$work/plan.mts" || die "could not build the plan from the catalog and the worker's argv builder"
# shellcheck disable=SC1091
source "$work/plan.sh"

# ── Hello-world sources: read "REC 40 2" from stdin, print "Hello, REC! 42" ──
INPUT="REC 40 2"
EXPECTED="Hello, REC! 42"
cat > "$work/src/c17" <<'SRC'
#include <stdio.h>
int main(void) {
    char name[64];
    long a, b;
    if (scanf("%63s %ld %ld", name, &a, &b) != 3) return 1;
    printf("Hello, %s! %ld\n", name, a + b);
    return 0;
}
SRC
cat > "$work/src/cpp17" <<'SRC'
#include <bits/stdc++.h>
using namespace std;
int main() {
    ios::sync_with_stdio(false);
    string name;
    long long a, b;
    cin >> name >> a >> b;
    vector<long long> v{a, b};
    cout << "Hello, " << name << "! " << accumulate(v.begin(), v.end(), 0LL) << "\n";
}
SRC
cp "$work/src/cpp17" "$work/src/cpp20"
cat > "$work/src/java21" <<'SRC'
import java.io.*;
import java.util.*;

public class Main {
    public static void main(String[] args) throws IOException {
        BufferedReader br = new BufferedReader(new InputStreamReader(System.in));
        StringTokenizer st = new StringTokenizer(br.readLine());
        String name = st.nextToken();
        long a = Long.parseLong(st.nextToken()), b = Long.parseLong(st.nextToken());
        System.out.println("Hello, " + name + "! " + (a + b));
    }
}
SRC
cat > "$work/src/py312" <<'SRC'
import sys
import numpy as np

name, a, b = sys.stdin.read().split()
print(f"Hello, {name}! {int(np.int64(a) + np.int64(b))}")
SRC
cat > "$work/src/pypy310" <<'SRC'
import sys

name, a, b = sys.stdin.read().split()
print(f"Hello, {name}! {int(a) + int(b)}")
SRC
cat > "$work/src/node22" <<'SRC'
const [name, a, b] = require("fs").readFileSync(0, "utf8").trim().split(/\s+/);
console.log(`Hello, ${name}! ${BigInt(a) + BigInt(b)}`);
SRC
cat > "$work/src/go123" <<'SRC'
package main

import "fmt"

func main() {
	var name string
	var a, b int64
	fmt.Scan(&name, &a, &b)
	fmt.Printf("Hello, %s! %d\n", name, a+b)
}
SRC
cat > "$work/src/kotlin20" <<'SRC'
fun main() {
    val (name, a, b) = readLine()!!.trim().split(Regex("\\s+"))
    println("Hello, $name! ${a.toLong() + b.toLong()}")
}
SRC
cat > "$work/src/rust180" <<'SRC'
use std::io::{self, Read};

fn main() {
    let mut input = String::new();
    io::stdin().read_to_string(&mut input).expect("stdin");
    let mut it = input.split_whitespace();
    let name = it.next().expect("name");
    let a: i64 = it.next().expect("a").parse().expect("a");
    let b: i64 = it.next().expect("b").parse().expect("b");
    println!("Hello, {}! {}", name, a + b);
}
SRC
cat > "$work/src/cs8" <<'SRC'
using System;

class Program {
    static void Main() {
        var parts = Console.In.ReadToEnd().Split((char[])null, StringSplitOptions.RemoveEmptyEntries);
        long a = long.Parse(parts[1]), b = long.Parse(parts[2]);
        Console.WriteLine($"Hello, {parts[0]}! {a + b}");
    }
}
SRC
cat > "$work/src/checker" <<'SRC'
#include "testlib.h"

int main(int argc, char* argv[]) {
    registerTestlibCmd(argc, argv);
    long long expected = ans.readLong();
    long long got = ouf.readLong();
    if (got == expected) quitf(_ok, "answer is %lld", got);
    if (got == -1) quitf(_pc(37), "partially correct");
    if (got == -3) quitf(_fail, "the checker found a broken test");
    quitf(_wa, "expected %lld, found %lld", expected, got);
}
SRC

# ── isolate helpers ─────────────────────────────────────────────────────────
BOX_DIR=""
box_init() { # <id>: a fresh box (stale one cleaned first); sets BOX_DIR
  local root
  "$ISOLATE" --cg --box-id="$1" --cleanup >/dev/null 2>&1
  root="$("$ISOLATE" --cg --box-id="$1" --init 2>"$work/init.err" | tail -1)" ||
    { echo "isolate --init of box $1 failed: $(cat "$work/init.err")"; return 1; }
  BOX_DIR="$root/box"
}
box_cleanup() { "$ISOLATE" --cg --box-id="$1" --cleanup >/dev/null 2>&1; }
put() { # <box dir> <name> <mode> <source file> — like the worker: create, write, chmod
  install -m "$3" "$4" "$1/$2"
}
meta_get() { sed -n "s/^$2://p" "$1" | head -1; }
# exec_box <array name> <box id> <box dir> <stdout name> <stderr name>: runs
# isolate with the planned argv (capture files pre-created, as the worker does).
# Sets EXIT (isolate's exit code), META, TIME_MS, MEM_KB, STATUS, EXITCODE.
exec_box() {
  local -n argv_ref="$1"
  : > "$3/$4"; : > "$3/$5"; chmod 0644 "$3/$4" "$3/$5"
  META="$work/meta/box-$2.meta"
  rm -f "$META"
  "$ISOLATE" "${argv_ref[@]}" >"$work/isolate.out" 2>"$work/isolate.err"
  EXIT=$?
  STATUS="$(meta_get "$META" status)"
  EXITCODE="$(meta_get "$META" exitcode)"
  local t; t="$(meta_get "$META" time)"
  TIME_MS="$(awk -v t="${t:-0}" 'BEGIN { printf "%d", t * 1000 + 0.5 }')"
  local w; w="$(meta_get "$META" time-wall)"
  WALL_MS="$(awk -v t="${w:-0}" 'BEGIN { printf "%d", t * 1000 + 0.5 }')"
  MEM_KB="$(meta_get "$META" cg-mem)"
  [[ -n "$MEM_KB" ]] || MEM_KB="$(meta_get "$META" max-rss)"
}
describe_failure() { # <box dir> <stdout name> <stderr name>
  echo "    isolate exit ${EXIT}, status '${STATUS:-}', exitcode '${EXITCODE:-}', message '$(meta_get "$META" message)'"
  head -c 1500 "$1/$3" 2>/dev/null | sed 's/^/    stderr| /'
  head -c 600 "$1/$2" 2>/dev/null | sed 's/^/    stdout| /'
  [[ -s "$work/isolate.err" ]] && head -c 600 "$work/isolate.err" | sed 's/^/    isolate| /'
  return 0
}

# ── Toolchain directories: root-owned, nothing writable ─────────────────────
failures=0
codes=()
extra_used=0
declare -A DIR_OK=()
check_dir() {
  local dir="/opt/toolchains/$1" bad
  [[ -n "${DIR_OK[$1]:-}" ]] && return "${DIR_OK[$1]}"
  if [[ ! -d "$dir" ]]; then
    echo "  $1: MISSING ($dir)"; DIR_OK[$1]=1; return 1
  fi
  bad="$(find "$dir" \( ! -type l -perm /222 \) -o ! -user root 2>/dev/null | head -3)"
  if [[ -n "$bad" ]]; then
    echo "  $1: NOT READ-ONLY / ROOT-OWNED: $(echo "$bad" | tr '\n' ' ')"; DIR_OK[$1]=1; return 1
  fi
  DIR_OK[$1]=0
}

selected=("$@")
want() { ((${#selected[@]} == 0)) || [[ " ${selected[*]} " == *" $1 "* ]]; }

echo "REC Code toolchain verification — $(hostname 2>/dev/null), kernel $(uname -r), $("$ISOLATE" --version | head -1)"
echo "boxes ${BASE}-$((BASE + 99)); argv from LANGUAGE_CATALOG via buildIsolateArgv/compileLimits/runLimits"
echo
rows=()
# verify_language <key> <compile argv array name> <row label> <counts toward the result: 1|0> <note prefix>
verify_language() {
  local key="$1" compile_name="$2" label="$3" counts="$4" prefix="$5"
  local src_name="SRC_$key" tl_name="TL_$key" boxc_name="BOXC_$key" boxr_name="BOXR_$key" extra_name="EXTRA_$key"
  local -n tcs="TC_$key" compile_argv="$compile_name"
  local result="PASS" note="" compile_ms="-" run_ms="-" run_kb="-" extra_note="" tc f name got variant cdir rdir vdir
  if [[ -n "${!extra_name}" ]]; then extra_note="[NOT THE CATALOG: +env ${!extra_name}] "; extra_used=1; fi
  for tc in "${tcs[@]}"; do check_dir "$tc" || result="FAIL"; done
  if [[ "$result" == "PASS" ]] && ! box_init "${!boxc_name}"; then result="FAIL"; fi
  if [[ "$result" == "PASS" ]]; then
    # Compile box (or, without a compile step, the source itself is the artifact).
    cdir="$BOX_DIR"
    put "$cdir" "${!src_name}" 0644 "$work/src/$key"
    if [[ ${#compile_argv[@]} -gt 0 ]]; then
      exec_box "$compile_name" "${!boxc_name}" "$cdir" compile.stdout compile.stderr
      compile_ms="${TIME_MS}/${WALL_MS} ms"
      if [[ $EXIT -ne 0 || -n "$STATUS" ]]; then
        result="FAIL"; note="compile failed"
        echo "  $label: compile FAILED"; describe_failure "$cdir" compile.stdout compile.stderr
      fi
    fi
    if [[ "$result" == "PASS" ]] && ! box_init "${!boxr_name}"; then result="FAIL"; fi
    if [[ "$result" == "PASS" ]]; then
      # The worker's hand-off: every regular file at the top of the compile box.
      rdir="$BOX_DIR"
      for f in "$cdir"/*; do
        name="$(basename "$f")"
        [[ -f "$f" && ! -L "$f" && "$name" != compile.stdout && "$name" != compile.stderr ]] || continue
        if [[ -x "$f" ]]; then put "$rdir" "$name" 0755 "$f"; else put "$rdir" "$name" 0644 "$f"; fi
      done
      if [[ "$key" == go123 ]] && readelf -l "$rdir/main" 2>/dev/null | grep -q "Requesting program interpreter"; then
        result="FAIL"; note="go binary is dynamically linked (CGO_ENABLED=0 expected)"
      fi
      printf '%s\n' "$INPUT" > "$work/input.txt"
      put "$rdir" input.txt 0444 "$work/input.txt"
      exec_box "RUN_$key" "${!boxr_name}" "$rdir" output.txt error.txt
      run_ms="${TIME_MS} ms"; run_kb="${MEM_KB:-?} KB"
      got="$(cat "$rdir/output.txt" 2>/dev/null)"
      if [[ $EXIT -ne 0 || -n "$STATUS" || "$got" != "$EXPECTED" ]]; then
        result="FAIL"; note="run: expected '$EXPECTED', got '${got:0:80}'"
        echo "  $label: run FAILED"; describe_failure "$rdir" output.txt error.txt
      elif [[ -s "$rdir/error.txt" ]]; then
        note="stderr: $(head -c 120 "$rdir/error.txt" | tr '\n' ' ')"
      fi
      box_cleanup "${!boxr_name}"

      if [[ "$key" == java21 && "$result" == "PASS" ]]; then
        # The AppCDS archive must map inside a box (-Xshare:on refuses to start otherwise).
        for variant in cds_on cds_off; do
          box_init "${!boxr_name}" || { result="FAIL"; break; }
          vdir="$BOX_DIR"
          for f in "$cdir"/*.class; do put "$vdir" "$(basename "$f")" 0644 "$f"; done
          put "$vdir" input.txt 0444 "$work/input.txt"
          exec_box "RUN_java21_$variant" "${!boxr_name}" "$vdir" output.txt error.txt
          got="$(cat "$vdir/output.txt" 2>/dev/null)"
          if [[ $EXIT -ne 0 || -n "$STATUS" || "$got" != "$EXPECTED" ]]; then
            result="FAIL"; note="AppCDS ${variant}: run failed"
            echo "  java21 (-Xshare:${variant#cds_}): FAILED"; describe_failure "$vdir" output.txt error.txt
          else
            note="${note:+$note; }-Xshare:${variant#cds_} ${TIME_MS} ms"
          fi
          box_cleanup "${!boxr_name}"
        done
      fi
    fi
    box_cleanup "${!boxc_name}"
  fi
  if ((counts)) && [[ "$result" != "PASS" ]]; then failures=$((failures + 1)); fi
  rows+=("$(printf '%-9s %-34s %-6s %-15s %-8s %-10s %-4s %s' "$label" "$(IFS=,; echo "${tcs[*]}")" "${!tl_name}" "$compile_ms" "$run_ms" "$run_kb" "$result" "${prefix}${extra_note}${note}")")
}

for key in "${LANGS[@]}"; do
  want "$key" || continue
  verify_language "$key" "COMPILE_$key" "$key" 1 ""
  if [[ "$key" == go123 ]]; then
    verify_language go123 PROPOSED_COMPILE_go123 "go123*" 0 "[PROPOSED compile argv bin/recx-go-build, not the catalog] "
  fi
done

# ── testlib checker ─────────────────────────────────────────────────────────
if want testlib; then
  chk_result="PASS"; chk_note=""
  check_dir "$CHK_TESTLIB" || chk_result="FAIL"
  check_dir gcc-13.2.0 || chk_result="FAIL"
  if [[ "$chk_result" == "PASS" ]] && ! box_init "$CHK_BOXC"; then chk_result="FAIL"; fi
  if [[ "$chk_result" == "PASS" ]]; then
    cdir="$BOX_DIR"
    put "$cdir" "$CHK_SOURCE" 0644 "$work/src/checker"
    exec_box CHK_COMPILE "$CHK_BOXC" "$cdir" compile.stdout compile.stderr
    chk_compile_ms="${TIME_MS}/${WALL_MS} ms"
    if [[ $EXIT -ne 0 || -n "$STATUS" || ! -f "$cdir/$CHK_BINARY" ]]; then
      chk_result="FAIL"; chk_note="checker compile failed"
      echo "  testlib: checker compile FAILED"; describe_failure "$cdir" compile.stdout compile.stderr
    else
      cp "$cdir/$CHK_BINARY" "$work/checker.bin"
      codes=()
      # output → expected exit code: ok 0, wa 1, _pc(37) 16+37 (PC_BASE_EXIT_CODE=16), fail 3
      for case in "42:0" "41:1" "-1:53" "-3:3"; do
        out="${case%%:*}"; want_code="${case##*:}"
        box_init "$CHK_BOXR" || { chk_result="FAIL"; break; }
        rdir="$BOX_DIR"
        put "$rdir" "$CHK_BINARY" 0755 "$work/checker.bin"
        printf '1\n' > "$work/c.in"; printf '%s\n' "$out" > "$work/c.out"; printf '42\n' > "$work/c.ans"
        put "$rdir" input.txt 0444 "$work/c.in"
        put "$rdir" output.txt 0444 "$work/c.out"
        put "$rdir" answer.txt 0444 "$work/c.ans"
        exec_box CHK_RUN "$CHK_BOXR" "$rdir" checker.stdout checker.stderr
        code="${EXITCODE:-?}"
        codes+=("output ${out} -> exit ${code} ($(head -c 60 "$rdir/checker.stderr" | tr '\n' ' ' | sed 's/ *$//'))")
        if [[ "$code" != "$want_code" || ( "$want_code" == 0 && -n "$STATUS" ) || ( "$want_code" != 0 && "$STATUS" != RE ) ]]; then
          chk_result="FAIL"; chk_note="exit ${code} for output ${out}, expected ${want_code}"
          describe_failure "$rdir" checker.stdout checker.stderr
        fi
        box_cleanup "$CHK_BOXR"
      done
    fi
    box_cleanup "$CHK_BOXC"
  fi
  [[ "$chk_result" == "PASS" ]] || failures=$((failures + 1))
  rows+=("$(printf '%-9s %-34s %-6s %-15s %-8s %-10s %-4s %s' testlib "gcc-13.2.0,$CHK_TESTLIB" - "${chk_compile_ms:--}" - - "$chk_result" "$chk_note")")
fi

echo
printf '%-9s %-34s %-6s %-15s %-8s %-10s %-4s %s\n' LANGUAGE TOOLCHAINS "TL ms" "COMPILE cpu/wall" "RUN cpu" "RUN mem" OK NOTES
printf '%s\n' "${rows[@]}"
if [[ " ${rows[*]} " == *"go123* "* ]]; then
  echo "(go123* is not the catalog: it compiles with install-go.sh's bin/recx-go-build — proposed for the go123 compile argv.)"
fi
if ((${#codes[@]} > 0)); then
  echo
  echo "testlib checker exit codes:"
  printf '  %s\n' "${codes[@]}"
fi
echo
if ((failures > 0)); then
  echo "FAILED: ${failures} toolchain check(s) failed."
  exit 1
fi
if ((extra_used)); then
  echo "PASSED ONLY WITH RECX_VERIFY_EXTRA_ENV — this is NOT a verification of the catalog as it stands."
  exit 3
fi
echo "OK: every selected toolchain compiled and ran inside isolate with the catalog's argv."
