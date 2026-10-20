import { expect, test, type APIRequestContext, type Browser, type BrowserContext, type Page, type Response } from "@playwright/test";
import { expectActionSuccess, toast } from "./support/actions";
import { authoringFixture, type AuthoringFixture, type ReferenceSpec } from "./support/authoring";
import { settle, waitForEditor } from "./support/page";
import { contextAs, expectLandedOn } from "./support/session";

/**
 * The Phase 4 manual check, automated: author a problem end
 * to end in the UI, fail validation on purpose with a wrong reference
 * solution, fix it, have a SECOND admin approve, publish, then edit the
 * statement in a new revision and confirm an older submission still shows
 * the revision it was judged against. Finally crawl everything a student
 * can fetch and prove no hidden test or reference source leaks.
 *
 *   RECADMIN01 (SUPER_ADMIN)  creates, edits, validates, submits for review,
 *                             publishes and finally retires the problem;
 *   RECADMIN02 (ADMIN)        approves (an approver must differ from the
 *                             creator, the last editor and the submitter);
 *   2116231001004 (STUDENT)   submits and crawls.
 *
 * Needs the live stack WITH a judge worker (E2E_JUDGE=1). Validation runs
 * on the REJUDGE lane, capped at floor(0.2 × RECX_SLOTS): the worker needs
 * RECX_SLOTS ≥ 5 and judge-rejudge in RECX_QUEUES, or validation never
 * starts — the wait fails after 5 minutes with that hint.
 *
 * Every run uses its own runId (slug, title, canaries), so leftovers of a
 * crashed run never collide; a published leftover is retired in afterAll.
 */

const JUDGE = process.env.E2E_JUDGE === "1";
const VALIDATION_TIMEOUT = 5 * 60_000;
/** Queue + compile + tests on the live judge. */
const VERDICT_TIMEOUT = 180_000;
const POLL_MS = 5_000;
const VIEWPORT = { width: 1366, height: 768 };

const fx: AuthoringFixture = authoringFixture();
const state: { problemId: string | null; published: boolean; retired: boolean } = {
  problemId: null,
  published: false,
  retired: false,
};

test.describe.configure({ mode: "serial" });

// ── Admin helpers ──────────────────────────────────────────────────────

const problemUrl = (id: string) => `/admin/problems/${id}`;

/** The validation page's "Publish readiness" status region. */
function readiness(page: Page) {
  return page
    .locator('div[role="status"][aria-live="polite"]')
    .filter({ hasText: /Validation|Stage [12]|Published revision|was published/ })
    .first();
}

function publishButton(page: Page) {
  return page.getByRole("button", { name: "Publish", exact: true });
}

const SLOT_HINT =
  "Validation runs on the REJUDGE lane, whose cap is floor(0.2 × RECX_SLOTS). The judge worker needs RECX_SLOTS ≥ 5 " +
  "and RECX_QUEUES including judge-rejudge (e.g. RECX_SLOTS=8, RECX_QUEUES=judge-practice,judge-run,judge-rejudge) " +
  "— check the worker's .env.local and that it is running and online.";

/**
 * Reload the validation page until its status satisfies `done`, or fail
 * after 5 minutes with the slot hint. Every third poll presses "Check
 * progress" (moves validation on and re-dispatches queued runs).
 */
async function waitForValidation(page: Page, id: string, done: (text: string) => boolean, step: string): Promise<string> {
  const deadline = Date.now() + VALIDATION_TIMEOUT;
  let last = "";
  for (let poll = 0; ; poll++) {
    await page.goto(`${problemUrl(id)}/validate`);
    last = (await readiness(page).innerText()).replace(/\s+/g, " ").trim();
    if (done(last)) return last;
    if (Date.now() > deadline) {
      throw new Error(`[${step}] validation did not finish within ${VALIDATION_TIMEOUT / 60_000} minutes. ${SLOT_HINT} Last status: "${last}"`);
    }
    if (poll % 3 === 2) {
      const check = page.getByRole("button", { name: "Check progress" });
      if (await check.isEnabled().catch(() => false)) await check.click().catch(() => undefined);
    }
    await page.waitForTimeout(POLL_MS);
  }
}

