import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { HEATMAP_STEPS, TOPICS, heatmapLevel } from "@recx/shared";
import {
  HEATMAP_DAYS,
  addDays,
  buildHeatmap,
  heatmapCellLabel,
  heatmapCssVars,
  heatmapFill,
  heatmapLegend,
  summariseByMonth,
  weekdayIndex,
} from "@/components/profile/heatmap-model";
import { labelAnchor, radarPolygon, radarScaleMax, wrapLabel } from "@/components/profile/radar-model";
import { canViewProfile } from "@/components/profile/visibility";
import {
  BIO_MAX,
  EDITOR_PREFS_DEFAULT,
  mergeEditorPrefs,
  normalizeBio,
  readEditorPrefs,
  settingsFromForm,
  settingsSchema,
} from "@/components/profile/settings-schema";
import { ActivityHeatmap } from "@/components/profile/activity-heatmap";
import { SkillRadar } from "@/components/profile/skill-radar";
import { BadgeShelf, badgeIcon } from "@/components/profile/badge-shelf";
import { languageLabel, languageShares, topicCounts } from "@/server/queries/profile";

// Vitest compiles .tsx with the classic JSX transform (tsconfig "jsx": "preserve").
(globalThis as { React?: unknown }).React = React;

const TODAY = "2026-10-10"; // a Saturday

