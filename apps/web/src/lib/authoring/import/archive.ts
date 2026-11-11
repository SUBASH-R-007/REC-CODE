import "server-only";
import { lstat, readdir, readFile } from "node:fs/promises";
import path from "node:path";
import zlib from "node:zlib";
import yauzl from "yauzl";
import { IMPORT_LIMITS, PACKAGE_FILES } from "@recx/shared/authoring";
import { AppError } from "@/lib/errors";
import type { PackageFiles, PackageIssue } from "./package";

/**
 * A bulk-import archive, grouped into problem directories. Each directory is
 * read into memory only when its turn comes (never unpacked to disk), so a
 * 300-problem archive costs one problem's worth of memory at a time.
 *
 * The zip reader is yauzl (pure JavaScript; apps/web never spawns
 * processes). Fences, on declared AND actually inflated bytes:
 *   - absolute paths, "..", empty segments, backslashes, NUL, over-long
 *     paths, case-folded duplicates, symlink entries and encrypted entries
 *     are refused;
 *   - IMPORT_LIMITS caps files, bytes per file / directory / archive;
 *   - each inflated file's CRC-32 must match (yauzl does not check it).
 * A problem that breaks a rule fails on its own (ArchiveEntryError → a FAILED
 * row); only damage to the archive as a whole is an ArchiveError.
 */

export interface ProblemArchive {
  /** Problem directory names, sorted. */
  entries: string[];
  /** Archive-level notes (ignored stray files). */
  warnings: PackageIssue[];
  read(entry: string): Promise<PackageFiles>;
  close(): Promise<void>;
}

/** The archive as a whole cannot be imported (not a zip, over a cap, unsafe). */
export class ArchiveError extends AppError {
  constructor(message: string) {
    super(message, 422);
    this.name = "ArchiveError";
  }
}

/** One problem directory cannot be read; the rest of the archive continues. */
export class ArchiveEntryError extends Error {
  constructor(readonly issues: PackageIssue[]) {
    super(issues[0]?.message ?? "The problem directory could not be read.");
    this.name = "ArchiveEntryError";
  }
}

const S_IFMT = 0o170000;
const S_IFLNK = 0o120000;

/** Why an archive path is unsafe, or null. */
export function unsafePathReason(name: string): string | null {
  if (name.includes("\u0000")) return "contains a NUL byte";
  if (name.includes("\\")) return "contains a backslash";
  if (name.startsWith("/") || /^[A-Za-z]:/.test(name)) return "is an absolute path";
  const segments = name.replace(/\/$/, "").split("/");
  if (segments.some((s) => s === "..")) return 'contains a ".." segment';
  if (segments.some((s) => s === "" || s === ".")) return "contains an empty or . segment";
  if (name.length > IMPORT_LIMITS.pathChars + 64) return "is too long";
  return null;
}

interface FileRecord {
  /** Path inside the problem directory, e.g. "testcases/000.in". */
  relative: string;
  declaredBytes: number;
  load: () => Promise<Buffer>;
}

interface Group {
  files: FileRecord[];
  issues: PackageIssue[];
  declaredBytes: number;
}