async function startValidation(page: Page, id: string, step: string): Promise<void> {
  await page.goto(`${problemUrl(id)}/validate`);
  await page.getByRole("button", { name: "Start validation" }).click();
  await expectActionSuccess(page, toast(page, /^Validation started:/), step);
}

/** Validate until complete; the deliberately-wrong solution must fail as expected. */
async function validateUntilComplete(page: Page, id: string, step: string): Promise<void> {
  await startValidation(page, id, step);
  const text = await waitForValidation(
    page,
    id,
    (t) => /Validation is complete\./.test(t) || /Model solution failed|internal error/.test(t),
    step,
  );
  expect(text, `[${step}] validation completes`).toContain("Validation is complete.");
  expect(text, `[${step}] no model failed`).not.toContain("Model solution failed");
  expect(text, `[${step}] the wrong solution failed as expected`).not.toContain("did not fail as expected");
}

async function saveReference(page: Page, ref: ReferenceSpec, step: string): Promise<void> {
  await page.getByLabel("Language", { exact: true }).selectOption(ref.language);
  await page.getByLabel("Expected verdict", { exact: true }).selectOption(ref.expectedVerdict);
  await page.getByLabel("Label", { exact: true }).fill(ref.label);
  await page.getByLabel("Source", { exact: true }).fill(ref.source);
  await page.getByRole("button", { name: "Save reference solution" }).click();
  await expectActionSuccess(page, page.getByRole("button", { name: `Edit ${ref.label} (${ref.language})` }), step);
}

async function submitForReview(page: Page, id: string, revision: number): Promise<void> {
  await page.goto(problemUrl(id));
  await page.getByRole("checkbox", { name: /originally authored for REC Code/ }).check();
  await page.getByRole("button", { name: "Submit for review" }).click();
  await expectActionSuccess(page, toast(page, `Revision ${revision} submitted for review.`), `submit r${revision}`);
}

async function approve(page: Page, id: string, revision: number): Promise<void> {
  await page.goto(problemUrl(id));
  const button = page.getByRole("button", { name: "Approve", exact: true });
  await expect(button, "RECADMIN02 did not author this revision, so may approve it").toBeEnabled();
  await button.click();
  await expectActionSuccess(page, toast(page, `Revision ${revision} approved.`), `approve r${revision}`);
}

async function publish(page: Page, id: string, revision: number): Promise<void> {
  await page.goto(`${problemUrl(id)}/validate`);
  await expect(publishButton(page), `r${revision} is approved and validated: Publish is available`).toBeEnabled();
  await publishButton(page).click();
  await expectActionSuccess(page, page.getByText(`Published revision ${revision}.`), `publish r${revision}`);
  await expect(readiness(page)).toContainText(`Published revision ${revision}`);
}

