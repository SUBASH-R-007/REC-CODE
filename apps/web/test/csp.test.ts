import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { themeInitScript, THEME_SCRIPT_CSP_HASH, THEME_STORAGE_KEY } from "@/lib/theme-script";
import { buildCsp, config } from "@/middleware";

function directives(csp: string): Map<string, string[]> {
  const map = new Map<string, string[]>();
  for (const part of csp.split(";")) {
    const [name, ...values] = part.trim().split(/\s+/);
    if (name) map.set(name, values);
  }
  return map;
}

describe("Content-Security-Policy theme-script hash", () => {
  it("matches the current theme script (guards against drift)", () => {
    const digest = createHash("sha256").update(themeInitScript).digest("base64");
    // If this fails, the inline theme script changed — update
    // THEME_SCRIPT_CSP_HASH in src/lib/theme-script.ts to this value, or
    // the script will be blocked by the CSP and every page flashes light.
    expect(THEME_SCRIPT_CSP_HASH).toBe(`'sha256-${digest}'`);
  });

  it("reads the same storage key the theme toggle writes", () => {
    expect(THEME_STORAGE_KEY).toBe("recx-theme");
    expect(themeInitScript).toContain(`localStorage.getItem("${THEME_STORAGE_KEY}")`);
  });
});

describe("buildCsp", () => {
  const nonce = "bm9uY2UtdmFsdWU=";

  it("allows framework scripts by nonce and the theme script by hash", () => {
    const d = directives(buildCsp(nonce, { dev: false }));
    expect(d.get("script-src")).toEqual(["'self'", `'nonce-${nonce}'`, THEME_SCRIPT_CSP_HASH, "'strict-dynamic'"]);
  });

  it("keeps style-src nonce-free so 'unsafe-inline' (React style attributes, Monaco) stays effective", () => {
    const d = directives(buildCsp(nonce, { dev: false }));
    expect(d.get("style-src")).toEqual(["'self'", "'unsafe-inline'"]);
  });

  it("locks down framing, plugins, base and form targets", () => {
    const d = directives(buildCsp(nonce, { dev: false }));
    expect(d.get("default-src")).toEqual(["'self'"]);
    expect(d.get("frame-src")).toEqual(["'none'"]);
    expect(d.get("frame-ancestors")).toEqual(["'none'"]);
    expect(d.get("object-src")).toEqual(["'none'"]);
    expect(d.get("base-uri")).toEqual(["'self'"]);
    expect(d.get("form-action")).toEqual(["'self'"]);
    expect(d.get("img-src")).toEqual(["'self'", "data:", "blob:"]);
    expect(d.get("font-src")).toEqual(["'self'", "data:"]);
    expect(d.get("worker-src")).toEqual(["'self'", "blob:"]);
  });

  it("production: no eval, no websockets, upgrade-insecure-requests on", () => {
    const csp = buildCsp(nonce, { dev: false });
    const d = directives(csp);
    expect(csp).not.toContain("unsafe-eval");
    expect(d.get("connect-src")).toEqual(["'self'"]);
    expect(d.has("upgrade-insecure-requests")).toBe(true);
  });

  it("development: eval for HMR and ws: for the dev socket, no upgrade", () => {
    const d = directives(buildCsp(nonce, { dev: true }));
    expect(d.get("script-src")).toContain("'unsafe-eval'");
    expect(d.get("connect-src")).toEqual(["'self'", "ws:"]);
    expect(d.has("upgrade-insecure-requests")).toBe(false);
  });
});

describe("middleware matcher", () => {
  const entry = config.matcher[0]!;
  // The source is a single path-to-regexp group holding a plain regex.
  const matches = (path: string) => new RegExp(`^${entry.source}$`).test(path);

  it("covers documents, server actions and the browser-facing APIs", () => {
    for (const path of ["/", "/login", "/problems", "/problems/two-sum", "/api/submissions/abc/stream"]) {
      expect(matches(path), path).toBe(true);
    }
  });

  it("skips static assets, Monaco and the judge-node protocol", () => {
    for (const path of [
      "/_next/static/chunks/main.js",
      "/_next/image",
      "/favicon.ico",
      "/monaco/vs/loader.js",
      "/api/judge/claim",
      "/api/judge/blob/abc",
    ]) {
      expect(matches(path), path).toBe(false);
    }
  });

  it("skips router prefetches", () => {
    expect(entry.missing).toEqual(
      expect.arrayContaining([
        { type: "header", key: "next-router-prefetch" },
        { type: "header", key: "purpose", value: "prefetch" },
      ]),
    );
  });
});
