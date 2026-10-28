import { describe, expect, it } from "vitest";
import { findFiles, readRepoFile } from "./support/repo";

/**
 * The vocabulary is READ from source rather than imported, like every other
 * fence here: this project has no dependency on the workspace packages, on
 * purpose — a structural test that imported the thing it checks could be
 * satisfied by a change to both at once.
 */
function quotedList(rel: string, declaration: string, closer = "]);"): string[] {
  const source = readRepoFile(rel);
  const start = source.indexOf(declaration);
  expect(start, `${rel}: no ${declaration}`).toBeGreaterThanOrEqual(0);
  // From AFTER the declaration: the declaration itself contains a "]" in
  // `readonly ProctorEventKind[]`, which would close the list immediately.
  const from = start + declaration.length;
  // The closer, not the first "]": a comment inside one of these lists
  // mentions `ProctorEventKind[]`, which would end the list immediately.
  const end = source.indexOf(closer, from);
  expect(end, `${rel}: ${declaration} is not closed`).toBeGreaterThan(from);
  const items = [...source.slice(from, end).matchAll(/"([A-Z][A-Z0-9_]*)"/g)].map((m) => m[1]!);
  expect(items.length, `${rel}: ${declaration} looks empty`).toBeGreaterThan(0);
  return items;
}

const PROCTOR_EVENT_KINDS = quotedList("packages/shared/src/proctor.ts", "export const PROCTOR_EVENT_KINDS = [", "] as const;");
const SERVER_ONLY_EVENT_KINDS = quotedList(
  "packages/shared/src/exam-telemetry.ts",
  "export const SERVER_ONLY_EVENT_KINDS: readonly ProctorEventKind[] = Object.freeze([",
);
const CONTEXT_ONLY_KINDS = quotedList(
  "packages/shared/src/triage.ts",
  "export const CONTEXT_ONLY_KINDS: readonly ProctorEventKind[] = Object.freeze([",
);
const FOCUS_LIMIT_ACTIONS = quotedList("packages/shared/src/assessment.ts", "export const FOCUS_LIMIT_ACTIONS = [", "] as const;");
const CLIENT_EVENT_KINDS = PROCTOR_EVENT_KINDS.filter((k) => !SERVER_ONLY_EVENT_KINDS.includes(k));

/**
 * `docs/PROCTORING.md` as tests (Phase 11b).
 *
 * That document is the most load-bearing prose in the repository: it is the
 * posture the college is asked to accept, the limits a student is promised,
 * and the list of things this engine will never contain. Until now it was
 * prose alone — and the audit that produced this file found that prose and
 * code had already drifted apart in one place.
 *
 * **What the audit found.** Of the twenty-five signals in the vocabulary,
 * two were declared, classified as server-derived, and produced by nothing:
 *
 *   - `INVIGILATOR_NOTE` — so the control §4 rates highest, "a physical
 *     invigilator in the room", could not reach the reviewer who decides. A
 *     reviewer saw focus losses and pastes, and never "the candidate had a
 *     phone under the desk". Phase 11b gave it a producer
 *     (`invigilate#recordObservation`).
 *   - `SUBMISSION_RATE_ANOMALY` — which cannot have a producer under the
 *     present attempt model, because a sitting submits ONCE, at the end
 *     (`lib/exam/submit.ts` creates every Submission in one transaction).
 *     There is no rate to be anomalous. It stays in the enum because the
 *     Prisma enum and `Accommodation.exemptSignals` are shared with live
 *     data, and it is listed below as reserved WITH ITS REASON rather than
 *     left looking implemented.
 *
 * The rule this file now enforces is that one: a signal either has a
 * producer, or says in writing why it has none.
 */

const WEB = "apps/web/src";


/**
 * Kinds with no producer, and why. A reason is not decoration: it is the
 * difference between "nobody has built this yet" and "this cannot mean
 * anything here", and a reviewer reading the vocabulary deserves to know
 * which.
 */
const CLIENT_EMITTED_KINDS = quotedList(
  "packages/shared/src/exam-telemetry.ts",
  "export const CLIENT_EMITTED_KINDS: readonly ProctorEventKind[] = Object.freeze([",
);
const SERVER_DERIVED_KINDS = quotedList(
  "packages/shared/src/exam-telemetry.ts",
  "export const SERVER_DERIVED_KINDS: readonly ProctorEventKind[] = Object.freeze([",
);

