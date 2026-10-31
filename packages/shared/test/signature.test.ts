import { describe, expect, it } from "vitest";
import {
  comparedTypeOf,
  containsDouble,
  FUNCTION_COMPARATOR_DESCRIPTIONS,
  FUNCTION_COMPARATORS,
  functionCompareMode,
  functionSignatureSchema,
  isReservedIdentifier,
  parseType,
  TypeParseError,
  typeToString,
  type FunctionSignature,
  type TypeNode,
} from "../src/harness/signature";
import { TWO_SUM } from "../src/samples/two-sum";

describe("parseType", () => {
  const accepted: Array<[source: string, node: TypeNode]> = [
    ["int", { kind: "int" }],
    ["long", { kind: "long" }],
    ["double", { kind: "double" }],
    ["bool", { kind: "bool" }],
    ["char", { kind: "char" }],
    ["string", { kind: "string" }],
    ["void", { kind: "void" }],
    ["TreeNode", { kind: "TreeNode" }],
    ["ListNode", { kind: "ListNode" }],
    ["list<int>", { kind: "list", of: { kind: "int" } }],
    ["matrix<double>", { kind: "matrix", of: { kind: "double" } }],
    ["pair<int,string>", { kind: "pair", a: { kind: "int" }, b: { kind: "string" } }],
    [
      "list<pair<int, list<string>>>",
      { kind: "list", of: { kind: "pair", a: { kind: "int" }, b: { kind: "list", of: { kind: "string" } } } },
    ],
    [" list < TreeNode > ", { kind: "list", of: { kind: "TreeNode" } }],
  ];

  it.each(accepted)("accepts %j", (source, node) => {
    expect(parseType(source)).toEqual(node);
  });

  it.each(accepted)("round-trips %j through typeToString", (source) => {
    const canonical = typeToString(parseType(source));
    expect(canonical).not.toMatch(/\s/);
    expect(parseType(canonical)).toEqual(parseType(source));
  });

  it.each([
    "",
    "integer",
    "Int",
    "List<int>",
    "map<int,int>",
    "set<int>",
    "int[]",
    "list<int",
    "list<>",
    "list<void>",
    "matrix<void>",
    "pair<int>",
    "pair<int,void>",
    "pair<void,int>",
    "list<int>>",
    "int int",
    "list<int>,",
  ])("rejects %j", (source) => {
    expect(() => parseType(source)).toThrow(TypeParseError);
  });
});

describe("functionSignatureSchema", () => {
  const base: FunctionSignature = {
    className: "Solution",
    methodName: "solve",
    params: [{ name: "nums", type: "list<int>" }],
    returns: "int",
    comparator: "EXACT",
    mutatedParam: null,
  };
  const check = (patch: Partial<FunctionSignature> & Record<string, unknown>) =>
    functionSignatureSchema.safeParse({ ...base, ...patch });

  it("accepts the two-sum signature", () => {
    expect(functionSignatureSchema.parse(TWO_SUM.signature)).toEqual(TWO_SUM.signature);
  });

  it("defaults mutatedParam to null", () => {
    const { mutatedParam: _omit, ...rest } = base;
    expect(functionSignatureSchema.parse(rest).mutatedParam).toBeNull();
  });

  it("requires mutatedParam for IN_PLACE_MUTATION", () => {
    expect(check({ comparator: "IN_PLACE_MUTATION", returns: "void" }).success).toBe(false);
    expect(check({ comparator: "IN_PLACE_MUTATION", returns: "void", mutatedParam: "other" }).success).toBe(false);
    expect(check({ comparator: "IN_PLACE_MUTATION", returns: "void", mutatedParam: "nums" }).success).toBe(true);
  });

  it("rejects a void return for every other comparator", () => {
    const fitting = {
      EXACT: "int",
      FLOAT_TOLERANCE: "double",
      SET_EQUAL: "list<int>",
      ROWS_ANY_ORDER: "matrix<int>",
      CUSTOM_CHECKER: "int",
    } as const;
    for (const [comparator, returns] of Object.entries(fitting) as [keyof typeof fitting, string][]) {
      expect(check({ comparator, returns: "void" }).success, comparator).toBe(false);
      expect(check({ comparator, returns }).success, comparator).toBe(true);
    }
  });

  it("rejects void parameters", () => {
    expect(check({ params: [{ name: "x", type: "void" }] }).success).toBe(false);
  });

  // A schema at a server boundary must report bad input, never throw: an
  // authoring action or a claim body with an unknown type would otherwise
  // surface as a 500 instead of a validation message.
  it("reports unknown parameter and return types as validation issues (safeParse never throws)", () => {
    const badParam = check({ params: [{ name: "x", type: "map<int,int>" }] });
    expect(badParam.success).toBe(false);
    const badReturn = check({ returns: "vector<int>" });
    expect(badReturn.success).toBe(false);
  });

  it("requires class Solution and identifier names", () => {
    expect(check({ className: "Main" as "Solution" }).success).toBe(false);
    expect(check({ methodName: "two-sum" }).success).toBe(false);
    expect(check({ methodName: "1st" }).success).toBe(false);
    expect(check({ params: [{ name: "a b", type: "int" }] }).success).toBe(false);
  });

  it("caps the parameter count at 8 and requires a known comparator", () => {
    const params = Array.from({ length: 9 }, (_, i) => ({ name: `p${i}`, type: "int" }));
    expect(check({ params }).success).toBe(false);
    expect(check({ params: params.slice(0, 8) }).success).toBe(true);
    expect(check({ comparator: "FUZZY" as "EXACT" }).success).toBe(false);
  });
});

