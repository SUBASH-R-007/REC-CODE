import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * PublicShell (the chrome of /u/[handle] and /judge): signed out it renders
 * the minimal header with Sign in and the page; signed in, the normal app
 * shell. It never redirects and never calls a guard — it grants nothing.
 */

const h = vi.hoisted(() => ({
  user: null as null | { id: string; role: string },
  redirect: vi.fn(() => {
    throw new Error("PublicShell must not redirect");
  }),
}));

vi.mock("@/lib/auth/session", () => ({ getCurrentUser: async () => h.user }));
vi.mock("@/components/shell/app-shell", async () => {
  const { createElement } = await import("react");
  return {
    AppShell: ({ children }: { children: React.ReactNode }) => createElement("div", { "data-app-shell": "yes" }, children),
  };
});
vi.mock("next/navigation", () => ({
  redirect: h.redirect,
  useRouter: () => ({ refresh: () => undefined, push: () => undefined }),
  usePathname: () => "/judge",
}));
vi.mock("@/lib/auth/guards", () => {
  const refuse = () => {
    throw new Error("PublicShell must not call a guard");
  };
  return { requireUser: refuse, requirePageRole: refuse, requireActionUser: refuse, requireActionRole: refuse, requireSuperAdmin: refuse };
});

const React = await import("react");
(globalThis as { React?: unknown }).React = React;
const { createElement } = React;
const { renderToStaticMarkup } = await import("react-dom/server");
const { PublicShell } = await import("@/components/shell/public-shell");
const { default: PublicLayout } = await import("@/app/(public)/layout");
const { default: ProfileLayout } = await import("@/app/u/layout");

async function render(shell: (props: { children: React.ReactNode }) => Promise<React.ReactElement>): Promise<string> {
  return renderToStaticMarkup(await shell({ children: createElement("p", null, "page body") }));
}

beforeEach(() => {
  vi.clearAllMocks();
  h.user = null;
});

describe("PublicShell", () => {
  it("signed out: minimal header with Sign in, the page in <main>, no app shell", async () => {
    const html = await render(PublicShell);
    expect(html).toContain("Sign in");
    expect(html).toContain('href="/login"');
    expect(html).toMatch(/<main id="main-content"[^>]*>.*page body.*<\/main>/s);
    expect(html).not.toContain("data-app-shell");
    expect(h.redirect).not.toHaveBeenCalled();
  });

  it("signed in: the app shell around the page", async () => {
    h.user = { id: "user_1", role: "STUDENT" };
    const html = await render(PublicShell);
    expect(html).toContain('data-app-shell="yes"');
    expect(html).toContain("page body");
    expect(html).not.toContain("Sign in");
    expect(h.redirect).not.toHaveBeenCalled();
  });

  it.each([
    ["(public) layout", PublicLayout],
    ["/u layout", ProfileLayout],
  ] as const)("%s is PublicShell around the page, nothing else", async (_name, layout) => {
    const page = createElement("p", null, "page body");
    const element = (await layout({ children: page })) as React.ReactElement<{ children: React.ReactNode }>;
    expect(element.type).toBe(PublicShell);
    expect(element.props.children).toBe(page);
    expect(h.redirect).not.toHaveBeenCalled();
  });
});