/** The keys of RESERVED_EVENT_KINDS: declared, produced by nothing, each with its reason. */
function reservedKinds(): string[] {
  const source = readRepoFile("packages/shared/src/exam-telemetry.ts");
  const start = source.indexOf("export const RESERVED_EVENT_KINDS");
  expect(start, "RESERVED_EVENT_KINDS moved").toBeGreaterThanOrEqual(0);
  const block = source.slice(start);
  const end = block.indexOf("\n});");
  expect(end, "RESERVED_EVENT_KINDS is not closed").toBeGreaterThan(0);
  // A key is at two spaces and followed by its reason; the reasons
  // themselves are indented further, so they cannot be mistaken for keys.
  return [...block.slice(0, end).matchAll(/^ {2}([A-Z][A-Z0-9_]*):/gm)].map((m) => m[1]!);
}

/** Where a signal is actually produced: the exam client, the exam server, the invigilator. */
const EMISSION_DIRS = [`${WEB}/lib/exam`, `${WEB}/components/exam`];
const EMISSION_FILES = [`${WEB}/server/actions/invigilate.ts`, "packages/shared/src/exam-telemetry.ts"];

/**
 * The emission path's source, with the declaration lists cut out of it: the
 * lists name every kind, so leaving them in would make everything look
 * produced. `classifyPaste` lives in the same file and is a real producer,
 * which is why the file is here at all.
 */
function emissionSources(): string {
  const files = [
    ...findFiles({ under: EMISSION_DIRS, extensions: [".ts", ".tsx"] }).filter((rel) => !rel.includes(".test.")),
    ...EMISSION_FILES,
  ];
  return files
    .map((rel) => {
      const source = readRepoFile(rel);
      const cut = source.indexOf("export const SERVER_ONLY_EVENT_KINDS");
      return cut >= 0 ? source.slice(0, cut) : source;
    })
    .join("\n");
}

describe("the declared classification is true of the code", () => {
  const sources = emissionSources();
  const reserved = reservedKinds();

  it.each([...CLIENT_EMITTED_KINDS, ...SERVER_DERIVED_KINDS])("%s is emitted somewhere", (kind) => {
    expect(
      new RegExp(`["']${kind}["']`).test(sources),
      `${kind} is declared as produced and appears nowhere in the emission path. ` +
        "Either emit it or move it to RESERVED_EVENT_KINDS with a reason.",
    ).toBe(true);
  });

  it("covers the whole vocabulary between the three lists", () => {
    const declared = new Set([...CLIENT_EMITTED_KINDS, ...SERVER_DERIVED_KINDS, ...reserved]);
    for (const kind of PROCTOR_EVENT_KINDS) {
      expect(declared.has(kind), `${kind} is in the vocabulary and in none of the three lists`).toBe(true);
    }
    // The arithmetic of the partition is asserted in
    // packages/shared/test/exam-telemetry.test.ts, which can import them.
    expect(declared.size).toBe(PROCTOR_EVENT_KINDS.length);
  });

  it("emits nothing it reserves", () => {
    expect(reserved.length, "no reserved kinds parsed; the reason map moved").toBeGreaterThan(0);
    for (const kind of reserved) {
      expect(
        new RegExp(`["']${kind}["']`).test(sources),
        `${kind} is reserved — declared as produced by nothing — yet the emission path names it`,
      ).toBe(false);
    }
  });
});

describe("a client cannot report what only the server can know", () => {
  it("keeps the two sets disjoint", () => {
    for (const kind of SERVER_ONLY_EVENT_KINDS) {
      expect(CLIENT_EVENT_KINDS as readonly string[]).not.toContain(kind);
    }
    expect(CLIENT_EVENT_KINDS.length + SERVER_ONLY_EVENT_KINDS.length).toBe(PROCTOR_EVENT_KINDS.length);
  });

  it("writes the invigilator's note as a SERVER event", () => {
    /**
     * It is in SERVER_ONLY_EVENT_KINDS, so the only thing that may write one
     * is the server — and the CHECK on ProctorEvent ties `source` to
     * `clientSeq`, which an invigilator's note has none of.
     */
    const action = readRepoFile(`${WEB}/server/actions/invigilate.ts`);
    expect(action).toContain('kind: "INVIGILATOR_NOTE"');
    expect(action).toContain('source: "SERVER"');
  });
});

