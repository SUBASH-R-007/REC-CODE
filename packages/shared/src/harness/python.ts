import { inPlaceNote, nodeNotes, usesKind } from "./cpp";
import { parseType, typeToString, type FunctionSignature, type TypeNode } from "./signature";

function pyHint(t: TypeNode): string {
  switch (t.kind) {
    case "int":
    case "long":
      return "int";
    case "double":
      return "float";
    case "bool":
      return "bool";
    case "char":
    case "string":
      return "str";
    case "void":
      return "None";
    case "TreeNode":
      return "Optional[TreeNode]";
    case "ListNode":
      return "Optional[ListNode]";
    case "list":
      return `List[${pyHint(t.of)}]`;
    case "matrix":
      return `List[List[${pyHint(t.of)}]]`;
    case "pair":
      return `Tuple[${pyHint(t.a)}, ${pyHint(t.b)}]`;
  }
}

/** Lines placed before the student's code. Kept short: line remapping depends on it. */
export function pythonPrelude(sig: FunctionSignature): string {
  const lines = [
    "from typing import *",
    "import sys, math, json, heapq, bisect, itertools, functools, collections",
    "from collections import defaultdict, deque, Counter, OrderedDict",
  ];
  if (usesKind(sig, "ListNode")) {
    lines.push(
      "class ListNode:",
      "    def __init__(self, val=0, next=None):",
      "        self.val = val",
      "        self.next = next",
    );
  }
  if (usesKind(sig, "TreeNode")) {
    lines.push(
      "class TreeNode:",
      "    def __init__(self, val=0, left=None, right=None):",
      "        self.val = val",
      "        self.left = left",
      "        self.right = right",
    );
  }
  return lines.join("\n") + "\n";
}

/**
 * A Python expression converting the parsed JSON value `expr` into the
 * parameter type, or null when json.loads already yields the right value.
 * Doubles become float (json gives int for "5"), pairs tuples, trees and
 * linked lists node objects — at any depth.
 */
function pyConvert(t: TypeNode, expr: string, depth: number): string | null {
  switch (t.kind) {
    case "double":
      return `float(${expr})`;
    case "TreeNode":
      return `_recx_tree(${expr})`;
    case "ListNode":
      return `_recx_list(${expr})`;
    case "pair": {
      const a = pyConvert(t.a, `${expr}[0]`, depth) ?? `${expr}[0]`;
      const b = pyConvert(t.b, `${expr}[1]`, depth) ?? `${expr}[1]`;
      return `(${a}, ${b})`;
    }
    case "list": {
      const v = `_x${depth}`;
      const inner = pyConvert(t.of, v, depth + 1);
      return inner === null ? null : `[${inner} for ${v} in ${expr}]`;
    }
    case "matrix": {
      const row = `_x${depth}`;
      const v = `_x${depth + 1}`;
      const inner = pyConvert(t.of, v, depth + 2);
      return inner === null ? null : `[[${inner} for ${v} in ${row}] for ${row} in ${expr}]`;
    }
    default:
      return null;
  }
}

export function pythonDriver(sig: FunctionSignature): string {
  const helpers: string[] = [];
  const toJson: string[] = [
    "def _recx_out(v):",
    "    if isinstance(v, bool) or v is None or isinstance(v, (int, float, str)):",
    "        return v",
    "    if isinstance(v, (list, tuple)):",
    "        return [_recx_out(x) for x in v]",
  ];
  if (usesKind(sig, "ListNode")) {
    helpers.push(
      "def _recx_list(vals):",
      "    dummy = ListNode()",
      "    tail = dummy",
      "    for x in vals or []:",
      "        tail.next = ListNode(x)",
      "        tail = tail.next",
      "    return dummy.next",
    );
    toJson.push(
      "    if isinstance(v, ListNode):",
      "        out = []",
      "        while v is not None and len(out) < 2000000:",
      "            out.append(v.val)",
      "            v = v.next",
      "        return out",
    );
  }
  if (usesKind(sig, "TreeNode")) {
    helpers.push(
      "def _recx_tree(vals):",
      "    if not vals or vals[0] is None:",
      "        return None",
      "    root = TreeNode(vals[0])",
      "    q = deque([root])",
      "    i = 1",
      "    while q and i < len(vals):",
      "        cur = q.popleft()",
      "        if i < len(vals) and vals[i] is not None:",
      "            cur.left = TreeNode(vals[i])",
      "            q.append(cur.left)",
      "        i += 1",
      "        if i < len(vals) and vals[i] is not None:",
      "            cur.right = TreeNode(vals[i])",
      "            q.append(cur.right)",
      "        i += 1",
      "    return root",
    );
    toJson.push(
      "    if isinstance(v, TreeNode):",
      "        out, q = [], deque([v])",
      "        while q and len(out) < 4000000:",
      "            n = q.popleft()",
      "            if n is None:",
      "                out.append(None)",
      "                continue",
      "            out.append(n.val)",
      "            q.append(n.left)",
      "            q.append(n.right)",
      "        while out and out[-1] is None:",
      "            out.pop()",
      "        return out",
    );
  }
  toJson.push("    return v");

  const reads = sig.params.flatMap((p, i) => {
    const convert = pyConvert(parseType(p.type), `_a${i}`, 0);
    const read = `    _a${i} = json.loads(_lines[${i}])`;
    return convert === null ? [read] : [read, `    _a${i} = ${convert}  # ${typeToString(parseType(p.type))}`];
  });
  const args = sig.params.map((_, i) => `_a${i}`).join(", ");
  const ret = parseType(sig.returns);
  let call: string[];
  if (sig.comparator === "IN_PLACE_MUTATION") {
    const idx = sig.params.findIndex((p) => p.name === sig.mutatedParam);
    call = [`    Solution().${sig.methodName}(${args})`, `    _r = _a${idx}`];
  } else if (ret.kind === "void") {
    call = [`    Solution().${sig.methodName}(${args})`, "    _r = None"];
  } else {
    call = [`    _r = Solution().${sig.methodName}(${args})`];
  }

  return [
    "",
    ...helpers,
    ...toJson,
    "def _recx_main():",
    "    _lines = sys.stdin.read().split('\\n')",
    `    if len(_lines) < ${sig.params.length}:`,
    "        sys.stderr.write('harness: missing input lines\\n')",
    "        sys.exit(3)",
    ...reads,
    ...call,
    "    sys.stdout.write(json.dumps(_recx_out(_r), separators=(',', ':'), ensure_ascii=False) + '\\n')",
    "_recx_main()",
    "",
  ].join("\n");
}

export function pythonStub(sig: FunctionSignature): string {
  const params = sig.params.map((p) => `${p.name}: ${pyHint(parseType(p.type))}`).join(", ");
  const note = inPlaceNote(sig, "#");
  return [
    ...nodeNotes(sig, "#"),
    "class Solution:",
    `    def ${sig.methodName}(self${params ? ", " + params : ""}) -> ${pyHint(parseType(sig.returns))}:`,
    note ? `        ${note}` : "        ",
    "",
  ].join("\n");
}
