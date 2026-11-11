import { describe, expect, it, vi } from "vitest";

/**
 * The super-admin's model controls, rendered (Phase 15g).
 *
 * `/super/settings/ai` is behind `requireSuperAdminPage`, and the seed
 * credentials for a real sign-in live only in gitignored environment files,
 * so the surface is proved the way Phase 15e proved the readiness check:
 * render the REAL component and read its markup. What matters here is that
 * the three things this phase gave a super-admin are actually on the page
 * and in the right shape — a wire format they choose, a model id they TYPE
 * rather than pick, an address they pick rather than type — and that the
 * one that is not theirs is not offered as if it were.
 */

const React = await import("react");
// apps/web/vitest.config.ts compiles .tsx with the classic JSX runtime.
(globalThis as { React?: unknown }).React = React;
const { createElement } = React;

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: () => undefined, push: () => undefined }) }));
vi.mock("@/server/actions/super-ai", () => ({
  updateAiHelper: async () => ({ ok: true, data: {} }),
  testAiModel: async () => ({ ok: true, data: {} }),
}));

const { renderToStaticMarkup } = await import("react-dom/server");
const { AI_HELPER_DEFAULT } = await import("@recx/shared");
const { ToastProvider } = await import("@recx/design");
const { AiHelperForm } = await import("@/components/super/ai-helper-form");

/** The real provider rather than a stub of it: the form calls `useToast`. */
const render = (over: Record<string, unknown> = {}, endpoints: string[] = []) =>
  renderToStaticMarkup(
    createElement(
      ToastProvider,
      null,
      createElement(AiHelperForm, { initial: { ...AI_HELPER_DEFAULT, ...over }, endpoints } as never),
    ),
  );

describe("choosing a model", () => {
  const html = render();

  it("offers the three wire formats this build speaks", () => {
    expect(html).toContain("Anthropic");
    expect(html).toContain("OpenAI</option>");
    expect(html).toContain("OpenAI-compatible endpoint");
  });

  it("takes the model id as text, not as a choice", () => {
    // The point of the phase: an id this build has never heard of must be
    // typeable. A <select> here would be the old catalogue by another name.
    expect(html).toMatch(/<input[^>]+value="claude-sonnet-5-5"/);
    expect(html).toContain("As the provider publishes it.");
  });

  it("still puts the familiar models one click away", () => {
    expect(html).toContain("Claude Sonnet 5.5");
    expect(html).toContain("Claude Haiku 5.5");
    // And says plainly that the list is not the limit.
    expect(html).toContain("Something else");
  });

  it("offers a way to find out whether it answers", () => {
    expect(html).toContain("Test this model");
    expect(html).toContain("No student&#x27;s work is sent");
  });

  it("does not offer an address where the endpoint is fixed in code", () => {
    // anthropic: there is nothing for a super-admin to choose, so there is
    // no control, not a disabled one.
    expect(html).not.toContain("Endpoint");
  });
});

describe("choosing where a college-hosted model lives", () => {
  it("lists the addresses the deployment allows, and marks the default", () => {
    const html = render({ provider: "openai-compatible", modelId: "qwen2.5-coder:32b" }, [
      "https://a.invalid/v1",
      "https://b.invalid/v1",
    ]);
    expect(html).toContain("Endpoint");
    expect(html).toContain("https://a.invalid/v1 (the first)");
    expect(html).toContain("https://b.invalid/v1");
    // Picked, never typed — the address is where the key goes.
    expect(html).toContain("Not typed here: it is where the key goes.");
    expect(html).toMatch(/<select[^>]*>(?:(?!<\/select>)[\s\S])*https:\/\/b\.invalid\/v1/);
  });

  it("says there is nothing to reach when the deployment named nothing", () => {
    const html = render({ provider: "openai-compatible", modelId: "qwen2.5-coder:32b" }, []);
    expect(html).toContain("sets no usable AI_BASE_URL");
    // A control that cannot be used is disabled rather than absent here,
    // because the super-admin needs to see that the choice exists and that
    // it is the deployment's to fill.
    expect(html).toMatch(/<select[^>]+disabled/);
  });

  it("lets a college-hosted endpoint name its own model, or defer to the deployment", () => {
    const html = render({ provider: "openai-compatible", modelId: "" }, ["https://a.invalid/v1"]);
    expect(html).toContain("Leave it empty to use the model the deployment sets in AI_MODEL.");
  });
});
