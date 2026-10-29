import type { GetServerSideProps, PageConfig } from "next";
import Head from "next/head";
import { CircleCheck, CodeXml, LogIn } from "lucide-react";
import { Button, Field, Input } from "@recx/design";
import { COLLEGE_NAME, PRODUCT_NAME, PRODUCT_TAGLINE } from "@/lib/brand/names";
import { LOGIN_IDENTIFIER_COOKIE } from "@/lib/auth/login-cookie";
import { PASSWORD_SET_NOTICE } from "@/lib/auth/reset-errors";
import { signInErrorMessage } from "@/lib/auth/sign-in-errors";
import { SESSION_COOKIE } from "@/lib/auth/session-token";
import { hasLiveSession } from "@/lib/pages-server";
import { Wordmark } from "@/components/shell/wordmark";

/**
 * Sign in — a server-rendered HTML page with NO JavaScript at all (the
 * Pages Router's `unstable_runtimeJS: false`; the only Pages Router page).
 * A student's first visit downloads no framework: the form is a plain POST
 * to /api/auth/login, which answers with a 303 to the role's home or back
 * here with ?error=<code>. Failure messages are server-rendered from the
 * code (lib/auth/sign-in-errors.ts), announced as an alert, tied to the
 * fields (aria-invalid + aria-describedby) and focus lands on the field to
 * fix — all without script. Measured: docs/CAPACITY.md, "Front-end budgets".
 */
export const config: PageConfig = { unstable_runtimeJS: false };

const HIGHLIGHTS = [
  "Original problems written for REC students",
  "Every submission judged in an isolated sandbox",
  "Per-test verdicts the moment judging finishes",
] as const;

const ERROR_ID = "login-error";

type FieldName = "identifier" | "password";
type Props = {
  error: string | null;
  /** Shown after /reset-password set one (`?reset=1`): a success, not a failure. */
  notice: string | null;
  identifier: string;
  /** The fields the error is about (aria-invalid); credential errors name both — never which part was wrong. */
  invalid: FieldName[];
  /** Where focus starts after a failure: the field to fix. */
  focus: FieldName | null;
};

const first = (value: string | string[] | undefined) => (Array.isArray(value) ? value[0] : value);

function fieldsFor(code: string, identifier: string): Pick<Props, "invalid" | "focus"> {
  if (code.startsWith("identifier-")) return { invalid: ["identifier"], focus: "identifier" };
  if (code.startsWith("password-")) return { invalid: ["password"], focus: "password" };
  if (code === "credentials") return { invalid: ["identifier", "password"], focus: identifier ? "password" : "identifier" };
  return { invalid: [], focus: identifier ? "password" : "identifier" };
}

export const getServerSideProps: GetServerSideProps<Props> = async ({ req, res, query }) => {
  res.setHeader("Cache-Control", "private, no-store");

  // Already signed in: "/" sends each role to its home. A database outage
  // still shows the form (signing in then answers "unavailable" with a
  // reference) rather than an error page.
  const token = req.cookies[SESSION_COOKIE];
  const signedIn = await hasLiveSession(token).catch((error: unknown) => {
    console.error("[auth] session check failed on /login:", error instanceof Error ? error.message : error);
    return false;
  });
  if (signedIn) return { redirect: { destination: "/", permanent: false } };

  // The identifier typed before a failed attempt: read once, then cleared
  // (with the attributes POST /api/auth/login set it with).
  const carried = req.cookies[LOGIN_IDENTIFIER_COOKIE];
  if (carried !== undefined) {
    const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
    res.setHeader("Set-Cookie", `${LOGIN_IDENTIFIER_COOKIE}=; Path=/login; Max-Age=0; HttpOnly; SameSite=Lax${secure}`);
  }
  // A password was just set (POST /api/auth/reset-password lands here).
  const notice = first(query.reset) === "1" ? PASSWORD_SET_NOTICE : null;
  const code = first(query.error);
  const error = signInErrorMessage(code, first(query.retry), first(query.ref));
  if (!error || !code) {
    return { props: { error: null, notice, identifier: "", invalid: [], focus: notice ? "identifier" : null } };
  }
  const typed = (carried ?? "").slice(0, 254);
  return { props: { error, notice, identifier: typed, ...fieldsFor(code, typed) } };
};