describe("heatmap levels and labels", () => {
  it("labels a cell with the date and what happened, in words", () => {
    expect(heatmapCellLabel("2026-03-12", 4, 0)).toBe("12 March 2026: 4 problems solved");
    expect(heatmapCellLabel("2026-03-12", 1, 0)).toBe("12 March 2026: 1 problem solved");
    expect(heatmapCellLabel("2026-03-12", 0, 0)).toBe("12 March 2026: no problems solved");
    expect(heatmapCellLabel("2026-03-02", 2, 9)).toBe("2 March 2026: 2 problems solved, 9 submissions");
    expect(heatmapCellLabel("2026-03-02", 0, 1)).toBe("2 March 2026: no problems solved, 1 submission");
  });

  it("varies lightness, not hue: five color-mix steps of --primary into --surface", () => {
    expect(heatmapFill(0)).toBeNull();
    HEATMAP_STEPS.forEach((step, i) => {
      expect(heatmapFill((i + 1) as 1 | 2 | 3 | 4 | 5)).toBe(`color-mix(in srgb, var(--primary) ${step}%, var(--surface))`);
    });
    const vars = heatmapCssVars();
    expect(Object.keys(vars)).toEqual(["--hm-1", "--hm-2", "--hm-3", "--hm-4", "--hm-5"]);
    for (const value of Object.values(vars)) expect(value).not.toMatch(/#[0-9a-f]{3,8}\b/i);
  });

  it("derives its text legend from heatmapLevel itself", () => {
    const legend = heatmapLegend();
    expect(legend.map((l) => l.level)).toEqual([0, 1, 2, 3, 4, 5]);
    expect(legend.map((l) => l.label)).toEqual(["None", "1", "2", "3–4", "5–7", "8 or more"]);
    // Every label's lower bound really maps to its level.
    expect(heatmapLevel(3)).toBe(3);
    expect(heatmapLevel(8)).toBe(5);
  });
});

describe("heatmap layout", () => {
  const activity = [
    { date: TODAY, solved: 3, submissions: 7 },
    { date: "2026-03-12", solved: 4, submissions: 4 },
    { date: addDays(TODAY, -(HEATMAP_DAYS - 1)), solved: 1, submissions: 2 }, // first day in the window
    { date: addDays(TODAY, -HEATMAP_DAYS), solved: 9, submissions: 9 }, // one day too old: ignored
    { date: "2026-06-01", solved: 0, submissions: 5 },
  ];
  const model = buildHeatmap(activity, TODAY);
  const cells = model.weeks.flatMap((w) => w.cells).filter((c) => c !== null);

  it("covers exactly 365 days in Monday-first week columns", () => {
    expect(cells).toHaveLength(HEATMAP_DAYS);
    expect(model.weeks.every((w) => w.cells.length === 7)).toBe(true);
    expect(cells[0]!.date).toBe(model.start);
    expect(cells.at(-1)!.date).toBe(TODAY);
    // Column rows are weekdays: Monday at index 0.
    for (const week of model.weeks) {
      week.cells.forEach((cell, i) => {
        if (cell) expect(weekdayIndex(cell.date)).toBe(i);
      });
    }
    // Padding before the window and after today is not a day.
    expect(model.weeks[0]!.cells.slice(0, weekdayIndex(model.start)).every((c) => c === null)).toBe(true);
    expect(model.weeks.at(-1)!.cells.slice(weekdayIndex(TODAY) + 1).every((c) => c === null)).toBe(true);
  });

  it("levels each day by problems solved and labels every cell", () => {
    const byDate = new Map(cells.map((c) => [c.date, c]));
    expect(byDate.get(TODAY)).toMatchObject({ level: 3, label: "10 October 2026: 3 problems solved, 7 submissions" });
    expect(byDate.get("2026-03-12")).toMatchObject({ level: 3 });
    expect(byDate.get("2026-06-01")).toMatchObject({ level: 0, submissions: 5 });
    expect(cells.every((c) => c.label.startsWith(`${Number(c.date.slice(8))} `))).toBe(true);
    expect(model.totalSolved).toBe(8);
    expect(model.activeDays).toBe(4);
  });

  it("labels month columns and offers the same data as a monthly table", () => {
    const labels = model.weeks.map((w) => w.monthLabel).filter(Boolean);
    expect(labels.length).toBeGreaterThanOrEqual(12);
    expect(labels).toContain("Mar");
    const months = summariseByMonth(model);
    expect(months[0]!.key).toBe(model.start.slice(0, 7));
    expect(months.at(-1)!.key).toBe("2026-10");
    expect(months.reduce((s, m) => s + m.solved, 0)).toBe(model.totalSolved);
    expect(months.reduce((s, m) => s + m.activeDays, 0)).toBe(model.activeDays);
    expect(months.find((m) => m.key === "2026-03")).toMatchObject({ label: "March 2026", solved: 4, activeDays: 1 });
  });

  it("renders a text label on every day cell, a text legend, and no hex colour", () => {
    const html = renderToStaticMarkup(React.createElement(ActivityHeatmap, { activity, today: TODAY }));
    const labelled = html.match(/role="img" aria-label="[^"]+"/g) ?? [];
    expect(labelled).toHaveLength(HEATMAP_DAYS);
    expect(html).toContain('aria-label="12 March 2026: 4 problems solved, 4 submissions"');
    expect(html).toContain("8 or more");
    expect(html).toContain("color-mix(in srgb, var(--primary) 44%, var(--surface))");
    expect(html).toContain("Show this activity as a table");
    expect(html).not.toMatch(/#[0-9a-fA-F]{6}\b/);
  });
});

describe("skill radar", () => {
  it("scales to a round ceiling and draws one vertex per topic", () => {
    expect(radarScaleMax([0, 0])).toBe(4);
    expect(radarScaleMax([5, 1])).toBe(8);
    expect(radarScaleMax([16])).toBe(16);
    const points = radarPolygon(Array.from({ length: 14 }, () => 4), 8, 100, { x: 200, y: 200 }).split(" ");
    expect(points).toHaveLength(14);
    expect(points[0]).toBe("200,150"); // 12 o'clock, half the radius
  });

  it("anchors labels by side and wraps long ones", () => {
    expect(labelAnchor(0, 14)).toBe("middle");
    expect(labelAnchor(3, 14)).toBe("start");
    expect(labelAnchor(10, 14)).toBe("end");
    expect(wrapLabel("Graphs")).toEqual(["Graphs"]);
    expect(wrapLabel("Recursion & Backtracking")).toEqual(["Recursion &", "Backtracking"]);
  });

  it("covers all 14 topics from UserStats JSON, ignoring junk keys", () => {
    const topics = topicCounts({ GRAPHS: 4, ARRAYS_HASHING: 2, NOT_A_TOPIC: 9 }, { GRAPHS: 1 });
    expect(topics.map((t) => t.topic)).toEqual([...TOPICS]);
    expect(topics.find((t) => t.topic === "GRAPHS")).toMatchObject({ unassisted: 4, assisted: 1, label: "Graphs" });
    expect(topicCounts("garbage", null).every((t) => t.unassisted === 0 && t.assisted === 0)).toBe(true);
  });

  it("renders an image with a text summary and a data-table alternative", () => {
    const topics = topicCounts({ GRAPHS: 4, TREES: 2 }, { GRAPHS: 1 });
    const own = renderToStaticMarkup(React.createElement(SkillRadar, { topics }));
    expect(own).toMatch(/<svg[^>]*role="img"/);
    expect(own).toContain("Strongest: Graphs (4), Trees (2).");
    expect((own.match(/<th scope="row"/g) ?? []).length).toBe(14);
    expect(own).toContain("Assisted solves");
    const pub = renderToStaticMarkup(React.createElement(SkillRadar, { topics, subject: "Priya S.", showAssisted: false }));
    expect(pub).not.toContain("Assisted solves");
    expect(pub).toContain("Skill radar for Priya S.");
  });
});

describe("badges and languages", () => {
  it("shows badges with icon, name and words — never colour alone", () => {
    const html = renderToStaticMarkup(
      React.createElement(BadgeShelf, {
        emptyText: "none",
        badges: [
          { key: "first", name: "First solve", description: "Solve a problem.", icon: "flame", awardedAt: new Date("2026-03-12T10:00:00Z") },
          { key: "week", name: "Seven days", description: "A 7-day streak.", icon: "no-such-icon", awardedAt: null },
        ],
      }),
    );
    expect(html).toContain("First solve");
    expect(html).toContain("Earned 12 Mar 2026");
    expect(html).toContain("Not earned yet");
    expect(badgeIcon("calendar-check")).toBe(badgeIcon("CalendarCheck"));
    expect(badgeIcon("no-such-icon")).toBe(badgeIcon("award"));
  });

  it("splits languages by solves with readable labels", () => {
    expect(languageLabel("cpp20")).toBe("C++20");
    expect(languageLabel("py312")).toBe("Python 3.12");
    expect(languageLabel("brainfuck")).toBe("brainfuck");
    expect(languageShares({ py312: 3, cpp20: 12, go123: 0 })).toEqual([
      { key: "cpp20", label: "C++20", count: 12 },
      { key: "py312", label: "Python 3.12", count: 3 },
    ]);
  });
});

describe("profile visibility", () => {
  const owner = (visibility: "PUBLIC" | "REC_ONLY" | "PRIVATE", status: "ACTIVE" | "DISABLED" | "ARCHIVED" | "GRADUATED" | "SOFT_RESTRICTED" = "ACTIVE") => ({
    id: "owner",
    visibility,
    status,
  });

  it.each([
    ["PUBLIC", null, true],
    ["PUBLIC", "peer", true],
    ["REC_ONLY", null, false],
    ["REC_ONLY", "peer", true],
    ["PRIVATE", null, false],
    ["PRIVATE", "peer", false],
    ["PRIVATE", "owner", true],
    ["REC_ONLY", "owner", true],
  ] as const)("%s profile, viewer %s → %s", (visibility, viewer, expected) => {
    expect(canViewProfile(owner(visibility), viewer)).toBe(expected);
  });

  it("has no profile for disabled or archived accounts, even for PUBLIC", () => {
    expect(canViewProfile(owner("PUBLIC", "DISABLED"), "peer")).toBe(false);
    expect(canViewProfile(owner("PUBLIC", "ARCHIVED"), null)).toBe(false);
    expect(canViewProfile(owner("PUBLIC", "GRADUATED"), null)).toBe(true);
    expect(canViewProfile(owner("REC_ONLY", "SOFT_RESTRICTED"), "peer")).toBe(true);
  });
});

describe("settings validation", () => {
  const form = (fields: Record<string, string>) => {
    const data = new FormData();
    for (const [k, v] of Object.entries(fields)) data.set(k, v);
    return settingsFromForm(data);
  };
  const valid = { visibility: "PUBLIC", bio: "  Practising for placements.  ", fontSize: "16", tabSize: "2" };

  it("parses the form, with an unchecked opt-out box meaning false", () => {
    expect(settingsSchema.parse(form(valid))).toEqual({
      visibility: "PUBLIC",
      leaderboardOptOut: false,
      bio: "Practising for placements.",
      fontSize: 16,
      tabSize: 2,
      // Phase 12j. A form with no keymap field is the standard keymap,
      // which is also what a browser that cannot render the select sends.
      keymap: "DEFAULT",
    });
    expect(settingsSchema.parse(form({ ...valid, leaderboardOptOut: "on" })).leaderboardOptOut).toBe(true);
  });

  it("refuses out-of-range values with readable messages", () => {
    const bad = (fields: Record<string, string>) => settingsSchema.safeParse(form({ ...valid, ...fields }));
    expect(bad({ visibility: "EVERYONE" }).error?.issues[0]?.message).toBe("Choose who can see your profile.");
    expect(bad({ fontSize: "11" }).success).toBe(false);
    expect(bad({ fontSize: "21" }).success).toBe(false);
    expect(bad({ fontSize: "14.5" }).success).toBe(false);
    expect(bad({ tabSize: "3" }).error?.issues[0]?.message).toBe("The tab size must be 2 or 4 spaces.");
    expect(bad({ bio: "x".repeat(BIO_MAX + 1) }).error?.issues[0]?.message).toBe(
      `Keep your bio to ${BIO_MAX} characters or fewer.`,
    );
    expect(bad({ bio: "🙂".repeat(BIO_MAX) }).success).toBe(true); // code points, not UTF-16 units
  });

  it("normalises the bio", () => {
    expect(normalizeBio("a\r\nb\u0007c\n\n\n\nd ")).toBe("a\nbc\n\nd");
  });

  it("reads and merges editor prefs without losing other keys", () => {
    expect(readEditorPrefs({})).toEqual(EDITOR_PREFS_DEFAULT);
    expect(readEditorPrefs({ fontSize: 18, tabSize: 2, keymap: "VIM" })).toEqual({
      fontSize: 18,
      tabSize: 2,
      keymap: "VIM",
    });
    // Each key falls back on its own: a nonsense font size does not cost
    // somebody their keymap.
    expect(readEditorPrefs({ fontSize: 99, tabSize: "4", keymap: "vim" })).toEqual({
      fontSize: EDITOR_PREFS_DEFAULT.fontSize,
      tabSize: 4,
      keymap: EDITOR_PREFS_DEFAULT.keymap,
    });
    expect(readEditorPrefs(null)).toEqual(EDITOR_PREFS_DEFAULT);
    // A key this form does not own survives the merge; the three it owns
    // are written (Phase 12j added the keymap to them).
    expect(
      mergeEditorPrefs({ wordWrap: true, fontSize: 12 }, { fontSize: 16, tabSize: 2, keymap: "EMACS" }),
    ).toEqual({ wordWrap: true, fontSize: 16, tabSize: 2, keymap: "EMACS" });
  });
});
