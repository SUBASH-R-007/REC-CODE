import AxeBuilder from "@axe-core/playwright";
import { expect, type Page, type TestInfo } from "@playwright/test";

/**
 * The axe harness, shared (Phase 12u).
 *
 * It was `a11y.spec.ts`'s own, which was right while one spec did the
 * scanning. The exam surface cannot be scanned from a list of paths — a
 * sitting has to be authored, started and navigated before there is
 * anything to look at — so a second spec needs the same rules, and the
 * rules are the point: the same tag set, the same exclusion with the same
 * justification, and the same definition of what gates.
 *
 * docs/ACCESSIBILITY.md §6: ZERO serious or critical violations of WCAG
 * 2.0 / 2.1 / 2.2 A and AA rules on the gated pages, in the light and the
 * dark theme, at 1366 × 768 and at a 375 × 812 phone viewport. No axe rule
 * is disabled.
 */

export const AXE_TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];

/**
 * One region is excluded from every scan, with this justification:
 * `nextjs-portal` — the Next.js development overlay / dev-tools indicator.
 * `next dev` injects it into every page; it is not part of REC Code and is
 * never shipped (a production build has no such element). Scanning it would
 * gate the product on Next.js's own development UI.
 */
export const AXE_EXCLUDE = ["nextjs-portal"];

export const GATING_IMPACTS = new Set(["serious", "critical"]);

export interface Finding {
  state: string;
  id: string;
  impact: string;
  help: string;
  nodes: number;
  targets: string[];
  /** The first few nodes: markup and axe's explanation (for fixing). */
  details: { html: string; summary: string }[];
}

type Violations = Awaited<ReturnType<AxeBuilder["analyze"]>>["violations"];

export function summarise(state: string, violations: Violations): Finding[] {
  return violations.map((v) => ({
    state,
    id: v.id,
    impact: v.impact ?? "unknown",
    help: v.help,
    nodes: v.nodes.length,
    targets: v.nodes.slice(0, 6).map((n) => n.target.map(String).join(" ")),
    details: v.nodes.slice(0, 3).map((n) => ({
      html: n.html.slice(0, 240),
      summary: (n.failureSummary ?? "").replace(/\s+/g, " ").slice(0, 400),
    })),
  }));
}

export function describeFindings(findings: readonly Finding[]): string {
  if (findings.length === 0) return "none";
  return findings
    .map((f) => `${f.impact}:${f.id}x${f.nodes}${f.state === "initial" ? "" : ` (${f.state})`}`)
    .join(", ");
}

export async function record(
  testInfo: TestInfo,
  label: string,
  findings: Finding[],
  url: string,
): Promise<void> {
  const body = JSON.stringify({ label, url, violations: findings }, null, 2);
  await testInfo.attach("axe-violations.json", { body, contentType: "application/json" });
  testInfo.annotations.push({ type: "axe", description: `${label}: ${describeFindings(findings)}` });
  console.log(`[axe] ${label} -> ${describeFindings(findings)}`);
  if (findings.length > 0 && process.env.E2E_AXE_DETAILS === "1") console.log(body);
}

export async function scan(page: Page, state: string): Promise<Finding[]> {
  const results = await new AxeBuilder({ page }).withTags(AXE_TAGS).exclude(AXE_EXCLUDE).analyze();
  return summarise(state, results.violations);
}

/** The gate: serious and critical, with the markup and axe's own reason. */
export function expectNoGatingViolations(findings: readonly Finding[], label: string): void {
  const blocking = findings.filter((f) => GATING_IMPACTS.has(f.impact));
  expect(
    blocking,
    `serious/critical axe violations on ${label}:\n${JSON.stringify(blocking, null, 2)}`,
  ).toEqual([]);
}