export default function LoginPage({ error, notice, identifier, invalid, focus }: Props) {
  // Every field points at the message; the ones it is about are marked invalid.
  const describe = (field: FieldName) =>
    error ? { "aria-describedby": ERROR_ID, ...(invalid.includes(field) ? { "aria-invalid": true } : {}) } : {};

  return (
    <>
      <Head>
        <title>{`${error ? "Sign-in failed — " : ""}Sign in · ${PRODUCT_NAME}`}</title>
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        {/*
          The App Router emits this link from app/icon.svg; a Pages Router
          page has to say it itself. Without it the browser falls back to
          requesting /favicon.ico, which does not exist — a 404 and a console
          error on the one page every student starts from. Found by
          Lighthouse's errors-in-console audit (Phase 10d).
        */}
        <link rel="icon" href="/icon.svg" type="image/svg+xml" />
        <meta
          name="description"
          content={`${PRODUCT_NAME} is the coding practice platform of ${COLLEGE_NAME}: original problems, instant judging and progress you can see.`}
        />
      </Head>
      <main id="main-content" tabIndex={-1} className="app-backdrop flex min-h-dvh outline-none">
        {/* Brand panel — decorative; hidden on small screens to keep the form first. */}
        <section
          aria-hidden
          className="relative hidden w-[44%] max-w-2xl flex-col justify-between overflow-hidden bg-linear-to-br from-primary-active via-primary-hover to-primary p-10 text-primary-fg lg:flex"
        >
          <div className="flex items-center gap-3">
            <span className="flex h-11 w-11 items-center justify-center rounded-xl bg-primary-fg/15 ring-1 ring-primary-fg/25">
              <CodeXml className="h-6 w-6" />
            </span>
            <span className="font-display text-2xl font-bold tracking-tight">{PRODUCT_NAME}</span>
          </div>
          <div>
            <p className="max-w-md font-display text-4xl font-bold leading-tight tracking-tight">{PRODUCT_TAGLINE}</p>
            <ul className="mt-8 space-y-3">
              {HIGHLIGHTS.map((line) => (
                <li key={line} className="flex items-start gap-2.5 text-primary-fg/85">
                  <CircleCheck className="mt-0.5 h-5 w-5 shrink-0" />
                  <span>{line}</span>
                </li>
              ))}
            </ul>
          </div>
          <p className="text-sm text-primary-fg/70">{COLLEGE_NAME}</p>
        </section>

        {/* Form panel */}
        <section className="flex flex-1 items-center justify-center px-4 py-10">
          <div className="w-full max-w-md">
            <div className="mb-8 flex justify-center lg:hidden">
              <Wordmark size="lg" />
            </div>

            <div className="rounded-2xl border border-border bg-surface p-6 shadow-card sm:p-8">
              <h1 className="font-display text-2xl font-bold tracking-tight">Welcome back</h1>
              <p className="mt-1 text-sm text-text-secondary">Sign in with your roll number or college email.</p>
              {notice && (
                <p
                  role="status"
                  className="mt-4 rounded-xl border border-success/25 bg-success-subtle px-3.5 py-2.5 text-sm text-success"
                >
                  {notice}
                </p>
              )}
              <form method="post" action="/api/auth/login" className="mt-6 space-y-4">
                <Field label="Roll number or college email" htmlFor="identifier">
                  <Input
                    id="identifier"
                    name="identifier"
                    defaultValue={identifier}
                    type="text"
                    autoComplete="username"
                    autoCapitalize="none"
                    autoCorrect="off"
                    spellCheck={false}
                    required
                    maxLength={254}
                    placeholder="Roll number or you@rajalakshmi.edu.in"
                    autoFocus={focus === "identifier"}
                    {...describe("identifier")}
                  />
                </Field>
                <Field label="Password" htmlFor="password">
                  <Input
                    id="password"
                    name="password"
                    type="password"
                    autoComplete="current-password"
                    required
                    maxLength={1024}
                    placeholder="Your password"
                    autoFocus={focus === "password"}
                    {...describe("password")}
                  />
                </Field>

                {error && (
                  <p
                    id={ERROR_ID}
                    role="alert"
                    className="rounded-xl border border-danger/25 bg-danger-subtle px-3.5 py-2.5 text-sm text-danger"
                  >
                    {error}
                  </p>
                )}

                <Button type="submit" className="w-full" size="lg">
                  <LogIn className="h-4 w-4" aria-hidden />
                  Sign in
                </Button>
              </form>
              {/*
                A plain anchor, not next/link: this page ships no JavaScript
                (unstable_runtimeJS: false) and a router that cannot run is
                not worth the markup.
              */}
              <p className="mt-6 text-center text-sm">
                <a href="/forgot-password" className="font-medium text-primary underline-offset-2 hover:underline">
                  Forgot your password, or never set one?
                </a>
              </p>
              {/*
                Phase 11f. A department may create accounts with a password it
                hands out, and the holder is made to replace it before they
                can reach anything — so the first sign-in needs one sentence
                here rather than a support call.
              */}
              <p className="mt-2 text-center text-xs text-muted">
                Signing in for the first time? Use the password your department gave you — you will be asked to choose
                your own straight away.
              </p>
            </div>

            <p className="mt-6 text-center text-xs text-muted">
              {PRODUCT_NAME} · {COLLEGE_NAME}
            </p>
          </div>
        </section>
      </main>
    </>
  );
}
