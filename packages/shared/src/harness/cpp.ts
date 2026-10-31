import { parseType, type FunctionSignature, type TypeNode } from "./signature";

/** C++ spelling of a grammar type. */
export function cppType(t: TypeNode): string {
  switch (t.kind) {
    case "int":
      return "int";
    case "long":
      return "long long";
    case "double":
      return "double";
    case "bool":
      return "bool";
    case "char":
      return "char";
    case "string":
      return "string";
    case "void":
      return "void";
    case "TreeNode":
      return "TreeNode*";
    case "ListNode":
      return "ListNode*";
    case "list":
      return `vector<${cppType(t.of)}>`;
    case "matrix":
      return `vector<vector<${cppType(t.of)}>>`;
    case "pair":
      return `pair<${cppType(t.a)}, ${cppType(t.b)}>`;
  }
}

export function usesKind(sig: Pick<FunctionSignature, "returns" | "params">, kind: "TreeNode" | "ListNode"): boolean {
  const all = [sig.returns, ...sig.params.map((p) => p.type)];
  return all.some((s) => new RegExp(`\\b${kind}\\b`).test(s));
}

export const CPP_NODE_DEFS = {
  ListNode: `struct ListNode {
    int val;
    ListNode *next;
    ListNode() : val(0), next(nullptr) {}
    ListNode(int x) : val(x), next(nullptr) {}
    ListNode(int x, ListNode *next) : val(x), next(next) {}
};`,
  TreeNode: `struct TreeNode {
    int val;
    TreeNode *left;
    TreeNode *right;
    TreeNode() : val(0), left(nullptr), right(nullptr) {}
    TreeNode(int x) : val(x), left(nullptr), right(nullptr) {}
    TreeNode(int x, TreeNode *left, TreeNode *right) : val(x), left(left), right(right) {}
};`,
};

/** The node structs a signature needs, one line each in the program. */
export function cppNodeDefs(sig: Pick<FunctionSignature, "returns" | "params">): string[] {
  const lines: string[] = [];
  if (usesKind(sig, "ListNode")) lines.push(...CPP_NODE_DEFS.ListNode.split("\n"));
  if (usesKind(sig, "TreeNode")) lines.push(...CPP_NODE_DEFS.TreeNode.split("\n"));
  return lines;
}

/** Lines placed before the student's code. Kept short: line remapping depends on it. */
export function cppPrelude(sig: FunctionSignature): string {
  return ["#include <bits/stdc++.h>", "using namespace std;", ...cppNodeDefs(sig)].join("\n") + "\n";
}