/** Group archive paths by their problem directory, after unwrapping one wrapping folder. */
function groupFiles(
  names: ReadonlyArray<{ name: string; declaredBytes: number; load: () => Promise<Buffer>; issue: string | null }>,
): { groups: Map<string, Group>; warnings: PackageIssue[] } {
  const files = names.filter((n) => !n.name.endsWith("/"));
  // One wrapping folder ("batch/<slug>/meta.json") is unwrapped; a single
  // problem directory ("<slug>/meta.json") is not.
  const first = new Set(files.map((f) => f.name.split("/")[0]));
  let prefix = "";
  if (first.size === 1 && files.every((f) => f.name.includes("/"))) {
    const only = [...first][0]!;
    if (!files.some((f) => f.name === `${only}/${PACKAGE_FILES.meta}`)) prefix = `${only}/`;
  }
  const groups = new Map<string, Group>();
  const warnings: PackageIssue[] = [];
  const seen = new Map<string, string>();
  for (const f of files) {
    const name = f.name.startsWith(prefix) ? f.name.slice(prefix.length) : f.name;
    const slash = name.indexOf("/");
    if (slash <= 0) {
      warnings.push({ path: f.name, message: "Files outside a problem directory are ignored." });
      continue;
    }
    const dir = name.slice(0, slash);
    const relative = name.slice(slash + 1);
    const group = groups.get(dir) ?? { files: [], issues: [], declaredBytes: 0 };
    groups.set(dir, group);
    if (f.issue) {
      group.issues.push({ path: relative || name, message: `Unsafe path: ${f.issue}.` });
      continue;
    }
    if (relative.length > IMPORT_LIMITS.pathChars) {
      group.issues.push({ path: relative.slice(0, 80), message: `Paths are at most ${IMPORT_LIMITS.pathChars} characters.` });
      continue;
    }
    const folded = name.toLowerCase();
    const clash = seen.get(folded);
    if (clash !== undefined) {
      group.issues.push({ path: relative, message: `Duplicate file name (differs only in case from ${clash}).` });
      continue;
    }
    seen.set(folded, name);
    group.files.push({ relative, declaredBytes: f.declaredBytes, load: f.load });
    group.declaredBytes += f.declaredBytes;
  }
  for (const group of groups.values()) {
    if (group.files.length > IMPORT_LIMITS.filesPerEntry) {
      group.issues.push({ path: "", message: `A problem directory has at most ${IMPORT_LIMITS.filesPerEntry} files.` });
    }
    if (group.declaredBytes > IMPORT_LIMITS.entryBytes) {
      group.issues.push({ path: "", message: `A problem directory holds at most ${IMPORT_LIMITS.entryBytes / 1024 / 1024} MB.` });
    }
  }
  return { groups, warnings };
}

async function readGroup(group: Group | undefined, entry: string): Promise<PackageFiles> {
  if (!group) throw new ArchiveEntryError([{ path: entry, message: "No such problem directory." }]);
  if (group.issues.length > 0) throw new ArchiveEntryError(group.issues);
  const out = new Map<string, Buffer>();
  const issues: PackageIssue[] = [];
  let total = 0;
  for (const f of group.files) {
    try {
      const bytes = await f.load();
      total += bytes.byteLength;
      if (total > IMPORT_LIMITS.entryBytes) {
        issues.push({ path: f.relative, message: `The directory inflates past ${IMPORT_LIMITS.entryBytes / 1024 / 1024} MB.` });
        break;
      }
      out.set(f.relative, bytes);
    } catch (error) {
      issues.push({ path: f.relative, message: error instanceof Error ? error.message : "The file could not be read." });
    }
  }
  if (issues.length > 0) throw new ArchiveEntryError(issues);
  return out;
}

/** Read a stream fully, failing past maxBytes. */
async function collect(stream: NodeJS.ReadableStream, maxBytes: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of stream as AsyncIterable<Buffer>) {
    size += chunk.byteLength;
    if (size > maxBytes) {
      (stream as unknown as { destroy?: () => void }).destroy?.();
      throw new Error(`The file inflates past ${maxBytes} bytes.`);
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, size);
}

