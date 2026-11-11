export type DeepReadonly<T> = T extends (...args: never[]) => unknown
  ? T
  : T extends object
    ? { readonly [K in keyof T]: DeepReadonly<T[K]> }
    : T;

/**
 * Object.freeze all the way down. The limits table and XP rules are shared by
 * every process; a shallow freeze would still let any importer silently
 * rewrite e.g. LIMITS.cpuTime.ceilingMs for its whole process.
 */
export function deepFreeze<T>(value: T): DeepReadonly<T> {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const key of Object.keys(value)) deepFreeze((value as Record<string, unknown>)[key]);
    Object.freeze(value);
  }
  return value as DeepReadonly<T>;
}
