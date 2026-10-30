import { describe, expect, it } from "vitest";
import { lexSource, readRepoFile } from "./support/repo";

/**
 * The two promises the archive makes, fenced where a reviewer sees them
 * (Phase 12e).
 *
 *   1. **There is no prose.** SPEC §11 asks for "structured fields, not
 *      prose", and the reason is not tidiness: an account of an interview
 *      written in a hurry names interviewers, repeats questions under an
 *      NDA and says things about a company the college would have to
 *      answer for — and prose cannot be counted into the "asked at" tags
 *      the archive exists to produce. The field list below is the whole
 *      model, asserted exactly, so adding a `notes` column is a line in a
 *      diff and a failing build rather than a quiet product change.
 *
 *   2. **Students never see who wrote one.** The student-facing read must
 *      not select a name. Not "select it and drop it on the way out" —
 *      not select it, so there is no payload it could survive in.
 */

const SCHEMA = "packages/db/prisma/schema.prisma";
const QUERIES = "apps/web/src/server/queries/interviews.ts";

/** The named fields of one Prisma model, in declaration order. */
export function modelFields(schema: string, model: string): string[] {
  const start = new RegExp(`^model\\s+${model}\\s*\\{`, "m").exec(schema);
  if (!start) throw new Error(`model ${model} is not in the schema`);
  const body = schema.slice(start.index + start[0].length);
  const end = body.indexOf("\n}");
  return body
    .slice(0, end)
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("//") && !line.startsWith("///") && !line.startsWith("@@"))
    .map((line) => line.split(/\s+/)[0]!)
    .filter(Boolean);
}

describe("detector self-test", () => {
  it("reads a model's fields and refuses an unknown model", () => {
    const schema = readRepoFile(SCHEMA);
    expect(modelFields(schema, "Company")).toContain("slug");
    expect(() => modelFields(schema, "NotAModel")).toThrow();
  });
});

describe("structured fields, not prose", () => {
  const schema = readRepoFile(SCHEMA);

  it("InterviewExperience has exactly these fields, and no body", () => {
    expect(modelFields(schema, "InterviewExperience")).toEqual([
      "id",
      "authorId",
      "author",
      "source",
      "companyId",
      "company",
      // The ONE free-text column, and it is a company name: a student has
      // to be able to say which company it was before anybody has entered
      // one. Bounded at 80 characters by a CHECK.
      "companyName",
      "role",
      "mode",
      "heldYear",
      "heldMonth",
      "rounds",
      "longestRoundMinutes",
      "outcome",
      "roundKinds",
      "topics",
      "preparation",
      "status",
      "decidedById",
      "decidedBy",
      "decidedAt",
      // A moderator's sentence to the student. Not the student's prose.
      "decisionReason",
      "createdAt",
      "problems",
    ]);
  });

  it("nothing in it is a Text column", () => {
    const start = /^model\s+InterviewExperience\s*\{/m.exec(schema)!;
    const body = schema.slice(start.index, schema.indexOf("\n}", start.index));
    expect(body).not.toContain("@db.Text");
  });

  it("the student form offers no textarea", () => {
    // The place a body would arrive from if one were ever added.
    const form = readRepoFile("apps/web/src/components/interviews/share-experience.tsx");
    expect(form).not.toContain("<Textarea");
    expect(form).not.toContain("<textarea");
  });
});

describe("students never see who wrote one", () => {
  const { code } = lexSource(readRepoFile(QUERIES));

  /** One exported function's body, up to the next top-level export. */
  function bodyOf(name: string): string {
    const match = new RegExp(`export async function ${name}\\(`).exec(code);
    expect(match, `${name} is exported from ${QUERIES}`).not.toBeNull();
    const rest = code.slice(match!.index + 1);
    const next = /\nexport (async function|function|const|interface)/.exec(rest);
    return rest.slice(0, next ? next.index : rest.length);
  }

  it("loadArchive selects no name and no email", () => {
    const body = bodyOf("loadArchive");
    for (const field of ["firstName", "lastName", "email", "collegeId", "handle"]) {
      expect(body, `loadArchive must not select ${field}`).not.toContain(field);
    }
  });

  it("the moderator's queue does select a name, because a row nobody stands behind cannot be followed up", () => {
    expect(bodyOf("loadPendingExperiences")).toContain("firstName");
  });

  it("the student-facing author shape is the two fields the anonymous line is built from", () => {
    expect(code).toContain("const AUTHOR_SHAPE = { select: { batchYear: true, departmentCode: true } }");
    // Section is deliberately absent: batch + department + section is
    // three or four people.
    expect(code).not.toContain("section: true");
  });
});
