import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The Hints and Editorial tabs rendered to HTML (the server components with
 * their view models stubbed): real headings, state as icon + word, the
 * assisted warning wired to its button, empty states instead of dead
 * controls, and no locked content in the markup.
 */

const h = vi.hoisted(() => ({
  loadHintsPanel: vi.fn(),
  loadEditorialPanel: vi.fn(),
}));

vi.mock("@/lib/db", () => ({ db: {} }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: () => undefined }) }));
vi.mock("@/lib/auth/guards", () => ({ requireUser: async () => ({ id: "user_1" }) }));
vi.mock("@/lib/help/panels", () => ({ loadHintsPanel: h.loadHintsPanel, loadEditorialPanel: h.loadEditorialPanel }));
vi.mock("@/server/actions/help", () => ({ revealHint: vi.fn(), viewEditorial: vi.fn() }));

const React = await import("react");
// apps/web/vitest.config.ts compiles .tsx with the classic JSX runtime
// (React.createElement), which expects a `React` in scope.
(globalThis as { React?: unknown }).React = React;
const { createElement } = React;
const { renderToStaticMarkup } = await import("react-dom/server");
const { ToastProvider } = await import("@recx/design");
const { HintsPanel } = await import("@/components/help/hints-panel");
const { EditorialPanel } = await import("@/components/help/editorial-panel");
const { ActivityTracker } = await import("@/components/help/activity-tracker");

const props = { problemId: "prob_1", versionId: "ver_live" };

async function render(panel: typeof HintsPanel | typeof EditorialPanel): Promise<string> {
  const element = await panel(props);
  return renderToStaticMarkup(createElement(ToastProvider, null, element));
}

beforeEach(() => vi.clearAllMocks());

describe("HintsPanel", () => {
  it("lists tiers with icon + word state, the unlock condition and the tier-3 warning", async () => {
    h.loadHintsPanel.mockResolvedValue({
      kind: "ready",
      progress: "So far: 2 failed submissions and 3 minutes of active work.",
      rows: [
        { tier: 1, state: "revealed", html: "<p>Think about complements.</p>" },
        { tier: 2, state: "available", warning: null },
        { tier: 3, state: "available", warning: "Using hint 3 marks a later solve as assisted (40% XP)." },
      ],
    });
    const html = await render(HintsPanel);
    expect(h.loadHintsPanel).toHaveBeenCalledWith("user_1", "prob_1", "ver_live", "PRACTICE");

    expect(html).toContain('<section aria-labelledby="help-hints-heading"');
    expect(html).toMatch(/<h2 id="help-hints-heading"[^>]*>Hints<\/h2>/);
    expect(html.match(/<h3[^>]*>Hint \d<\/h3>/g)).toHaveLength(3);
    expect(html).toContain("Revealed");
    expect(html).toContain("Unlocked");
    expect(html).toContain("<p>Think about complements.</p>");
    expect(html).toContain("So far: 2 failed submissions and 3 minutes of active work.");
    expect(html).toContain("Reveal hint 2");

    // The warning is visible and is the button's description.
    const warning = html.match(/<p id="([^"]+)"[^>]*>.*?Using hint 3 marks a later solve as assisted \(40% XP\)\./);
    expect(warning).not.toBeNull();
    expect(html).toContain(`aria-describedby="${warning?.[1]}"`);
    // Every icon is decorative.
    expect(html.match(/<svg(?![^>]*aria-hidden="true")/g)).toBeNull();
  });

  it("shows a locked tier's condition and no button for it", async () => {
    h.loadHintsPanel.mockResolvedValue({
      kind: "ready",
      progress: "So far: 0 failed submissions and 0 minutes of active work.",
      rows: [
        { tier: 1, state: "available", warning: null },
        { tier: 2, state: "locked", condition: "Hint 2 unlocks after 1 failed submission or 10 minutes of work." },
      ],
    });
    const html = await render(HintsPanel);
    expect(html).toContain("Locked");
    expect(html).toContain("Hint 2 unlocks after 1 failed submission or 10 minutes of work.");
    expect(html).not.toContain("Reveal hint 2");
    expect(html.match(/<button/g)).toHaveLength(1);
  });

  it.each([
    [{ kind: "empty" }, "No hints for this problem"],
    [{ kind: "closed", message: "Hints are not available during contests and assessments." }, "Hints are not available"],
    [{ kind: "stale", message: "Reload the page." }, "This problem was updated"],
    [{ kind: "unavailable", message: "Help is not available for this problem." }, "Hints are not available"],
  ])("renders an empty state with no controls (%o)", async (view, title) => {
    h.loadHintsPanel.mockResolvedValue(view);
    const html = await render(HintsPanel);
    expect(html).toContain(title);
    expect(html).not.toContain("<button");
  });
});

describe("EditorialPanel", () => {
  it("locked: the reason, no control", async () => {
    h.loadEditorialPanel.mockResolvedValue({ kind: "locked", reason: "The editorial unlocks when you solve this problem." });
    const html = await render(EditorialPanel);
    expect(html).toMatch(/<h2 id="help-editorial-heading"[^>]*>Editorial<\/h2>/);
    expect(html).toContain("Locked");
    expect(html).toContain("The editorial unlocks when you solve this problem.");
    expect(html).not.toContain("<button");
  });

  it("available: an explicit View editorial step with the assisted warning", async () => {
    h.loadEditorialPanel.mockResolvedValue({
      kind: "available",
      warning: "Viewing the editorial before you solve this problem marks your solve as assisted (40% XP).",
    });
    const html = await render(EditorialPanel);
    expect(html).toContain("View editorial");
    expect(html).toContain("marks your solve as assisted (40% XP).");
    expect(html).toMatch(/aria-describedby="[^"]+"/);
  });

  it("viewed: the content, no button", async () => {
    h.loadEditorialPanel.mockResolvedValue({ kind: "viewed", html: "<h3>Approach</h3><p>Hash map.</p>" });
    const html = await render(EditorialPanel);
    expect(html).toContain("<h3>Approach</h3><p>Hash map.</p>");
    expect(html).not.toContain("<button");
  });

  it("empty: says there is no editorial", async () => {
    h.loadEditorialPanel.mockResolvedValue({ kind: "empty" });
    const html = await render(EditorialPanel);
    expect(html).toContain("No editorial yet");
    expect(html).not.toContain("<button");
  });
});

describe("ActivityTracker", () => {
  it("renders nothing", () => {
    expect(renderToStaticMarkup(createElement(ActivityTracker, { problemId: "prob_1" }))).toBe("");
  });
});
