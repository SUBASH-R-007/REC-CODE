/**
 * A cheap, server-side syntax highlighter for read-only source (the full
 * submission page). One regular-expression pass per file; no editor, no
 * client JavaScript. It marks comments, strings, numbers, keywords and
 * preprocessor lines — enough to read code comfortably, not a parser.
 * Unknown languages and very large files come back as one plain token.
 */

export type TokenType = "plain" | "comment" | "string" | "number" | "keyword" | "meta";

export interface Token {
  type: TokenType;
  text: string;
}

/** Above this many characters the source is shown unhighlighted. */
export const HIGHLIGHT_MAX_CHARS = 120_000;

const words = (list: string) => new Set(list.split(/\s+/).filter(Boolean));

const C_KEYWORDS = words(`
  auto break case char const continue default do double else enum extern float for goto if inline int long
  register restrict return short signed sizeof static struct switch typedef union unsigned void volatile while
  bool true false NULL`);
const CPP_KEYWORDS = new Set([
  ...C_KEYWORDS,
  ...words(`
  alignas alignof and asm catch class constexpr consteval constinit const_cast decltype delete dynamic_cast
  explicit export friend mutable namespace new noexcept not nullptr operator or override private protected
  public reinterpret_cast static_assert static_cast template this throw try typeid typename using virtual
  final concept requires co_await co_return co_yield`),
]);
const JAVA_KEYWORDS = words(`
  abstract assert boolean break byte case catch char class const continue default do double else enum extends
  final finally float for goto if implements import instanceof int interface long native new package private
  protected public return short static strictfp super switch synchronized this throw throws transient try void
  volatile while var record sealed permits yield true false null`);
const KOTLIN_KEYWORDS = words(`
  as break class continue do else false for fun if in interface is null object package return super this throw
  true try typealias typeof val var when while by catch constructor companion data enum final finally import
  init inner internal lateinit open operator out override private protected public sealed suspend vararg`);
const JS_KEYWORDS = words(`
  async await break case catch class const continue debugger default delete do else export extends false
  finally for function if import in instanceof let new null of return static super switch this throw true try
  typeof undefined var void while with yield`);
const GO_KEYWORDS = words(`
  break case chan const continue default defer else fallthrough for func go goto if import interface map
  package range return select struct switch type var true false nil iota`);
const PY_KEYWORDS = words(`
  False None True and as assert async await break class continue def del elif else except finally for from
  global if import in is lambda nonlocal not or pass raise return try while with yield match case self`);

/** End of input (for unterminated comments and strings). */
const EOF = "(?![\\s\\S])";
const DQ = String.raw`"(?:[^"\\\n]|\\.)*"?`;
const SQ = String.raw`'(?:[^'\\\n]|\\.)*'?`;
const BLOCK = String.raw`\/\*[\s\S]*?(?:\*\/|${EOF})`;
const NUMBER = String.raw`\b\d[\w.]*`;
const IDENT = String.raw`[A-Za-z_$][\w$]*`;

interface Grammar {
  /** Groups, in order: comment, string, number, identifier, meta (optional). */
  pattern: RegExp;
  keywords: ReadonlySet<string>;
}

function grammar(parts: { comment: string; string: string; meta?: string }, keywords: ReadonlySet<string>): Grammar {
  const meta = parts.meta ? `|(${parts.meta})` : "";
  return {
    pattern: new RegExp(`(${parts.comment})|(${parts.string})|(${NUMBER})|(${IDENT})${meta}`, "gm"),
    keywords,
  };
}

const C_LIKE_COMMENT = String.raw`\/\/[^\n]*|${BLOCK}`;
const PREPROCESSOR = String.raw`^[ \t]*#[^\n]*`;

const GRAMMARS: Readonly<Record<string, Grammar>> = {
  c: grammar({ comment: C_LIKE_COMMENT, string: `${DQ}|${SQ}`, meta: PREPROCESSOR }, C_KEYWORDS),
  cpp: grammar({ comment: C_LIKE_COMMENT, string: `${DQ}|${SQ}`, meta: PREPROCESSOR }, CPP_KEYWORDS),
  java: grammar({ comment: C_LIKE_COMMENT, string: `${DQ}|${SQ}` }, JAVA_KEYWORDS),
  kotlin: grammar(
    { comment: C_LIKE_COMMENT, string: String.raw`"""[\s\S]*?(?:"""|${EOF})|${DQ}|${SQ}` },
    KOTLIN_KEYWORDS,
  ),
  javascript: grammar(
    { comment: C_LIKE_COMMENT, string: String.raw`${DQ}|${SQ}|\`(?:[^\`\\]|\\[\s\S])*\`?` },
    JS_KEYWORDS,
  ),
  go: grammar({ comment: C_LIKE_COMMENT, string: String.raw`${DQ}|${SQ}|\`[^\`]*\`?` }, GO_KEYWORDS),
  python: grammar(
    {
      comment: String.raw`#[^\n]*`,
      string: String.raw`"""[\s\S]*?(?:"""|${EOF})|'''[\s\S]*?(?:'''|${EOF})|${DQ}|${SQ}`,
    },
    PY_KEYWORDS,
  ),
};

function push(tokens: Token[], type: TokenType, text: string) {
  if (text.length === 0) return;
  const last = tokens[tokens.length - 1];
  if (last && last.type === type) last.text += text;
  else tokens.push({ type, text });
}

export function tokenize(source: string, language: string): Token[] {
  const g = GRAMMARS[language];
  if (!g || source.length > HIGHLIGHT_MAX_CHARS) return source.length > 0 ? [{ type: "plain", text: source }] : [];
  const tokens: Token[] = [];
  const re = new RegExp(g.pattern.source, g.pattern.flags);
  let at = 0;
  for (let m = re.exec(source); m !== null; m = re.exec(source)) {
    const [text, comment, string, number, ident, meta] = m;
    if (text.length === 0) {
      re.lastIndex += 1;
      continue;
    }
    push(tokens, "plain", source.slice(at, m.index));
    if (comment !== undefined) push(tokens, "comment", text);
    else if (string !== undefined) push(tokens, "string", text);
    else if (number !== undefined) push(tokens, "number", text);
    else if (ident !== undefined) push(tokens, g.keywords.has(text) ? "keyword" : "plain", text);
    else if (meta !== undefined) push(tokens, "meta", text);
    else push(tokens, "plain", text);
    at = m.index + text.length;
  }
  push(tokens, "plain", source.slice(at));
  return tokens;
}

/** Number of lines as an editor counts them (a trailing newline does not open a new line). */
export function lineCount(source: string): number {
  if (source.length === 0) return 1;
  let n = 1;
  for (let i = source.indexOf("\n"); i !== -1; i = source.indexOf("\n", i + 1)) n++;
  return source.endsWith("\n") ? n - 1 : n;
}
