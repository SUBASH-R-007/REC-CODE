import { writeFileSync } from "node:fs";
import { expect, test, type BrowserContext, type CDPSession, type Page, type TestInfo } from "@playwright/test";
import { passwordFor, type Account } from "./support/accounts";

/**
 * Throttled workspace performance (the Phase 3 "manual" checks, automated).
 *
 * 1366 × 768, CPU throttled 4× (CDP), network 3 Mbps down / 1 Mbps up /
 * 150 ms RTT (CDP), signed in as a student, /problems/two-sum:
 *
 *   (a) COLD (HTTP cache disabled): the plain textarea is typable — React
 *       has hydrated it — within 2.5 s of navigation start;
 *   (b) Monaco has taken over and is interactive within 7 s cold, and
 *       within 4 s warm (static assets in the HTTP cache);
 *   (c) the console is an OVERLAY drawer: opening it never resizes the
 *       editor (no squeeze), never scrolls an editor whose caret is already
 *       clear of it, and never leaves the caret line under it — the editor
 *       scrolls just enough to keep the caret line above the drawer, also
 *       while the student keeps typing with the console open (Monaco here;
 *       the plain-textarea fallback in its own test below);
 *   (d) CLS on the workspace ≤ 0.05; LCP is recorded with its element (the
 *       statement is expected to be it);
 *   (e) the plain textarea is typable before Monaco arrives (cold and warm:
 *       textareaTypable < monaco).
 *
 * The timing budgets are ENFORCED against a production build and REPORTED
 * against `next dev` (an unminified, compile-on-request server says nothing
 * about what students get). Production on Windows:
 *
 *     cd apps/web && next build && JUDGE_ALLOW_UNHARDENED_NODES=false next start -p 3200
 *     E2E_BASE_URL=http://localhost:3200 npx playwright test --project perf
 *
 * E2E_PERF_ENFORCE=1 enforces against any server; E2E_PERF_OUT=<file>
 * writes the measurements as JSON. The caret checks (c) and the order (e)
 * are always enforced.
 *
 * Two more tests: the plain-textarea fallback (Monaco blocked) keeps its
 * caret above the console too; and, with E2E_JUDGE=1 (a live judge — the
 * WSL dev stack), a throttled solve from start to finish — open the
 * problem, type into the textarea before Monaco arrives, write a solution,
 * Run → Accepted, Submit → Accepted — with the caret checked against the
 * console all the way through.
 *
 * Runs as student 2116231001003 (E2E_PERF_STUDENT_ID), whom the other specs
 * do not use; the typed text is put back with "Reset to starter code".
 */

const STUDENT: Account = {
  key: "student",
  identifier: process.env.E2E_PERF_STUDENT_ID ?? "2116231001003",
  passwordVar: "SEED_STUDENT_PASSWORD",
  storageState: "",
};
const PROBLEM = "/problems/two-sum";
const VIEWPORT = { width: 1366, height: 768 };
/** 3 Mbps / 1 Mbps in bytes per second (SI megabits), 150 ms round trip. */
const NETWORK = { offline: false, latency: 150, downloadThroughput: 375_000, uploadThroughput: 125_000 };
const CPU_SLOWDOWN = 4;
/** The judged solve (last test) needs a real judge worker attached to the server under test. */
const JUDGE = process.env.E2E_JUDGE === "1";
/** two-sum in Python 3.12 on one line (one line: nothing for the editor to re-indent). */
const SOLUTION_PY =
  "class Solution: twoSum = lambda self, nums, target: (lambda seen: next([seen[target - x], i] for i, x in enumerate(nums) if (target - x) in seen or seen.setdefault(x, i) is None))({})";

const BUDGET = {
  textareaTypableMs: 2_500,
  monacoColdMs: 7_000,
  monacoWarmMs: 4_000,
  cls: 0.05,
} as const;

/** What the init script below collects inside the page. */
interface PerfState {
  marks: { textareaVisible?: number; textareaTypable?: number; monaco?: number };
  /** element "(none)": the node was gone or inside a closed (user-agent) shadow root, e.g. a <textarea>'s text. */
  lcp: { time: number; size: number; element: string; inStatement: boolean }[];
  /** Layout shifts without recent input, with the nodes that moved. */
  shifts: { time: number; value: number; sources: string[] }[];
  fcp?: number;
}

declare global {
  interface Window {
    __recxPerf?: PerfState;
  }
}