export async function openZipArchive(file: string): Promise<ProblemArchive> {
  let zip: yauzl.ZipFile;
  try {
    zip = await yauzl.openPromise(file, {
      lazyEntries: true,
      autoClose: false,
      decodeStrings: false,
      validateEntrySizes: true,
      strictFileNames: true,
    });
  } catch (error) {
    throw new ArchiveError(`This is not a readable zip archive (${error instanceof Error ? error.message : "unknown error"}).`);
  }
  const names: Array<{ name: string; declaredBytes: number; load: () => Promise<Buffer>; issue: string | null }> = [];
  let declaredTotal = 0;
  try {
    for await (const entry of zip.eachEntry()) {
      if (names.length >= IMPORT_LIMITS.archiveFiles) throw new ArchiveError(`An archive holds at most ${IMPORT_LIMITS.archiveFiles} files.`);
      const raw = entry.fileName as unknown as Buffer;
      const name = yauzl.getFileNameLowLevel(entry.generalPurposeBitFlag, raw, entry.extraFields, true);
      let issue = unsafePathReason(name);
      const madeByUnix = entry.versionMadeBy >> 8 === 3;
      if (!issue && madeByUnix && ((entry.externalFileAttributes >>> 16) & S_IFMT) === S_IFLNK) issue = "is a symbolic link";
      if (!issue && entry.isEncrypted()) issue = "is encrypted";
      if (!issue && entry.compressionMethod !== 0 && entry.compressionMethod !== 8) issue = "uses an unsupported compression method";
      if (!issue && entry.uncompressedSize > IMPORT_LIMITS.fileBytes) {
        issue = `declares ${entry.uncompressedSize} bytes (the limit is ${IMPORT_LIMITS.fileBytes})`;
      }
      if (!issue) {
        declaredTotal += entry.uncompressedSize;
        if (declaredTotal > IMPORT_LIMITS.totalUncompressedBytes) {
          throw new ArchiveError(`The archive inflates to more than ${IMPORT_LIMITS.totalUncompressedBytes / 1024 ** 3} GB.`);
        }
      }
      const expectedCrc = entry.crc32;
      const declared = entry.uncompressedSize;
      names.push({
        name: issue && issue.startsWith("contains a NUL") ? name.split("\u0000").join("?") : name,
        declaredBytes: declared,
        issue,
        load: async () => {
          const stream = await zip.openReadStreamPromise(entry);
          const bytes = await collect(stream, Math.min(declared, IMPORT_LIMITS.fileBytes));
          if (zlib.crc32(bytes) >>> 0 !== expectedCrc >>> 0) throw new Error("The file is corrupt (CRC-32 mismatch).");
          return bytes;
        },
      });
    }
  } catch (error) {
    zip.close();
    if (error instanceof ArchiveError) throw error;
    throw new ArchiveError(`The archive's directory is damaged (${error instanceof Error ? error.message : "unknown error"}).`);
  }
  const { groups, warnings } = groupFiles(names);
  if (groups.size > IMPORT_LIMITS.entries) {
    zip.close();
    throw new ArchiveError(`An archive holds at most ${IMPORT_LIMITS.entries} problems (this one has ${groups.size}).`);
  }
  return {
    entries: [...groups.keys()].sort(),
    warnings,
    read: (entry) => readGroup(groups.get(entry), entry),
    close: async () => zip.close(),
  };
}

/**
 * A directory of problem directories (the CLI). A directory that itself
 * holds meta.json is one problem. Symbolic links are refused, never followed.
 */
export async function openDirectoryArchive(root: string): Promise<ProblemArchive> {
  const top = await lstat(root);
  if (!top.isDirectory()) throw new ArchiveError(`${root} is not a directory.`);
  const single = await lstat(path.join(root, PACKAGE_FILES.meta)).then(
    (s) => s.isFile(),
    () => false,
  );
  const base = single ? path.dirname(path.resolve(root)) : path.resolve(root);
  const names: Array<{ name: string; declaredBytes: number; load: () => Promise<Buffer>; issue: string | null }> = [];
  let declaredTotal = 0;

  async function walk(dir: string, rel: string): Promise<void> {
    for (const dirent of await readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, dirent.name);
      const name = rel ? `${rel}/${dirent.name}` : dirent.name;
      if (names.length >= IMPORT_LIMITS.archiveFiles) throw new ArchiveError(`An import holds at most ${IMPORT_LIMITS.archiveFiles} files.`);
      const stat = await lstat(full);
      if (stat.isSymbolicLink()) {
        names.push({ name, declaredBytes: 0, issue: "is a symbolic link", load: async () => Buffer.alloc(0) });
        continue;
      }
      if (stat.isDirectory()) {
        await walk(full, name);
        continue;
      }
      if (!stat.isFile()) continue;
      let issue = unsafePathReason(name);
      if (!issue && stat.size > IMPORT_LIMITS.fileBytes) issue = `is ${stat.size} bytes (the limit is ${IMPORT_LIMITS.fileBytes})`;
      if (!issue) {
        declaredTotal += stat.size;
        if (declaredTotal > IMPORT_LIMITS.totalUncompressedBytes) throw new ArchiveError("The import is larger than the total size limit.");
      }
      names.push({ name, declaredBytes: stat.size, issue, load: () => readFile(full) });
    }
  }
  const startDir = single ? path.resolve(root) : base;
  await walk(startDir, single ? path.basename(path.resolve(root)) : "");
  const { groups, warnings } = groupFiles(names);
  if (groups.size > IMPORT_LIMITS.entries) throw new ArchiveError(`An import holds at most ${IMPORT_LIMITS.entries} problems.`);
  return {
    entries: [...groups.keys()].sort(),
    warnings,
    read: (entry) => readGroup(groups.get(entry), entry),
    close: async () => undefined,
  };
}