describe("functionSignatureSchema — Phase 4 rules", () => {
  const sig = (patch: Partial<FunctionSignature>): Record<string, unknown> => ({
    className: "Solution",
    methodName: "solve",
    params: [{ name: "nums", type: "list<int>" }],
    returns: "int",
    comparator: "EXACT",
    mutatedParam: null,
    ...patch,
  });
  const ok = (patch: Partial<FunctionSignature>) => functionSignatureSchema.safeParse(sig(patch)).success;
  const messages = (patch: Partial<FunctionSignature>) => {
    const r = functionSignatureSchema.safeParse(sig(patch));
    return r.success ? [] : r.error.issues.map((i) => i.message);
  };

  it("rejects duplicate parameter names", () => {
    const params = [
      { name: "a", type: "int" },
      { name: "a", type: "int" },
    ];
    expect(ok({ params })).toBe(false);
    expect(messages({ params }).join()).toMatch(/declared twice/);
  });

  it.each(["class", "int", "def", "lambda", "boolean", "self", "main", "Solution", "NULL", "__x", "_Big", "recx_x", "RecxIn", "_recx_out"])(
    "rejects the reserved name %s for a parameter and the method",
    (name) => {
      expect(isReservedIdentifier(name)).toBe(true);
      expect(ok({ params: [{ name, type: "int" }] })).toBe(false);
      expect(ok({ methodName: name })).toBe(false);
    },
  );

  it.each(["nums", "target", "name", "_x", "value2", "grid"])("accepts the ordinary name %s", (name) => {
    expect(isReservedIdentifier(name)).toBe(false);
    expect(ok({ params: [{ name, type: "list<int>" }] })).toBe(true);
  });

  it("rejects java.lang.Object method names for the method", () => {
    for (const methodName of ["equals", "hashCode", "toString", "getClass", "wait", "notify"]) expect(ok({ methodName })).toBe(false);
  });

  it("rejects mutatedParam outside IN_PLACE_MUTATION", () => {
    expect(ok({ mutatedParam: "nums" })).toBe(false);
  });

  it("IN_PLACE_MUTATION needs a void method and a list, matrix, TreeNode or ListNode parameter", () => {
    const inPlace = (type: string, returns = "void") =>
      ok({ comparator: "IN_PLACE_MUTATION", returns, params: [{ name: "x", type }], mutatedParam: "x" });
    for (const type of ["list<int>", "matrix<char>", "TreeNode", "ListNode", "list<string>", "list<pair<int,int>>"]) {
      expect(inPlace(type), type).toBe(true);
    }
    for (const type of ["int", "long", "string", "pair<int,int>", "bool", "char"]) expect(inPlace(type), type).toBe(false);
    expect(inPlace("list<int>", "int")).toBe(false);
    expect(inPlace("list<double>")).toBe(false);
  });

  it("EXACT refuses a compared type containing a double; parameters may hold doubles", () => {
    expect(ok({ returns: "double" })).toBe(false);
    expect(ok({ returns: "list<pair<int,double>>" })).toBe(false);
    expect(ok({ params: [{ name: "w", type: "list<double>" }], returns: "int" })).toBe(true);
  });

  it("FLOAT_TOLERANCE needs a double in the compared type", () => {
    expect(ok({ comparator: "FLOAT_TOLERANCE", returns: "double" })).toBe(true);
    expect(ok({ comparator: "FLOAT_TOLERANCE", returns: "matrix<double>" })).toBe(true);
    expect(ok({ comparator: "FLOAT_TOLERANCE", returns: "pair<string,double>" })).toBe(true);
    expect(ok({ comparator: "FLOAT_TOLERANCE", returns: "list<int>" })).toBe(false);
    expect(ok({ comparator: "FLOAT_TOLERANCE", returns: "long" })).toBe(false);
  });

  it("SET_EQUAL compares a list or matrix without doubles", () => {
    for (const returns of ["list<int>", "matrix<int>", "list<string>", "list<pair<int,int>>", "list<list<int>>"]) {
      expect(ok({ comparator: "SET_EQUAL", returns }), returns).toBe(true);
    }
    for (const returns of ["int", "string", "pair<int,int>", "TreeNode", "list<double>"]) {
      expect(ok({ comparator: "SET_EQUAL", returns }), returns).toBe(false);
    }
  });

  it("ROWS_ANY_ORDER compares a matrix or a list of lists or pairs without doubles", () => {
    for (const returns of ["matrix<int>", "list<list<int>>", "list<pair<int,string>>", "matrix<string>"]) {
      expect(ok({ comparator: "ROWS_ANY_ORDER", returns }), returns).toBe(true);
    }
    for (const returns of ["list<int>", "list<string>", "int", "matrix<double>"]) {
      expect(ok({ comparator: "ROWS_ANY_ORDER", returns }), returns).toBe(false);
    }
  });

  it("CUSTOM_CHECKER accepts any non-void type, doubles included", () => {
    for (const returns of ["int", "double", "list<double>", "TreeNode", "pair<int,int>"]) {
      expect(ok({ comparator: "CUSTOM_CHECKER", returns }), returns).toBe(true);
    }
  });

  it("never throws, whatever the input (safeParse at a server boundary)", () => {
    const inputs: unknown[] = [{}, null, 1, "x", { params: "x" }, sig({ params: [{ name: "x", type: "map<int>" }] }), sig({ returns: "list<" })];
    for (const bad of inputs) expect(() => functionSignatureSchema.safeParse(bad)).not.toThrow();
  });
});

