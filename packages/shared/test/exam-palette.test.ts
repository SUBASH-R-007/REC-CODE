import { describe, expect, it } from "vitest";
import {
  EXAM_BOTTOM_BAR_ACTIONS,
  PALETTE_APPEARANCE,
  PALETTE_STATES,
  isPaletteKey,
  paletteCounts,
  paletteCountsText,
  paletteLabel,
  paletteNavigate,
  paletteStateOf,
  type PaletteState,
  type QuestionProgress,
} from "../src/exam-palette";

const q = (over: Partial<QuestionProgress> = {}): QuestionProgress => ({
  visited: false,
  answered: false,
  marked: false,
  ...over,
});

describe("paletteStateOf", () => {
  it("is NOT_VISITED before the question is opened", () => {
    expect(paletteStateOf(q())).toBe("NOT_VISITED");
  });

  it("is VISITED_UNANSWERED once opened and left blank", () => {
    expect(paletteStateOf(q({ visited: true }))).toBe("VISITED_UNANSWERED");
  });

  it("is ANSWERED when answered", () => {
    expect(paletteStateOf(q({ visited: true, answered: true }))).toBe("ANSWERED");
  });

  it("is MARKED when marked but blank", () => {
    expect(paletteStateOf(q({ visited: true, marked: true }))).toBe("MARKED");
  });

  it("is ANSWERED_MARKED when both", () => {
    expect(paletteStateOf(q({ visited: true, answered: true, marked: true }))).toBe("ANSWERED_MARKED");
  });

  it("treats never-visited as never-visited whatever else is set", () => {
    // A question that was never opened cannot be answered. If the stored
    // state says otherwise that is a bug elsewhere, not a sixth state.
    expect(paletteStateOf(q({ answered: true, marked: true }))).toBe("NOT_VISITED");
  });

  it("produces only the five states, over every input combination", () => {
    const seen = new Set<PaletteState>();
    for (const visited of [false, true]) {
      for (const answered of [false, true]) {
        for (const marked of [false, true]) {
          seen.add(paletteStateOf({ visited, answered, marked }));
        }
      }
    }
    expect([...seen].sort()).toEqual([...PALETTE_STATES].sort());
  });
});

describe("the five states each carry shape, icon and label", () => {
  it("covers every state", () => {
    expect(Object.keys(PALETTE_APPEARANCE).sort()).toEqual([...PALETTE_STATES].sort());
  });

  it("gives every state a distinct accessible legend", () => {
    const legends = PALETTE_STATES.map((s) => PALETTE_APPEARANCE[s].legend);
    expect(new Set(legends).size).toBe(PALETTE_STATES.length);
  });

  it("never relies on colour alone: every state differs from every other in shape, glyph or badge", () => {
    const fingerprints = PALETTE_STATES.map((s) => {
      const a = PALETTE_APPEARANCE[s];
      return `${a.shape}|${a.icon ?? "none"}|${a.badge ?? "none"}`;
    });
    expect(new Set(fingerprints).size).toBe(PALETTE_STATES.length);
  });

  it("matches the shapes and glyphs the spec fixes", () => {
    expect(PALETTE_APPEARANCE.NOT_VISITED).toMatchObject({ shape: "square", icon: null, badge: null });
    expect(PALETTE_APPEARANCE.VISITED_UNANSWERED).toMatchObject({ shape: "square-notched", icon: "minus" });
    expect(PALETTE_APPEARANCE.ANSWERED).toMatchObject({ shape: "circle", icon: "check" });
    expect(PALETTE_APPEARANCE.MARKED).toMatchObject({ shape: "circle", icon: "flag", badge: null });
    expect(PALETTE_APPEARANCE.ANSWERED_MARKED).toMatchObject({ shape: "circle", icon: "flag", badge: "check" });
  });

  it("gives the unvisited state no glyph, which is what distinguishes it", () => {
    expect(PALETTE_APPEARANCE.NOT_VISITED.icon).toBeNull();
    for (const state of PALETTE_STATES) {
      if (state !== "NOT_VISITED") expect(PALETTE_APPEARANCE[state].icon).not.toBeNull();
    }
  });
});

describe("paletteLabel", () => {
  it("carries the number and the state, never a bare number", () => {
    expect(paletteLabel(7, "ANSWERED")).toBe("Question 7, answered");
    expect(paletteLabel(7, "NOT_VISITED")).toBe("Question 7, not visited");
    expect(paletteLabel(12, "ANSWERED_MARKED")).toBe("Question 12, answered and marked for review");
  });

  it("names a state for every one of the five", () => {
    for (const state of PALETTE_STATES) {
      const label = paletteLabel(1, state);
      expect(label.length).toBeGreaterThan("Question 1, ".length);
      expect(label.startsWith("Question 1, ")).toBe(true);
    }
  });
});

