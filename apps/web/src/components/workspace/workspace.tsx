"use client";

import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Panel, PanelGroup, PanelResizeHandle } from "react-resizable-panels";
import {
  ChevronDown,
  ChevronUp,
  Check,
  CloudOff,
  Loader2,
  Maximize2,
  Minimize2,
  Play,
  RotateCcw,
  Send,
  TerminalSquare,
} from "lucide-react";
import { Button, Dialog, EmptyState, Select, cn, useToast } from "@recx/design";
import { VERDICT_LABEL, utf8Length, type LanguageKey } from "@recx/shared";
import { CodeEditor } from "@/components/editor/code-editor";
import {
  EDITOR_DEFAULT_PERCENT,
  FOCUS_SHORTCUT,
  MEDIA,
  STATEMENT_DEFAULT_PERCENT,
  editorKeyHint,
  editorMinPercent,
  statementMinPercent,
  type Density,
  type EditorKind,
  type MobileTab,
} from "@/components/workspace/layout";
import { LanguageVersion } from "@/components/workspace/language-version";
import { ResultConsole, type ConsoleTab, type CustomInputState } from "@/components/workspace/result-console";
import { RestoreBar } from "@/components/workspace/restore-bar";
import { TabStrip, type TabStripItem } from "@/components/workspace/tab-strip";
import { WorkspaceContext, type WorkspaceActions } from "@/components/workspace/workspace-context";
import { useDrafts, type InitialServerDraft } from "@/hooks/use-drafts";
import { useFocusMode } from "@/hooks/use-focus-mode";
import { useMediaQuery } from "@/hooks/use-media-query";
import { useVerdictStream, type JudgeTarget } from "@/hooks/use-verdict-stream";
import { isApplePlatform } from "@/lib/drafts/browser";
import { saveStatus } from "@/lib/drafts/status";
import { judgeLanguageHref } from "@/lib/judge/judge-links";
import { MAX_CUSTOM_INPUT_BYTES, MAX_SOURCE_BYTES } from "@/lib/judge/submit-schema";
import type { StudentView } from "@/lib/judge/view";
import type { WorkspaceLanguage } from "@/server/queries/problems";
import { runCode, submitSolution } from "@/server/actions/judge";

type StatementTab = "description" | "editorial" | "submissions" | "hints" | "assistant";
/** Always present; "assistant" is optional and its tab exists only when it is given. */
type FixedStatementTab = Exclude<StatementTab, "assistant">;

/** "C++20 (GCC 13.2.0)" → "C++20" for the compact language picker. */
function shortName(label: string): string {
  return label.split(" (")[0] ?? label;
}

/** The single aria-live announcement: the final verdict only, never per test. */
function announce(view: StudentView): string {
  const what = view.kind === "submission" ? "Submission" : "Run";
  if (view.kind === "run" && view.isCustom && view.verdict === "AC") return `${what} finished.`;
  const label = VERDICT_LABEL[view.display];
  if (view.kind === "submission" && view.verdict !== "CE" && view.total > 0) {
    return `${what} result: ${label}. Passed ${view.passed} of ${view.total} tests.`;
  }
  return `${what} result: ${label}.`;
}

/**
 * The coding workspace (Phase 3).
 *
 *   ≥ 1024 px   statement 38 % | editor 62 % (resizable, keyboard too; the
 *               editor never below 380 px). The console is an overlay drawer
 *               over the bottom of the editor — the editor never shrinks.
 *   < 1024 px   one column, three tabs: Problem / Code / Result.
 *   < 768 px    CodeMirror 6 instead of Monaco (chosen by CodeEditor).
 *   < 700 px    tall: data-density="compact" (controls 36 → 30 px).
 *   Ctrl+Shift+F  focus mode: statement and app chrome hidden; Esc or the
 *               shortcut again leaves.
 *
 * One tree for every width, so nothing remounts (the editor never reloads)
 * when the viewport crosses a breakpoint, and the server-rendered HTML is
 * already laid out by CSS before hydration. The statement-side panels are
 * server-rendered and passed in.
 */
