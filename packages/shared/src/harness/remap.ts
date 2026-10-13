import { sanitizeToolOutput, truncateUtf8, utf8Length } from "../sanitize";
import type { HarnessFamily } from "./family";

/**
 * Compile-error and runtime-trace remapping for FUNCTION-mode programs. A
 * hard requirement, not polish: beginners are most of a first-year cohort,
 * and an error pointing at line 147 of a file they never wrote makes the
 * product unusable for them.
 *
 * The student's code sits verbatim inside the generated program, so every
 * location in it shifts by exactly the prelude length. remapDiagnostics():
 *
 *   - maps a location inside the student's code to {displayName}:{line}
 *     (solution.cpp, solution.py, Solution.java);
 *   - labels a location inside generated code "[generated driver code]",
 *     and drops generated-code notes, "required from" lines, instantiation
 *     banners, source excerpts, caret lines and stack frames entirely;
 *   - strips the line numbers of locations in other files (library headers,
 *     JDK classes, Python modules);
 *
 * so NO output line ever shows a line number outside 1..userLineCount (a
 * property the tests check over many fixtures). diagnosticHints() then adds
 * a plain-language hint for each recognisable mistake.
 */

export interface HarnessBuild {
  /** The complete program written to the box. */
  source: string;
  /** 1-based line of the program on which the student's first line sits. */
  userStartLine: number;
  /** Number of lines of student code. */
  userLineCount: number;
  /** Name shown to students in diagnostics instead of the box file name. */
  displayName: string;
  /** Which code generator produced the program (decides the diagnostic formats). */
  family: HarnessFamily;
}

export const GENERATED = "[generated driver code]";
const JUDGE_CALL = "the judge's code that calls your function";

export const GENERATED_CODE_HINT =
  "Hint: some messages point at the judge's code that calls your function. Check that your class is named Solution and that the method's name, parameter types and return type match the starter code.";
export const MAIN_HINT = "Hint: do not write main() — in a function problem the judge supplies it and calls your method.";
export const PUBLIC_CLASS_HINT = "Hint: write `class Solution` without `public` — your class shares the judge's Main.java file.";
export const STDIN_HINT =
  "Hint: your code read standard input. In a function problem the judge reads the input and passes it to your method as arguments.";
export const UNCLOSED_HINT = "Hint: check that every bracket, brace and quote in your code is closed.";
export const duplicateHint = (name: string) => `Hint: the judge already defines ${name}; remove your own definition.`;

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

interface Mapper {
  map(n: number): number | null;
  display: string;
  file: string;
  fileRe: string;
}

function mapperFor(build: HarnessBuild, boxFileName: string): Mapper {
  const first = build.userStartLine;
  const last = build.userStartLine + build.userLineCount - 1;
  return {
    map: (n) => (n >= first && n <= last ? n - first + 1 : null),
    display: build.displayName,
    file: boxFileName,
    fileRe: escapeRegExp(boxFileName),
  };
}

/** Inline mentions of the box file anywhere in a line ("declared at main.cpp:12"). */
function inlineLocations(line: string, m: Mapper): string {
  const located = line.replace(new RegExp(`(^|[\\s'"(])${m.fileRe}:(\\d+)(:\\d+)?`, "g"), (_x, pre: string, ln: string, col?: string) => {
    const mapped = m.map(Number(ln));
    return mapped === null ? `${pre}${GENERATED}` : `${pre}${m.display}:${mapped}${col ?? ""}`;
  });
  return located.replace(new RegExp(`(^|[\\s'"(])${m.fileRe}(?=[:\\s'")]|$)`, "g"), `$1${m.display}`);
}

// ── gcc ─────────────────────────────────────────────────────────────────

const UNCLOSED_AT_END = /expected '}' at end of input/;