const READER_SCALARS = String.raw`namespace recx_harness {
struct In {
    const string& s; size_t p = 0;
    explicit In(const string& src) : s(src) {}
    void ws() { while (p < s.size() && isspace((unsigned char)s[p])) ++p; }
#ifdef RECX_HARNESS_FAIL
    [[noreturn]] void fail(const char* what) { RECX_HARNESS_FAIL(what); }
#else
    [[noreturn]] void fail(const char* what) { fprintf(stderr, "harness: malformed input (%s)\n", what); exit(3); }
#endif
    void expect(char c) { ws(); if (p >= s.size() || s[p] != c) fail("unexpected character"); ++p; }
    bool peek(char c) { ws(); return p < s.size() && s[p] == c; }
    bool isNull() { ws(); if (s.compare(p, 4, "null") == 0) { p += 4; return true; } return false; }
    long long integer() {
        ws(); size_t st = p; if (p < s.size() && (s[p] == '-' || s[p] == '+')) ++p;
        while (p < s.size() && isdigit((unsigned char)s[p])) ++p;
        if (st == p) fail("expected integer");
        return stoll(s.substr(st, p - st));
    }
    double real() {
        ws(); size_t st = p;
        while (p < s.size() && (isdigit((unsigned char)s[p]) || strchr("+-.eE", s[p]))) ++p;
        if (st == p) fail("expected number");
        string t = s.substr(st, p - st); char* e = nullptr; double v = strtod(t.c_str(), &e); if (e != t.c_str() + t.size()) fail("expected number"); return v;
    }
    string str() {
        expect('"'); string out;
        while (p < s.size() && s[p] != '"') {
            char c = s[p++];
            if (c != '\\') { out += c; continue; }
            if (p >= s.size()) fail("bad escape");
            char e = s[p++];
            switch (e) {
                case 'n': out += '\n'; break; case 't': out += '\t'; break;
                case 'r': out += '\r'; break; case 'b': out += '\b'; break;
                case 'f': out += '\f'; break; case '/': out += '/'; break;
                case '\\': out += '\\'; break; case '"': out += '"'; break;
                case 'u': {
                    if (p + 4 > s.size()) fail("bad escape");
                    unsigned cp = stoul(s.substr(p, 4), nullptr, 16); p += 4;
                    if (cp >= 0xD800 && cp <= 0xDBFF && p + 6 <= s.size() && s[p] == '\\' && s[p + 1] == 'u') {
                        unsigned lo = stoul(s.substr(p + 2, 4), nullptr, 16);
                        if (lo >= 0xDC00 && lo <= 0xDFFF) { cp = 0x10000 + ((cp - 0xD800) << 10) + (lo - 0xDC00); p += 6; }
                    }
                    if (cp < 0x80) out += (char)cp;
                    else if (cp < 0x800) { out += (char)(0xC0 | (cp >> 6)); out += (char)(0x80 | (cp & 0x3F)); }
                    else if (cp < 0x10000) { out += (char)(0xE0 | (cp >> 12)); out += (char)(0x80 | ((cp >> 6) & 0x3F)); out += (char)(0x80 | (cp & 0x3F)); }
                    else { out += (char)(0xF0 | (cp >> 18)); out += (char)(0x80 | ((cp >> 12) & 0x3F)); out += (char)(0x80 | ((cp >> 6) & 0x3F)); out += (char)(0x80 | (cp & 0x3F)); }
                    break;
                }
                default: fail("bad escape");
            }
        }
        expect('"'); return out;
    }
};
inline void parse(In& in, int& v) { v = (int)in.integer(); }
inline void parse(In& in, long long& v) { v = in.integer(); }
inline void parse(In& in, double& v) { v = in.real(); }
inline void parse(In& in, bool& v) {
    in.ws();
    if (in.s.compare(in.p, 4, "true") == 0) { in.p += 4; v = true; }
    else if (in.s.compare(in.p, 5, "false") == 0) { in.p += 5; v = false; }
    else in.fail("expected bool");
}
inline void parse(In& in, string& v) { v = in.str(); }
inline void parse(In& in, char& v) { string t = in.str(); v = t.empty() ? '\0' : t[0]; }
inline vector<optional<int>> nullableInts(In& in) {
    vector<optional<int>> out; in.expect('[');
    if (in.peek(']')) { in.expect(']'); return out; }
    while (true) { if (in.isNull()) out.push_back(nullopt); else out.push_back((int)in.integer()); if (in.peek(',')) { in.expect(','); continue; } in.expect(']'); return out; }
}

inline void write(ostream& o, int v) { o << v; }
inline void write(ostream& o, long long v) { o << v; }
inline void write(ostream& o, double v) {
    char buf[64]; auto r = to_chars(buf, buf + sizeof buf, v); o.write(buf, r.ptr - buf);
}
inline void write(ostream& o, bool v) { o << (v ? "true" : "false"); }
inline void writeStr(ostream& o, const string& v) {
    o << '"';
    for (unsigned char c : v) {
        switch (c) {
            case '"': o << "\\\""; break; case '\\': o << "\\\\"; break;
            case '\n': o << "\\n"; break; case '\t': o << "\\t"; break;
            case '\r': o << "\\r"; break; case '\b': o << "\\b"; break; case '\f': o << "\\f"; break;
            default:
                if (c < 0x20) { char b[8]; snprintf(b, sizeof b, "\\u%04x", c); o << b; }
                else o << (char)c;
        }
    }
    o << '"';
}
inline void write(ostream& o, const string& v) { writeStr(o, v); }
inline void write(ostream& o, char v) { writeStr(o, string(1, v)); }
inline void write(ostream& o, const vector<bool>& v) {
    o << '['; for (size_t i = 0; i < v.size(); ++i) { if (i) o << ','; write(o, (bool)v[i]); } o << ']';
}
// Declared up front: unqualified lookup inside a template only sees what was
// declared before it, and ADL never reaches this namespace for std types.
template <class T> void parse(In& in, vector<T>& v);
template <class A, class B> void parse(In& in, pair<A, B>& v);
template <class T> void write(ostream& o, const vector<T>& v);
template <class A, class B> void write(ostream& o, const pair<A, B>& v);
} // namespace recx_harness
`;