describe("the engine is actually connected (Phase 11b)", () => {
  /**
   * The audit's worst finding, and the reason this file exists.
   *
   * `flagAttemptIfNeeded` was written in Phase 6 — complete, idempotent,
   * audited — and NOTHING in the repository called it. No attempt was ever
   * flagged; no result was ever withheld; the 72-hour SLA had nothing to
   * act on; the review queue, the reviews and the appeals were a surface
   * over an empty table. A whole phase of integrity machinery was inert,
   * and every test passed, because every test called the engine directly.
   *
   * These two assertions are the ones that would have caught it: a thing
   * that decides something must be reachable from the thing that happens.
   */
  it("bands a sitting when it is submitted", () => {
    const submit = readRepoFile(`${WEB}/lib/exam/submit.ts`);
    expect(submit, "nothing calls flagAttemptIfNeeded, so no sitting is ever banded").toContain(
      "flagAttemptIfNeeded(",
    );
    // After the derivation, because the band counts SNAPSHOT_JUMP events.
    expect(submit.indexOf("deriveSnapshotJumps(")).toBeLessThan(submit.indexOf("flagAttemptIfNeeded("));
  });

  it("derives the snapshot evidence when it is submitted", () => {
    expect(readRepoFile(`${WEB}/lib/exam/submit.ts`)).toContain("deriveSnapshotJumps(");
    // And the derivation is reachable from nowhere else that could double it.
    const derivation = readRepoFile(`${WEB}/lib/exam/snapshot-jump.ts`);
    expect(derivation, "the derivation must refuse to run twice for one attempt").toContain('kind: "SNAPSHOT_JUMP"');
    expect(derivation).toMatch(/already > 0/);
  });
});

describe("no signal ever penalises anybody by itself (PROCTORING.md §3)", () => {
  it("offers exactly two things to do at the focus limit, and neither voids a result", () => {
    expect([...FOCUS_LIMIT_ACTIONS].sort()).toEqual(["AUTOSUBMIT", "FLAG_ONLY"]);
  });

  it("keeps the review SLA at 72 hours, after which the result publishes as CLEARED", () => {
    expect(readRepoFile("packages/shared/src/triage.ts")).toMatch(/export const REVIEW_SLA_HOURS = 72;/);
    // The job that does it, and the status it sets.
    const sla = readRepoFile("apps/scheduler/src/main.ts");
    expect(sla).toContain("integritySla");
    const engine = findFiles({ under: ["apps/scheduler/src"], extensions: [".ts"] })
      .map((rel) => readRepoFile(rel))
      .join("\n");
    expect(engine).toMatch(/CLEARED/);
  });

  it("cannot reach a band on context alone", () => {
    // The arithmetic is tested in packages/shared/test/triage.test.ts; what
    // this asserts is that the CLASSIFICATION still covers the two signals
    // Phase 11b added, which are the ones a future reader is most likely to
    // assume are findings.
    expect(CONTEXT_ONLY_KINDS).toContain("INVIGILATOR_NOTE");
    expect(CONTEXT_ONLY_KINDS).toContain("SUBMISSION_RATE_ANOMALY");
  });
});

describe("forbidden by name (PROCTORING.md §5)", () => {
  /**
   * The list says the engine "will never include, enable by default, or
   * quietly add" these. A promise about what software does not do is only
   * as good as the thing that notices it appearing.
   */
  const FORBIDDEN: ReadonlyArray<[string, RegExp]> = [
    ["webcam or microphone capture", /getUserMedia/],
    ["screen recording", /getDisplayMedia/],
    ["any recording", /\bMediaRecorder\b/],
    ["speech capture", /SpeechRecognition/],
    ["peer-to-peer media", /RTCPeerConnection/],
    ["clipboard reading", /navigator\.clipboard\.readText/],
  ];

  const web = findFiles({ under: [WEB], extensions: [".ts", ".tsx"] }).filter((rel) => !rel.includes(".test."));

  it.each(FORBIDDEN)("%s appears nowhere in apps/web/src", (_what, pattern) => {
    const offenders = web.filter((rel) => pattern.test(readRepoFile(rel)));
    expect(offenders, `docs/PROCTORING.md §5 forbids this by name`).toEqual([]);
  });

  it("records the size and hash of a paste, never its text", () => {
    // The model's own comments say so; this keeps the field names honest.
    const schema = readRepoFile("packages/db/prisma/schema.prisma");
    const model = schema.slice(schema.indexOf("model ProctorEvent {"));
    const body = model.slice(0, model.indexOf("\n}"));
    expect(body).toContain("never its text");
    expect(body).not.toMatch(/^\s+text\s+String/m);
    expect(body).not.toMatch(/^\s+content\s+String/m);
  });
});

