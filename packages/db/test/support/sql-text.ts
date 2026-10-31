/**
 * Read migration SQL the way PostgreSQL tokenises it: line and (nested)
 * block comments, single-quoted and E'' strings, quoted identifiers and
 * dollar-quoted strings with any tag ($$, $fn$, $body$ …). Used by the
 * static guard fence (frozen-coverage.test.ts) so a comment cannot hide or
 * fake a statement and a dollar tag cannot hide a function body.
 */

interface Piece {
  kind: "code" | "comment" | "quoted";
  text: string;
  /** Dollar-quoted strings only: the text between the opening and closing tag. */
  dollarBody?: string;
}

const IDENT_CHAR = /[A-Za-z0-9_$\u0080-￿]/;
const DOLLAR_TAG = /^\$(?:[A-Za-z_\u0080-￿][A-Za-z0-9_\u0080-￿]*)?\$/;

function lex(sql: string): Piece[] {
  const pieces: Piece[] = [];
  let code = "";
  const flush = () => {
    if (code) pieces.push({ kind: "code", text: code });
    code = "";
  };
  let i = 0;
  const n = sql.length;
  while (i < n) {
    const c = sql[i]!;
    const prev = i > 0 ? sql[i - 1]! : "";
    if (c === "-" && sql[i + 1] === "-") {
      const end = sql.indexOf("\n", i);
      const stop = end === -1 ? n : end;
      flush();
      pieces.push({ kind: "comment", text: sql.slice(i, stop) });
      i = stop;
      continue;
    }
    if (c === "/" && sql[i + 1] === "*") {
      let depth = 1;
      let j = i + 2;
      while (j < n && depth > 0) {
        if (sql.startsWith("/*", j)) {
          depth++;
          j += 2;
        } else if (sql.startsWith("*/", j)) {
          depth--;
          j += 2;
        } else {
          j++;
        }
      }
      flush();
      pieces.push({ kind: "comment", text: sql.slice(i, j) });
      i = j;
      continue;
    }
    if (c === "'") {
      // E'…' strings take backslash escapes; '' is a quote in every string.
      const escapes = /[eE]/.test(prev) && !IDENT_CHAR.test(i > 1 ? sql[i - 2]! : "");
      let j = i + 1;
      while (j < n) {
        if (escapes && sql[j] === "\\") {
          j += 2;
          continue;
        }
        if (sql[j] === "'") {
          if (sql[j + 1] === "'") {
            j += 2;
            continue;
          }
          break;
        }
        j++;
      }
      const stop = Math.min(j + 1, n);
      flush();
      pieces.push({ kind: "quoted", text: sql.slice(i, stop) });
      i = stop;
      continue;
    }
    if (c === '"') {
      let j = i + 1;
      while (j < n) {
        if (sql[j] === '"') {
          if (sql[j + 1] === '"') {
            j += 2;
            continue;
          }
          break;
        }
        j++;
      }
      const stop = Math.min(j + 1, n);
      code += sql.slice(i, stop); // a quoted identifier is code, not a string
      i = stop;
      continue;
    }
    if (c === "$" && !IDENT_CHAR.test(prev)) {
      const tag = DOLLAR_TAG.exec(sql.slice(i, i + 200))?.[0];
      if (tag) {
        const end = sql.indexOf(tag, i + tag.length);
        const stop = end === -1 ? n : end + tag.length;
        flush();
        pieces.push({ kind: "quoted", text: sql.slice(i, stop), dollarBody: sql.slice(i + tag.length, end === -1 ? n : end) });
        i = stop;
        continue;
      }
    }
    code += c;
    i++;
  }
  flush();
  return pieces;
}

/** `sql` with every comment replaced by a space; strings, identifiers and dollar-quoted bodies kept verbatim. */
export function stripSqlComments(sql: string): string {
  return lex(sql)
    .map((p) => (p.kind === "comment" ? " " : p.text))
    .join("");
}

/** Top-level statements (split at `;` outside strings, identifiers and comments), trimmed, without the `;`. */
export function splitSqlStatements(sql: string): string[] {
  const statements: string[] = [];
  let current = "";
  for (const piece of lex(sql)) {
    if (piece.kind === "comment") {
      current += " ";
      continue;
    }
    if (piece.kind === "quoted") {
      current += piece.text;
      continue;
    }
    const parts = piece.text.split(";");
    current += parts[0]!;
    for (const part of parts.slice(1)) {
      statements.push(current.trim());
      current = part;
    }
  }
  statements.push(current.trim());
  return statements.filter((s) => s.length > 0);
}

/** The bodies of the dollar-quoted strings in `sql` (any tag), in order. */
export function dollarQuotedBodies(sql: string): string[] {
  return lex(sql)
    .filter((p) => p.dollarBody !== undefined)
    .map((p) => p.dollarBody!);
}

/** Lower-cased with whitespace and parentheses removed: compares WHEN predicates written in different styles. */
export function normalizePredicate(predicate: string): string {
  return predicate.replace(/[\s()]+/g, "").toLowerCase();
}
