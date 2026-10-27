import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The zero-JavaScript sign-in page (src/pages/login.tsx): its server props
 * (getServerSideProps) and its markup, rendered to static HTML — which is
 * all a student's browser ever gets for this page. Failure states must work
 * without script: the alert, aria-invalid only on the fields the error is
 * about, aria-describedby, and the autofocus target.
 */

const h = vi.hoisted(() => ({
  live: vi.fn(async (_token: string | undefined) => false),
}));
vi.mock("@/lib/pages-server", () => ({ hasLiveSession: h.live, brandForPages: vi.fn() }));

const React = await import("react");
(globalThis as { React?: unknown }).React = React;
const { createElement } = React;
const { renderToStaticMarkup } = await import("react-dom/server");
const page = await import("@/pages/login");
const LoginPage = page.default;

type Props = Parameters<typeof LoginPage>[0];
const render = (props: Props) => renderToStaticMarkup(createElement(LoginPage, props));
const NONE: Props = { error: null, notice: null, identifier: "", invalid: [], focus: null };

/** The opening tag of the input with this id. */
function input(html: string, id: string): string {
  const tag = html.match(new RegExp(`<input[^>]*\\bid="${id}"[^>]*>`))?.[0];
  if (!tag) throw new Error(`no <input id="${id}">`);
  return tag;
}

beforeEach(() => {
  h.live.mockReset();
  h.live.mockResolvedValue(false);
});

describe("login page markup", () => {
  it("ships no script and posts a plain form", () => {
    expect(page.config).toEqual({ unstable_runtimeJS: false });
    const html = render(NONE);
    expect(html).not.toContain("<script");
    const formTag = html.match(/<form[^>]*>/)?.[0] ?? "";
    expect(formTag).toContain('method="post"');
    expect(formTag).toContain('action="/api/auth/login"');
    expect(input(html, "identifier")).toContain('name="identifier"');
    // HTML attribute names are case-insensitive; React writes some in camelCase.
    expect(input(html, "identifier")).toMatch(/autocomplete="username"/i);
    expect(input(html, "password")).toContain('type="password"');
    expect(input(html, "password")).toMatch(/autocomplete="current-password"/i);
    expect(html).toContain('<main id="main-content"');
  });

  it("with no error: no alert, nothing invalid or described, no autofocus", () => {
    const html = render(NONE);
    expect(html).not.toContain('role="alert"');
    expect(html).not.toContain("aria-invalid");
    expect(html).not.toContain("aria-describedby");
    expect(html).not.toContain("autofocus");
    expect(input(html, "identifier")).toContain('value=""');
  });

  it("a credential failure: the alert, both fields invalid and described by it, focus on the password", () => {
    const html = render({ error: "Roll number/email or password is incorrect.", notice: null, identifier: "2116231001001", invalid: ["identifier", "password"], focus: "password" });
    expect(html).toMatch(/<p id="login-error" role="alert"[^>]*>Roll number\/email or password is incorrect\.<\/p>/);
    for (const id of ["identifier", "password"]) {
      expect(input(html, id)).toContain('aria-invalid="true"');
      expect(input(html, id)).toContain('aria-describedby="login-error"');
    }
    expect(input(html, "password")).toContain('autofocus=""');
    expect(input(html, "identifier")).not.toContain("autofocus");
    expect(input(html, "identifier")).toContain('value="2116231001001"');
    expect(input(html, "password")).not.toMatch(/\bvalue=/);
  });

  it("a field error marks only that field invalid; both fields still point at the message", () => {
    const html = render({ error: "Enter your password.", notice: null, identifier: "2116231001001", invalid: ["password"], focus: "password" });
    expect(input(html, "password")).toContain('aria-invalid="true"');
    expect(input(html, "identifier")).not.toContain("aria-invalid");
    expect(input(html, "identifier")).toContain('aria-describedby="login-error"');
    expect(input(html, "password")).toContain('autofocus=""');
  });

  it("the echoed identifier is escaped", () => {
    const html = render({ error: "Enter your password.", notice: null, identifier: '"><script>alert(1)</script>', invalid: ["password"], focus: "password" });
    expect(html).not.toContain("<script>");
    expect(input(html, "identifier")).toContain('value="&quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt;"');
  });
});

describe("login getServerSideProps", () => {
  function context(cookies: Record<string, string>, query: Record<string, string | string[]>) {
    const headers: Record<string, string> = {};
    return {
      ctx: {
        req: { cookies },
        res: { setHeader: (name: string, value: string) => void (headers[name.toLowerCase()] = value) },
        query,
      } as unknown as Parameters<typeof page.getServerSideProps>[0],
      headers,
    };
  }

  it("a known code: the message, the carried identifier (then cleared), the fields and the focus", async () => {
    const { ctx, headers } = context({ recx_login_id: "2116231001001" }, { error: "credentials" });
    const result = await page.getServerSideProps(ctx);
    expect(result).toEqual({
      props: {
        error: "Roll number/email or password is incorrect.",
        notice: null,
        identifier: "2116231001001",
        invalid: ["identifier", "password"],
        focus: "password",
      },
    });
    expect(headers["cache-control"]).toBe("private, no-store");
    expect(headers["set-cookie"]).toMatch(/^recx_login_id=; Path=\/login; Max-Age=0; HttpOnly; SameSite=Lax/);
  });

  it("an unknown code or a message in the URL renders the plain form", async () => {
    for (const error of ["<b>you have been hacked</b>", "toString", "Roll number/email or password is incorrect."]) {
      const { ctx } = context({ recx_login_id: "someone" }, { error });
      expect(await page.getServerSideProps(ctx)).toEqual({ props: { error: null, notice: null, identifier: "", invalid: [], focus: null } });
    }
  });

  it("identifier-missing focuses the identifier; rate-limited and unavailable read their own parameters", async () => {
    expect(await page.getServerSideProps(context({}, { error: "identifier-missing" }).ctx)).toMatchObject({
      props: { invalid: ["identifier"], focus: "identifier" },
    });
    expect(await page.getServerSideProps(context({}, { error: "rate-limited", retry: "4" }).ctx)).toMatchObject({
      props: { error: expect.stringContaining("4 minutes"), invalid: [], focus: "identifier" },
    });
    expect(await page.getServerSideProps(context({}, { error: "unavailable", ref: "K7QM2X" }).ctx)).toMatchObject({
      props: { error: expect.stringContaining("K7QM2X") },
    });
  });

  it("an over-long carried identifier is cut to 254 characters", async () => {
    const { ctx } = context({ recx_login_id: "x".repeat(400) }, { error: "credentials" });
    const result = (await page.getServerSideProps(ctx)) as { props: { identifier: string } };
    expect(result.props.identifier).toHaveLength(254);
  });

  it("already signed in: redirected to / (which sends each role home)", async () => {
    h.live.mockResolvedValue(true);
    const { ctx } = context({ recx_session: "token" }, {});
    expect(await page.getServerSideProps(ctx)).toEqual({ redirect: { destination: "/", permanent: false } });
    expect(h.live).toHaveBeenCalledWith("token");
  });

  it("the session check failing still shows the form", async () => {
    h.live.mockRejectedValue(new Error("database down"));
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { ctx } = context({ recx_session: "token" }, {});
    expect(await page.getServerSideProps(ctx)).toEqual({ props: { error: null, notice: null, identifier: "", invalid: [], focus: null } });
    logged.mockRestore();
  });
});
