/**
 * Every string a server-rendered React tree would carry to the browser, for
 * the student-exposure canary test (test/student-exposure.db.test.ts).
 *
 * `collectStrings(node)` walks a value returned by a page or layout:
 *   - strings, numbers and bigints are collected; Dates as ISO strings;
 *   - arrays, iterables, Maps, Sets and plain objects are walked;
 *   - promises (and thenables) are awaited, then walked;
 *   - a React element's props are walked (children included), and an
 *     ASYNC function component is expanded: called with its props, its
 *     result awaited and walked. Sync components (client components, and
 *     server components that cannot fetch) are not called — every value
 *     they could render reaches them through the props walked here.
 *   - functions (event handlers, server-action references) carry no data to
 *     the browser and are skipped.
 *
 * A component that throws is recorded as `<threw:Name: message>` rather
 * than aborting the walk, so one failing card cannot hide the rest of the
 * page; the caller decides whether a throw is acceptable.
 */

const ELEMENT_TYPES = new Set([Symbol.for("react.transitional.element"), Symbol.for("react.element")]);
const MAX_DEPTH = 400;

interface Element {
  $$typeof: symbol;
  type: unknown;
  props: Record<string, unknown> | null;
}

function isElement(value: unknown): value is Element {
  return typeof value === "object" && value !== null && ELEMENT_TYPES.has((value as { $$typeof?: symbol }).$$typeof as symbol);
}

function isAsyncFunction(fn: unknown): fn is (props: unknown) => Promise<unknown> {
  return typeof fn === "function" && fn.constructor?.name === "AsyncFunction";
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return (
    (typeof value === "object" || typeof value === "function") &&
    value !== null &&
    typeof (value as { then?: unknown }).then === "function"
  );
}

export interface CollectOptions {
  /** Called for each async component that throws (default: record it as a string). */
  onThrow?: (name: string, error: unknown) => void;
}

export async function collectStrings(node: unknown, options: CollectOptions = {}): Promise<string[]> {
  const out: string[] = [];
  const seen = new WeakSet<object>();

  const walk = async (value: unknown, depth: number): Promise<void> => {
    if (depth > MAX_DEPTH) throw new Error("collectStrings: tree too deep");
    if (value === null || value === undefined || typeof value === "boolean" || typeof value === "symbol") return;
    if (typeof value === "string") {
      out.push(value);
      return;
    }
    if (typeof value === "number" || typeof value === "bigint") {
      out.push(String(value));
      return;
    }
    if (typeof value === "function") return;
    if (isThenable(value)) {
      await walk(await value, depth + 1);
      return;
    }
    if (typeof value !== "object") return;
    if (seen.has(value)) return;
    seen.add(value);

    if (value instanceof Date) {
      out.push(Number.isNaN(value.getTime()) ? "Invalid Date" : value.toISOString());
      return;
    }
    if (isElement(value)) {
      const props = value.props ?? {};
      if (isAsyncFunction(value.type)) {
        const name = value.type.name || "anonymous";
        let rendered: unknown;
        try {
          rendered = await value.type(props);
        } catch (error) {
          if (options.onThrow) options.onThrow(name, error);
          else out.push(`<threw:${name}: ${error instanceof Error ? error.message : String(error)}>`);
          rendered = undefined;
        }
        await walk(rendered, depth + 1);
      }
      for (const prop of Object.values(props)) await walk(prop, depth + 1);
      return;
    }
    if (value instanceof Map) {
      for (const [k, v] of value) {
        await walk(k, depth + 1);
        await walk(v, depth + 1);
      }
      return;
    }
    if (Array.isArray(value) || value instanceof Set || typeof (value as { [Symbol.iterator]?: unknown })[Symbol.iterator] === "function") {
      for (const item of value as Iterable<unknown>) await walk(item, depth + 1);
      return;
    }
    for (const [k, v] of Object.entries(value)) {
      out.push(k);
      await walk(v, depth + 1);
    }
  };

  await walk(node, 0);
  return out;
}
