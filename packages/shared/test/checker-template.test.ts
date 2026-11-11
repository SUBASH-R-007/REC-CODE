import { describe, expect, it } from "vitest";
import { checkerTemplate, cppReaderKit } from "../src/harness";
import type { FunctionSignature } from "../src/harness/signature";

const pairSig: FunctionSignature = {
  className: "Solution",
  methodName: "findPair",
  params: [
    { name: "prices", type: "list<int>" },
    { name: "amount", type: "long" },
  ],
  returns: "pair<int,int>",
  comparator: "CUSTOM_CHECKER",
  mutatedParam: null,
};

describe("checkerTemplate", () => {
  const source = checkerTemplate(pairSig);

  it("is a self-contained testlib checker built on the harness reader", () => {
    expect(source).toContain('#include "testlib.h"');
    expect(source).toContain("registerTestlibCmd(argc, argv);");
    expect(source).toContain(cppReaderKit(pairSig));
    // A value that does not parse is a checker FAIL, through testlib (never a bare exit).
    expect(source).toContain('#define RECX_HARNESS_FAIL(what) quitf(_fail, "malformed value (%s)", what)');
    expect(source.indexOf("#define RECX_HARNESS_FAIL")).toBeLessThan(source.indexOf("namespace recx_harness"));
  });

  it("reads every parameter from input.txt, the jury answer and the student's answer", () => {
    expect(source).toContain("vector<int> prices = readValue<vector<int>>(::inf);");
    expect(source).toContain("long long amount = readValue<long long>(::inf);");
    expect(source).toContain("pair<int, int> jury = readValue<pair<int, int>>(::ans);");
    expect(source).toContain("pair<int, int> got = readValue<pair<int, int>>(::ouf);");
  });

  it("validates the jury answer (FAIL) before the student's (WA), with a TODO for the author", () => {
    expect(source).toContain("string checkAnswer(vector<int> const& prices, long long const& amount, pair<int, int> const& candidate)");
    expect(source).toContain("// TODO:");
    const main = source.indexOf("int main(");
    expect(source.indexOf("quitf(_fail", main)).toBeGreaterThan(main);
    expect(source.indexOf("quitf(_fail", main)).toBeLessThan(source.indexOf("quitf(_wa", main));
    expect(source).toMatch(/quitf\(_ok, "a valid answer"\);\n}\n$/);
  });

  it("keeps clear of parameter names and defines the node structs it needs", () => {
    const clash = checkerTemplate({
      ...pairSig,
      params: [
        { name: "jury", type: "TreeNode" },
        { name: "got", type: "int" },
        { name: "candidate", type: "int" },
      ],
      returns: "list<int>",
    });
    expect(clash).toContain("struct TreeNode {");
    expect(clash).toContain("vector<int> recx_jury = readValue<vector<int>>(::ans);");
    expect(clash).toContain("vector<int> recx_got = readValue<vector<int>>(::ouf);");
    expect(clash).toContain("vector<int> const& recx_candidate)");
    expect(clash).toContain("TreeNode* const& jury");
  });

  it("checks the mutated parameter's type for an IN_PLACE_MUTATION signature", () => {
    const inPlace = checkerTemplate({
      ...pairSig,
      params: [{ name: "grid", type: "matrix<int>" }],
      returns: "void",
      comparator: "IN_PLACE_MUTATION",
      mutatedParam: "grid",
    });
    expect(inPlace).toContain("vector<vector<int>> jury = readValue<vector<vector<int>>>(::ans);");
  });
});