describe("signature helpers", () => {
  it("containsDouble finds a double at any depth", () => {
    expect(containsDouble(parseType("double"))).toBe(true);
    expect(containsDouble(parseType("list<pair<int,matrix<double>>>"))).toBe(true);
    expect(containsDouble(parseType("list<pair<int,matrix<long>>>"))).toBe(false);
  });

  it("comparedTypeOf is the mutated parameter for IN_PLACE_MUTATION, else the return type", () => {
    const params = [
      { name: "a", type: "int" },
      { name: "grid", type: "matrix<int>" },
    ];
    expect(typeToString(comparedTypeOf({ params, comparator: "IN_PLACE_MUTATION", returns: "void", mutatedParam: "grid" }))).toBe("matrix<int>");
    expect(typeToString(comparedTypeOf({ params, comparator: "EXACT", returns: "long", mutatedParam: null }))).toBe("long");
  });

  it("functionCompareMode mirrors CUSTOM_CHECKER ⇔ CHECKER", () => {
    for (const c of FUNCTION_COMPARATORS) expect(functionCompareMode(c)).toBe(c === "CUSTOM_CHECKER" ? "CHECKER" : "TOKEN");
  });

  it("describes every comparator for students and authors", () => {
    for (const c of FUNCTION_COMPARATORS) {
      const d = FUNCTION_COMPARATOR_DESCRIPTIONS[c];
      expect(d.label.length).toBeGreaterThan(0);
      expect(d.student.length).toBeGreaterThan(20);
      expect(d.author.length).toBeGreaterThan(20);
    }
  });
});
