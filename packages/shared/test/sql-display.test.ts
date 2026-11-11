import { describe, expect, it } from "vitest";
import {
  SQL_DISPLAY_ROWS,
  SQL_LIMITS,
  clipResultSet,
  describeResultSet,
  displayCell,
  readResultSet,
  writeResultSet,
  type SqlResultSet,
} from "../src/index";

/**
 * Showing a result set to a student (Phase 12k, slice 4). The list of
 * languages a submission may carry moved to `submit-language.test.ts` when
 * Phase 12n added the third one that is not a toolchain.
 */

const rs = (rows: Array<Array<string | null>>): SqlResultSet => ({ columns: ["id", "name"], rows });

function manyRows(n: number): SqlResultSet {
  return rs(Array.from({ length: n }, (_, i) => [String(i + 1), `name-${i + 1}`]));
}

describe("clipResultSet", () => {
  it("leaves a short result set exactly as it is", () => {
    const small = manyRows(3);
    expect(clipResultSet(small)).toBe(small);
    expect(clipResultSet(small).truncated).toBeUndefined();
  });

  it("keeps the first rows and says it is a prefix", () => {
    const clipped = clipResultSet(manyRows(SQL_DISPLAY_ROWS + 5));
    expect(clipped.rows).toHaveLength(SQL_DISPLAY_ROWS);
    expect(clipped.rows[0]).toEqual(["1", "name-1"]);
    expect(clipped.truncated).toBe(true);
  });

  it("never drops the columns, so a clipped table still has a header", () => {
    expect(clipResultSet(manyRows(100), 1).columns).toEqual(["id", "name"]);
  });
});

describe("readResultSet", () => {
  it("round-trips through writeResultSet", () => {
    const original = rs([["1", "Asha"], [null, "Bala"]]);
    const back = readResultSet(writeResultSet(original));
    expect(back).toEqual({ columns: ["id", "name"], rows: [["1", "Asha"], [null, "Bala"]] });
  });

  it("writes a clipped set, and the clip survives the round trip", () => {
    const back = readResultSet(writeResultSet(manyRows(SQL_DISPLAY_ROWS + 1)));
    expect(back?.rows).toHaveLength(SQL_DISPLAY_ROWS);
    expect(back?.truncated).toBe(true);
  });

  it("returns null for anything that is not a result set, rather than throwing", () => {
    // A page renders what it is given: the dataset (plain SQL), a field cut
    // by a byte budget, a blob from before this existed, an empty value.
    for (const text of [
      null,
      undefined,
      "",
      "   ",
      "SELECT id FROM students",
      '{"columns":["id"],"rows":[["1"]]',
      '{"columns":["id"],"rows":[["1","2"]]}',
      '{"columns":["id"],"rows":[],"extra":1}',
      "[]",
      "null",
    ]) {
      expect(readResultSet(text)).toBeNull();
    }
  });

  it("refuses a result set larger than the judged caps", () => {
    const tooWide = { columns: Array.from({ length: SQL_LIMITS.columns + 1 }, (_, i) => `c${i}`), rows: [] };
    expect(readResultSet(JSON.stringify(tooWide))).toBeNull();
  });
});

describe("describeResultSet and displayCell", () => {
  it("counts columns and rows, and says when the rows are a prefix", () => {
    expect(describeResultSet(rs([["1", "a"]]))).toBe("2 columns, 1 row");
    expect(describeResultSet({ columns: ["id"], rows: [] })).toBe("1 column, 0 rows");
    expect(describeResultSet({ ...rs([["1", "a"]]), truncated: true })).toBe("2 columns, first 1 row");
  });

  it("writes NULL as a word, because '' is a different answer", () => {
    expect(displayCell(null)).toBe("NULL");
    expect(displayCell("")).toBe("");
    expect(displayCell("NULL")).toBe("NULL");
  });
});