/** Runs before any page script: observers + a cheap poll for the editor milestones. */
function installProbe() {
  const state: PerfState = { marks: {}, lcp: [], shifts: [] };
  window.__recxPerf = state;
  const describe = (el: Element | null): string => {
    if (!el) return "(none)";
    const text = (el.textContent ?? "").trim().replace(/\s+/g, " ").slice(0, 40);
    return `${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ""}${text ? ` "${text}"` : ""}`;
  };
  try {
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries() as (PerformanceEntry & { element?: Element | null; size?: number })[]) {
        const element = entry.element ?? null;
        state.lcp.push({
          time: entry.startTime,
          size: entry.size ?? 0,
          element: describe(element),
          inStatement: Boolean(element?.closest('section[aria-label="Problem"]')),
        });
      }
    }).observe({ type: "largest-contentful-paint", buffered: true });
    new PerformanceObserver((list) => {
      type Shift = PerformanceEntry & {
        value: number;
        hadRecentInput: boolean;
        sources?: { node?: Node | null; previousRect: DOMRectReadOnly; currentRect: DOMRectReadOnly }[];
      };
      for (const entry of list.getEntries() as Shift[]) {
        if (entry.hadRecentInput) continue;
        const sources = (entry.sources ?? []).map((source) => {
          const node = source.node instanceof Element ? source.node : (source.node?.parentElement ?? null);
          const from = source.previousRect;
          const to = source.currentRect;
          const round = Math.round;
          return (
            `${describe(node)} y ${round(from.y)}→${round(to.y)}, h ${round(from.height)}→${round(to.height)}, ` +
            `x ${round(from.x)}→${round(to.x)}, w ${round(from.width)}→${round(to.width)}`
          );
        });
        state.shifts.push({ time: entry.startTime, value: entry.value, sources });
      }
    }).observe({ type: "layout-shift", buffered: true });
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) if (entry.name === "first-contentful-paint") state.fcp = entry.startTime;
    }).observe({ type: "paint", buffered: true });
  } catch {
    // Observers unsupported: the marks below still work.
  }
  const tick = () => {
    const root = document.querySelector("[data-editor-root]");
    const textarea = root?.querySelector<HTMLTextAreaElement>(":scope > textarea") ?? null;
    const now = performance.now();
    if (textarea && state.marks.textareaVisible === undefined && textarea.getBoundingClientRect().height > 0) {
      state.marks.textareaVisible = now;
    }
    // Hydrated = React has attached its props (and so its onChange) to the node.
    if (textarea && state.marks.textareaTypable === undefined && Object.keys(textarea).some((k) => k.startsWith("__reactProps$"))) {
      state.marks.textareaTypable = now;
    }
    if (root?.getAttribute("data-editor") === "monaco" && root.querySelector(".monaco-editor textarea")) {
      state.marks.monaco ??= now;
    }
    if (state.marks.monaco === undefined) setTimeout(tick, 25);
  };
  setTimeout(tick, 0);
}

interface Transfer {
  url: string;
  bytes: number;
  /** When the response finished, in ms after the first request of the page. */
  doneMs: number;
}

/** CDP throttling + cache control, and a log of bytes on the wire per response. */
async function instrument(context: BrowserContext, page: Page, opts: { throttle: boolean; cache: boolean }) {
  const cdp: CDPSession = await context.newCDPSession(page);
  await cdp.send("Network.enable");
  await cdp.send("Network.setCacheDisabled", { cacheDisabled: !opts.cache });
  if (opts.throttle) {
    await cdp.send("Network.emulateNetworkConditions", NETWORK);
    await cdp.send("Emulation.setCPUThrottlingRate", { rate: CPU_SLOWDOWN });
  }
  const urls = new Map<string, string>();
  const transfers: Transfer[] = [];
  let start: number | undefined;
  cdp.on("Network.requestWillBeSent", (e) => {
    start ??= e.timestamp;
  });
  cdp.on("Network.responseReceived", (e) => urls.set(e.requestId, e.response.url));
  cdp.on("Network.loadingFinished", (e) => {
    const url = urls.get(e.requestId);
    if (url) transfers.push({ url, bytes: e.encodedDataLength, doneMs: Math.round((e.timestamp - (start ?? e.timestamp)) * 1000) });
  });
  return { cdp, transfers };
}

async function signIn(page: Page) {
  await page.goto("/login");
  await page.getByLabel("Roll number or college email").fill(STUDENT.identifier);
  await page.getByLabel("Password", { exact: true }).fill(passwordFor(STUDENT));
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL((url) => !url.pathname.startsWith("/login"), { timeout: 120_000 });
}

async function waitForMark(page: Page, mark: keyof PerfState["marks"], timeout: number) {
  await page.waitForFunction((m) => window.__recxPerf?.marks[m] !== undefined, mark, { timeout, polling: 100 });
}

const perfState = (page: Page) => page.evaluate(() => window.__recxPerf as PerfState);

/**
 * Monaco's own stylesheet is applied — a fast editor that renders unstyled
 * (visible input textarea, no overflow guard, a visible aria live region)
 * must fail here, not pass on its timings.
 */
async function expectMonacoStyled(page: Page) {
  const styled = await page.evaluate(() => {
    const sheet = [...document.querySelectorAll<HTMLLinkElement>('link[rel="stylesheet"]')].some((l) =>
      (l.getAttribute("href") ?? "").endsWith("/monaco/vs/editor/editor.main.css"),
    );
    const guard = document.querySelector("[data-editor-root] .monaco-editor .overflow-guard");
    const input = document.querySelector("[data-editor-root] .monaco-editor textarea");
    const aria = document.querySelector(".monaco-aria-container");
    return {
      sheet,
      guardOverflow: guard ? getComputedStyle(guard).overflow : null,
      inputZIndex: input ? getComputedStyle(input).zIndex : null,
      ariaPosition: aria ? getComputedStyle(aria).position : "absent",
    };
  });
  expect(styled, "Monaco's stylesheet is applied").toEqual({
    sheet: true,
    guardOverflow: "hidden",
    inputZIndex: "-10",
    ariaPosition: expect.stringMatching(/^(absolute|absent)$/),
  });
}

