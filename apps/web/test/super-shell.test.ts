import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

/**
 * The /super tree: the persistent strip (exact spec wording, danger tokens,
 * icon plus text), the twelve routes all implemented, and every layout and
 * page under app/super calling requireSuperAdminPage() itself.
 */

vi.mock("next/navigation", () => ({ usePathname: () => "/super/users", useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock("@/server/actions/auth", () => ({ logout: vi.fn() }));

const { SUPER_STRIP_TEXT, SuperStrip } = await import("@/components/super/super-strip");
const { SuperShell } = await import("@/components/super/super-shell");
const { SUPER_NAV, isSuperNavActive } = await import("@/components/super/nav");

const SUPER_DIR = path.resolve(__dirname, "../src/app/super");

function files(dir: string, name: RegExp): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...files(full, name));
    else if (name.test(entry)) out.push(full);
  }
  return out;
}

describe("super strip", () => {
  it("reads exactly the spec wording", () => {
    expect(SUPER_STRIP_TEXT).toBe("Super-admin — all actions are audited");
  });

  it("renders in the shell with the danger tokens, sticky, with an icon", () => {
    const html = renderToStaticMarkup(
      createElement(SuperShell, {
        user: { firstName: "Super", lastName: "Admin", email: "", collegeId: "RECADMIN01" },
        children: createElement("p", null, "page"),
      }),
    );
    const strip = renderToStaticMarkup(createElement(SuperStrip));
    expect(html).toContain(strip);
    expect(strip).toContain(SUPER_STRIP_TEXT);
    expect(strip).toContain("bg-danger-subtle");
    expect(strip).toContain("text-danger");
    expect(strip).toContain("sticky");
    expect(strip).toContain('role="note"');
    expect(strip).toContain("<svg");
    expect(html).toContain('aria-label="Super-admin"');
  });
});

describe("super navigation", () => {
  it("lists the twelve spec routes", () => {
    expect(SUPER_NAV.map((i) => i.href)).toEqual([
      "/super",
      "/super/users",
      "/super/roles",
      "/super/settings/branding",
      "/super/settings/policy",
      "/super/settings/judge",
      "/super/settings/integrations",
      "/super/audit",
      "/super/impersonate",
      "/super/flags",
      "/super/jobs",
      "/super/data",
    ]);
  });

  it.each(SUPER_NAV.map((i) => [i.href]))("%s has a page.tsx", (href) => {
    const rel = href.replace(/^\/super/, "");
    expect(existsSync(path.join(SUPER_DIR, rel, "page.tsx"))).toBe(true);
  });

  it("marks /super active only on itself", () => {
    expect(isSuperNavActive("/super", "/super")).toBe(true);
    expect(isSuperNavActive("/super/users", "/super")).toBe(false);
    expect(isSuperNavActive("/super/settings/judge", "/super/settings/judge")).toBe(true);
    expect(isSuperNavActive("/super/settings/judgement", "/super/settings/judge")).toBe(false);
  });
});

describe("every /super layout and page guards itself", () => {
  const pages = files(SUPER_DIR, /^(page|layout)\.tsx$/);

  it("finds the layout and the twelve pages", () => {
    expect(pages.length).toBe(13);
  });

  it.each(pages.map((p) => [path.relative(SUPER_DIR, p)]))("%s calls requireSuperAdminPage()", (rel) => {
    const source = readFileSync(path.join(SUPER_DIR, rel), "utf8");
    expect(source).toContain("await requireSuperAdminPage()");
    expect(source).not.toMatch(/from\s+["'][^"']*monaco/);
  });
});
