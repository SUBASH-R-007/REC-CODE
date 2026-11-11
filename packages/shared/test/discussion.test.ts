import { describe, expect, it } from "vitest";
import {
  DISCUSSION_KIND_LABEL,
  DISCUSSION_LIMITS,
  DISCUSSION_POST_KINDS,
  DISCUSSION_REFUSALS,
  HELP_CONTEXTS,
  REPORT_REASONS,
  REPORT_REASON_LABEL,
  discussionAccess,
  hiddenNotice,
  mayAskDoubt,
  mayReplyToDoubt,
  type DiscussionInput,
  type HelpContext,
} from "../src/index";

function input(over: Partial<DiscussionInput> = {}): DiscussionInput {
  return { context: "PRACTICE", solved: true, assisted: false, moderator: false, ...over };
}

describe("who may read and who may post", () => {
  it("an unassisted solver may do both", () => {
    expect(discussionAccess(input())).toEqual({ mayRead: true, mayPost: true, readReason: null, postReason: null });
  });

  it("somebody who has not solved it may do neither, and is told why", () => {
    const access = discussionAccess(input({ solved: false }));
    expect(access.mayRead).toBe(false);
    expect(access.mayPost).toBe(false);
    expect(access.readReason).toBe(DISCUSSION_REFUSALS.unsolved);
    expect(access.postReason).toBe(DISCUSSION_REFUSALS.unsolved);
  });

  it("an ASSISTED solver may read but not post", () => {
    const access = discussionAccess(input({ assisted: true }));
    expect(access.mayRead).toBe(true);
    expect(access.readReason).toBeNull();
    expect(access.mayPost).toBe(false);
    expect(access.postReason).toBe(DISCUSSION_REFUSALS.assisted);
  });

  it("the assisted refusal says it is only this problem, and is not a telling-off", () => {
    expect(DISCUSSION_REFUSALS.assisted).toContain("only applies to this problem");
    expect(DISCUSSION_REFUSALS.assisted).toContain("which is fine");
  });

  it("nobody reads or posts during a contest or an assessment, however they solved it", () => {
    for (const context of ["CONTEST", "ASSESSMENT"] as HelpContext[]) {
      for (const over of [{}, { assisted: true }, { solved: false }]) {
        const access = discussionAccess(input({ context, ...over }));
        expect(access.mayRead, context).toBe(false);
        expect(access.mayPost, context).toBe(false);
        expect(access.readReason).toBe(DISCUSSION_REFUSALS.notPractice);
      }
    }
  });

  it("the sitting refusal beats every other refusal", () => {
    // A student who has not solved it, in a contest, is told about the
    // contest — the thing they can do nothing about today — rather than
    // being told to go and solve it.
    expect(discussionAccess(input({ context: "CONTEST", solved: false })).readReason).toBe(
      DISCUSSION_REFUSALS.notPractice,
    );
  });

  it("a moderator reads everywhere and posts nowhere", () => {
    for (const context of HELP_CONTEXTS) {
      const access = discussionAccess(input({ context, moderator: true, solved: false }));
      expect(access.mayRead, context).toBe(true);
      // A mentor's contribution is an answer on a question, not a "how I
      // solved it" for a problem they never solved.
      expect(access.mayPost, context).toBe(false);
      expect(access.postReason).toBeNull();
    }
  });
});

describe("doubts", () => {
  it("are asked in practice and nowhere else", () => {
    expect(mayAskDoubt("PRACTICE")).toBe(true);
    expect(mayAskDoubt("CONTEST")).toBe(false);
    expect(mayAskDoubt("ASSESSMENT")).toBe(false);
  });

  it("are answered by the asker and by a mentor, and by nobody else", () => {
    expect(mayReplyToDoubt({ viewerId: "a", askerId: "a", moderator: false })).toBe(true);
    expect(mayReplyToDoubt({ viewerId: "b", askerId: "a", moderator: true })).toBe(true);
    // The hole an anti-spoiler gate on solutions alone would leave open.
    expect(mayReplyToDoubt({ viewerId: "b", askerId: "a", moderator: false })).toBe(false);
  });
});

describe("what a hidden post says", () => {
  it("names the moderator's reason, so the decision is visible", () => {
    expect(hiddenNotice("It pastes the whole solution.", true)).toBe(
      "Hidden by a TA or mentor: It pastes the whole solution.",
    );
  });

  it("says so plainly when the author hid their own", () => {
    expect(hiddenNotice("anything", false)).toBe("Hidden by its author.");
  });
});

describe("the vocabulary", () => {
  it("labels every post kind and every report reason", () => {
    for (const kind of DISCUSSION_POST_KINDS) expect(DISCUSSION_KIND_LABEL[kind].length).toBeGreaterThan(3);
    for (const reason of REPORT_REASONS) expect(REPORT_REASON_LABEL[reason].length).toBeGreaterThan(3);
  });

  it("every refusal is a sentence a student can act on", () => {
    for (const [key, text] of Object.entries(DISCUSSION_REFUSALS)) {
      expect(text.length, key).toBeGreaterThan(20);
      expect(text.trim(), key).toMatch(/[.!]$/);
    }
  });

  it("the limits are ordered and sane", () => {
    for (const [key, range] of Object.entries(DISCUSSION_LIMITS)) {
      expect(range.min, key).toBeGreaterThan(0);
      expect(range.max, key).toBeGreaterThan(range.min);
    }
    // A shared solution needs more room than a one-line reply.
    expect(DISCUSSION_LIMITS.body.max).toBeGreaterThan(DISCUSSION_LIMITS.replyBody.max);
  });
});