/** Largest web-vitals session window (1 s gap, 5 s cap) and the plain total. */
function clsOf(shifts: PerfState["shifts"]) {
  let best = 0;
  let current = 0;
  let start = -Infinity;
  let last = -Infinity;
  for (const s of shifts) {
    if (s.time - last > 1_000 || s.time - start > 5_000) {
      current = 0;
      start = s.time;
    }
    current += s.value;
    last = s.time;
    best = Math.max(best, current);
  }
  return { cls: best, total: shifts.reduce((t, s) => t + s.value, 0) };
}

const kb = (bytes: number) => Math.round((bytes / 1024) * 10) / 10;

/** Hashed chunk names mean a production build; `next dev` serves unhashed ones. */
async function isProductionBuild(page: Page): Promise<boolean> {
  return page.evaluate(() =>
    [...document.querySelectorAll<HTMLScriptElement>("script[src]")].some((s) =>
      /\/_next\/static\/chunks\/webpack-[0-9a-f]{8,}\.js/.test(s.src),
    ),
  );
}

/** The caret and the editor, in viewport pixels, read through Monaco's own API (the AMD global). */
interface CaretSnapshot {
  line: number;
  column: number;
  lastLine: string;
  /** Caret line box in the viewport. */
  top: number;
  bottom: number;
  /** The editor's visible area in the viewport. */
  editorTop: number;
  editorBottom: number;
  editorHeight: number;
  scrollTop: number;
}

async function caretSnapshot(page: Page): Promise<CaretSnapshot | null> {
  return page.evaluate(() => {
    interface Pos {
      lineNumber: number;
      column: number;
    }
    interface Ed {
      getPosition(): Pos | null;
      getScrolledVisiblePosition(p: Pos): { top: number; left: number; height: number } | null;
      getDomNode(): HTMLElement | null;
      getScrollTop(): number;
      getModel(): { getLineCount(): number; getLineContent(n: number): string } | null;
    }
    const api = (window as unknown as { monaco?: { editor: { getEditors(): Ed[] } } }).monaco;
    const editor = api?.editor.getEditors()[0];
    const pos = editor?.getPosition();
    const dom = editor?.getDomNode()?.getBoundingClientRect();
    const visible = pos ? editor?.getScrolledVisiblePosition(pos) : null;
    const model = editor?.getModel();
    if (!editor || !pos || !dom || !visible || !model) return null;
    return {
      line: pos.lineNumber,
      column: pos.column,
      lastLine: model.getLineContent(model.getLineCount()),
      top: dom.top + visible.top,
      bottom: dom.top + visible.top + visible.height,
      editorTop: dom.top,
      editorBottom: dom.bottom,
      editorHeight: dom.height,
      scrollTop: editor.getScrollTop(),
    };
  });
}

/** The plain textarea's caret line, from its value, line height, padding and scroll (wrap="off": lines are exact). */
async function plainCaret(page: Page): Promise<(CaretSnapshot & { line: number }) | null> {
  return page.evaluate(() => {
    const ta = document.querySelector<HTMLTextAreaElement>("[data-editor-root] > textarea");
    if (!ta) return null;
    const head = ta.selectionDirection === "backward" ? ta.selectionStart : ta.selectionEnd;
    const line = ta.value.slice(0, head).split("\n").length;
    const style = getComputedStyle(ta);
    const lineHeight = parseFloat(style.lineHeight);
    const box = ta.getBoundingClientRect();
    const top = box.top + ta.clientTop + parseFloat(style.paddingTop) + (line - 1) * lineHeight - ta.scrollTop;
    const lines = ta.value.split("\n");
    return {
      line,
      column: head - ta.value.lastIndexOf("\n", head - 1),
      lastLine: lines[lines.length - 1] ?? "",
      top,
      bottom: top + lineHeight,
      editorTop: box.top,
      editorBottom: box.bottom,
      editorHeight: box.height,
      scrollTop: ta.scrollTop,
    };
  });
}

/** Monaco's text, through its own API (the AMD global). */
async function monacoValue(page: Page): Promise<string> {
  return page.evaluate(() => {
    const api = (window as unknown as { monaco?: { editor: { getEditors(): { getValue(): string }[] } } }).monaco;
    return api?.editor.getEditors()[0]?.getValue() ?? "";
  });
}

/** The console drawer's top edge in the viewport, or null while it is closed. */
async function consoleTop(page: Page): Promise<number | null> {
  return page.evaluate(() => {
    const drawer = [...document.querySelectorAll("section[aria-labelledby]")].find(
      (s) => s.querySelector("h2")?.textContent?.trim() === "Console",
    );
    const r = drawer?.getBoundingClientRect();
    return r && r.height > 0 ? r.top : null;
  });
}