/** Generic containers, emitted after the node I/O so they can see it. */
const READER_TEMPLATES = String.raw`namespace recx_harness {
template <class T> void parse(In& in, vector<T>& v) {
    in.expect('['); v.clear();
    if (in.peek(']')) { in.expect(']'); return; }
    while (true) { T x{}; parse(in, x); v.push_back(std::move(x)); if (in.peek(',')) { in.expect(','); continue; } in.expect(']'); return; }
}
template <class A, class B> void parse(In& in, pair<A, B>& v) { in.expect('['); parse(in, v.first); in.expect(','); parse(in, v.second); in.expect(']'); }
template <class T> void write(ostream& o, const vector<T>& v) {
    o << '['; for (size_t i = 0; i < v.size(); ++i) { if (i) o << ','; write(o, v[i]); } o << ']';
}
template <class A, class B> void write(ostream& o, const pair<A, B>& v) { o << '['; write(o, v.first); o << ','; write(o, v.second); o << ']'; }
} // namespace recx_harness
`;

const LIST_NODE_IO = String.raw`namespace recx_harness {
inline void parse(In& in, ListNode*& head) {
    head = nullptr; if (in.isNull()) return;
    vector<optional<int>> vals = nullableInts(in);
    ListNode dummy; ListNode* tail = &dummy;
    for (auto& x : vals) { tail->next = new ListNode(x.value_or(0)); tail = tail->next; }
    head = dummy.next;
}
inline void write(ostream& o, ListNode* head) {
    o << '['; bool first = true; size_t guard = 0;
    while (head && guard++ < 2000000) { if (!first) o << ','; first = false; o << head->val; head = head->next; }
    o << ']';
}
} // namespace recx_harness
`;

const TREE_NODE_IO = String.raw`namespace recx_harness {
inline void parse(In& in, TreeNode*& root) {
    root = nullptr; if (in.isNull()) return;
    vector<optional<int>> vals = nullableInts(in);
    if (vals.empty() || !vals[0]) return;
    root = new TreeNode(*vals[0]); deque<TreeNode*> q{root}; size_t i = 1;
    while (!q.empty() && i < vals.size()) {
        TreeNode* cur = q.front(); q.pop_front();
        if (i < vals.size() && vals[i]) { cur->left = new TreeNode(*vals[i]); q.push_back(cur->left); } ++i;
        if (i < vals.size() && vals[i]) { cur->right = new TreeNode(*vals[i]); q.push_back(cur->right); } ++i;
    }
}
inline void write(ostream& o, TreeNode* root) {
    vector<string> out; deque<TreeNode*> q{root};
    while (!q.empty() && out.size() < 4000000) { TreeNode* n = q.front(); q.pop_front(); if (!n) { out.push_back("null"); continue; } out.push_back(to_string(n->val)); q.push_back(n->left); q.push_back(n->right); }
    while (!out.empty() && out.back() == "null") out.pop_back();
    o << '['; for (size_t i = 0; i < out.size(); ++i) { if (i) o << ','; o << out[i]; } o << ']';
}
} // namespace recx_harness
`;

