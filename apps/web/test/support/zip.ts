import zlib from "node:zlib";

/**
 * A minimal zip writer for tests (no new dev dependency): stored or
 * deflated entries, with knobs to lie about sizes, break the CRC, set a
 * symbolic-link mode or flip compressed bytes — the archive defects the
 * importer must refuse one entry at a time.
 */
export interface ZipEntry {
  name: string;
  data: Buffer | string;
  /** 8 = deflate (default), 0 = stored. */
  method?: 0 | 8;
  /** Declared uncompressed size, when it should lie. */
  declaredSize?: number;
  /** Write a wrong CRC-32. */
  badCrc?: boolean;
  /** Unix mode (e.g. 0o120777 for a symlink); made-by is set to Unix. */
  unixMode?: number;
  /** Flip bytes in the middle of the compressed data. */
  corrupt?: boolean;
}

export function buildZip(entries: readonly ZipEntry[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const e of entries) {
    const raw = typeof e.data === "string" ? Buffer.from(e.data, "utf8") : e.data;
    const method = e.method ?? 8;
    let body = method === 8 ? zlib.deflateRawSync(raw) : Buffer.from(raw);
    if (e.corrupt && body.length > 4) {
      body = Buffer.from(body);
      for (let i = 1; i < Math.min(body.length - 1, 9); i++) body[i] = body[i]! ^ 0xa5;
    }
    const crc = (zlib.crc32(raw) ^ (e.badCrc ? 0x5a5a5a5a : 0)) >>> 0;
    const name = Buffer.from(e.name, "utf8");
    const size = e.declaredSize ?? raw.length;
    const flags = 0x0800; // UTF-8 names

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0x5921, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(size, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, name, body);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(e.unixMode !== undefined ? (3 << 8) | 20 : 20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(flags, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0x5921, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(size, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(e.unixMode !== undefined ? (e.unixMode << 16) >>> 0 : 0, 38);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);
    offset += local.length + name.length + body.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);
  return Buffer.concat([...locals, cd, end]);
}

/** The files of one valid STDIN problem package (format 1), keyed by path inside its directory. */
export function packageFiles(slug: string, n: number, overrides: Record<string, string | Buffer | null> = {}): Record<string, string | Buffer> {
  const meta = {
    format: 1,
    slug,
    displayCode: `REC-${String(n).padStart(4, "0")}`,
    title: `Imported problem ${n}`,
    difficulty: "EASY",
    topics: ["STRINGS"],
    origin: "FACULTY",
    constraints: ["1 ≤ |w| ≤ 100"],
    ioMode: "STDIN",
    functionSignature: null,
    compareMode: "TOKEN",
    floatEpsilon: null,
    scoringMode: "ICPC",
    stopOnFirstFailure: true,
    timeLimitMs: 1000,
    memoryLimitKb: 262144,
    samples: [0],
    subtasks: [],
    solutions: [
      { file: "solutions/model.cpp", language: "cpp20", expected: "AC", label: "Model" },
      { file: "solutions/echo.py", language: "py312", expected: "WA", label: "Echo" },
    ],
    starters: { py312: "starters/main.py" },
    checker: null,
  };
  const files: Record<string, string | Buffer | null> = {
    "meta.json": JSON.stringify(meta, null, 2),
    "statement.md": `Print the word in upper case. (${slug})`,
    "editorial.md": "### Approach\n\nUpper-case every character.",
    "hints/1.md": "Look at each character.",
    "testcases/000.in": `alpha${n}\n`,
    "testcases/000.out": `ALPHA${n}\n`,
    "testcases/001.in": `beta${n}-${slug}\n`,
    "testcases/001.out": `BETA${n}-${slug.toUpperCase()}\n`,
    "solutions/model.cpp": "#include <iostream>\nint main(){std::string s;std::cin>>s;for(auto&c:s)c=toupper(c);std::cout<<s<<'\\n';}\n",
    "solutions/echo.py": "print(input())\n",
    "starters/main.py": "word = input()\n",
    ...overrides,
  };
  const out: Record<string, string | Buffer> = {};
  for (const [k, v] of Object.entries(files)) if (v !== null) out[k] = v;
  return out;
}

export function asMap(files: Record<string, string | Buffer>): Map<string, Buffer> {
  return new Map(Object.entries(files).map(([k, v]) => [k, typeof v === "string" ? Buffer.from(v, "utf8") : v]));
}
