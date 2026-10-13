import { lineCount, tokenize, type TokenType } from "@/components/workspace/highlight";

const TOKEN_CLASS: Readonly<Record<Exclude<TokenType, "plain">, string>> = {
  comment: "text-muted italic",
  string: "text-success",
  number: "text-accent",
  keyword: "text-primary font-medium",
  meta: "text-text-secondary",
};

/**
 * Read-only source with line numbers and cheap server-side highlighting
 * (src/components/workspace/highlight.ts). No editor and no client code:
 * the line-number gutter is one text node and the code one <pre>, so even
 * a 256 KB file is a handful of DOM nodes per token, not per line. Code is
 * never wrapped (indentation carries meaning); it scrolls horizontally, and
 * the region is focusable so it scrolls from the keyboard.
 */
export function SourceView({ source, language, label }: { source: string; language: string; label: string }) {
  const tokens = tokenize(source, language);
  const lines = lineCount(source);
  const numbers = Array.from({ length: lines }, (_, k) => k + 1).join("\n");
  return (
    <div
      role="region"
      aria-label={label}
      tabIndex={0}
      className="scroll-thin flex max-h-[70dvh] overflow-auto rounded-xl border border-border bg-surface font-mono text-[13px] leading-5 outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
    >
      <pre
        aria-hidden
        className="sticky left-0 shrink-0 border-r border-border bg-background px-3 py-3 text-right text-muted tabular-nums select-none"
      >
        {numbers}
      </pre>
      <pre className="min-w-0 flex-1 px-4 py-3 whitespace-pre text-text">
        <code>
          {tokens.map((token, k) =>
            token.type === "plain" ? (
              token.text
            ) : (
              <span key={k} className={TOKEN_CLASS[token.type]}>
                {token.text}
              </span>
            ),
          )}
        </code>
      </pre>
    </div>
  );
}
