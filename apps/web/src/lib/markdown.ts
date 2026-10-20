import "server-only";
import { Marked } from "marked";
import sanitizeHtml from "sanitize-html";

/**
 * Problem statements are authored in Markdown and rendered to HTML once, on
 * the server. Two fences:
 *
 *   1. marked renders raw HTML blocks/tags as escaped text, so an author's
 *      <script> or <img onerror> shows up literally instead of executing.
 *   2. sanitize-html then enforces an allow-list over the generated HTML: no
 *      script/style/iframe/img, no event-handler or style attributes, links
 *      restricted to http(s)/mailto and given rel="noopener noreferrer".
 *
 * The result is safe for dangerouslySetInnerHTML.
 */

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

const marked = new Marked({
  gfm: true,
  breaks: false,
  renderer: {
    // Raw HTML in a statement is shown, never interpreted.
    html({ text }) {
      return escapeHtml(text);
    },
  },
});

const SANITIZE: sanitizeHtml.IOptions = {
  allowedTags: [
    "p",
    "br",
    "hr",
    "h3",
    "h4",
    "h5",
    "h6",
    "strong",
    "em",
    "del",
    "sup",
    "sub",
    "kbd",
    "code",
    "pre",
    "blockquote",
    "ul",
    "ol",
    "li",
    "a",
    "table",
    "thead",
    "tbody",
    "tr",
    "th",
    "td",
  ],
  allowedAttributes: {
    a: ["href", "title", "rel", "target"],
    ol: ["start"],
    th: [{ name: "align", values: ["left", "center", "right"], multiple: false }],
    td: [{ name: "align", values: ["left", "center", "right"], multiple: false }],
  },
  allowedClasses: { code: ["language-*"] },
  allowedSchemes: ["http", "https", "mailto"],
  allowedSchemesAppliedToAttributes: ["href"],
  allowProtocolRelative: false,
  disallowedTagsMode: "discard",
  // Content of these is dropped together with the tag.
  nonTextTags: ["script", "style", "textarea", "option", "noscript", "iframe", "object", "embed"],
  transformTags: {
    // The page owns h1/h2; statement headings start at h3.
    h1: "h3",
    h2: "h3",
    a: (_tagName, attribs) => {
      const out: sanitizeHtml.Attributes = { rel: "noopener noreferrer", target: "_blank" };
      if (attribs.href) out.href = attribs.href;
      if (attribs.title) out.title = attribs.title;
      return { tagName: "a", attribs: out };
    },
  },
};

/** Render a statement (or any author Markdown) to sanitised HTML. */
export function renderMarkdown(markdown: string): string {
  const html = marked.parse(markdown, { async: false });
  return sanitizeHtml(html, SANITIZE);
}