/**
 * The JSON reader / writer for a signature's types, in namespace
 * recx_harness: parse(In&, T&) and write(ostream&, const T&) for every type
 * of the grammar. Needs <bits/stdc++.h>, `using namespace std;` and the node
 * structs (cppNodeDefs) before it. Shared by the harness driver and by the
 * testlib checker template, so a checker reads values exactly as the
 * harness writes them.
 */
export function cppReaderKit(sig: Pick<FunctionSignature, "returns" | "params">): string {
  const parts = [READER_SCALARS];
  if (usesKind(sig, "ListNode")) parts.push(LIST_NODE_IO);
  if (usesKind(sig, "TreeNode")) parts.push(TREE_NODE_IO);
  parts.push(READER_TEMPLATES);
  return parts.join("\n");
}

/** Lines placed after the student's code: the reader/writer and main(). */
export function cppDriver(sig: FunctionSignature): string {
  const decls = sig.params.map((p, i) => {
    const t = parseType(p.type);
    return [
      `    ${cppType(t)} a${i}{};`,
      `    { if (!getline(cin, line)) { fprintf(stderr, "harness: missing input line ${i + 1}\\n"); return 3; } recx_harness::In in(line); recx_harness::parse(in, a${i}); }`,
    ].join("\n");
  });
  const args = sig.params.map((_, i) => `a${i}`).join(", ");
  const ret = parseType(sig.returns);
  let call: string;
  if (sig.comparator === "IN_PLACE_MUTATION") {
    const idx = sig.params.findIndex((p) => p.name === sig.mutatedParam);
    call = `    sol.${sig.methodName}(${args});\n    recx_harness::write(cout, a${idx});`;
  } else if (ret.kind === "void") {
    call = `    sol.${sig.methodName}(${args});\n    cout << "null";`;
  } else {
    call = `    auto result = sol.${sig.methodName}(${args});\n    recx_harness::write(cout, result);`;
  }

  return [
    cppReaderKit(sig),
    [
      "int main() {",
      "    ios::sync_with_stdio(false);",
      "    cin.tie(nullptr);",
      "    string line;",
      ...decls,
      "    Solution sol;",
      call,
      "    cout << '\\n';",
      "    return 0;",
      "}",
      "",
    ].join("\n"),
  ].join("\n");
}

/** Comment lines a starter stub opens with (node types the judge defines). */
export function nodeNotes(sig: Pick<FunctionSignature, "returns" | "params">, comment: string): string[] {
  const notes: string[] = [];
  if (usesKind(sig, "ListNode")) notes.push(`${comment} The judge defines ListNode (val, next) — do not redefine it.`);
  if (usesKind(sig, "TreeNode")) notes.push(`${comment} The judge defines TreeNode (val, left, right) — do not redefine it.`);
  return notes;
}

/** The in-place reminder placed in an IN_PLACE_MUTATION stub's body, or null. */
export function inPlaceNote(sig: FunctionSignature, comment: string): string | null {
  return sig.comparator === "IN_PLACE_MUTATION" && sig.mutatedParam
    ? `${comment} Do not return anything: change \`${sig.mutatedParam}\` in place.`
    : null;
}

/** Starter-code method stub for a signature (used when authoring). */
export function cppStub(sig: FunctionSignature): string {
  const params = sig.params
    .map((p) => {
      const t = parseType(p.type);
      const byRef = t.kind === "list" || t.kind === "matrix" || t.kind === "string" || t.kind === "pair";
      return `${cppType(t)}${byRef ? "&" : ""} ${p.name}`;
    })
    .join(", ");
  const note = inPlaceNote(sig, "//");
  return [
    ...nodeNotes(sig, "//"),
    "class Solution {",
    "public:",
    `    ${cppType(parseType(sig.returns))} ${sig.methodName}(${params}) {`,
    note ? `        ${note}` : "        ",
    "    }",
    "};",
    "",
  ].join("\n");
}
