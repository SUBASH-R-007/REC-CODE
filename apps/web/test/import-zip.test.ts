import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildZip, packageFiles, type ZipEntry } from "./support/zip";

/**
 * The zip side of bulk import (yauzl): problem directories are grouped and
 * read one at a time, one wrapping folder is unwrapped, and every unsafe or
 * damaged entry fails only its own problem directory — except damage to the
 * archive as a whole (not a zip), which is an ArchiveError.
 */
const { ArchiveEntryError, ArchiveError, openDirectoryArchive, openZipArchive, unsafePathReason } = await import(
  "@/lib/authoring/import/archive"
);

let dir = "";
beforeAll(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "recx-zip-test-"));
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

let n = 0;
async function zipFile(entries: readonly ZipEntry[]): Promise<string> {
  const file = path.join(dir, `a${++n}.zip`);
  await writeFile(file, buildZip(entries));
  return file;
}

function problemEntries(prefix: string, slug: string, code: number, overrides: Record<string, string | Buffer | null> = {}): ZipEntry[] {
  return Object.entries(packageFiles(slug, code, overrides)).map(([name, data]) => ({ name: `${prefix}${slug}/${name}`, data }));
}

async function readError(archive: Awaited<ReturnType<typeof openZipArchive>>, entry: string): Promise<string> {
  try {
    await archive.read(entry);
    return "no error";
  } catch (error) {
    expect(error).toBeInstanceOf(ArchiveEntryError);
    return (error as InstanceType<typeof ArchiveEntryError>).issues.map((i) => `${i.path}: ${i.message}`).join("\n");
  }
}

describe("openZipArchive", () => {
  it("groups files by problem directory and reads one directory on demand", async () => {
    const archive = await openZipArchive(await zipFile([...problemEntries("", "alpha", 1), ...problemEntries("", "beta", 2, {})]));
    expect(archive.entries).toEqual(["alpha", "beta"]);
    const files = await archive.read("beta");
    expect(files.get("statement.md")?.toString("utf8")).toMatch(/beta/);
    expect(files.get("testcases/000.in")?.toString("utf8")).toBe("alpha2\n");
    await archive.close();
  });

  it("unwraps one wrapping folder, but not a single problem directory", async () => {
    const wrapped = await openZipArchive(await zipFile([...problemEntries("batch/", "alpha", 1), ...problemEntries("batch/", "beta", 2)]));
    expect(wrapped.entries).toEqual(["alpha", "beta"]);
    await wrapped.close();
    const single = await openZipArchive(await zipFile(problemEntries("", "alpha", 1)));
    expect(single.entries).toEqual(["alpha"]);
    await single.close();
  });

  it("reads stored (uncompressed) entries", async () => {
    const archive = await openZipArchive(await zipFile(problemEntries("", "alpha", 1).map((e) => ({ ...e, method: 0 as const }))));
    expect((await archive.read("alpha")).get("meta.json")?.toString("utf8")).toMatch(/"slug": "alpha"/);
    await archive.close();
  });

  it("fails only the directory with a corrupt file (CRC or deflate damage)", async () => {
    const archive = await openZipArchive(
      await zipFile([
        ...problemEntries("", "alpha", 1),
        ...problemEntries("", "beta", 2).map((e) => (e.name.endsWith("statement.md") ? { ...e, badCrc: true } : e)),
        ...problemEntries("", "gamma", 3).map((e) => (e.name.endsWith("solutions/model.cpp") ? { ...e, corrupt: true } : e)),
      ]),
    );
    expect(await archive.read("alpha")).toBeInstanceOf(Map);
    expect(await readError(archive, "beta")).toMatch(/statement\.md: The file is corrupt \(CRC-32 mismatch\)/);
    expect(await readError(archive, "gamma")).toMatch(/solutions\/model\.cpp:/);
    await archive.close();
  });

  it("refuses an entry whose declared size lies", async () => {
    const archive = await openZipArchive(
      await zipFile(problemEntries("", "alpha", 1).map((e) => (e.name.endsWith("statement.md") ? { ...e, declaredSize: 3 } : e))),
    );
    expect(await readError(archive, "alpha")).toMatch(/statement\.md:/);
    await archive.close();
  });

  it("refuses a declared size over the per-file cap without reading it", async () => {
    const archive = await openZipArchive(
      await zipFile(problemEntries("", "alpha", 1).map((e) => (e.name.endsWith("statement.md") ? { ...e, declaredSize: 65 * 1024 * 1024 } : e))),
    );
    expect(await readError(archive, "alpha")).toMatch(/Unsafe path: declares 68157440 bytes/);
    await archive.close();
  });

  it("refuses traversal, backslashes, symlinks and case-folded duplicates in their own directory", async () => {
    const archive = await openZipArchive(
      await zipFile([
        ...problemEntries("", "alpha", 1),
        { name: "bad1/../../etc/passwd", data: "x" },
        { name: "bad2/a\\b.txt", data: "x" },
        { name: "bad3/link", data: "/etc/passwd", unixMode: 0o120777 },
        ...problemEntries("", "bad4", 4),
        { name: "bad4/Statement.MD", data: "dup" },
      ]),
    );
    expect(await archive.read("alpha")).toBeInstanceOf(Map);
    expect(await readError(archive, "bad1")).toMatch(/Unsafe path: contains a "\.\." segment/);
    expect(await readError(archive, "bad2")).toMatch(/Unsafe path: contains a backslash/);
    expect(await readError(archive, "bad3")).toMatch(/Unsafe path: is a symbolic link/);
    expect(await readError(archive, "bad4")).toMatch(/Duplicate file name/);
    await archive.close();
  });

  it("is an ArchiveError when the file is not a zip at all", async () => {
    const file = path.join(dir, "not-a-zip.zip");
    await writeFile(file, "this is not a zip archive");
    await expect(openZipArchive(file)).rejects.toBeInstanceOf(ArchiveError);
  });
});

describe("unsafePathReason", () => {
  it("names the reason", () => {
    expect(unsafePathReason("a/b.txt")).toBeNull();
    expect(unsafePathReason("/abs")).toMatch(/absolute/);
    expect(unsafePathReason("C:/x")).toMatch(/absolute/);
    expect(unsafePathReason("a/../b")).toMatch(/\.\./);
    expect(unsafePathReason("a//b")).toMatch(/empty/);
    expect(unsafePathReason("a\u0000b")).toMatch(/NUL/);
  });
});

describe("openDirectoryArchive (CLI)", () => {
  it("reads a directory of problem directories, and a single problem directory", async () => {
    const root = path.join(dir, "tree");
    for (const [slug, code] of [
      ["alpha", 1],
      ["beta", 2],
    ] as const) {
      for (const [name, data] of Object.entries(packageFiles(slug, code))) {
        const file = path.join(root, slug, ...name.split("/"));
        await mkdir(path.dirname(file), { recursive: true });
        await writeFile(file, data);
      }
    }
    const archive = await openDirectoryArchive(root);
    expect(archive.entries).toEqual(["alpha", "beta"]);
    expect((await archive.read("alpha")).get("testcases/001.in")?.toString("utf8")).toBe("beta1-alpha\n");
    const single = await openDirectoryArchive(path.join(root, "beta"));
    expect(single.entries).toEqual(["beta"]);
    expect((await single.read("beta")).has("meta.json")).toBe(true);
  });
});
