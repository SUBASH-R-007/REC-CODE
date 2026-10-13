import { describe, expect, it } from "vitest";
import { TWO_SUM } from "@recx/shared/samples/two-sum";
import { renderMarkdown } from "@/lib/markdown";

/** Every real start tag in the output (escaped text like &lt;img&gt; is not a tag). */
function tags(html: string): string[] {
  return html.match(/<[a-z][^>]*>/gi) ?? [];
}

describe("renderMarkdown", () => {
  it("renders ordinary statement Markdown", () => {
    const html = renderMarkdown(TWO_SUM.statement);
    expect(html).toContain("<strong>two different positions</strong>");
    expect(html).toContain("<code>nums</code>");
    expect(html).toContain("<pre><code>");
    // Author headings are demoted below the page's own h1/h2.
    expect(html).toContain("<h3>Example 1</h3>");
  });

  it("never emits a script element", () => {
    const html = renderMarkdown("Hello\n\n<script>alert(1)</script>\n\nInline <script>alert(2)</script> too.");
    expect(html).not.toMatch(/<script/i);
    expect(html).not.toMatch(/<\/script/i);
  });

  it("strips event-handler attributes", () => {
    const html = renderMarkdown('<img src="x" onerror="alert(1)">\n\n<p onclick="alert(2)">hi</p>\n\n<a href="https://example.org" onmouseover="alert(3)">x</a>');
    expect(html).not.toMatch(/<img/i);
    for (const tag of tags(html)) expect(tag).not.toMatch(/\son\w+\s*=/i);
    // Raw HTML survives only as visible, inert text.
    expect(html).toContain("&lt;img");
  });

  it("removes javascript: and other unsafe URL schemes from links", () => {
    const html = renderMarkdown(
      "[click](javascript:alert(1)) [data](data:text/html;base64,PHNjcmlwdD4=) [vb](vbscript:msgbox(1)) [ok](https://example.org/a)",
    );
    expect(html).not.toMatch(/javascript:/i);
    expect(html).not.toMatch(/data:text/i);
    expect(html).not.toMatch(/vbscript:/i);
    expect(html).toContain('href="https://example.org/a"');
  });

  it("adds rel=noopener noreferrer to every link", () => {
    const html = renderMarkdown("See [the docs](https://example.org) and <https://example.com>.");
    const anchors = html.match(/<a\b[^>]*>/g) ?? [];
    expect(anchors.length).toBe(2);
    for (const a of anchors) expect(a).toContain('rel="noopener noreferrer"');
  });

  it("drops iframes, styles and inline style attributes", () => {
    const html = renderMarkdown(
      '<iframe src="https://evil.example"></iframe>\n\n<style>body{display:none}</style>\n\n<p style="color:red">x</p>',
    );
    expect(html).not.toMatch(/<iframe/i);
    expect(html).not.toMatch(/<style/i);
    for (const tag of tags(html)) expect(tag).not.toMatch(/\sstyle\s*=/i);
  });

  it("keeps code-block language classes but nothing else", () => {
    const html = renderMarkdown("```cpp\nint main() {}\n```");
    expect(html).toContain('<code class="language-cpp">');
  });

  it("renders GFM tables", () => {
    const html = renderMarkdown("| a | b |\n|:--|--:|\n| 1 | 2 |");
    expect(html).toContain("<table>");
    expect(html).toMatch(/<th align="left">a<\/th>/);
  });
});
