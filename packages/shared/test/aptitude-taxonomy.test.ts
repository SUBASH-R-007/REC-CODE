import { describe, expect, it } from "vitest";
import {
  APTITUDE_AREAS,
  APTITUDE_AREA_LABEL,
  APTITUDE_AREA_TOPIC_COUNT,
  APTITUDE_TOPICS,
  APTITUDE_TOPIC_AREA,
  APTITUDE_TOPIC_LABEL,
  APTITUDE_TOPIC_SLUG,
  areaOfTopic,
  isAptitudeArea,
  isAptitudeTopic,
  topicFromSlug,
  topicsOfArea,
} from "../src/aptitude-taxonomy";

/**
 * The taxonomy is the one list. The Prisma enums mirror it (enum-parity) and
 * the area↔topic CHECK is generated from APTITUDE_TOPIC_AREA, so a topic that
 * slips out of this file takes a weakness heatmap and a section blueprint
 * with it.
 */

describe("areas", () => {
  it("has the three the spec names, labelled", () => {
    expect(APTITUDE_AREAS).toEqual(["QUANTITATIVE", "LOGICAL", "VERBAL"]);
    for (const area of APTITUDE_AREAS) expect(APTITUDE_AREA_LABEL[area]).toBeTruthy();
  });

  it("recognises an area and refuses anything else", () => {
    expect(isAptitudeArea("VERBAL")).toBe(true);
    expect(isAptitudeArea("verbal")).toBe(false);
    expect(isAptitudeArea(undefined)).toBe(false);
  });
});

describe("topics", () => {
  it("has 29, split 14 / 9 / 6 as the spec lists them", () => {
    // The counts are asserted so that dropping a topic is a test failure
    // rather than a silently narrower "weakest topic" view.
    expect(APTITUDE_TOPICS).toHaveLength(29);
    expect(APTITUDE_AREA_TOPIC_COUNT).toEqual({ QUANTITATIVE: 14, LOGICAL: 9, VERBAL: 6 });
  });

  it("gives every topic exactly one area", () => {
    expect(Object.keys(APTITUDE_TOPIC_AREA).sort()).toEqual([...APTITUDE_TOPICS].sort());
    for (const topic of APTITUDE_TOPICS) expect(APTITUDE_AREAS).toContain(areaOfTopic(topic));
  });

  it("lists them in area order, which is the order the Prisma enum must hold", () => {
    // enum-parity compares member ORDER, so this is the contract and not a
    // cosmetic preference.
    const areas = APTITUDE_TOPICS.map((topic) => APTITUDE_TOPIC_AREA[topic]);
    expect(areas).toEqual([...areas].sort((a, b) => APTITUDE_AREAS.indexOf(a) - APTITUDE_AREAS.indexOf(b)));
  });

  it("has no duplicate members", () => {
    expect(new Set(APTITUDE_TOPICS).size).toBe(APTITUDE_TOPICS.length);
  });

  it("spells every member in the SCREAMING_SNAKE form a Postgres enum takes", () => {
    for (const topic of APTITUDE_TOPICS) expect(topic).toMatch(/^[A-Z]+(_[A-Z]+)*$/);
  });

  it("labels every topic, and never leaves the enum spelling showing", () => {
    for (const topic of APTITUDE_TOPICS) {
      expect(APTITUDE_TOPIC_LABEL[topic], topic).toBeTruthy();
      expect(APTITUDE_TOPIC_LABEL[topic]).not.toContain("_");
    }
    expect(APTITUDE_TOPIC_LABEL.TIME_SPEED_DISTANCE).toBe("Time, Speed & Distance");
    expect(APTITUDE_TOPIC_LABEL.INTEREST).toBe("Simple & Compound Interest");
  });

  it("returns the topics of one area, in taxonomy order", () => {
    expect(topicsOfArea("VERBAL")).toEqual([
      "READING_COMPREHENSION",
      "SENTENCE_CORRECTION",
      "PARA_JUMBLES",
      "SYNONYMS_ANTONYMS",
      "CLOZE",
      "ERROR_SPOTTING",
    ]);
    expect(topicsOfArea("QUANTITATIVE")).toHaveLength(14);
    expect(topicsOfArea("LOGICAL")).toHaveLength(9);
  });

  it("recognises a topic and refuses anything else", () => {
    expect(isAptitudeTopic("PERCENTAGES")).toBe(true);
    expect(isAptitudeTopic("VIBES")).toBe(false);
    expect(isAptitudeTopic(7)).toBe(false);
  });
});

describe("URL slugs", () => {
  it("gives every topic a kebab-case slug", () => {
    // `/aptitude/TIME_SPEED_DISTANCE` in a student's address bar looks like a
    // leaked internal name.
    for (const topic of APTITUDE_TOPICS) {
      expect(APTITUDE_TOPIC_SLUG[topic], topic).toMatch(/^[a-z]+(-[a-z]+)*$/);
    }
    expect(APTITUDE_TOPIC_SLUG.TIME_SPEED_DISTANCE).toBe("time-speed-distance");
  });

  it("round-trips every topic through its slug", () => {
    for (const topic of APTITUDE_TOPICS) expect(topicFromSlug(APTITUDE_TOPIC_SLUG[topic])).toBe(topic);
  });

  it("gives every topic a distinct slug", () => {
    expect(new Set(Object.values(APTITUDE_TOPIC_SLUG)).size).toBe(APTITUDE_TOPICS.length);
  });

  it("accepts a slug whatever its case, and refuses an unknown one", () => {
    expect(topicFromSlug("Time-Speed-Distance")).toBe("TIME_SPEED_DISTANCE");
    expect(topicFromSlug("time_speed_distance")).toBeNull();
    expect(topicFromSlug("")).toBeNull();
  });
});