export function Workspace({
  problemId,
  slug,
  languages,
  initialLanguage,
  serverDrafts,
  sampleIndexes,
  defaultCustomInput,
  customHint,
  header,
  panels,
  submissionCount,
  judgeLink = true,
}: {
  problemId: string;
  slug: string;
  languages: WorkspaceLanguage[];
  /** The language to open in (cookie preference, else the newest draft's). */
  initialLanguage: LanguageKey | null;
  /** The viewer's server CodeDrafts for this problem. */
  serverDrafts: InitialServerDraft[];
  sampleIndexes: number[];
  defaultCustomInput: string;
  customHint: string;
  /** Server-rendered title row (h1, difficulty, solve status, bookmark). */
  header: React.ReactNode;
  /** Server-rendered statement-side tabs. */
  /**
   * The statement-side tabs. `assistant` is optional on purpose: a surface
   * that serves no AI helper (a contest, an exam) passes none and gets no
   * tab at all, rather than a disabled one. A door a student cannot open is
   * still a door.
   */
  panels: Record<FixedStatementTab, React.ReactNode> & { assistant?: React.ReactNode };
  submissionCount: number;
  /** Footer language links to /judge in a new tab; the arena and attempt surfaces pass false. */
  judgeLink?: boolean;
}) {
  const router = useRouter();
  const { toast } = useToast();
  const baseId = useId();
  const consoleId = `${baseId}-console`;
  const hintId = `${baseId}-editor-keys`;
  const rootRef = useRef<HTMLDivElement>(null);

  // ── Viewport ──────────────────────────────────────────────────────────
  const wide = useMediaQuery(MEDIA.wide, true);
  const compact = useMediaQuery(MEDIA.compact, false);
  // MEDIA.compact is densityFor()'s threshold as a media query.
  const density: Density = compact ? "compact" : "comfortable";
  const focus = useFocusMode(rootRef);

  // ── Code and drafts ───────────────────────────────────────────────────
  const drafts = useDrafts({ problemId, slug, languages, serverDrafts, initialLanguage });
  const { language, source } = drafts;
  const byKey = useMemo(() => new Map(languages.map((l) => [l.key, l])), [languages]);
  const active = language ? byKey.get(language) : undefined;
  const [resetOpen, setResetOpen] = useState(false);
  const status = saveStatus(drafts.sync);

  const [editorKind, setEditorKind] = useState<EditorKind>("monaco");
  const [apple, setApple] = useState(false);
  useEffect(() => setApple(isApplePlatform()), []);
  const keyHint = editorKeyHint(editorKind, apple);

  // ── Tabs ──────────────────────────────────────────────────────────────
  const [statementTab, setStatementTab] = useState<StatementTab>("description");
  const [mobileTab, setMobileTab] = useState<MobileTab>("problem");
  const hasAssistant = panels.assistant !== undefined;
  const statementItems = useMemo<TabStripItem<StatementTab>[]>(() => {
    const items: [StatementTab, string][] = [
      ["description", "Description"],
      ["editorial", "Editorial"],
      ["submissions", submissionCount > 0 ? `Submissions (${submissionCount})` : "Submissions"],
      ["hints", "Hints"],
    ];
    if (hasAssistant) items.push(["assistant", "Assistant"]);
    return items.map(([value, label]) => ({
      value,
      label,
      tabId: `${baseId}-st-${value}`,
      panelId: `${baseId}-sp-${value}`,
    }));
  }, [baseId, hasAssistant, submissionCount]);
  const mobileItems = useMemo<TabStripItem<MobileTab>[]>(
    () =>
      (
        [
          ["problem", "Problem", `${baseId}-problem`],
          ["code", "Code", `${baseId}-code`],
          ["result", "Result", consoleId],
        ] as const
      ).map(([value, label, panelId]) => ({ value, label, panelId, tabId: `${baseId}-mt-${value}` })),
    [baseId, consoleId],
  );
  /** Narrow screens: these regions are tab panels of the Problem / Code / Result tabs. */
  const mobilePanel = (tab: MobileTab) =>
    wide ? {} : { role: "tabpanel" as const, "aria-labelledby": `${baseId}-mt-${tab}` };

  // ── Judge ─────────────────────────────────────────────────────────────
  const [target, setTarget] = useState<JudgeTarget | null>(null);
  const [sending, setSending] = useState<"submission" | "run" | null>(null);
  const stream = useVerdictStream(target);
  const [consoleOpen, setConsoleOpen] = useState(false);
  const [consoleTab, setConsoleTab] = useState<ConsoleTab>("result");
  const [custom, setCustom] = useState<CustomInputState>({ enabled: false, text: defaultCustomInput });
  const [announcement, setAnnouncement] = useState("");

  const toggleRef = useRef<HTMLButtonElement>(null);
  const consoleHeadingRef = useRef<HTMLHeadingElement>(null);
  const focusConsoleOnOpen = useRef(false);

  /** Show the console: the overlay on wide screens, the Result tab on narrow ones. */
  const openConsole = useCallback(
    (moveFocus: boolean) => {
      if (moveFocus) focusConsoleOnOpen.current = true;
      setConsoleOpen(true);
      if (!wide) setMobileTab("result");
    },
    [wide],
  );

  useEffect(() => {
    if ((consoleOpen || mobileTab === "result") && focusConsoleOnOpen.current) {
      focusConsoleOnOpen.current = false;
      consoleHeadingRef.current?.focus();
    }
  });

  const closeConsole = useCallback(() => {
    setConsoleOpen(false);
    toggleRef.current?.focus();
  }, []);

  // ── Console overlay vs the caret ──────────────────────────────────────
  // The drawer floats over the bottom of the editor and never resizes it.
  // How many pixels of the editor it covers is measured here and handed to
  // the editor, which keeps the caret line above it (CodeEditor's
  // occludedBottom). Narrow screens: the console is a tab, not an overlay
  // (it is not absolutely positioned there), so it covers nothing.
  const editorAreaRef = useRef<HTMLDivElement>(null);
  const [occludedBottom, setOccludedBottom] = useState(0);
  useEffect(() => {
    const area = editorAreaRef.current;
    const drawer = consoleOpen ? document.getElementById(consoleId) : null;
    if (!area || !drawer) {
      setOccludedBottom(0);
      return;
    }
    const measure = () => {
      const covered =
        getComputedStyle(drawer).position === "absolute" && drawer.offsetHeight > 0
          ? Math.max(0, area.getBoundingClientRect().bottom - drawer.getBoundingClientRect().top)
          : 0;
      setOccludedBottom(Math.round(covered));
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(area);
    observer.observe(drawer);
    return () => observer.disconnect();
  }, [consoleOpen, consoleId]);

  const showResult = useCallback(
    (next: JudgeTarget) => {
      setTarget(next);
      setConsoleTab("result");
      openConsole(true);
    },
    [openConsole],
  );
  const actions = useMemo<WorkspaceActions>(() => ({ showResult }), [showResult]);

  // Final verdict: announce it once, and refresh the server-rendered panels
  // (Submissions, solve status, hint unlocks).
  const finishedKey = useRef<string | null>(null);
  useEffect(() => {
    const view = stream.view;
    if (stream.phase !== "done" || !view?.terminal || !target) return;
    // On the render where `target` changes, the stream still holds the
    // previous job's finished view (its reset runs in an effect). Only a view
    // of this target may be announced, or a Submit right after a Run would
    // announce the Run again and mark the submission as already announced.
    if (view.kind !== target.kind || view.id !== target.id) return;
    const key = `${target.kind}:${target.id}`;
    if (finishedKey.current === key) return;
    finishedKey.current = key;
    setAnnouncement(announce(view));
    if (view.kind === "submission") router.refresh();
  }, [stream.phase, stream.view, target, router]);

  function preflight(): boolean {
    if (source.trim().length === 0) {
      toast("Write some code first.", "warning");
      return false;
    }
    if (utf8Length(source) > MAX_SOURCE_BYTES) {
      toast("Your code is larger than 256 KB. Trim it down and try again.", "error");
      return false;
    }
    return true;
  }

  async function submit() {
    if (!language || sending || !preflight()) return;
    setSending("submission");
    setConsoleTab("result");
    openConsole(false);
    drafts.flush();
    try {
      const result = await submitSolution({ slug, language, source });
      if (result.ok) setTarget({ kind: "submission", id: result.data.id });
      else toast(result.error, "error");
    } catch {
      toast("Could not reach the server. Check your connection and try again.", "error");
    } finally {
      setSending(null);
    }
  }

  async function run() {
    if (!language || sending || !preflight()) return;
    const customInput = custom.enabled ? custom.text : null;
    if (customInput !== null && utf8Length(customInput) > MAX_CUSTOM_INPUT_BYTES) {
      toast("Custom input is larger than 64 KB. Use a smaller input and try again.", "error");
      return;
    }
    setSending("run");
    setConsoleTab("result");
    openConsole(false);
    drafts.flush();
    try {
      const result = await runCode({ slug, language, source, customInput });
      if (result.ok) setTarget({ kind: "run", id: result.data.id });
      else toast(result.error, "error");
    } catch {
      toast("Could not reach the server. Check your connection and try again.", "error");
    } finally {
      setSending(null);
    }
  }

  function confirmReset() {
    setResetOpen(false);
    drafts.reset();
  }

  // ── Pane sizes (percent of the group, for pixel floors) ───────────────
  const groupBoxRef = useRef<HTMLDivElement>(null);
  const [groupWidth, setGroupWidth] = useState(1280);
  useEffect(() => {
    const el = groupBoxRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width;
      if (width) setGroupWidth(width);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const control = "h-(--ws-ctl)!";
  const iconControl = "h-(--ws-ctl)! w-(--ws-ctl)!";
  /** Run / Submit while a request is in flight: looks disabled, keeps focus. */
  const busyClass = "aria-disabled:cursor-not-allowed aria-disabled:opacity-55";

  // ── Statement side ────────────────────────────────────────────────────
  const statementPane = (
    <section
      id={`${baseId}-problem`}
      aria-label="Problem"
      {...mobilePanel("problem")}
      className="flex h-full min-h-0 flex-col overflow-hidden rounded-2xl border border-border bg-surface shadow-card"
    >
      <TabStrip
        label="Problem details"
        items={statementItems}
        value={statementTab}
        onChange={setStatementTab}
        className="scroll-thin shrink-0 overflow-x-auto border-b border-border px-2 py-1"
      />
      <div className="scroll-thin min-h-0 flex-1 overflow-y-auto">
        {statementItems.map((item) => (
          <div
            key={item.value}
            role="tabpanel"
            id={item.panelId}
            aria-labelledby={item.tabId}
            hidden={statementTab !== item.value}
            tabIndex={0}
            className="p-4 outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary/40 lg:p-5"
          >
            {panels[item.value]}
          </div>
        ))}
      </div>
    </section>
  );

  // ── Editor side ───────────────────────────────────────────────────────
  const editorPane =
    !language || !active ? (
      <div className="flex h-full items-center justify-center rounded-2xl border border-border bg-surface p-6 shadow-card">
        <EmptyState
          title="No languages available"
          description="No judge language is enabled for this problem right now. Please check back later."
        />
      </div>
    ) : (
      <section
        aria-label="Code"
        className="flex h-full min-h-0 flex-col overflow-hidden rounded-2xl border border-border bg-surface shadow-card"
      >
        <div className="flex min-h-(--ws-bar) shrink-0 flex-wrap items-center gap-1.5 border-b border-border px-2 py-1">
          <label className="sr-only" htmlFor={`${baseId}-language`}>
            Language
          </label>
          <div className="w-32 shrink-0">
            {/* Toolbar size: the shared field padding is overridden here only. */}
            <Select
              id={`${baseId}-language`}
              value={language}
              onChange={(e) => drafts.changeLanguage(e.target.value as LanguageKey)}
              className={cn(control, "rounded-lg! py-0! pl-2.5! text-sm")}
            >
              {languages.map((l) => (
                <option key={l.key} value={l.key}>
                  {shortName(l.label)}
                </option>
              ))}
            </Select>
          </div>
          <Button
            variant="ghost"
            size="sm"
            className={cn(control, "px-2!")}
            aria-label="Reset to starter code"
            onClick={() => setResetOpen(true)}
          >
            <RotateCcw className="h-4 w-4" aria-hidden />
            <span className="hidden xl:inline" aria-hidden>
              Reset
            </span>
          </Button>
          <div className="ml-auto flex items-center gap-1.5">
            <Button
              variant="ghost"
              size="icon"
              className={iconControl}
              aria-label="Focus mode"
              aria-pressed={focus.on}
              aria-keyshortcuts="Control+Shift+F"
              title={`${focus.on ? "Leave" : "Enter"} focus mode (${FOCUS_SHORTCUT})`}
              onClick={focus.toggle}
            >
              {focus.on ? (
                <Minimize2 className="h-4 w-4" aria-hidden />
              ) : (
                <Maximize2 className="h-4 w-4" aria-hidden />
              )}
            </Button>
            {/* aria-disabled, not disabled, while a request is in flight: a
                focused button that disables itself drops keyboard focus to
                <body> (WCAG 2.4.3). run() / submit() ignore presses meanwhile. */}
            <Button
              variant="outline"
              size="sm"
              className={cn(control, busyClass)}
              onClick={run}
              aria-disabled={sending !== null || undefined}
            >
              {sending === "run" ? (
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
              ) : (
                <Play className="h-4 w-4" aria-hidden />
              )}
              {custom.enabled ? "Run custom" : "Run"}
            </Button>
            <Button size="sm" className={cn(control, busyClass)} onClick={submit} aria-disabled={sending !== null || undefined}>
              {sending === "submission" ? (
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
              ) : (
                <Send className="h-4 w-4" aria-hidden />
              )}
              Submit
            </Button>
          </div>
        </div>

        {drafts.offer && (
          <RestoreBar offer={drafts.offer} onRestore={drafts.applyOffer} onDismiss={drafts.dismissOffer} />
        )}

        {/* The editor keeps its full size; the console overlays it (wide) or
            replaces it as the Result tab (narrow). */}
        <div ref={editorAreaRef} className="relative min-h-0 flex-1">
          <div
            id={`${baseId}-code`}
            {...mobilePanel("code")}
            className={cn("h-full", mobileTab === "result" && "max-lg:hidden")}
            onBlur={(e) => {
              if (!e.currentTarget.contains(e.relatedTarget as Node | null)) drafts.flush();
            }}
          >
            <CodeEditor
              value={source}
              onChange={drafts.setSource}
              language={active.editorLanguage}
              label={`Code editor, ${active.label}`}
              describedBy={hintId}
              onKind={setEditorKind}
              occludedBottom={occludedBottom}
            />
          </div>
          <ResultConsole
            ref={consoleHeadingRef}
            id={consoleId}
            open={consoleOpen}
            tabActive={mobileTab === "result"}
            dismissible={wide}
            onClose={closeConsole}
            tab={consoleTab}
            onTabChange={setConsoleTab}
            target={target}
            sending={sending}
            stream={stream}
            sampleIndexes={sampleIndexes}
            custom={custom}
            onCustomChange={setCustom}
            customHint={customHint}
          />
        </div>

        <div className="flex min-h-8 shrink-0 flex-wrap items-center gap-x-3 gap-y-0.5 border-t border-border px-2 py-1 text-xs">
          <button
            ref={toggleRef}
            type="button"
            aria-expanded={consoleOpen}
            aria-controls={consoleId}
            onClick={() => (consoleOpen ? closeConsole() : openConsole(true))}
            className="inline-flex h-(--ws-ctl-sm) items-center gap-1.5 rounded-md px-2 font-medium text-text-secondary transition-colors hover:bg-primary-subtle hover:text-text max-lg:hidden"
          >
            <TerminalSquare className="h-3.5 w-3.5" aria-hidden />
            Console
            {consoleOpen ? (
              <ChevronDown className="h-3.5 w-3.5" aria-hidden />
            ) : (
              <ChevronUp className="h-3.5 w-3.5" aria-hidden />
            )}
          </button>
          {status && (
            <span
              className={cn(
                "inline-flex min-w-0 items-center gap-1",
                status.tone === "warn" ? "font-medium text-text" : "text-muted",
              )}
            >
              {status.tone === "warn" ? (
                <CloudOff className="h-3.5 w-3.5 shrink-0 text-warning" aria-hidden />
              ) : (
                <Check className="h-3.5 w-3.5 shrink-0" aria-hidden />
              )}
              <span className="truncate">{status.label}</span>
            </span>
          )}
          {keyHint && (
            // Visible from 768 px; on phones it still describes the editor for screen readers.
            <span id={hintId} className="sr-only text-muted md:not-sr-only">
              {keyHint}
            </span>
          )}
          <LanguageVersion
            label={active.label}
            version={active.version}
            href={judgeLink ? judgeLanguageHref(active.key) : null}
          />
        </div>
      </section>
    );

  return (
    <WorkspaceContext.Provider value={actions}>
      <div
        ref={rootRef}
        data-density={density}
        data-focus-mode={focus.on ? "" : undefined}
        className={cn(
          // Control and bar sizes: 36 / 44 px, compact 30 / 36 px — never below 30 px.
          "flex min-h-0 flex-1 flex-col gap-2 [--ws-bar:2.75rem] [--ws-ctl-sm:2rem] [--ws-ctl:2.25rem]",
          "data-[density=compact]:gap-1.5 data-[density=compact]:[--ws-bar:2.25rem] data-[density=compact]:[--ws-ctl-sm:1.875rem] data-[density=compact]:[--ws-ctl:1.875rem]",
          // The same before hydration (data-density is set by script).
          "[@media(max-height:699px)]:[--ws-bar:2.25rem] [@media(max-height:699px)]:[--ws-ctl-sm:1.875rem] [@media(max-height:699px)]:[--ws-ctl:1.875rem]",
          focus.on ? "fixed inset-0 z-50 bg-background p-2" : "px-2 pt-2 pb-2 sm:px-3",
        )}
      >
        <div
          className={cn(
            "flex min-h-(--ws-bar) shrink-0 flex-wrap items-center gap-x-3 gap-y-1 px-1",
            focus.on && "hidden",
          )}
        >
          {header}
        </div>

        <TabStrip
          label="Workspace"
          items={mobileItems}
          value={mobileTab}
          onChange={setMobileTab}
          className="shrink-0 rounded-xl border border-border bg-surface p-1 lg:hidden"
          tabClassName="flex-1 justify-center"
        />

        <div ref={groupBoxRef} className="min-h-0 flex-1">
          <PanelGroup
            direction="horizontal"
            autoSaveId="recx-workspace-v2"
            className="h-full max-lg:flex-col!"
          >
            <Panel
              id="statement"
              order={1}
              defaultSize={STATEMENT_DEFAULT_PERCENT}
              minSize={statementMinPercent(groupWidth)}
              className={cn(
                "max-lg:basis-auto!",
                // While the HTML is still streaming in, the browser can paint
                // the statement before the editor pane exists — alone in the
                // row it would fill it, then snap to 38 % (a layout shift of
                // ~0.07). Alone, it keeps its default share
                // (STATEMENT_DEFAULT_PERCENT of the row less the 0.625rem
                // resize handle). `:not(:has(~ *))`, not `:only-child`: Chrome
                // does not match :only-child / :last-child until the parent
                // has finished parsing, which is exactly the moment in question.
                "lg:[&:not(:has(~*))]:max-w-[calc((100%-0.625rem)*0.38)]",
                mobileTab !== "problem" && "max-lg:hidden!",
                focus.on && "lg:hidden!",
              )}
            >
              {statementPane}
            </Panel>
            <PanelResizeHandle
              aria-label="Resize the problem and code panes"
              className={cn("group flex w-2.5 items-center justify-center outline-none max-lg:hidden!", focus.on && "hidden!")}
            >
              <span
                aria-hidden
                className="h-10 w-1 rounded-full bg-border-strong transition-colors group-hover:bg-primary group-focus-visible:h-16 group-focus-visible:bg-primary group-data-[resize-handle-state=drag]:bg-primary"
              />
            </PanelResizeHandle>
            <Panel
              id="editor"
              order={2}
              defaultSize={EDITOR_DEFAULT_PERCENT}
              minSize={editorMinPercent(groupWidth)}
              className={cn("max-lg:min-h-[22rem] max-lg:basis-auto!", mobileTab === "problem" && "max-lg:hidden!")}
            >
              {editorPane}
            </Panel>
          </PanelGroup>
        </div>
      </div>

      <p aria-live="polite" role="status" className="sr-only">
        {announcement}
      </p>

      <Dialog open={resetOpen} onClose={() => setResetOpen(false)} title="Reset to starter code?" size="sm">
        <p className="text-sm text-text-secondary">
          This replaces your {active ? shortName(active.label) : ""} code for this problem with the starter code. You can
          undo it from the bar above the editor until you leave the page.
        </p>
        <div className="mt-5 flex justify-end gap-2">
          <Button variant="ghost" onClick={() => setResetOpen(false)}>
            Cancel
          </Button>
          <Button variant="danger" onClick={confirmReset}>
            Reset code
          </Button>
        </div>
      </Dialog>
    </WorkspaceContext.Provider>
  );
}