describe("a contest is not an exam, and nothing pretends otherwise", () => {
  /**
   * The integrity engine is assessment-only, by design: `IntegrityFlag`
   * hangs off an `AssessmentAttempt`, a contest has no proctor mode, and the
   * arena emits no telemetry. That is a decision, not an omission — a
   * contest is practice with stakes, and the product says so where it
   * matters (the signed export's framing copy).
   *
   * What this asserts is that the decision stays visible: if somebody
   * half-builds contest proctoring, a student will be monitored without
   * being told, which §1 forbids.
   */
  it("flags an assessment attempt, and only that", () => {
    const schema = readRepoFile("packages/db/prisma/schema.prisma");
    const model = schema.slice(schema.indexOf("model IntegrityFlag {"));
    const body = model.slice(0, model.indexOf("\n}"));
    expect(body).toMatch(/attempt\s+AssessmentAttempt/);
    expect(body).not.toMatch(/Contest/);
  });

  it("emits no proctoring telemetry from the contest surfaces", () => {
    const contestFiles = findFiles({
      under: [`${WEB}/app/(student)/contests`, `${WEB}/components/contest`],
      extensions: [".ts", ".tsx"],
    });
    expect(contestFiles.length, "the contest surface moved; point this test at it").toBeGreaterThan(3);
    const offenders = contestFiles.filter((rel) => /ProctorEvent|proctorMode|telemetry/i.test(readRepoFile(rel)));
    expect(
      offenders,
      "a contest that collects proctoring telemetry is an exam, and must be documented and disclosed as one before it collects anything",
    ).toEqual([]);
  });

  it("says so in the posture document", () => {
    const doc = readRepoFile("docs/PROCTORING.md");
    expect(doc).toMatch(/contest/i);
  });
});

describe("the browser is not the control (PROCTORING.md §8, Phase 11c)", () => {
  /**
   * "Can proctor mode require an incognito window, so no extensions can be
   * plugged in?" is the most-asked proctoring question, and the answer is
   * no three times over (§8): a page cannot detect private mode, a private
   * window is not extension-free, and a page cannot see extensions at all.
   *
   * The reason this needs a fence rather than a paragraph is that the
   * failure mode is attractive. Somebody will find a heuristic that works
   * on the laptop in front of them, and it will ship as a *gate* — and a
   * gate built on a self-reported value does not add a line a reviewer can
   * discount, it stops an honest student from sitting the paper. The
   * heuristics misreport Guest mode and some ordinary profiles, so the
   * students it stops are chosen at random on exam morning.
   *
   * Same shape as the §5 fence, and deliberately beside it.
   */
  const SNIFFERS: ReadonlyArray<[string, RegExp]> = [
    ["private-mode detection by storage quota", /storage\s*\.\s*estimate\s*\(/],
    ["private-mode detection by the FileSystem probe", /webkitRequestFileSystem|\brequestFileSystem\b/],
    ["a private-mode detection library or flag", /detectIncognito|isIncognito|incognitoMode|isPrivateMode|privateBrowsing/i],
    ["extension sniffing by resource probe", /chrome-extension:\/\//],
    ["the extension management API", /chrome\s*\.\s*management/],
  ];

  const web = findFiles({ under: [WEB], extensions: [".ts", ".tsx"] }).filter((rel) => !rel.includes(".test."));

  it.each(SNIFFERS)("%s appears nowhere in apps/web/src", (_what, pattern) => {
    const offenders = web.filter((rel) => pattern.test(readRepoFile(rel)));
    expect(
      offenders,
      "docs/PROCTORING.md §8: the window type is not detectable and not a control. The operational answer is deploy/lab-policy/ on a machine the college owns.",
    ).toEqual([]);
  });

  it("answers the question in the document, and points at the control that works", () => {
    const doc = readRepoFile("docs/PROCTORING.md");
    const section = doc.slice(doc.indexOf("## 8."));
    expect(section.length, "§8 is missing from docs/PROCTORING.md").toBeGreaterThan(1_000);
    // The three walls, each named.
    expect(section).toMatch(/no API|there is no API/i);
    expect(section).toMatch(/Allow in incognito/);
    expect(section).toMatch(/cannot see extensions/i);
    // And the place the answer actually lives.
    expect(section).toContain("deploy/lab-policy/");
    expect(section).toContain("RUNBOOK.md");
  });
});
