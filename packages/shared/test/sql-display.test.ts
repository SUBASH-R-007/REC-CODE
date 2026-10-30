import { describe, expect, it } from "vitest";
import {
  LANGUAGE_KEYS,
  SQL_DISPLAY_ROWS,
  SQL_EDITOR_LANGUAGE,
  SQL_LANGUAGE_KEY,
  SQL_LANGUAGE_LABEL,
  SQL_LIMITS,
  SQL_STARTER_CODE,
  SUBMIT_LANGUAGE_KEYS,
  clipResultSet,
  describeResultSet,
  displayCell,
  isSubmitLanguage,
  readResultSet,
  submitEditorLanguage,
  submitLanguageLabel,
  writeResultSet,
  type SqlResultSet,
} from "../src/index";

/**
 * Showing a result set to a student, and the one list of languages a
 * submission may carry (Phase 12k, slice 4).
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

describe("the languages a submission may carry", () => {
  it("is every toolchain plus SQL, and nothing else", () => {
    expect(SUBMIT_LANGUAGE_KEYS).toEqual([...LANGUAGE_KEYS, SQL_LANGUAGE_KEY]);
    expect(SUBMIT_LANGUAGE_KEYS).toHaveLength(LANGUAGE_KEYS.length + 1);
    for (const key of SUBMIT_LANGUAGE_KEYS) expect(isSubmitLanguage(key)).toBe(true);
    for (const bad of ["", "sql", "SQL17", "mysql8", null, 7]) expect(isSubmitLanguage(bad)).toBe(false);
  });

  it("labels SQL as its dialect and every toolchain from the catalogue", () => {
    expect(submitLanguageLabel(SQL_LANGUAGE_KEY)).toBe(SQL_LANGUAGE_LABEL);
    expect(submitLanguageLabel("cpp20")).toContain("C++20");
    // A row whose LanguageConfig is long gone still renders.
    expect(submitLanguageLabel("rust180")).toBe("rust180");
  });

  it("gives SQL an editor grammar, and an unknown key plaintext", () => {
    expect(submitEditorLanguage(SQL_LANGUAGE_KEY)).toBe(SQL_EDITOR_LANGUAGE);
    expect(submitEditorLanguage("py312")).toBe("python");
    expect(submitEditorLanguage("rust180")).toBe("plaintext");
  });

  it("opens a SQL editor with a comment and nothing else", () => {
    expect(SQL_STARTER_CODE.trim().startsWith("--")).toBe(true);
    expect(SQL_STARTER_CODE).not.toMatch(/select/i);
  });
});