/** Put keyboard focus back in Monaco without moving its caret (a click would). */
async function focusMonaco(page: Page): Promise<void> {
  await page.evaluate(() => {
    const api = (window as unknown as { monaco?: { editor: { getEditors(): { focus(): void }[] } } }).monaco;
    api?.editor.getEditors()[0]?.focus();
  });
}

const consoleToggle = (page: Page) => page.getByRole("button", { name: "Console", exact: true });
const consoleHeading = (page: Page) => page.getByRole("heading", { name: "Console", level: 2 });

/**
 * The caret line is on screen and not under the console: inside the editor,
 * inside the viewport, and — with the console open — above its top edge.
 */
function expectCaretClear(
  s: Pick<CaretSnapshot, "top" | "bottom" | "editorTop" | "editorBottom"> | null,
  drawerTop: number | null,
  when: string,
) {
  expect.soft(s, `caret readable ${when}`).not.toBeNull();
  if (!s) return;
  expect.soft(s.top, `caret line inside the editor ${when}`).toBeGreaterThanOrEqual(s.editorTop - 0.5);
  expect.soft(s.bottom, `caret line inside the editor ${when}`).toBeLessThanOrEqual(s.editorBottom + 0.5);
  expect.soft(s.top, `caret line inside the viewport ${when}`).toBeGreaterThanOrEqual(0);
  expect.soft(s.bottom, `caret line inside the viewport ${when}`).toBeLessThanOrEqual(VIEWPORT.height);
  if (drawerTop !== null) {
    expect.soft(s.bottom, `caret line above the console overlay ${when} (drawer top ${drawerTop.toFixed(0)} px)`).toBeLessThanOrEqual(
      drawerTop + 0.5,
    );
  }
}

function record(testInfo: TestInfo, name: string, value: string) {
  testInfo.annotations.push({ type: name, description: value });
  console.log(`[perf] ${name}: ${value}`);
}

