import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildManifest, writeBundle, type BundleFile, type BundleManifest } from "@/lib/testdata/bundle";
import { prepareBlob } from "@/lib/testdata/blobs";
import { ImmutableKeyError } from "@/lib/testdata/keys";
import { LocalFsStore } from "@/lib/testdata/local-fs";
import { splitUstarName, TarError, writeTar } from "@/lib/testdata/tar";

const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

interface ParsedEntry {
  name: string;
  type: string;
  mode: number;
  mtime: number;
  data: Buffer;
}

/** An independent ustar reader (header checksum verified), used only to check the writer. */
function parseTar(archive: Buffer): ParsedEntry[] {
  expect(archive.byteLength % 512).toBe(0);
  const field = (h: Buffer, offset: number, length: number) =>
    h.subarray(offset, offset + length).toString("latin1").replace(/\0[\s\S]*$/, "");
  const entries: ParsedEntry[] = [];
  let offset = 0;
  for (;;) {
    const header = archive.subarray(offset, offset + 512);
    expect(header.byteLength).toBe(512);
    if (header.every((b) => b === 0)) {
      // End of archive: two zero blocks.
      expect(archive.subarray(offset, offset + 1024).every((b) => b === 0)).toBe(true);
      break;
    }
    let sum = 0;
    for (let i = 0; i < 512; i++) sum += i >= 148 && i < 156 ? 0x20 : header[i]!;
    expect(parseInt(field(header, 148, 8).trim(), 8)).toBe(sum);
    expect(field(header, 257, 6)).toBe("ustar");
    expect(header.subarray(263, 265).toString("latin1")).toBe("00");

    const size = parseInt(field(header, 124, 12), 8);
    const prefix = field(header, 345, 155);
    const name = field(header, 0, 100);
    entries.push({
      name: prefix ? `${prefix}/${name}` : name,
      type: field(header, 156, 1),
      mode: parseInt(field(header, 100, 8), 8),
      mtime: parseInt(field(header, 136, 12), 8),
      data: archive.subarray(offset + 512, offset + 512 + size),
    });
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  return entries;
}

describe("writeTar", () => {
  const longDir = `${"d".repeat(120)}/${"e".repeat(20)}`;
  const entries = [
    { name: "tests/000.in", bytes: Buffer.from("[2,7,11,15]\n9\n") },
    { name: "tests/000.out", bytes: Buffer.from("[0,1]\n") },
    { name: "tests/empty.txt", bytes: new Uint8Array(0) },
    { name: "tests/exact-block.bin", bytes: new Uint8Array(1024).fill(7) },
    { name: "tests/utf8.txt", bytes: Buffer.from("தமிழ் — €😀\n") },
    { name: `${longDir}/${"f".repeat(90)}.in`, bytes: Buffer.from("long path\n") },
  ];

  it("round-trips names, sizes and bytes through an independent parser", () => {
    const parsed = parseTar(writeTar(entries));
    expect(parsed.map((e) => e.name)).toEqual(entries.map((e) => e.name));
    parsed.forEach((p, i) => {
      expect(p.type).toBe("0");
      expect(p.mode).toBe(0o644);
      expect(p.mtime).toBe(0);
      expect(sha(p.data)).toBe(sha(entries[i]!.bytes));
    });
  });

  it("is deterministic", () => {
    expect(writeTar(entries).equals(writeTar(entries))).toBe(true);
  });

  it("writes an empty archive as two zero blocks", () => {
    const empty = writeTar([]);
    expect(empty.byteLength).toBe(1024);
    expect(parseTar(empty)).toEqual([]);
  });

  it("splits long paths into ustar prefix + name", () => {
    expect(splitUstarName("a/b.in")).toEqual({ prefix: "", name: "a/b.in" });
    const split = splitUstarName(`${longDir}/${"f".repeat(90)}.in`);
    expect(split.prefix.length).toBeLessThanOrEqual(155);
    expect(split.name.length).toBeLessThanOrEqual(100);
    expect(() => splitUstarName("x".repeat(300))).toThrow(TarError);
  });

  it.each(["../escape", "/abs/path", "a//b", "a/./b", "a/../b", "", "space name", "tab\tname"])(
    "refuses unsafe name %j",
    (name) => {
      expect(() => writeTar([{ name, bytes: new Uint8Array(1) }])).toThrow(TarError);
    },
  );

  it("refuses duplicate names", () => {
    expect(() =>
      writeTar([
        { name: "a.in", bytes: new Uint8Array(1) },
        { name: "a.in", bytes: new Uint8Array(1) },
      ]),
    ).toThrow(TarError);
  });
});

describe("writeBundle", () => {
  let root: string;
  beforeAll(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "recx-bundle-"));
  });
  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const files: BundleFile[] = [
    { name: "tests/000.in", bytes: Buffer.from("[2,7,11,15]\n9\n"), testIndex: 0, role: "input", isSample: true, subtask: null },
    { name: "tests/000.out", bytes: Buffer.from("[0,1]\n"), testIndex: 0, role: "output", isSample: true, subtask: null },
    { name: "tests/001.in", bytes: Buffer.from("[3,3]\n6\n"), testIndex: 1, role: "input", isSample: false, subtask: 1 },
    { name: "tests/001.out", bytes: Buffer.from("[0,1]\n"), testIndex: 1, role: "output", isSample: false, subtask: 1 },
  ];

  it("writes tests.tar.zst and manifest.json under problems/{id}/v{revision}", async () => {
    const store = new LocalFsStore(root);
    const written = await writeBundle({ problemId: "cmproblem1", revision: 1, files }, store);
    expect(written.bundleKey).toBe("problems/cmproblem1/v1/tests.tar.zst");
    expect(written.manifestKey).toBe("problems/cmproblem1/v1/manifest.json");

    const archive = await store.get(written.bundleKey);
    expect(sha(archive)).toBe(written.bundleSha256);
    const parsed = parseTar(zlib.zstdDecompressSync(archive));
    expect(parsed.map((p) => p.name)).toEqual(files.map((f) => f.name));
    parsed.forEach((p, i) => expect(p.data.equals(files[i]!.bytes)).toBe(true));

    const manifestBytes = await store.get(written.manifestKey);
    expect(sha(manifestBytes)).toBe(written.manifestSha256);
    const manifest = JSON.parse(manifestBytes.toString("utf8")) as BundleManifest;
    expect(manifest.bundle.sha256).toBe(written.bundleSha256);
    expect(manifest.files[2]).toEqual({
      name: "tests/001.in",
      sha256: sha(files[2]!.bytes),
      sizeBytes: files[2]!.bytes.byteLength,
      testIndex: 1,
      role: "input",
      isSample: false,
      subtask: 1,
    });
  });

  it("re-writing the same revision is a no-op; different content needs a new revision", async () => {
    const store = new LocalFsStore(root);
    const first = await writeBundle({ problemId: "cmproblem2", revision: 1, files }, store);
    const again = await writeBundle({ problemId: "cmproblem2", revision: 1, files }, store);
    expect(again.manifestSha256).toBe(first.manifestSha256);

    const changed = files.map((f, i) => (i === 3 ? { ...f, bytes: Buffer.from("[1,0]\n") } : f));
    await expect(writeBundle({ problemId: "cmproblem2", revision: 1, files: changed }, store)).rejects.toThrow(
      ImmutableKeyError,
    );
    const next = await writeBundle({ problemId: "cmproblem2", revision: 2, files: changed }, store);
    expect(next.bundleKey).toBe("problems/cmproblem2/v2/tests.tar.zst");
  });

  it("builds a deterministic manifest", () => {
    const a = buildManifest("p", 3, files, { sha256: "0".repeat(64), sizeBytes: 10 });
    const b = buildManifest("p", 3, files, { sha256: "0".repeat(64), sizeBytes: 10 });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});

describe("prepareBlob", () => {
  it("inlines small UTF-8 text", () => {
    const blob = prepareBlob(Buffer.from("[1,2]\n"));
    expect(blob.inline).toBe("[1,2]\n");
    expect(blob.sizeBytes).toBe(6);
    expect(blob.sha256).toBe(sha(Buffer.from("[1,2]\n")));
  });

  it("does not inline blobs over 64 KB, binary data or NUL bytes", () => {
    expect(prepareBlob(Buffer.alloc(64 * 1024 + 1, 0x61)).inline).toBeNull();
    expect(prepareBlob(Buffer.alloc(64 * 1024, 0x61)).inline).not.toBeNull();
    expect(prepareBlob(Buffer.from([0xff, 0xfe, 0x41])).inline).toBeNull();
    expect(prepareBlob(Buffer.from("a\0b")).inline).toBeNull();
  });
});
