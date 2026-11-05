import { describe, expect, it } from "vitest";
import { meetsVersionFloor } from "@recx/shared";
import { examBrowserSettingSchema, versionFloorOf } from "@/lib/exam/exam-browser-setting";

/**
 * The lowest REC Exam Browser version a deployment accepts (Phase 14f).
 *
 * This is the emergency lever: a build found to have a flaw stops being
 * usable the day it is known, without a redeploy. It is therefore also the
 * lever that locks a hall out of its exam, so what matters most here is the
 * direction it fails in when something is wrong with the stored value.
 */

describe("reading the stored floor", () => {
  it("means no floor when nothing is stored", () => {
    expect(versionFloorOf(null)).toEqual({ floor: null, unreadable: false });
    expect(versionFloorOf(undefined)).toEqual({ floor: null, unreadable: false });
    expect(versionFloorOf({})).toEqual({ floor: null, unreadable: false });
  });

  it("reads a version", () => {
    expect(versionFloorOf({ minVersion: "1.2.0" })).toEqual({ floor: "1.2.0", unreadable: false });
  });

  it("means NO floor when the stored value cannot be read, and says so", () => {
    /**
     * The direction that matters. `meetsVersionFloor` compares three
     * numbers, so a floor that is not three numbers would compare as
     * "below any floor" and refuse every build in the hall -- turning a
     * typo in a settings row into a morning where nobody can sit.
     */
    for (const broken of [{ minVersion: "latest" }, { minVersion: 3 }, { minVersion: "" }, "1.2.0", 7]) {
      const read = versionFloorOf(broken);
      expect(read.floor, JSON.stringify(broken)).toBeNull();
      expect(read.unreadable, JSON.stringify(broken)).toBe(true);
    }
  });

  it("does not quietly ignore a floor somebody saved", () => {
    // `unreadable` exists so the caller can log it. A setting that is being
    // ignored and says nothing is worse than no setting at all.
    expect(versionFloorOf({ minVersion: "not a version" }).unreadable).toBe(true);
    expect(versionFloorOf({ minVersion: "1.0.0" }).unreadable).toBe(false);
  });
});

describe("what may be saved as a floor", () => {
  it("accepts three numbers", () => {
    for (const version of ["1.0.0", "0.0.1", "12.4.9"]) {
      expect(examBrowserSettingSchema.safeParse({ minVersion: version }).success, version).toBe(true);
    }
  });

  it("refuses anything the comparison could not use", () => {
    for (const version of ["1", "1.0", "v1.0.0", "latest", "1.0.0.0", ""]) {
      expect(examBrowserSettingSchema.safeParse({ minVersion: version }).success, version).toBe(false);
    }
  });

  it("trims, because a pasted version carries a space more often than not", () => {
    const parsed = examBrowserSettingSchema.parse({ minVersion: " 1.4.2 " });
    expect(parsed.minVersion).toBe("1.4.2");
  });
});

describe("the floor and the comparison agree", () => {
  it("accepts a build at or above a saved floor and refuses one below", () => {
    /**
     * Read together, these two are the whole control: anything this schema
     * will store, `meetsVersionFloor` can compare -- which is why the
     * schema refuses "1.0" rather than storing something the comparison
     * would read as below every floor.
     */
    const floor = versionFloorOf({ minVersion: "1.2.0" }).floor as string;
    expect(meetsVersionFloor("1.2.0", floor)).toBe(true);
    expect(meetsVersionFloor("1.3.0", floor)).toBe(true);
    expect(meetsVersionFloor("1.1.9", floor)).toBe(false);
  });
});
