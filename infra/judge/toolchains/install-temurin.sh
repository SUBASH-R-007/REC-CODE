#!/usr/bin/env bash
# Install the pinned Eclipse Temurin JDK into /opt/toolchains/temurin-21.0.4+7
# (java21; also the JVM that Kotlin compiles and runs on) and build its AppCDS
# archive lib/recx-appcds.jsa.
#
# Source: the official Adoptium release tarball. Its sha256 is pinned below
# AND cross-checked against the .sha256.txt Adoptium publishes next to it, so
# a changed upstream artifact or a tampered download both stop the install.
#
# The AppCDS archive is dumped with exactly the JVM options the catalog runs
# with (-XX:+UseSerialGC -XX:ActiveProcessorCount=1) from the class list of a
# representative competitive-programming program (buffered I/O, Scanner,
# StringTokenizer, collections, streams, lambdas, String.format), so those
# JDK classes are mapped from the archive instead of being parsed and
# verified on every run. The catalog passes -Xshare:auto: a JVM that cannot
# map the archive still runs, only slower. verify-toolchains.sh proves the
# archive maps inside a box (-Xshare:on).
#
# Idempotent; run as root. A toolchain upgrade is a NEW directory and a NEW
# LanguageConfig row, never an in-place change to this one.
set -euo pipefail

ID="temurin-21.0.4+7"
VERSION="21.0.4+7"
PREFIX="/opt/toolchains/${ID}"
TARBALL="OpenJDK21U-jdk_x64_linux_hotspot_21.0.4_7.tar.gz"
URL="https://github.com/adoptium/temurin21-binaries/releases/download/jdk-21.0.4%2B7/${TARBALL}"
# Adoptium's published value (${TARBALL}.sha256.txt), pinned 2026-10-10.
SHA256="51fb4d03a4429c39d397d3a03a779077159317616550e4e71624c9843083e7b9"
# Must equal the run flags of java21 / kotlin20 in packages/shared/src/languages.ts.
JVM_FLAGS=(-XX:+UseSerialGC -XX:ActiveProcessorCount=1)
JSA="lib/recx-appcds.jsa"

if [[ $EUID -ne 0 ]]; then
  echo "install-temurin.sh must run as root" >&2
  exit 1
fi

installed() {
  [[ -x "$PREFIX/bin/java" && -x "$PREFIX/bin/javac" && -f "$PREFIX/$JSA" ]] &&
    "$PREFIX/bin/java" -version 2>&1 | grep -q "build ${VERSION}" &&
    "$PREFIX/bin/java" "${JVM_FLAGS[@]}" -XX:SharedArchiveFile="$PREFIX/$JSA" -Xshare:on -version >/dev/null 2>&1
}
if installed; then
  echo "temurin ${VERSION} (+ AppCDS archive) already installed at ${PREFIX}"
  exit 0
fi

