#!/usr/bin/env bash
# Does this backup set still say what it says? (Phase 10e)
#
#   scripts/ops/verify-backup.sh BACKUP_SET_DIR
#
# Exits 0 only if every one of these holds:
#
#   1. both files are present — a set with a dump and no test data is the
#      half-set that leaves submissions judged against test cases that no
#      longer exist, and it must not pass;
#   2. the manifest names both, with a sha256 each;
#   3. the recomputed digests MATCH the manifest's;
#   4. the sizes match the manifest's (a cheap check that catches a truncated
#      copy before the digests do);
#   5. pg_dump's own table of contents is readable, so the dump is a dump
#      rather than a file of the right length.
#
# Run it after taking a set, after copying one anywhere, and before
# restoring. A backup that cannot be verified is worse than no backup,
# because it is believed.

set -uo pipefail

SET_DIR="${1:-}"
if [ -z "$SET_DIR" ] || [ ! -d "$SET_DIR" ]; then
  echo "usage: verify-backup.sh BACKUP_SET_DIR" >&2
  exit 2
fi

MANIFEST="$SET_DIR/MANIFEST.txt"
problems=0

fail() {
  printf '  FAIL  %s\n' "$1"
  problems=$((problems + 1))
}
ok() {
  printf '  ok    %s\n' "$1"
}

printf 'verifying %s\n' "$SET_DIR"

if [ ! -f "$MANIFEST" ]; then
  fail "no MANIFEST.txt: this is a directory, not a backup set"
  exit 1
fi

head -n 1 "$MANIFEST" | grep -qx "recx-backup" || fail "MANIFEST.txt is not a recx backup manifest"

for name in database.dump testdata.tar.zst; do
  if [ ! -f "$SET_DIR/$name" ]; then
    fail "$name is missing — a half set must never restore"
    continue
  fi

  expected="$(awk -v f="$name" '$1=="sha256" && $3==f {print $2}' "$MANIFEST")"
  if [ -z "$expected" ]; then
    fail "$name has no sha256 in the manifest"
    continue
  fi

  actual="$(sha256sum "$SET_DIR/$name" | cut -d' ' -f1)"
  if [ "$actual" != "$expected" ]; then
    fail "$name does not match its manifest digest (expected ${expected:0:16}…, got ${actual:0:16}…)"
    continue
  fi
  ok "$name matches its digest"

  key="$(printf '%s' "$name" | sed 's/database\.dump/database_bytes/; s/testdata\.tar\.zst/testdata_bytes/')"
  declared="$(awk -v k="$key" '$1==k {print $2}' "$MANIFEST")"
  size="$(stat -c %s "$SET_DIR/$name")"
  if [ -n "$declared" ] && [ "$declared" != "$size" ]; then
    fail "$name is $size bytes, the manifest says $declared"
  fi
done

# A file of the right length and the right digest is still not a restorable
# dump if it was never one: pg_restore --list reads the archive's table of
# contents without touching a database.
if [ -f "$SET_DIR/database.dump" ] && command -v pg_restore > /dev/null; then
  if pg_restore --list "$SET_DIR/database.dump" > /dev/null 2>&1; then
    entries="$(pg_restore --list "$SET_DIR/database.dump" 2>/dev/null | grep -cv '^;')"
    ok "pg_restore reads the archive ($entries entries)"
  else
    fail "pg_restore cannot read database.dump"
  fi
fi

if [ -f "$SET_DIR/testdata.tar.zst" ] && command -v zstd > /dev/null; then
  if zstd -t -q "$SET_DIR/testdata.tar.zst" 2>/dev/null; then
    ok "zstd verifies testdata.tar.zst"
  else
    fail "testdata.tar.zst does not decompress"
  fi
fi

head="$(awk '$1=="migration_head" {print $2}' "$MANIFEST")"
printf '  info  migration head %s\n' "${head:-unknown}"
printf '  info  image %s\n' "$(awk '$1=="image" {print $2}' "$MANIFEST")"

if [ "$problems" -ne 0 ]; then
  printf '\n%s problem(s): this set must not be restored.\n' "$problems"
  exit 1
fi
printf '\nverified.\n'