async function retire(page: Page, id: string): Promise<void> {
  await page.goto(problemUrl(id));
  await page.getByRole("button", { name: "Retire problem" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Reason", { exact: true }).fill(fx.retireReason);
  await dialog.getByRole("button", { name: "Confirm retirement" }).click();
  await expectActionSuccess(page, toast(page, "Problem retired."), "retire");
  state.retired = true;
}

// ── Student helpers ────────────────────────────────────────────────────

async function editorValue(page: Page): Promise<string> {
  return page.evaluate(() => {
    const w = window as unknown as { monaco?: { editor: { getEditors(): { getValue(): string }[] } } };
    return w.monaco?.editor.getEditors()[0]?.getValue() ?? "";
  });
}

/**
 * Submit the Python solution from the workspace; returns the submission id
 * once it is Accepted. `earlier` are this student's earlier submission ids
 * (never mistaken for the new one).
 */
async function submitAccepted(page: Page, step: string, earlier: readonly string[] = []): Promise<string> {
  await page.goto(`/problems/${fx.slug}`);
  await settle(page);
  await waitForEditor(page, "monaco");
  await page.getByLabel("Language", { exact: true }).selectOption("py312");
  await page.locator("[data-editor-root] .monaco-editor .view-lines").click();
  await page.keyboard.press("ControlOrMeta+A");
  await page.keyboard.insertText(fx.studentSource);
  await expect.poll(() => editorValue(page), { message: `[${step}] the editor holds the solution` }).toBe(fx.studentSource);

  // The workspace follows the new submission at /api/submissions/<id>[/stream].
  const followed = page.waitForRequest(
    (r) => {
      const match = /^\/api\/submissions\/([^/]+)(\/stream)?$/.exec(new URL(r.url()).pathname);
      return match !== null && !earlier.includes(match[1]!);
    },
    { timeout: 60_000 },
  );
  await page.getByRole("button", { name: "Submit", exact: true }).click();
  const id = new URL((await followed).url()).pathname.split("/")[3] ?? "";
  expect(id, `[${step}] the submission id`).toMatch(/^[A-Za-z0-9_-]+$/);

  const announced = page.locator('p[role="status"][aria-live="polite"]').filter({ hasText: /^Submission result/ });
  await expect(announced, `[${step}] the verdict`).toHaveText(/^Submission result: Accepted\./, { timeout: VERDICT_TIMEOUT });
  // The announcement is the workspace's; the stored verdict of THIS submission must agree.
  const view = (await (await page.request.get(`/api/submissions/${id}`)).json()) as { terminal?: boolean; verdict?: string | null };
  expect(view, `[${step}] /api/submissions/${id}`).toMatchObject({ terminal: true, verdict: "AC" });
  return id;
}

/** The "Problem version" value on a submission page. */
async function expectPinnedRevision(page: Page, url: string, revision: number, who: string): Promise<void> {
  const response = await page.goto(url);
  expect(response?.status(), `${who} opens ${url}`).toBe(200);
  const value = page.locator("dt", { hasText: "Problem version" }).locator("xpath=following-sibling::dd[1]");
  await expect(value, `${who}: the submission shows the revision it was judged against`).toHaveText(`Revision ${revision}`);
  await expect(page.getByText(`Judged against revision ${revision}`)).toBeVisible();
}

// ── The crawl: live evidence that no student route leaks tests or sources ──

const SECRETS = () => [
  { name: "hidden input", value: fx.hiddenInput },
  { name: "hidden output", value: fx.hiddenOutput },
  { name: "reference canary", value: fx.refCanary },
];

function leaksIn(body: string): string[] {
  return SECRETS()
    .filter((s) => body.includes(s.value))
    .map((s) => s.name);
}

interface Fetched {
  status: number;
  type: string;
  body: string;
}

/**
 * GET as the student. No redirects are followed (a bounce to /login would
 * make the check vacuous), except for an RSC request, which a Next server
 * with validateRSCRequestHeaders on redirects once to add its `_rsc`
 * cache-busting parameter; its content type is asserted instead.
 */
async function fetchAs(request: APIRequestContext, path: string, headers: Record<string, string> = {}): Promise<Fetched> {
  const maxRedirects = headers.RSC === "1" ? 2 : 0;
  const response = await request.get(path, { headers, maxRedirects, timeout: 120_000 });
  return { status: response.status(), type: response.headers()["content-type"] ?? "", body: await response.text() };
}

/** Bodies of every same-origin HTML, RSC flight and JSON response a browser page receives. */
function collectResponses(page: Page, origin: string, found: string[]): () => Promise<number> {
  let pending: Promise<void>[] = [];
  let seen = 0;
  const onResponse = (response: Response) => {
    const url = new URL(response.url());
    if (url.origin !== origin) return;
    const type = response.headers()["content-type"] ?? "";
    if (!/text\/html|text\/x-component|application\/json/.test(type)) return;
    pending.push(
      response
        .text()
        .then((body) => {
          seen++;
          for (const leak of leaksIn(body)) found.push(`browser ${type.split(";")[0]} ${url.pathname}${url.search}: ${leak}`);
        })
        .catch(() => undefined), // a body evicted by the next navigation
    );
  };
  page.on("response", onResponse);
  return async () => {
    const batch = pending;
    pending = [];
    await Promise.all(batch);
    return seen;
  };
}

async function closeAll(contexts: readonly (BrowserContext | null)[]): Promise<void> {
  for (const context of contexts) await context?.close().catch(() => undefined);
}

async function retireLeftover(browser: Browser): Promise<void> {
  if (!state.problemId || !state.published || state.retired) return;
  const context = await contextAs(browser, "admin", { viewport: VIEWPORT });
  try {
    await retire(await context.newPage(), state.problemId);
  } finally {
    await context.close();
  }
}

// ── The journey ─────────────────────────────────────────────────────────

test.describe("authoring journey", () => {
  test.skip(!JUDGE, "needs a live judge (E2E_JUDGE=1): validation and the student's submissions are judged");

  test.afterAll(async ({ browser }) => {
    // Never leave a published test problem in the catalogue.
    await retireLeftover(browser);
  });

  test("author, fail validation, fix, approve as a second admin, publish r1 and r2; old submissions keep r1; nothing leaks", async ({
    browser,
    baseURL,
  }, testInfo) => {
    test.setTimeout(20 * 60_000);
    testInfo.annotations.push({ type: "runId", description: fx.runId });
    const origin = new URL(baseURL ?? "http://localhost:3000").origin;

    let adminCtx: BrowserContext | null = null;
    let reviewerCtx: BrowserContext | null = null;
    let studentCtx: BrowserContext | null = null;
    try {
      adminCtx = await contextAs(browser, "admin", { viewport: VIEWPORT });
      reviewerCtx = await contextAs(browser, "staffAdmin", { viewport: VIEWPORT });
      studentCtx = await contextAs(browser, "authoring", { viewport: VIEWPORT });
      const admin = await adminCtx.newPage();
      const reviewer = await reviewerCtx.newPage();
      const student = await studentCtx.newPage();
      let id = "";
      let firstSubmission = "";
      let secondSubmission = "";

      await test.step("1. RECADMIN01 creates the draft, its tests and references (a WRONG cpp20 model first)", async () => {
        await admin.goto("/admin/problems/new");
        await admin.getByLabel("Title", { exact: true }).fill(fx.title);
        await admin.getByLabel("Slug", { exact: true }).fill(fx.slug);
        await admin.getByLabel("Difficulty", { exact: true }).selectOption("EASY");
        await admin.getByLabel("Input mode", { exact: true }).selectOption("STDIN");
        await admin.getByLabel("Comparator", { exact: true }).selectOption("TOKEN");
        await admin.getByLabel("Time limit (ms)", { exact: true }).fill("1000");
        await admin.getByLabel("Memory limit (MB)", { exact: true }).fill("256");
        await admin.getByLabel("Statement (Markdown)", { exact: true }).fill(fx.statement);
        await admin.getByRole("button", { name: "Create draft" }).click();
        await expectActionSuccess(admin, admin.getByRole("heading", { level: 1, name: fx.title }), "create draft", 120_000);
        const match = /^\/admin\/problems\/([A-Za-z0-9_-]+)$/.exec(new URL(admin.url()).pathname);
        expect(match?.[1], "the new problem's page").toBeTruthy();
        id = match![1]!;
        state.problemId = id;
        testInfo.annotations.push({ type: "problem", description: `${id} (${fx.slug})` });

        await admin.goto(`${problemUrl(id)}/testcases`);
        for (const [index, t] of fx.tests.entries()) {
          await admin.getByLabel("Input", { exact: true }).fill(t.input);
          await admin.getByLabel("Expected output", { exact: true }).fill(t.output);
          await admin.getByLabel("Sample", { exact: true }).setChecked(t.sample);
          await admin.getByRole("button", { name: "Add test case" }).click();
          await expectActionSuccess(admin, toast(admin, `Test ${index} added.`), `add test ${index}`);
        }

        await admin.goto(problemUrl(id));
        for (const ref of fx.references) await saveReference(admin, ref, `reference ${ref.label}`);
      });

      await test.step("2. validation fails: the model produced WA, and Publish is unavailable", async () => {
        await startValidation(admin, id, "validate (wrong model)");
        const text = await waitForValidation(
          admin,
          id,
          (t) => /Model solution failed/.test(t) || /Validation is complete\.|internal error/.test(t),
          "validate (wrong model)",
        );
        expect(text).toMatch(/Model solution failed: .*produced WA/);
        await expect(readiness(admin)).toContainText(/Model solution failed: .*produced WA/);
        await expect(publishButton(admin), "Publish is unavailable while a model fails").toBeDisabled();
      });

      await test.step("3. fix the model, revalidate until complete, submit for review (originality attested)", async () => {
        await admin.goto(problemUrl(id));
        await admin.getByRole("button", { name: `Edit ${fx.wrongModel.label} (${fx.wrongModel.language})` }).click();
        const source = admin.getByLabel("Source", { exact: true });
        await expect(source, "the form holds the wrong model").toHaveValue(new RegExp(fx.refCanary));
        await source.fill(fx.fixedModelSource);
        await admin.getByRole("button", { name: "Save reference solution" }).click();
        await expectActionSuccess(admin, toast(admin, "Reference solution updated. Validate again."), "fix the model");

        await validateUntilComplete(admin, id, "validate r1");
        await submitForReview(admin, id, 1);
      });

      await test.step("4. RECADMIN02 approves", async () => {
        await approve(reviewer, id, 1);
      });

      await test.step('5. publish: "Published revision 1"', async () => {
        await publish(admin, id, 1);
        state.published = true;
      });

      await test.step("6. student 004 submits Python and gets Accepted", async () => {
        firstSubmission = await submitAccepted(student, "first submission");
        testInfo.annotations.push({ type: "submission r1", description: `/problems/${fx.slug}/submissions/${firstSubmission}` });
      });

      await test.step('7. a new revision with a statement marker; validate; RECADMIN02 approves; "Published revision 2"', async () => {
        await admin.goto(problemUrl(id));
        await admin.getByRole("button", { name: "Create new revision" }).click();
        await expectActionSuccess(admin, toast(admin, /Draft revision 2 created\.|Revision 2 is already open\./), "new revision");
        // Only a DRAFT revision is editable, and revision 1 is frozen: this is revision 2.
        await expect(admin.getByRole("button", { name: "Save details" })).toBeVisible();
        await expect(admin.getByRole("link", { name: "r2", exact: true })).toHaveAttribute("aria-current", "page");

        await admin.getByLabel("Statement (Markdown)", { exact: true }).fill(`${fx.statement}\n\n${fx.r2Marker}`);
        await admin.getByRole("button", { name: "Save details" }).click();
        await expectActionSuccess(admin, toast(admin, "Details saved."), "edit the statement");

        await validateUntilComplete(admin, id, "validate r2");
        await submitForReview(admin, id, 2);
        await approve(reviewer, id, 2);
        await publish(admin, id, 2);
      });

      await test.step("8. the old submission keeps revision 1; the workspace shows r2; a new submission is on r2", async () => {
        const firstUrl = `/problems/${fx.slug}/submissions/${firstSubmission}`;
        await expectPinnedRevision(student, firstUrl, 1, "the student");
        await expect(student.getByText("it is now at revision 2")).toBeVisible();
        await expectPinnedRevision(admin, firstUrl, 1, "the admin");

        await student.goto(`/problems/${fx.slug}`);
        await settle(student);
        await expect(student.getByText(fx.r2Marker).first(), "the workspace statement is revision 2").toBeVisible();

        secondSubmission = await submitAccepted(student, "second submission", [firstSubmission]);
        await expectPinnedRevision(student, `/problems/${fx.slug}/submissions/${secondSubmission}`, 2, "the student");
      });

      await test.step("9. crawl as the student: no hidden test or reference source in HTML, RSC or JSON", async () => {
        const leaks: string[] = [];
        const request = studentCtx!.request;

        await student.goto("/profile");
        const handleHref = await student
          .locator('a[href^="/u/"]')
          .first()
          .getAttribute("href", { timeout: 15_000 })
          .catch(() => null);
        if (!handleHref) testInfo.annotations.push({ type: "crawl", description: "no /u/<handle> link on /profile; skipped" });

        const pages = [
          "/problems",
          `/problems/${fx.slug}`,
          `/problems/${fx.slug}/submissions/${firstSubmission}`,
          `/problems/${fx.slug}/submissions/${secondSubmission}`,
          "/dashboard",
          "/profile",
          ...(handleHref ? [handleHref] : []),
          "/leaderboard",
          "/bookmarks",
          "/notes",
          "/sheets",
          "/learn",
          "/help",
          "/judge",
        ];
        const apis = [
          `/api/submissions/${firstSubmission}`,
          `/api/submissions/${secondSubmission}`,
          `/api/search?q=${encodeURIComponent(fx.slug)}`,
          // Positive control: the title search finds the problem, so the search was really looked at.
          `/api/search?q=${encodeURIComponent(fx.title)}`,
        ];

        // Over HTTP: the HTML document and the RSC flight payload of every page.
        for (const path of pages) {
          const okStatuses = path.startsWith("/u/") ? [200, 404] : [200];
          const html = await fetchAs(request, path);
          expect(okStatuses, `${path} (HTML) as the student`).toContain(html.status);
          expect(html.type, `${path} is an HTML document`).toContain("text/html");
          for (const leak of leaksIn(html.body)) leaks.push(`HTML ${path}: ${leak}`);
          if (path === `/problems/${fx.slug}`) {
            expect(html.body, "positive control: the workspace HTML carries the sample input").toContain(fx.sampleInput);
          }

          const rsc = await fetchAs(request, path, { RSC: "1" });
          expect(okStatuses, `${path} (RSC) as the student`).toContain(rsc.status);
          expect(rsc.type, `${path} answers an RSC flight payload`).toContain("text/x-component");
          for (const leak of leaksIn(rsc.body)) leaks.push(`RSC ${path}: ${leak}`);
          if (path === `/problems/${fx.slug}`) {
            expect(rsc.body, "positive control: the workspace flight payload carries the sample input").toContain(fx.sampleInput);
          }
        }
        for (const path of apis) {
          const json = await fetchAs(request, path, { accept: "application/json" });
          expect(json.status, `${path} as the student`).toBe(200);
          expect(json.type, `${path} is JSON`).toContain("application/json");
          for (const leak of leaksIn(json.body)) leaks.push(`JSON ${path}: ${leak}`);
        }
        expect((await fetchAs(request, apis[3]!)).body, "positive control: the title search finds the problem").toContain(fx.slug);

        // In the browser: every HTML, flight and JSON response each page pulls in.
        const settleResponses = collectResponses(student, origin, leaks);
        for (const path of pages) {
          await student.goto(path);
          await settle(student);
          await settleResponses();
        }
        expect(await settleResponses(), "the browser crawl read responses").toBeGreaterThan(0);

        expect(leaks, "secrets in student-reachable responses").toEqual([]);

        // A staff page sends the student home; the judge's blob route wants a judge node.
        await student.goto(problemUrl(id), { waitUntil: "commit" });
        await expectLandedOn(student, "/dashboard");

        const blobPath = `/api/judge/blob/${fx.hiddenInputSha256}`;
        const noProtocol = await request.get(blobPath, { maxRedirects: 0 });
        expect(noProtocol.status(), "no judge protocol header: refused (426)").toBe(426);
        const expected = ((await noProtocol.json()) as { expected?: number }).expected;
        expect(typeof expected, "the 426 names the current protocol version").toBe("number");
        const noNode = await request.get(blobPath, { headers: { "x-recx-judge-protocol": String(expected) }, maxRedirects: 0 });
        expect(noNode.status(), "the student's cookie is not a judge node: 401").toBe(401);
        expect(leaksIn(await noNode.text())).toEqual([]);
      });

      await test.step("10. RECADMIN01 retires the problem", async () => {
        await retire(admin, id);
        await expect(admin.getByText("This problem is retired.")).toBeVisible();
      });
    } finally {
      await closeAll([adminCtx, reviewerCtx, studentCtx]);
    }
  });
});