need=()
command -v curl >/dev/null || need+=(curl)
[[ -e /etc/ssl/certs/ca-certificates.crt ]] || need+=(ca-certificates)
if ((${#need[@]})); then
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -qq
  apt-get install -y -qq "${need[@]}" >/dev/null
fi

mkdir -p /opt/toolchains
work="$(mktemp -d /var/tmp/temurin-install.XXXXXX)"
# Staged next to the final path so the last step is one rename: a worker never
# sees a half-installed directory (it offers a language when the directory exists).
stage="$(mktemp -d /opt/toolchains/.staging-temurin.XXXXXX)"
trap 'rm -rf "$work" "$stage"' EXIT

fetch() { curl -fsSL --retry 3 --proto '=https' --tlsv1.2 -o "$2" "$1"; }
fetch "$URL" "$work/$TARBALL"
fetch "${URL}.sha256.txt" "$work/published.sha256.txt"
published="$(awk '{print $1; exit}' "$work/published.sha256.txt")"
if [[ "$published" != "$SHA256" ]]; then
  echo "Adoptium publishes sha256 ${published} for ${TARBALL}, pinned ${SHA256}: refusing" >&2
  exit 1
fi
echo "${SHA256}  $work/${TARBALL}" | sha256sum -c -

tar -xzf "$work/$TARBALL" -C "$stage" --strip-components=1 --no-same-owner
# Not needed to compile or run a submission: JDK sources, jmods (jlink input), man pages.
rm -rf "$stage/lib/src.zip" "$stage/jmods" "$stage/man"
printf 'source=%s\nsha256=%s\n' "$URL" "$SHA256" > "$stage/.recx-provenance"

# ── AppCDS archive ──────────────────────────────────────────────────────────
# Dumped in the staging copy: the JVM locates its runtime image from its own
# path, so the archive stays valid after the rename (checked at the end).
cat > "$work/Main.java" <<'JAVA'
import java.io.*;
import java.math.BigInteger;
import java.util.*;
import java.util.function.*;
import java.util.stream.*;

public class Main {
    public static void main(String[] args) throws IOException {
        BufferedReader br = new BufferedReader(new InputStreamReader(System.in));
        PrintWriter out = new PrintWriter(new BufferedWriter(new OutputStreamWriter(System.out)));
        StringTokenizer st = new StringTokenizer(br.readLine());
        int n = Integer.parseInt(st.nextToken());
        long[] a = new long[n];
        st = new StringTokenizer(br.readLine());
        for (int i = 0; i < n; i++) a[i] = Long.parseLong(st.nextToken());
        Arrays.sort(a);
        List<Long> list = new ArrayList<>();
        for (long x : a) list.add(x);
        Collections.reverse(list);
        Map<Long, Integer> freq = new HashMap<>();
        for (long x : a) freq.merge(x, 1, Integer::sum);
        TreeMap<Long, Integer> sorted = new TreeMap<>(freq);
        Set<Long> seen = new HashSet<>(list);
        Deque<Integer> dq = new ArrayDeque<>();
        PriorityQueue<long[]> pq = new PriorityQueue<>((p, q) -> Long.compare(p[0], q[0]));
        for (int i = 0; i < n; i++) { dq.addLast(i); pq.add(new long[] {a[i], i}); }
        long sum = LongStream.of(a).sum();
        String joined = list.stream().map(String::valueOf).collect(Collectors.joining(" "));
        Function<Long, Long> sq = x -> x * x;
        BigInteger big = BigInteger.valueOf(sum).pow(3);
        StringBuilder sb = new StringBuilder();
        sb.append(joined).append('\n');
        sb.append(String.format("%d %.3f %s%n", sum, sum / (double) Math.max(1, n), big));
        sb.append("first=" + sorted.firstKey() + " distinct=" + seen.size() + " sq=" + sq.apply(a[0]));
        out.println(sb);
        out.println(pq.poll()[0] + " " + dq.pollFirst() + " " + Objects.hash(a[0], n));
        Scanner sc = new Scanner("1 2 3");
        int t = 0;
        while (sc.hasNextInt()) t += sc.nextInt();
        out.println(t);
        out.flush();
    }
}
JAVA
mkdir -p "$work/classes" "$work/empty"
"$stage/bin/javac" "${JVM_FLAGS[@]/#/-J}" -encoding UTF-8 -d "$work/classes" "$work/Main.java"
printf '5\n3 1 4 1 5\n' > "$work/input.txt"
(cd "$work/classes" && "$stage/bin/java" "${JVM_FLAGS[@]}" -Xshare:off \
  -XX:DumpLoadedClassList="$work/classes.lst" -cp . Main < "$work/input.txt" >/dev/null)
# Classes loaded from a directory (the probe's own) cannot be archived; the
# archive holds JDK classes and the lambda forms the probe resolved.
grep -v -E '^(Main|Main\$)' "$work/classes.lst" > "$work/jdk-classes.lst"
# Dumped from an empty directory so the archive records no application class
# path, which a box's "-cp ." then matches.
(cd "$work/empty" && "$stage/bin/java" "${JVM_FLAGS[@]}" -Xshare:dump \
  -XX:SharedClassListFile="$work/jdk-classes.lst" -XX:SharedArchiveFile="$stage/$JSA" >/dev/null)

chown -R root:root "$stage"
chmod -R a-w,a+rX "$stage"
rm -rf "$PREFIX"
mv -T "$stage" "$PREFIX"

# The catalog's run flags must map the archive at its final path (-Xshare:on
# refuses to start otherwise).
(cd "$work/classes" && "$PREFIX/bin/java" "${JVM_FLAGS[@]}" -XX:SharedArchiveFile="$PREFIX/$JSA" \
  -Xshare:on -cp . Main < "$work/input.txt" >/dev/null)
entries="$(wc -l < "$work/jdk-classes.lst")"
echo "temurin ${VERSION} at ${PREFIX}; AppCDS archive $(du -h "$PREFIX/$JSA" | cut -f1) from ${entries} class-list entries"
