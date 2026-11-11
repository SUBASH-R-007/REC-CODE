import { describe, expect, it } from "vitest";
import { findFiles, isTestPath, lexSource, lineAt, readRepoFile } from "./support/repo";

/**
 * A route a FORM posts to must redirect RELATIVELY (Phase 13a).
 *
 * The defect this exists to refuse took the whole exam away, silently.
 *
 * `POST /api/exam/start/[slug]` answered with
 * `NextResponse.redirect(new URL(to, request.url), 303)`, which writes an
 * ABSOLUTE `Location` built from the host Next believes it is serving. On
 * this machine the dev server is reached as `127.0.0.1` and Next resolves
 * `request.url` to `localhost`, so the redirect crossed origin — and the
 * readiness page's own Content-Security-Policy says `form-action 'self'`,
 * which Chromium enforces against a form submission's REDIRECT as well as
 * its action. The browser refused to send the form at all:
 *
 *     Sending form data to 'http://127.0.0.1:3001/api/exam/start/<slug>'
 *     violates the following Content Security Policy directive:
 *     "form-action 'self'". The request has been blocked.
 *
 * Printed in a console no candidate has open. No request reached the
 * server, no attempt was created, nothing appeared on screen: the Start
 * button simply did nothing, for every candidate, with an invigilator
 * watching. In production the same thing happens behind any proxy or
 * alternate hostname — which is most of them.
 *
 * A relative `Location` is resolved by the browser against the URL IT
 * used, so it is same-origin by construction. `seeOther()` in
 * `lib/http/form-body.ts` is that, and it is what the sign-in routes have
 * always used — which is exactly why the login form never had this bug.
 *
 * So: no `NextResponse.redirect` in a route handler. Every redirect a
 * route needs today is to a page of this product, and there is a helper
 * for it. If an external redirect is ever genuinely needed, add it to
 * ALLOWED below with the reason — a deliberate exception, written down,
 * rather than a pattern that silently returns.
 */

/** Route handlers allowed to build an absolute redirect, with the reason. */
const ALLOWED = new Map<string, string>([
  [
    "apps/web/src/app/api/auth/oidc/start/route.ts",
    // Phase 16i. The destination is the LMS's authorization endpoint, which
    // is ANOTHER ORIGIN by definition, so a relative Location cannot
    // express it. The URL is built from the issuer's own discovery document
    // and never from anything in the request; both of this route's
    // refusals, and every redirect in its callback, are relative through
    // `seeOther()`. Nothing posts a form to it -- it is a link on the
    // sign-in page.
    "redirects the browser to the LMS authorization endpoint (another origin by definition)",
  ],
]);

const ABSOLUTE_REDIRECT = /\bNextResponse\s*\.\s*redirect\s*\(/g;

interface Finding {
  file: string;
  line: number;
  what: string;
}

export function absoluteRedirects(file: string, source: string): Finding[] {
  // Comments and strings are stripped, so the story above does not flag
  // itself and neither does a doc comment naming the old call.
  const { code } = lexSource(source);
  return [...code.matchAll(ABSOLUTE_REDIRECT)].map((m) => ({
    file,
    line: lineAt(code, m.index),
    what: m[0].replace(/\s+/g, ""),
  }));
}

describe("detector self-test", () => {
  it.each([
    ["return NextResponse.redirect(new URL('/x', request.url), 303);"],
    ["return NextResponse . redirect( url );"],
  ])("flags %s", (snippet) => {
    expect(absoluteRedirects("x.ts", snippet)).toHaveLength(1);
  });

  it.each([
    ["return seeOther('/assessments');"],
    ["// return NextResponse.redirect(new URL('/x', request.url));"],
    ["/** NextResponse.redirect is refused here */"],
    ["return NextResponse.json({ error }, { status: 400 });"],
  ])("ignores %s", (snippet) => {
    expect(absoluteRedirects("x.ts", snippet)).toEqual([]);
  });

  it("flags it inside a string too, which is the lexer being honest", () => {
    /**
     * `lexSource` blanks COMMENTS and keeps string literals, so the call
     * written inside a string is reported. That is the right way round: a
     * false positive is a sentence an author rewords, and a route that
     * builds this call from a string is the one thing a scanner must not
     * miss.
     */
    expect(absoluteRedirects("x.ts", "const how = 'NextResponse.redirect(' + rest;")).toHaveLength(1);
  });
});

describe("redirects out of a route handler", () => {
  const routes = findFiles({ under: ["apps/web/src/app/api"], extensions: [".ts"], exclude: isTestPath }).filter((f) =>
    f.endsWith("/route.ts"),
  );

  it("scans the API routes (sanity)", () => {
    expect(routes.length).toBeGreaterThan(20);
    expect(routes).toContain("apps/web/src/app/api/exam/start/[slug]/route.ts");
  });

  it("are relative, so a form submission cannot be refused by form-action", () => {
    const outside = routes
      .filter((f) => !ALLOWED.has(f))
      .flatMap((f) => absoluteRedirects(f, readRepoFile(f)))
      .map((f) => `${f.file}:${f.line}  ${f.what} — use seeOther() from lib/http/form-body.ts`);
    expect(outside).toEqual([]);
  });

  it("the one allowed exception is the LMS authorization redirect, and nothing else in that file", () => {
    /**
     * Phase 16i. `ALLOWED` exempts a FILE, not a line, so the exemption is
     * checked here: the start route may build exactly ONE absolute
     * redirect, and its refusals must still be relative. Without this, the
     * exception for a cross-origin provider would quietly cover an
     * absolute `/login` redirect added later -- which is the defect this
     * whole file exists to refuse.
     */
    const file = "apps/web/src/app/api/auth/oidc/start/route.ts";
    expect([...ALLOWED.keys()]).toEqual([file]);
    expect(absoluteRedirects(file, readRepoFile(file))).toHaveLength(1);
    // And the callback, which is NOT exempt, has none at all.
    const callback = "apps/web/src/app/api/auth/oidc/callback/route.ts";
    expect(absoluteRedirects(callback, readRepoFile(callback))).toEqual([]);
  });

  it("and the route the readiness form posts to uses the shared helper", () => {
    // Named, because this is the one that was broken and the one whose
    // failure nobody can see from the page.
    const source = readRepoFile("apps/web/src/app/api/exam/start/[slug]/route.ts");
    expect(source).toContain("seeOther(");
    expect(source).toContain('from "@/lib/http/form-body"');
  });

  it("and the helper itself emits a relative Location", () => {
    const helper = readRepoFile("apps/web/src/lib/http/form-body.ts");
    expect(helper).toContain("status: 303");
    // No absolute URL built inside it either: `Location: location`, where
    // the caller passes a path.
    expect(helper).not.toMatch(/new URL\(/);
  });
});