function remapGcc(lines: string[], m: Mapper): string[] {
  const out: string[] = [];
  /** Whether excerpt lines under the current header belong to the student's code. */
  let excerpts: "user" | "drop" = "drop";
  let excerptKept = false;
  // "file:line[:col]: message" — a gcc location never contains a space.
  const header = /^(\S+?):(\d+)(?::(\d+))?:(\s*)(.*)$/;
  const banner = /^(\S+): ((?:In |At ).*)$/;
  // The student left a scope open (a missing "}" or "};"): the generated
  // driver then lands inside their class and fails in a cascade of errors
  // about the judge's own code. Keep only "expected '}' at end of input"
  // (and the student-located "to match this '{'" note); drop the rest.
  const unclosed = lines.some((l) => UNCLOSED_AT_END.test(l));

  for (const line of lines) {
    if (/^In file included from /.test(line) || /^\s+from \S+:\d+[,:]?\s*$/.test(line)) continue;

    const excerpt = /^(\s*)(\d+)( \|.*)$/.exec(line);
    if (excerpt) {
      const mapped = excerpts === "user" ? m.map(Number(excerpt[2])) : null;
      excerptKept = mapped !== null;
      if (mapped !== null) out.push(`${excerpt[1]}${String(mapped).padStart(excerpt[2]!.length)}${excerpt[3]}`);
      continue;
    }
    if (/^\s*(?:\+\+\+ )?\|/.test(line)) {
      if (excerptKept) out.push(line);
      continue;
    }
    excerptKept = false;

    const h = header.exec(line);
    if (h && !/^\s/.test(line)) {
      const [, file, ln, col, gap, rest] = h as unknown as [string, string, string, string | undefined, string, string];
      if (file === m.file) {
        const mapped = m.map(Number(ln));
        if (mapped !== null) {
          excerpts = "user";
          out.push(`${m.display}:${mapped}${col ? `:${col}` : ""}:${gap}${inlineLocations(rest, m)}`);
          continue;
        }
        excerpts = "drop";
        if (/^note:/.test(rest) || /required from|In instantiation of/.test(rest)) continue;
        if (unclosed && !UNCLOSED_AT_END.test(rest)) continue;
        out.push(`${GENERATED}: ${inlineLocations(rest, m)}`);
        continue;
      }
      // Another file (a library header, <command-line>): keep the message, never its line numbers.
      excerpts = "drop";
      out.push(`${file}:${gap}${inlineLocations(rest, m)}`);
      continue;
    }

    const b = banner.exec(line);
    if (b) {
      const [, file, rest] = b as unknown as [string, string, string];
      excerpts = "drop";
      if (file === m.file) {
        if (unclosed) continue;
        if (/^In function '(?:int )?main\(\)'/.test(rest) || /^In member function '[^']*::main\(\)'/.test(rest)) {
          out.push(`In ${JUDGE_CALL}:`);
          continue;
        }
        if (/^In instantiation of/.test(rest) && /recx_harness/.test(rest)) continue;
        out.push(`${m.display}: ${rest}`);
        continue;
      }
      out.push(`${file}: ${rest}`);
      continue;
    }
    out.push(inlineLocations(line, m));
  }
  // The harness's own namespace means nothing to a student: strip the
  // qualifier, and drop a line that still names it ("'recx_harness' has not
  // been declared" would only become "'' has not been declared").
  return out.map((l) => l.replace(/\brecx_harness::/g, "")).filter((l) => !/\brecx_harness\b/.test(l));
}

// ── javac and JVM stack traces ──────────────────────────────────────────

function remapJava(lines: string[], m: Mapper): string[] {
  const out: string[] = [];
  const header = new RegExp(`^${m.fileRe}:(\\d+): (.*)$`);
  const frame = /^(\s*at .*\()([^():]+):(\d+)\)\s*$/;
  /** After a header in generated code: drop its source line and caret line. */
  let dropSource = 0;

  for (const line of lines) {
    if (dropSource > 0) {
      dropSource--;
      if (dropSource === 1) continue; // the source line
      if (/^\s*\^\s*$/.test(line)) continue; // the caret line
    }
    const h = header.exec(line);
    if (h) {
      const mapped = m.map(Number(h[1]));
      if (mapped !== null) {
        out.push(`${m.display}:${mapped}: ${h[2]}`);
      } else {
        out.push(`${GENERATED}: ${h[2]}`);
        dropSource = 2;
      }
      continue;
    }
    const f = frame.exec(line);
    if (f) {
      const [, pre, file, ln] = f as unknown as [string, string, string, string];
      if (file === m.file) {
        const mapped = m.map(Number(ln));
        if (mapped !== null) out.push(`${pre}${m.display}:${mapped})`);
        // A generated frame (Main.main, RecxIn…) is dropped.
        continue;
      }
      out.push(`${pre}${file})`);
      continue;
    }
    if (/^\s*location: class Main\s*$/.test(line)) {
      out.push(line.replace(/location: class Main/, `location: ${JUDGE_CALL}`));
      continue;
    }
    out.push(inlineLocations(line, m));
  }
  return out;
}

// ── CPython / PyPy ──────────────────────────────────────────────────────