test.describe("workspace performance (throttled)", () => {
  test.use({ viewport: VIEWPORT });

  test("two-sum: cold and warm load, editor takeover, caret stability, CLS / LCP", async ({ browser }, testInfo) => {
    test.setTimeout(600_000);
    // A first visit has no service worker yet; the app's (production-only)
    // worker serves /_next/static cache-first, which would make "cold" warm.
    const context = await browser.newContext({ viewport: VIEWPORT, serviceWorkers: "block" });
    await context.addInitScript(installProbe);
    const results: Record<string, unknown> = { measuredAt: new Date().toISOString(), baseURL: testInfo.project.use.baseURL };

    // Sign in (unthrottled), then warm the route once so a dev server has
    // compiled it — the cold measurement is about the browser, not the compiler.
    const setup = await context.newPage();
    await signIn(setup);
    await setup.goto(PROBLEM, { waitUntil: "load" });
    await waitForMark(setup, "monaco", 180_000);
    const production = await isProductionBuild(setup);
    await setup.close();
    const enforce = production || process.env.E2E_PERF_ENFORCE === "1";
    results.server = production ? "production build" : "next dev";
    results.enforced = enforce;
    record(testInfo, "server", `${results.server} (timing budgets ${enforce ? "enforced" : "reported only"})`);

    // ── (a)(b)(d) COLD: HTTP cache disabled, throttled ─────────────────
    const cold = await context.newPage();
    const coldNet = await instrument(context, cold, { throttle: true, cache: false });
    await cold.goto(PROBLEM, { waitUntil: "commit", timeout: 180_000 });
    await waitForMark(cold, "textareaTypable", 180_000);
    await waitForMark(cold, "monaco", 180_000);
    await cold.waitForTimeout(1_500); // let late shifts / LCP candidates land
    const coldState = await perfState(cold);
    await expectMonacoStyled(cold);
    const coldCls = clsOf(coldState.shifts);
    const lcpLast = coldState.lcp.at(-1);
    const lcpStatement = [...coldState.lcp].reverse().find((e) => e.inStatement);
    const coldNextJs = coldNet.transfers.filter((t) => /\/_next\/static\/.+\.js(\?|$)/.test(t.url));

    const isMonaco = (t: Transfer) => t.url.includes("/monaco/vs/");
    const sum = (list: Transfer[]) => list.reduce((total, t) => total + t.bytes, 0);
    const coldMonaco = coldNet.transfers.filter(isMonaco);
    results.cold = {
      fcpMs: coldState.fcp,
      textareaVisibleMs: coldState.marks.textareaVisible,
      textareaTypableMs: coldState.marks.textareaTypable,
      monacoInteractiveMs: coldState.marks.monaco,
      lcp: coldState.lcp,
      lcpMs: lcpLast?.time,
      lcpElement: lcpLast?.element,
      lcpStatementMs: lcpStatement?.time,
      lcpStatementElement: lcpStatement?.element,
      cls: coldCls.cls,
      clsTotal: coldCls.total,
      shifts: coldState.shifts,
      nextJsTransferKb: kb(sum(coldNextJs)),
      nextJsFiles: coldNextJs.length,
      monacoTransferKb: kb(sum(coldMonaco)),
      monacoFiles: coldMonaco.map((t) => `${t.url.split("/monaco/vs/")[1]} ${kb(t.bytes)} KB @ ${t.doneMs} ms`),
      totalTransferKb: kb(sum(coldNet.transfers)),
    };
    record(
      testInfo,
      "cold",
      `typable ${Math.round(coldState.marks.textareaTypable ?? -1)} ms (≤ ${BUDGET.textareaTypableMs}), ` +
        `Monaco ${Math.round(coldState.marks.monaco ?? -1)} ms (≤ ${BUDGET.monacoColdMs}), ` +
        `FCP ${Math.round(coldState.fcp ?? -1)} ms, LCP ${Math.round(lcpLast?.time ?? -1)} ms ${lcpLast?.element ?? ""}` +
        `${lcpStatement ? ` (statement ${Math.round(lcpStatement.time)} ms)` : ""}, ` +
        `CLS ${coldCls.cls.toFixed(4)} (total ${coldCls.total.toFixed(4)})`,
    );
    record(
      testInfo,
      "cold transfer",
      `Next JS ${kb(sum(coldNextJs))} KB in ${coldNextJs.length} files, Monaco ${kb(sum(coldMonaco))} KB, ` +
        `all ${kb(sum(coldNet.transfers))} KB`,
    );

    // ── (c) the console overlays the editor; the caret stays above it ──
    const editor = cold.locator("[data-editor-root] .monaco-editor .view-lines");
    const vh = VIEWPORT.height;
    await editor.click();

    // A caret already clear of the drawer: opening the console moves nothing.
    await cold.keyboard.press("Control+Home");
    await cold.waitForTimeout(500);
    const atTop = await caretSnapshot(cold);
    await consoleToggle(cold).click();
    await expect(consoleHeading(cold)).toBeVisible();
    await cold.waitForTimeout(500);
    const atTopConsole = await caretSnapshot(cold);
    expectCaretClear(atTopConsole, await consoleTop(cold), "at the top of the file, console open");
    expect.soft(atTopConsole?.scrollTop, "a caret already clear of the console: the editor does not scroll").toBe(atTop?.scrollTop);
    expect.soft(atTopConsole?.top, "a caret already clear of the console: the caret line does not move").toBeCloseTo(
      atTop?.top ?? Number.NaN,
      0,
    );
    await consoleToggle(cold).click();
    await expect(consoleHeading(cold)).toBeHidden();

    // A caret near the bottom: the console would cover it, so the editor scrolls it clear.
    await focusMonaco(cold);
    await cold.keyboard.press("Control+End");
    for (let i = 0; i < 24; i++) await cold.keyboard.press("Enter");
    await cold.keyboard.type("// perf check", { delay: 20 });
    await cold.waitForTimeout(500);
    const afterTyping = await caretSnapshot(cold);
    await testInfo.attach("after-typing.png", { body: await cold.screenshot(), contentType: "image/png" });
    await consoleToggle(cold).click();
    await expect(consoleHeading(cold)).toBeVisible();
    await cold.waitForTimeout(500);
    const afterConsole = await caretSnapshot(cold);
    const drawerTop = await consoleTop(cold);
    await testInfo.attach("console-open.png", { body: await cold.screenshot(), contentType: "image/png" });
    const occluded = afterConsole !== null && drawerTop !== null && afterConsole.bottom > drawerTop + 0.5;

    // Keep typing with the console open: every new line stays clear of it.
    await focusMonaco(cold);
    const whileOpen: { line: number; top: number; bottom: number; drawerTop: number | null }[] = [];
    for (let i = 1; i <= 8; i++) {
      await cold.keyboard.press("Enter");
      await cold.keyboard.type(`// console open ${i}`, { delay: 10 });
      await cold.waitForTimeout(250);
      const s = await caretSnapshot(cold);
      const top = await consoleTop(cold);
      if (s) whileOpen.push({ line: s.line, top: Math.round(s.top), bottom: Math.round(s.bottom), drawerTop: top && Math.round(top) });
      expectCaretClear(s, top, `typing with the console open (line ${i})`);
    }
    await testInfo.attach("typing-console-open.png", { body: await cold.screenshot(), contentType: "image/png" });

    results.caret = { atTop, atTopConsole, afterTyping, afterConsole, drawerTop, occludedByConsole: occluded, whileOpen };
    record(
      testInfo,
      "caret",
      `line ${afterTyping?.line}:${afterTyping?.column}, bottom ${afterTyping?.bottom.toFixed(0)} px in the editor's ` +
        `${afterTyping?.editorTop.toFixed(0)}–${afterTyping?.editorBottom.toFixed(0)} px (viewport ${vh}); ` +
        `console open: drawer top ${drawerTop?.toFixed(0)} px, caret line ${afterConsole?.top.toFixed(0)}–${afterConsole?.bottom.toFixed(0)} px, ` +
        `editor ${afterTyping?.editorHeight.toFixed(0)} → ${afterConsole?.editorHeight.toFixed(0)} px tall, ` +
        `scrollTop ${afterTyping?.scrollTop} → ${afterConsole?.scrollTop}; caret line under the console: ${occluded ? "YES" : "no"}; ` +
        `8 more lines typed with it open, lowest caret bottom ${Math.max(...whileOpen.map((w) => w.bottom))} px`,
    );
    expect.soft(afterTyping?.lastLine, "the typed text landed in Monaco").toContain("// perf check");
    expectCaretClear(afterTyping, null, "after typing");
    expectCaretClear(afterConsole, drawerTop, "with the console open");
    expect.soft(occluded, "the caret line is not under the console overlay").toBe(false);
    expect.soft(afterConsole?.editorHeight, "the console overlays the editor; it never squeezes it").toBeCloseTo(
      afterTyping?.editorHeight ?? Number.NaN,
      0,
    );

    // Put the student's code back (the typed lines are a real draft).
    await cold.keyboard.press("Escape");
    await cold.getByRole("button", { name: "Reset to starter code" }).click();
    await cold.getByRole("button", { name: "Reset code" }).click();
    await cold.waitForTimeout(4_000); // the 3 s server draft save
    // Everything /monaco/vs served over the whole cold session (typing included).
    results.monacoSessionFiles = coldNet.transfers
      .filter(isMonaco)
      .map((t) => `${t.url.split("/monaco/vs/")[1]} ${kb(t.bytes)} KB @ ${t.doneMs} ms`);
    record(testInfo, "Monaco files (cold session)", (results.monacoSessionFiles as string[]).join(", "));
    // Each /monaco/vs file crosses the wire once (preloads are consumed, not repeated).
    const monacoUrls = coldNet.transfers.filter(isMonaco).map((t) => t.url);
    expect(monacoUrls.filter((url, i) => monacoUrls.indexOf(url) !== i), "Monaco files fetched twice").toEqual([]);
    await coldNet.cdp.detach();
    await cold.close();

    // ── (b) WARM: static assets in the HTTP cache (primed unthrottled), ──
    // measured throttled. The service worker stays blocked: its fetches are
    // not covered by the page's network throttling, which would flatter
    // the number.
    const prime = await context.newPage();
    await prime.goto(PROBLEM, { waitUntil: "load" });
    await waitForMark(prime, "monaco", 180_000);
    await prime.waitForTimeout(2_000);
    await prime.close();

    const warm = await context.newPage();
    const warmNet = await instrument(context, warm, { throttle: true, cache: true });
    await warm.goto(PROBLEM, { waitUntil: "commit", timeout: 180_000 });
    await waitForMark(warm, "textareaTypable", 180_000);
    await waitForMark(warm, "monaco", 180_000);
    await warm.waitForTimeout(1_000);
    const warmState = await perfState(warm);
    await expectMonacoStyled(warm);
    const warmCls = clsOf(warmState.shifts);
    results.warm = {
      textareaTypableMs: warmState.marks.textareaTypable,
      monacoInteractiveMs: warmState.marks.monaco,
      lcpMs: warmState.lcp.at(-1)?.time,
      cls: warmCls.cls,
      shifts: warmState.shifts,
      networkKb: kb(sum(warmNet.transfers)),
    };
    record(
      testInfo,
      "warm",
      `typable ${Math.round(warmState.marks.textareaTypable ?? -1)} ms, Monaco ${Math.round(warmState.marks.monaco ?? -1)} ms ` +
        `(≤ ${BUDGET.monacoWarmMs}), CLS ${warmCls.cls.toFixed(4)}, ${kb(sum(warmNet.transfers))} KB over the wire`,
    );
    await warmNet.cdp.detach();
    await warm.close();
    await context.close();

    for (const [name, state] of [["cold", coldState], ["warm", warmState]] as const) {
      const notable = state.shifts.filter((s) => s.value >= 0.005);
      if (notable.length === 0) continue;
      record(
        testInfo,
        `${name} layout shifts`,
        notable.map((s) => `${s.value.toFixed(4)} @ ${Math.round(s.time)} ms: ${s.sources.join("; ")}`).join(" | "),
      );
    }

    const json = JSON.stringify(results, null, 2);
    await testInfo.attach("perf-workspace.json", { body: json, contentType: "application/json" });
    if (process.env.E2E_PERF_OUT) writeFileSync(process.env.E2E_PERF_OUT, json);

    // ── (e) the fallback is typable before Monaco arrives ──────────────
    for (const [name, state] of [["cold", coldState], ["warm", warmState]] as const) {
      expect(state.marks.textareaTypable, `textarea typable (${name})`).toBeDefined();
      expect(state.marks.textareaTypable ?? Infinity, `textarea typable before Monaco (${name})`).toBeLessThan(
        state.marks.monaco ?? -Infinity,
      );
    }

    // ── Budgets (soft: every number is checked and reported) ───────────
    expect.soft(coldCls.cls, "CLS (cold) ≤ 0.05").toBeLessThanOrEqual(BUDGET.cls);
    expect.soft(warmCls.cls, "CLS (warm) ≤ 0.05").toBeLessThanOrEqual(BUDGET.cls);
    if (enforce) {
      expect.soft(coldState.marks.textareaTypable ?? Infinity, "textarea typable (cold) ≤ 2.5 s").toBeLessThanOrEqual(
        BUDGET.textareaTypableMs,
      );
      expect.soft(coldState.marks.monaco ?? Infinity, "Monaco interactive (cold) ≤ 7 s").toBeLessThanOrEqual(BUDGET.monacoColdMs);
      expect.soft(warmState.marks.monaco ?? Infinity, "Monaco interactive (warm) ≤ 4 s").toBeLessThanOrEqual(BUDGET.monacoWarmMs);
    }
  });

  test("plain-textarea fallback (Monaco unavailable): typable, and its caret stays above the console", async ({
    browser,
  }, testInfo) => {
    test.setTimeout(300_000);
    const context = await browser.newContext({ viewport: VIEWPORT, serviceWorkers: "block" });
    const page = await context.newPage();
    await signIn(page);
    // Monaco never arrives: the textarea is the editor for the whole test.
    await page.route("**/monaco/vs/**", (route) => route.abort());
    await page.goto(PROBLEM, { waitUntil: "load" });
    const textarea = page.locator("[data-editor-root] > textarea");
    await expect(textarea).toBeVisible();
    await expect
      .poll(() => textarea.evaluate((el) => Object.keys(el).some((k) => k.startsWith("__reactProps$"))), {
        message: "the textarea is hydrated (typable)",
        timeout: 60_000,
      })
      .toBe(true);

    await textarea.click();
    await page.keyboard.press("Control+End");
    for (let i = 0; i < 24; i++) await page.keyboard.press("Enter");
    await page.keyboard.type("// plain check", { delay: 10 });
    await expect(textarea, "typing lands in the plain textarea").toHaveValue(/\/\/ plain check$/);
    const before = await plainCaret(page);
    await consoleToggle(page).click();
    await expect(consoleHeading(page)).toBeVisible();
    await page.waitForTimeout(500);
    const opened = await plainCaret(page);
    const drawerTop = await consoleTop(page);
    const box = await textarea.evaluate((el) => ({
      style: el.getAttribute("style"),
      scrollTop: el.scrollTop,
      scrollHeight: el.scrollHeight,
      clientHeight: el.clientHeight,
    }));
    record(testInfo, "plain textarea box (console open)", JSON.stringify(box));
    // The browser's own caret reveal may leave the line box's half-leading
    // (2 px) under the textarea's edge; the console check below is exact.
    expectCaretClear(before && { ...before, bottom: before.bottom - 2 }, null, "plain textarea, after typing");
    expectCaretClear(opened, drawerTop, "plain textarea, console open");
    expect.soft(opened?.editorHeight, "the console overlays the textarea; it never squeezes it").toBeCloseTo(
      before?.editorHeight ?? Number.NaN,
      0,
    );

    // Keep typing with the console open (focus() keeps the textarea's caret where it was).
    await textarea.focus();
    for (let i = 1; i <= 8; i++) {
      await page.keyboard.press("Enter");
      await page.keyboard.type(`// console open ${i}`, { delay: 10 });
      await page.waitForTimeout(150);
      expectCaretClear(await plainCaret(page), await consoleTop(page), `plain textarea, typing with the console open (line ${i})`);
    }
    await expect(page.locator("[data-editor-root]"), "Monaco was blocked: still the plain editor").toHaveAttribute(
      "data-editor",
      "plain",
    );
    record(
      testInfo,
      "plain textarea caret",
      `line ${opened?.line}: ${before?.top.toFixed(0)}–${before?.bottom.toFixed(0)} px → console open ` +
        `${opened?.top.toFixed(0)}–${opened?.bottom.toFixed(0)} px, drawer top ${drawerTop?.toFixed(0)} px, ` +
        `textarea ${before?.editorHeight.toFixed(0)} → ${opened?.editorHeight.toFixed(0)} px tall`,
    );

    await page.getByRole("button", { name: "Reset to starter code" }).click();
    await page.getByRole("button", { name: "Reset code" }).click();
    await page.waitForTimeout(4_000); // the 3 s server draft save
    await context.close();
  });

  test("throttled solve, start to finish: textarea first, then Monaco; Run and Submit Accepted; caret above the console throughout", async ({
    browser,
  }, testInfo) => {
    test.skip(!JUDGE, "needs a live judge (E2E_JUDGE=1)");
    test.setTimeout(900_000);
    const context = await browser.newContext({ viewport: VIEWPORT, serviceWorkers: "block" });
    await context.addInitScript(installProbe);
    const setup = await context.newPage();
    await signIn(setup);
    await setup.close();

    // Throttled from the first byte of the problem page to the last verdict.
    const page = await context.newPage();
    const net = await instrument(context, page, { throttle: true, cache: true });
    await page.goto(PROBLEM, { waitUntil: "commit", timeout: 180_000 });

    // The fallback is typable before Monaco: type into it while it is still the editor.
    await waitForMark(page, "textareaTypable", 180_000);
    const root = page.locator("[data-editor-root]");
    const plainFirst = (await root.getAttribute("data-editor")) === "plain";
    expect.soft(plainFirst, "the plain textarea is the editor when it becomes typable (Monaco not there yet)").toBe(true);
    // Monaco may take over while this is being typed: CodeEditor hands it the
    // textarea's text and caret, and the rest of the keystrokes land in Monaco.
    let typedInTextarea = false;
    if (plainFirst) {
      try {
        await page.locator("[data-editor-root] > textarea").focus({ timeout: 10_000 });
        typedInTextarea = true;
      } catch (error) {
        // Monaco replaced the textarea between the check and the focus.
        record(testInfo, "textarea focus", error instanceof Error ? error.message.split("\n")[0]! : String(error));
      }
      if (typedInTextarea) {
        await page.keyboard.press("Control+Home");
        await page.keyboard.type("# typed before Monaco\n", { delay: 20 });
      }
    }
    await waitForMark(page, "monaco", 300_000);
    const marks = (await perfState(page)).marks;
    expect(marks.textareaTypable ?? Infinity, "textarea typable before Monaco").toBeLessThan(marks.monaco ?? -Infinity);
    if (typedInTextarea) {
      await expect
        .poll(() => monacoValue(page), { message: "nothing typed into the textarea was lost when Monaco took over" })
        .toMatch(/^# typed before Monaco\n/);
    }

    // Write the solution in Python 3.12: comment lines first, so the caret ends low in the editor.
    await page.getByLabel("Language", { exact: true }).selectOption("py312");
    const source = [
      ...Array.from({ length: 30 }, (_, i) => `# throttled solve, note ${i + 1}`),
      SOLUTION_PY,
    ].join("\n");
    await page.locator("[data-editor-root] .monaco-editor .view-lines").click();
    await page.keyboard.press("ControlOrMeta+A");
    await page.keyboard.insertText(source);
    await expect.poll(() => monacoValue(page), { message: "the editor holds the solution", timeout: 60_000 }).toBe(source);
    await page.waitForTimeout(500); // the draft-status row may re-wrap under the editor; let layout settle
    const typed = await caretSnapshot(page);
    expectCaretClear(typed, null, "after writing the solution");

    // Watch the caret against the console while judging runs.
    const samples: { at: string; bottom: number; drawerTop: number | null }[] = [];
    const watch = async (phase: string, until: () => Promise<boolean>) => {
      const deadline = Date.now() + 240_000;
      while (Date.now() < deadline && !(await until())) {
        const s = await caretSnapshot(page);
        const top = await consoleTop(page);
        if (s) samples.push({ at: phase, bottom: Math.round(s.bottom), drawerTop: top === null ? null : Math.round(top) });
        expectCaretClear(s, top, `while ${phase}`);
        await page.waitForTimeout(500);
      }
    };
    const announced = (kind: "Run" | "Submission") =>
      page.locator('p[role="status"][aria-live="polite"]').filter({ hasText: new RegExp(`^${kind} result`) });

    await page.getByRole("button", { name: "Run", exact: true }).click();
    await watch("running", async () => (await announced("Run").count()) > 0);
    await expect(announced("Run")).toHaveText(/^Run result: Accepted\./, { timeout: 180_000 });
    expectCaretClear(await caretSnapshot(page), await consoleTop(page), "after the Run verdict");
    await testInfo.attach("solve-run.png", { body: await page.screenshot(), contentType: "image/png" });

    await page.getByRole("button", { name: "Submit", exact: true }).click();
    await watch("submitting", async () => (await announced("Submission").count()) > 0);
    await expect(announced("Submission")).toHaveText(/^Submission result: Accepted\./, { timeout: 180_000 });
    const final = await caretSnapshot(page);
    const drawerTop = await consoleTop(page);
    expectCaretClear(final, drawerTop, "after the accepted submission");
    expect(drawerTop, "the console is open over the editor").not.toBeNull();
    await testInfo.attach("solve-accepted.png", { body: await page.screenshot(), contentType: "image/png" });

    const occludedSamples = samples.filter((s) => s.drawerTop !== null && s.bottom > s.drawerTop + 0.5);
    record(
      testInfo,
      "throttled solve",
      `typable ${Math.round(marks.textareaTypable ?? -1)} ms, Monaco ${Math.round(marks.monaco ?? -1)} ms ` +
        `(textarea was the editor when typable: ${plainFirst ? "yes" : "no"}; typed into it before Monaco: ${typedInTextarea ? "yes" : "no"}); Run Accepted, Submit Accepted; ` +
        `caret checked ${samples.length + 3} times, ${samples.filter((s) => s.drawerTop !== null).length} with the console open, ` +
        `${occludedSamples.length} under it; final caret bottom ${final?.bottom.toFixed(0)} px, drawer top ${drawerTop?.toFixed(0)} px`,
    );
    if (process.env.E2E_PERF_OUT) {
      writeFileSync(
        process.env.E2E_PERF_OUT.replace(/(\.json)?$/, "-solve.json"),
        JSON.stringify({ measuredAt: new Date().toISOString(), marks, plainFirst, typedInTextarea, typed, final, drawerTop, samples }, null, 2),
      );
    }
    expect(occludedSamples, "the caret line was never under the console").toEqual([]);

    // The draft goes back to the starter code; the accepted submission stays.
    await page.getByRole("button", { name: "Reset to starter code" }).click();
    await page.getByRole("button", { name: "Reset code" }).click();
    await page.waitForTimeout(4_000);
    await net.cdp.detach();
    await context.close();
  });
});
