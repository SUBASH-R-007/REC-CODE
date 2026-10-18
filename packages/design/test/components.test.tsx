import { VERDICTS, VERDICT_CODE, VERDICT_LABEL, type VerdictDisplay } from "@recx/shared";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import * as barrel from "../src/index";
import {
  Avatar,
  Badge,
  Button,
  Card,
  CardBody,
  CardHeader,
  CardSkeleton,
  Dialog,
  DifficultyBadge,
  Dropdown,
  DropdownItem,
  EmptyState,
  Field,
  Input,
  PageSkeleton,
  ProgressBar,
  ProgressRing,
  Select,
  SolveStatus,
  StatCard,
  Tab,
  TabList,
  TabPanel,
  Tabs,
  Textarea,
  ToastProvider,
  VERDICT_STYLE,
  VerdictBadge,
} from "../src/index";
import { readPackageFile } from "./helpers";

const DISPLAY_STATES: VerdictDisplay[] = [...VERDICTS, "QUEUED", "RUNNING"];
const PENDING = new Set<VerdictDisplay>(["QUEUED", "RUNNING"]);
const ANY_HEX = /#[0-9a-fA-F]{3,8}\b/;

function codeSpans(markup: string): string[] {
  return [...markup.matchAll(/<span[^>]*class="[^"]*font-mono[^"]*"[^>]*>([^<]*)<\/span>/g)].map(
    (m) => m[1] ?? "",
  );
}

