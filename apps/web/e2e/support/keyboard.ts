import { expect, type Page } from "@playwright/test";

/**
 * Keyboard-only helpers. Nothing here clicks: focus moves only through
 * key presses, and the page is only READ (to find out where focus landed and
 * whether it is visible).
 */

/** What the focused element is, enough to match it and to explain a failure. */
export interface FocusDesc {
  tag: string;
  id: string;
  role: string | null;
  type: string | null;
  value: string | null;
  href: string | null;
  checked: boolean | null;
  /** Accessible-ish name: aria-label, else the label / text content (trimmed, 120 chars). */
  name: string;
  /** Inside a code editor (Monaco / CodeMirror / the plain textarea). */
  inEditor: boolean;
  /** Text content (first 4,000 characters) — for tab panels and summaries. */
  text: string;
}

/**
 * The Next.js development overlay / dev-tools button (`<nextjs-portal>`),
 * injected by `next dev` only. It is not REC Code and never ships, so the
 * journey passes through it without asserting on it (the same element the
 * axe scans exclude, see a11y.spec.ts).
 */
export const DEV_OVERLAY_TAG = "nextjs-portal";
export const isDevOverlay = (d: FocusDesc | null) => d?.tag === DEV_OVERLAY_TAG;

/** Visible-focus verdict for the focused element. */
export interface FocusIndicator {
  ok: boolean;
  how: string;
  desc: FocusDesc | null;
}

export async function describeFocus(page: Page): Promise<FocusDesc | null> {
  return page.evaluate(() => {
    const el = document.activeElement as HTMLElement | null;
    if (!el || el === document.body || el === document.documentElement) return null;
    const clean = (s: string | null | undefined) => (s ?? "").replace(/\s+/g, " ").trim().slice(0, 120);
    const labelled = el.getAttribute("aria-labelledby");
    const labelText = labelled
      ? labelled
          .split(/\s+/)
          .map((id) => document.getElementById(id)?.textContent ?? "")
          .join(" ")
      : "";
    const input = el as HTMLInputElement;
    const labels = "labels" in input && input.labels ? Array.from(input.labels).map((l) => l.textContent ?? "") : [];
    return {
      tag: el.tagName.toLowerCase(),
      id: el.id,
      role: el.getAttribute("role"),
      type: el.getAttribute("type"),
      value: "value" in input && typeof input.value === "string" ? input.value : null,
      href: el.getAttribute("href"),
      checked: el instanceof HTMLInputElement && (el.type === "checkbox" || el.type === "radio") ? el.checked : null,
      name: clean(el.getAttribute("aria-label") || labelText || labels.join(" ") || el.textContent),
      inEditor: el.closest("[data-editor-root]") !== null,
      text: (el.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 4000),
    };
  });
}

function show(desc: FocusDesc | null): string {
  if (!desc) return "<body> (focus lost)";
  const bits = [desc.tag];
  if (desc.id) bits.push(`#${desc.id}`);
  if (desc.role) bits.push(`[role=${desc.role}]`);
  if (desc.href) bits.push(`[href=${desc.href}]`);
  if (desc.inEditor) bits.push("(editor)");
  return `${bits.join("")} "${desc.name}"`;
}

/**
 * Is the focused element showing a focus indicator? It must match
 * :focus-visible and carry a real indicator: an outline at least 1 px wide
 * with a non-transparent colour, or a ring (a spread box-shadow). Inside the
 * code editor the indicator is the editor wrapper's inset ring (the editors
 * paint over their own textarea), so that is what is checked there.
 */
export async function focusIndicator(page: Page): Promise<FocusIndicator> {
  const desc = await describeFocus(page);
  if (!desc) return { ok: false, how: "focus is on <body>", desc };
  const verdict = await page.evaluate(() => {
    const el = document.activeElement as HTMLElement;
    const transparent = (c: string) => c === "transparent" || /rgba\([^)]*,\s*0\)$/.test(c);
    const ring = (shadow: string) => shadow !== "none" && /0px 0px 0px [1-9]/.test(shadow);
    const editor = el.closest<HTMLElement>("[data-editor-root]");
    if (editor) {
      const after = getComputedStyle(editor, "::after").boxShadow;
      return { ok: after !== "none" && after.includes("inset"), how: `editor ring: ${after}` };
    }
    if (!el.matches(":focus-visible")) return { ok: false, how: "focused but not :focus-visible" };
    const s = getComputedStyle(el);
    const outlineWidth = parseFloat(s.outlineWidth) || 0;
    if (s.outlineStyle !== "none" && outlineWidth >= 1 && !transparent(s.outlineColor)) {
      return { ok: true, how: `outline ${s.outlineWidth} ${s.outlineStyle} ${s.outlineColor}` };
    }
    if (ring(s.boxShadow)) return { ok: true, how: `ring ${s.boxShadow}` };
    return { ok: false, how: `no indicator (outline ${s.outlineStyle} ${s.outlineWidth}, shadow ${s.boxShadow})` };
  });
  return { ...verdict, desc };
}

/** Assert the focused element shows a visible focus indicator. */
export async function expectFocusVisible(page: Page, step: string): Promise<FocusDesc> {
  const indicator = await focusIndicator(page);
  expect(indicator.ok, `[${step}] focus must be visible on ${show(indicator.desc)} — ${indicator.how}`).toBe(true);
  return indicator.desc as FocusDesc;
}

export async function expectFocusInEditor(page: Page, step: string, inside: boolean): Promise<void> {
  const desc = await describeFocus(page);
  expect(desc?.inEditor ?? false, `[${step}] focus ${inside ? "inside" : "outside"} the editor; it is on ${show(desc)}`).toBe(
    inside,
  );
}

/**
 * One Tab (Shift+Tab backwards). Inside the code editor Tab indents, so the
 * documented escape is used first: Esc, then Tab (docs/ACCESSIBILITY.md §5).
 */
export async function pressTab(page: Page, backwards = false): Promise<void> {
  const desc = await describeFocus(page);
  if (desc?.inEditor) await page.keyboard.press("Escape");
  await page.keyboard.press(backwards ? "Shift+Tab" : "Tab");
}

/**
 * Tab (or Shift+Tab) until the focused element matches `want`, asserting a
 * visible focus indicator on every element focus stops at on the way.
 */
export async function tabTo(
  page: Page,
  want: (desc: FocusDesc) => boolean,
  label: string,
  { backwards = false, max = 80 }: { backwards?: boolean; max?: number } = {},
): Promise<FocusDesc> {
  const path: string[] = [];
  for (let i = 0; i < max; i++) {
    await pressTab(page, backwards);
    const indicator = await focusIndicator(page);
    path.push(show(indicator.desc));
    // Focus on <body> happens between the last element and the first (wrap);
    // the dev overlay is skipped over (not product UI).
    if (indicator.desc && !isDevOverlay(indicator.desc)) {
      expect(
        indicator.ok,
        `[${label}] focus must be visible on ${show(indicator.desc)} — ${indicator.how}\npath: ${path.join(" → ")}`,
      ).toBe(true);
      if (want(indicator.desc)) return indicator.desc;
    }
  }
  throw new Error(`[${label}] not reached with ${max} ${backwards ? "Shift+Tab" : "Tab"} presses. Path:\n${path.join("\n")}`);
}

export const isSkipLink = (d: FocusDesc) => d.tag === "a" && (d.href ?? "").endsWith("#main-content");
export const isMain = (d: FocusDesc) => d.id === "main-content";