function remapPython(lines: string[], m: Mapper): string[] {
  const out: string[] = [];
  const frame = /^(\s*)File "([^"]+)", line (\d+)(.*)$/;
  let droppingFrame = false;
  /** The innermost frame so far is the harness's: the error happened in the judge's code. */
  let lastFrameGenerated = false;

  for (const line of lines) {
    const f = frame.exec(line);
    if (f) {
      droppingFrame = false;
      lastFrameGenerated = false;
      const [, indent, rawFile, ln, rest] = f as unknown as [string, string, string, string, string];
      const file = rawFile.replace(/^\/box\//, "");
      if (file === m.file) {
        const mapped = m.map(Number(ln));
        if (mapped !== null) {
          out.push(`${indent}File "${m.display}", line ${mapped}${rest}`);
          continue;
        }
        if (/^, in /.test(rest)) {
          droppingFrame = true; // a harness frame: drop it with its source and caret lines
          lastFrameGenerated = true;
          continue;
        }
        // A syntax error located in the driver: the student's code ended unfinished.
        out.push(`${indent}File "${m.display}", after your last line`);
        droppingFrame = true;
        continue;
      }
      if (file === "<string>") {
        droppingFrame = true; // the judge's compile-check command
        continue;
      }
      out.push(`${indent}File "${rawFile}"${rest}`);
      continue;
    }
    if (droppingFrame && /^ {4,}\S|^\s*$/.test(line) && line.length > 0) continue;
    droppingFrame = false;
    // The exception line of a traceback whose innermost frame is the harness's
    // (a misnamed method, a wrong parameter count): say where it happened.
    if (lastFrameGenerated && /^\S/.test(line)) {
      out.push(`  ${GENERATED}`);
      lastFrameGenerated = false;
    }

    // "IndentationError: expected an indented block after function definition on line 7"
    // "SyntaxError: unterminated string literal (detected at line 6)"
    let text = /^(?:\w+\.)*\w*(?:Error|Warning)\b/.test(line)
      ? line
          .replace(/\bon line (\d+)/g, (_x, ln: string) => {
            const mapped = m.map(Number(ln));
            return mapped === null ? `in ${JUDGE_CALL}` : `on line ${mapped}`;
          })
          .replace(/\(detected at line (\d+)\)/g, (_x, ln: string) => {
            const mapped = m.map(Number(ln));
            return mapped === null ? "(detected after your last line)" : `(detected at line ${mapped})`;
          })
      : line;
    text = text.replace(new RegExp(`\\((?:/box/)?${m.fileRe}, line (\\d+)\\)`, "g"), (_x, ln: string) => {
      const mapped = m.map(Number(ln));
      return mapped === null ? `(${GENERATED})` : `(${m.display}, line ${mapped})`;
    });
    out.push(inlineLocations(text, m));
  }
  return out;
}

/**
 * Remap compiler / interpreter diagnostics from the generated program back
 * to the student's own line numbers (see the module comment). `boxFileName`
 * is the program's file in the box (main.cpp, main.py, Main.java), with any
 * /box/ prefix already removed.
 */
export function remapDiagnostics(output: string, build: HarnessBuild, boxFileName: string): string {
  const m = mapperFor(build, boxFileName);
  const lines = output.replace(/\r\n?/g, "\n").split("\n");
  switch (build.family) {
    case "cpp":
      return remapGcc(lines, m).join("\n");
    case "java":
      return remapJava(lines, m).join("\n");
    case "python":
      return remapPython(lines, m).join("\n");
  }
}

const DUPLICATE = /duplicate class: (ListNode|TreeNode|Pair|Main|RecxIn|RecxOut)\b|redefinition of '(?:struct )?(ListNode|TreeNode)'/;

/** Plain-language hints for recognisable mistakes in already-remapped output, each once. */
export function diagnosticHints(remapped: string): string[] {
  const hints: string[] = [];
  if (remapped.includes(GENERATED) || remapped.includes(JUDGE_CALL)) hints.push(GENERATED_CODE_HINT);
  if (/redefinition of '(?:int )?main\(/.test(remapped) || /duplicate class: Main\b/.test(remapped)) hints.push(MAIN_HINT);
  if (/class Solution is public, should be declared in a file named/.test(remapped)) hints.push(PUBLIC_CLASS_HINT);
  const dup = DUPLICATE.exec(remapped);
  if (dup && (dup[1] ?? dup[2]) !== "Main") hints.push(duplicateHint(dup[1] ?? dup[2]!));
  if (/harness: missing input/.test(remapped)) hints.push(STDIN_HINT);
  if (/at end of input|was never closed|reached end of file while parsing|after your last line|unterminated|EOF while scanning/.test(remapped)) {
    hints.push(UNCLOSED_HINT);
  }
  return hints;
}

/**
 * The student-facing text of a FUNCTION program's tool output: remapped,
 * sanitised (no host paths), capped at maxBytes, with the hints after it —
 * the hints are never truncated away.
 */
export function renderDiagnostics(raw: string, build: HarnessBuild, boxFileName: string, maxBytes: number): string {
  const remapped = remapDiagnostics(raw, build, boxFileName);
  const hints = diagnosticHints(remapped);
  const tail = hints.length > 0 ? `\n\n${hints.join("\n")}` : "";
  const room = Math.max(0, maxBytes - utf8Length(tail));
  const body = sanitizeToolOutput(remapped, room);
  return body.length > 0 ? truncateUtf8(body + tail, maxBytes) : truncateUtf8(tail.trimStart(), maxBytes);
}