describe("VerdictBadge", () => {
  it("has a style row for every verdict and pending state", () => {
    for (const verdict of DISPLAY_STATES) expect(VERDICT_STYLE[verdict], verdict).toBeDefined();
    expect(Object.keys(VERDICT_STYLE).sort()).toEqual([...DISPLAY_STATES].sort());
  });

  it.each(DISPLAY_STATES)("%s renders its label, its code (unless pending) and an aria-hidden icon", (verdict) => {
    for (const size of ["sm", "md"] as const) {
      const markup = renderToStaticMarkup(<VerdictBadge verdict={verdict} size={size} />);
      expect(markup).toContain(`>${VERDICT_LABEL[verdict]}<`);
      expect(markup).toMatch(/<svg[^>]*aria-hidden="true"/);
      expect(markup).toContain(`data-verdict="${verdict}"`);
      expect(markup).toContain(VERDICT_STYLE[verdict].tone);
      expect(markup).not.toMatch(ANY_HEX);
      if (PENDING.has(verdict)) {
        expect(VERDICT_STYLE[verdict].code).toBeNull();
        expect(codeSpans(markup)).toEqual([]);
        expect(markup).not.toContain(VERDICT_CODE[verdict]);
      } else {
        expect(VERDICT_STYLE[verdict].code).toBe(VERDICT_CODE[verdict]);
        expect(codeSpans(markup)).toEqual([VERDICT_CODE[verdict]]);
      }
    }
  });

  it("encodes verdicts in distinct icon silhouettes, not colour alone", () => {
    const s = VERDICT_STYLE;
    expect(s.AC.silhouette).toBe("circle");
    expect(s.WA.silhouette).toBe("circle");
    expect(s.RE.silhouette).toBe("triangle");
    expect(s.CE.silhouette).toBe("document");
    expect(s.AC.icon).not.toBe(s.WA.icon);
    expect(new Set([s.AC.icon, s.WA.icon, s.RE.icon, s.CE.icon]).size).toBe(4);
    // Every state has its own glyph.
    expect(new Set(DISPLAY_STATES.map((v) => s[v].icon)).size).toBe(DISPLAY_STATES.length);
    // Rendered outlines differ too (lucide names its SVG by icon).
    const iconClass = (v: VerdictDisplay) =>
      /class="lucide (lucide-[a-z0-9-]+)/.exec(renderToStaticMarkup(<VerdictBadge verdict={v} />))?.[1];
    expect(iconClass("AC")).toBe("lucide-circle-check");
    expect(iconClass("WA")).toBe("lucide-circle-x");
    expect(iconClass("RE")).toBe("lucide-triangle-alert");
    expect(iconClass("CE")).toBe("lucide-file-warning");
  });

  it("adds a left-edge shape cue per verdict family", () => {
    expect(VERDICT_STYLE.AC.border).toBe("solid");
    expect(VERDICT_STYLE.TLE.border).toBe("dashed");
    expect(VERDICT_STYLE.RE.border).toBe("dotted");
    expect(VERDICT_STYLE.CE.border).toBe("dotted");
    const tle = renderToStaticMarkup(<VerdictBadge verdict="TLE" />);
    expect(tle).toContain("border-l-[3px]");
    expect(tle).toContain("border-dashed");
    expect(renderToStaticMarkup(<VerdictBadge verdict="RE" />)).toContain("border-dotted");
    const queued = renderToStaticMarkup(<VerdictBadge verdict="QUEUED" />);
    expect(queued).not.toContain("border-l-[3px]");
    expect(queued).toContain("border-border");
  });

  it("spins RUNNING only under motion-safe", () => {
    const markup = renderToStaticMarkup(<VerdictBadge verdict="RUNNING" />);
    expect(markup).toContain("motion-safe:animate-spin");
    expect(markup).not.toMatch(/[\s"]animate-spin/);
  });

  it("shows passed/total for PARTIAL, with a spoken equivalent", () => {
    const markup = renderToStaticMarkup(<VerdictBadge verdict="PARTIAL" passed={3} total={5} />);
    expect(markup).toContain(">3/5<");
    expect(markup).toContain("3 of 5 tests passed");
    expect(renderToStaticMarkup(<VerdictBadge verdict="AC" passed={3} total={5} />)).not.toContain("3/5");
    expect(renderToStaticMarkup(<VerdictBadge verdict="PARTIAL" passed={0} total={0} />)).not.toContain("0/0");
  });
});

describe("DifficultyBadge", () => {
  it.each([
    ["EASY", "Easy", 1, "text-success"],
    ["MEDIUM", "Medium", 2, "text-accent"],
    ["HARD", "Hard", 3, "text-danger"],
  ] as const)("%s always renders the word and %i of 3 bars", (difficulty, word, filled, tone) => {
    const markup = renderToStaticMarkup(<DifficultyBadge difficulty={difficulty} />);
    expect(markup).toContain(`${word}</span>`);
    expect(markup).toContain(tone);
    expect(markup).toMatch(/<span aria-hidden="true" class="inline-flex items-end/);
    const bars = markup.match(/w-\[3px\]/g) ?? [];
    const dimmed = markup.match(/opacity-25/g) ?? [];
    expect(bars).toHaveLength(3);
    expect(bars.length - dimmed.length).toBe(filled);
  });
});

describe("SolveStatus", () => {
  it("renders nothing at all when not attempted", () => {
    expect(renderToStaticMarkup(<SolveStatus status={null} />)).toBe("");
    expect(renderToStaticMarkup(<SolveStatus />)).toBe("");
  });

  it("renders a filled check with the word when solved", () => {
    const markup = renderToStaticMarkup(<SolveStatus status="solved" />);
    expect(markup).toContain("Solved");
    expect(markup).toContain("text-success");
    expect(markup).toContain("fill-current");
    expect(markup).toContain("lucide-circle-check");
  });

  it("renders a hollow dashed circle with the word when attempted", () => {
    const markup = renderToStaticMarkup(<SolveStatus status="attempted" />);
    expect(markup).toContain("Attempted");
    expect(markup).toContain("text-accent");
    expect(markup).toContain("lucide-circle-dashed");
    expect(markup).not.toContain("fill-current");
  });
});

describe("primitives", () => {
  it("render without hardcoded colours", () => {
    const markup = renderToStaticMarkup(
      <ToastProvider>
        <Card glass>
          <CardHeader title="Title" subtitle="Sub" action={<Badge tone="primary">New</Badge>} />
          <CardBody>
            <Avatar firstName="Priya" lastName="Sharma" />
            <Button loading>Save</Button>
            <Field label="Name" htmlFor="n" hint="Your name">
              <Input id="n" />
            </Field>
            <Textarea />
            <Select>
              <option>One</option>
            </Select>
            <ProgressBar value={3} max={4} />
            <ProgressRing value={40}>40%</ProgressRing>
            <StatCard label="Solved" value={12} />
            <EmptyState title="Nothing yet" description="Try a problem" icon={<span>i</span>} compact />
            <Tabs defaultValue="a">
              <TabList label="Sections">
                <Tab value="a">A</Tab>
                <Tab value="b">B</Tab>
              </TabList>
              <TabPanel value="a">Panel A</TabPanel>
              <TabPanel value="b">Panel B</TabPanel>
            </Tabs>
            <Dropdown trigger="Menu" triggerLabel="Open menu">
              <DropdownItem>Item</DropdownItem>
            </Dropdown>
            <CardSkeleton />
            <PageSkeleton />
          </CardBody>
        </Card>
      </ToastProvider>,
    );
    expect(markup).toContain("Panel A");
    expect(markup).not.toContain("Panel B");
    expect(markup).toContain('aria-selected="true"');
    expect(markup).toContain("PS");
    expect(markup).toContain('aria-valuenow="75"');
    expect(markup).not.toMatch(ANY_HEX);
  });

  it("EmptyState renders no image when no icon is given", () => {
    const markup = renderToStaticMarkup(<EmptyState title="Empty" />);
    expect(markup).not.toContain("<img");
    expect(markup).not.toContain("aria-hidden");
  });
});

describe("Dialog", () => {
  it("offers a labelled close button by default", () => {
    const markup = renderToStaticMarkup(
      <Dialog open onClose={() => undefined} title="Rotate">
        body
      </Dialog>,
    );
    expect(markup).toContain('aria-label="Close dialog"');
    expect(markup).toMatch(/<h2 id="[^"]+"[^>]*>Rotate<\/h2>/);
  });

  it("dismissible={false} has no close button (the content must offer the way out)", () => {
    const markup = renderToStaticMarkup(
      <Dialog open dismissible={false} onClose={() => undefined} title="New token">
        <button type="button">I have copied it</button>
      </Dialog>,
    );
    expect(markup).not.toContain("Close dialog");
    expect(markup).toContain("I have copied it");
  });
});

describe("barrel", () => {
  it("does not expose the server-only derivation", () => {
    for (const name of ["deriveTheme", "buildBrandCss", "PRESETS", "REC_PURPLE_PALETTE", "simulate"]) {
      expect(barrel).not.toHaveProperty(name);
    }
    const source = readPackageFile("src/index.ts");
    expect(source).not.toMatch(/from "\.\/(derive|presets|contrast|cvd|palette)"/);
    expect(source).not.toContain("culori");
  });
});
