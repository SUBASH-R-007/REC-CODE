import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { HIGHLIGHT_MAX_CHARS, lineCount, tokenize, type Token } from "@/components/workspace/highlight";
import { SourceView } from "@/components/workspace/source-view";

const joined = (tokens: Token[]) => tokens.map((t) => t.text).join("");
const of = (tokens: Token[], type: Token["type"]) => tokens.filter((t) => t.type === type).map((t) => t.text);

describe("cheap highlighter", () => {
  it("never changes the text", () => {
    const samples: [string, string][] = [
      ["cpp", '#include <bits/stdc++.h>\nint main() { /* c */ std::string s = "a\\"b"; return 0; } // done\n'],
      ["python", 'def f(x):\n    """doc"""\n    return x + 1  # inc\nprint(f\'{1}\')\n'],
      ["java", "class A { public static void main(String[] a) { char c = '\\n'; } }"],
      ["go", "package main\nfunc main() { s := `raw\nstring` }\n"],
      ["javascript", "const t = `a ${b} c`; // x\n"],
      ["kotlin", 'fun main() { val s = """multi\nline"""; }'],
      ["plaintext", "anything at all"],
      ["cpp", "/* unterminated comment"],
      ["python", "s = 'unterminated"],
    ];
    for (const [language, source] of samples) expect(joined(tokenize(source, language))).toBe(source);
  });

  it("marks comments, strings, numbers, keywords and preprocessor lines (C++)", () => {
    const tokens = tokenize('#include <cstdio>\nint main() {\n  return 42; // answer\n  const char* s = "hi";\n}\n', "cpp");
    expect(of(tokens, "meta")).toEqual(["#include <cstdio>"]);
    expect(of(tokens, "keyword")).toEqual(expect.arrayContaining(["int", "return", "const", "char"]));
    expect(of(tokens, "number")).toEqual(["42"]);
    expect(of(tokens, "comment")).toEqual(["// answer"]);
    expect(of(tokens, "string")).toEqual(['"hi"']);
    // Identifiers that are not keywords stay plain.
    expect(of(tokens, "keyword")).not.toContain("main");
  });

  it("handles Python comments and triple-quoted strings", () => {
    const tokens = tokenize('def f():\n    """a # not a comment"""\n    return None  # real\n', "python");
    expect(of(tokens, "string")).toEqual(['"""a # not a comment"""']);
    expect(of(tokens, "comment")).toEqual(["# real"]);
    expect(of(tokens, "keyword")).toEqual(expect.arrayContaining(["def", "return", "None"]));
  });

  it("does not treat a '#' inside a C++ string as a preprocessor line", () => {
    const tokens = tokenize('auto s = "#define X";\n', "cpp");
    expect(of(tokens, "meta")).toEqual([]);
    expect(of(tokens, "string")).toEqual(['"#define X"']);
  });

  it("returns one plain token for unknown languages and very large files", () => {
    expect(tokenize("int x;", "brainfuck")).toEqual([{ type: "plain", text: "int x;" }]);
    const big = "int x;\n".repeat(Math.ceil(HIGHLIGHT_MAX_CHARS / 7) + 1);
    expect(tokenize(big, "cpp")).toEqual([{ type: "plain", text: big }]);
    expect(tokenize("", "cpp")).toEqual([]);
  });

  it("counts lines like an editor", () => {
    expect(lineCount("")).toBe(1);
    expect(lineCount("a")).toBe(1);
    expect(lineCount("a\n")).toBe(1);
    expect(lineCount("a\nb")).toBe(2);
    expect(lineCount("a\nb\n")).toBe(2);
    expect(lineCount("\n\n")).toBe(2);
  });
});

describe("SourceView", () => {
  // apps/web's vitest config compiles .tsx with the classic JSX runtime.
  (globalThis as { React?: typeof React }).React = React;

  it("renders escaped code with one line-number node, and is keyboard-scrollable", () => {
    const html = renderToStaticMarkup(
      React.createElement(SourceView, {
        source: 'int main() { std::cout << "<b>&"; }\n// x\n',
        language: "cpp",
        label: "Submitted code, C++20",
      }),
    );
    expect(html).toContain('role="region"');
    expect(html).toContain('tabindex="0"');
    expect(html).toContain('aria-label="Submitted code, C++20"');
    expect(html).toContain("&lt;b&gt;&amp;");
    expect(html).not.toContain("<b>");
    expect(html).toContain(">1\n2</pre>");
  });
});
