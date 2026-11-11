import type { MonacoApi, MonacoThemeData } from "@/components/editor/monaco-types";

/**
 * Monaco's theme, built at runtime from the page's design tokens so the
 * editor follows the admin-chosen brand and light/dark mode. Monaco only
 * understands hex colours, so each token is resolved through the browser
 * (var() chains, oklch(), rgb() …) and read back as RGBA from a 1×1 canvas.
 */

export const MONACO_THEME = "recx";

let canvasContext: CanvasRenderingContext2D | null | undefined;

function context(): CanvasRenderingContext2D | null {
  if (canvasContext === undefined) {
    const canvas = document.createElement("canvas");
    canvas.width = 1;
    canvas.height = 1;
    canvasContext = canvas.getContext("2d", { willReadFrequently: true });
  }
  return canvasContext;
}

const hex2 = (n: number) => Math.round(n).toString(16).padStart(2, "0");

/** Resolve a CSS custom property to "#rrggbb" / "#rrggbbaa", or null. */
function tokenHex(name: string, probe: HTMLElement): string | null {
  probe.style.color = "";
  probe.style.color = `var(${name})`;
  const resolved = getComputedStyle(probe).color;
  const ctx = context();
  if (!resolved || !ctx) return null;
  ctx.clearRect(0, 0, 1, 1);
  ctx.fillStyle = resolved;
  ctx.fillRect(0, 0, 1, 1);
  const [r = 0, g = 0, b = 0, a = 255] = ctx.getImageData(0, 0, 1, 1).data;
  if (a === 0) return null;
  return `#${hex2(r)}${hex2(g)}${hex2(b)}${a < 255 ? hex2(a) : ""}`;
}

/** Same colour at a given opacity (for selections and highlights). */
function withAlpha(hex: string | null, alpha: number): string | null {
  if (!hex) return null;
  return `${hex.slice(0, 7)}${hex2(Math.max(0, Math.min(1, alpha)) * 255)}`;
}

export function buildTheme(): MonacoThemeData {
  const root = document.documentElement;
  const dark = root.classList.contains("dark");
  const probe = document.createElement("span");
  probe.style.display = "none";
  document.body.appendChild(probe);
  try {
    const t = (name: string) => tokenHex(name, probe);
    const surface = t("--surface");
    const background = t("--background");
    const text = t("--text");
    const secondary = t("--text-secondary");
    const muted = t("--muted");
    const border = t("--border");
    const primary = t("--primary");
    // Dark theme: the canonical --primary is below 4.5:1 as text on the dark
    // surfaces, so primary-coloured TEXT uses --primary-hover there — the
    // same rule as packages/design/utilities.css (docs/OPEN-QUESTIONS.md,
    // Phase 3, "Design: dark-theme contrast").
    const primaryText = dark ? (t("--primary-hover") ?? primary) : primary;
    const primarySubtle = t("--primary-subtle");
    const elevated = t("--surface-elevated") ?? surface;
    const success = t("--success");
    const accent = t("--accent");
    const info = t("--info");
    const danger = t("--danger");

    const fg = (hex: string | null) => (hex ? hex.slice(1, 7) : undefined);
    const rules = [
      { token: "comment", foreground: fg(muted), fontStyle: "italic" },
      { token: "keyword", foreground: fg(primaryText) },
      { token: "string", foreground: fg(success) },
      { token: "number", foreground: fg(accent) },
      { token: "type", foreground: fg(info) },
      { token: "delimiter", foreground: fg(secondary) },
      { token: "invalid", foreground: fg(danger) },
    ].filter((r) => r.foreground !== undefined);

    const entries: [string, string | null][] = [
      ["editor.background", surface],
      ["editor.foreground", text],
      ["editorLineNumber.foreground", muted],
      ["editorLineNumber.activeForeground", text],
      ["editorCursor.foreground", primary],
      ["editor.selectionBackground", withAlpha(primary, dark ? 0.35 : 0.22)],
      ["editor.inactiveSelectionBackground", primarySubtle],
      ["editor.lineHighlightBackground", withAlpha(primarySubtle, 0.6)],
      ["editor.lineHighlightBorder", withAlpha(primarySubtle, 0)],
      ["editorIndentGuide.background1", border],
      ["editorIndentGuide.activeBackground1", muted],
      ["editorWhitespace.foreground", border],
      ["editorBracketMatch.background", withAlpha(primary, 0.15)],
      ["editorBracketMatch.border", primary],
      ["editorGutter.background", surface],
      ["editorWidget.background", elevated],
      ["editorWidget.border", border],
      ["editorSuggestWidget.background", elevated],
      ["editorSuggestWidget.border", border],
      ["editorSuggestWidget.selectedBackground", primarySubtle],
      ["input.background", background],
      ["focusBorder", primary],
      ["scrollbarSlider.background", withAlpha(muted, 0.25)],
      ["scrollbarSlider.hoverBackground", withAlpha(muted, 0.4)],
      ["scrollbarSlider.activeBackground", withAlpha(primary, 0.45)],
    ];
    const colors: Record<string, string> = {};
    for (const [key, value] of entries) if (value) colors[key] = value;

    return { base: dark ? "vs-dark" : "vs", inherit: true, rules, colors };
  } finally {
    probe.remove();
  }
}

export function applyTheme(monaco: MonacoApi): void {
  monaco.editor.defineTheme(MONACO_THEME, buildTheme());
  monaco.editor.setTheme(MONACO_THEME);
}

/** Re-apply the theme whenever <html> changes class (dark toggle) or style. */
export function watchTheme(monaco: MonacoApi): () => void {
  let frame = 0;
  const observer = new MutationObserver(() => {
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(() => applyTheme(monaco));
  });
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ["class", "style", "data-theme"] });
  return () => {
    cancelAnimationFrame(frame);
    observer.disconnect();
  };
}