describe("paletteCounts", () => {
  const board: QuestionProgress[] = [
    ...Array.from({ length: 12 }, () => q({ visited: true, answered: true })),
    ...Array.from({ length: 3 }, () => q({ visited: true, marked: true })),
    ...Array.from({ length: 10 }, () => q({ visited: true })),
    ...Array.from({ length: 5 }, () => q()),
  ];

  it("counts the spec's own example", () => {
    const counts = paletteCounts(board);
    expect(counts).toEqual({ answered: 12, marked: 3, notAnswered: 18, total: 30 });
  });

  it("renders the counts row the spec shows", () => {
    expect(paletteCountsText({ answered: 12, marked: 3, notAnswered: 15, total: 30 })).toBe(
      "Answered 12 · Marked 3 · Not answered 15",
    );
  });

  it("counts a marked-and-answered question in both marked and answered", () => {
    const counts = paletteCounts([q({ visited: true, answered: true, marked: true })]);
    expect(counts).toEqual({ answered: 1, marked: 1, notAnswered: 0, total: 1 });
  });

  it("counts unvisited questions as not answered", () => {
    expect(paletteCounts([q(), q()])).toEqual({ answered: 0, marked: 0, notAnswered: 2, total: 2 });
  });

  it("handles an empty paper without dividing by anything", () => {
    expect(paletteCounts([])).toEqual({ answered: 0, marked: 0, notAnswered: 0, total: 0 });
  });

  it("keeps answered + notAnswered equal to the total", () => {
    const counts = paletteCounts(board);
    expect(counts.answered + counts.notAnswered).toBe(counts.total);
  });
});

describe("paletteNavigate", () => {
  const grid = { total: 30, columns: 5 };

  it("moves one along with Left and Right", () => {
    expect(paletteNavigate({ ...grid, index: 6, key: "ArrowRight" })).toBe(7);
    expect(paletteNavigate({ ...grid, index: 6, key: "ArrowLeft" })).toBe(5);
  });

  it("moves a whole row with Up and Down, because the palette is a grid", () => {
    expect(paletteNavigate({ ...grid, index: 6, key: "ArrowDown" })).toBe(11);
    expect(paletteNavigate({ ...grid, index: 6, key: "ArrowUp" })).toBe(1);
  });

  it("jumps to the ends with Home and End", () => {
    expect(paletteNavigate({ ...grid, index: 17, key: "Home" })).toBe(0);
    expect(paletteNavigate({ ...grid, index: 17, key: "End" })).toBe(29);
  });

  it("clamps rather than wrapping, so one extra keypress never loses the candidate's place", () => {
    expect(paletteNavigate({ ...grid, index: 29, key: "ArrowRight" })).toBe(29);
    expect(paletteNavigate({ ...grid, index: 0, key: "ArrowLeft" })).toBe(0);
    expect(paletteNavigate({ ...grid, index: 0, key: "ArrowUp" })).toBe(0);
  });

  it("moves to the last question when Down would leave the grid", () => {
    expect(paletteNavigate({ ...grid, index: 27, key: "ArrowDown" })).toBe(29);
  });

  it("leaves Tab and every other key to the browser", () => {
    for (const key of ["Tab", "Enter", " ", "Escape", "a", "PageDown"]) {
      expect(paletteNavigate({ ...grid, index: 3, key })).toBeNull();
    }
  });

  it("recognises exactly its own keys", () => {
    expect(isPaletteKey("ArrowRight")).toBe(true);
    expect(isPaletteKey("Tab")).toBe(false);
  });

  it("survives a one-question paper and a single column", () => {
    expect(paletteNavigate({ total: 1, columns: 5, index: 0, key: "ArrowRight" })).toBe(0);
    expect(paletteNavigate({ total: 4, columns: 1, index: 1, key: "ArrowDown" })).toBe(2);
  });

  it("returns null for an empty paper instead of a negative index", () => {
    expect(paletteNavigate({ total: 0, columns: 5, index: 0, key: "ArrowRight" })).toBeNull();
  });

  it("tolerates an out-of-range starting index", () => {
    expect(paletteNavigate({ ...grid, index: 99, key: "ArrowLeft" })).toBe(28);
    expect(paletteNavigate({ ...grid, index: -5, key: "ArrowRight" })).toBe(1);
  });

  it("never returns an index outside the paper, over every key and position", () => {
    for (let index = 0; index < 30; index++) {
      for (const key of ["ArrowRight", "ArrowLeft", "ArrowUp", "ArrowDown", "Home", "End"]) {
        const next = paletteNavigate({ ...grid, index, key })!;
        expect(next).toBeGreaterThanOrEqual(0);
        expect(next).toBeLessThan(30);
      }
    }
  });
});

describe("the bottom bar order", () => {
  it("is TCS iON / AMCAT muscle memory, and is not to be rearranged", () => {
    expect(EXAM_BOTTOM_BAR_ACTIONS.map((a) => a.id)).toEqual([
      "previous",
      "markAndNext",
      "clear",
      "saveAndNext",
    ]);
    expect(EXAM_BOTTOM_BAR_ACTIONS.map((a) => a.label)).toEqual([
      "Previous",
      "Mark for review & next",
      "Clear response",
      "Save & next",
    ]);
  });
});
