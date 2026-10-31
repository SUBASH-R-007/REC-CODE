/**
 * Boot checks that run before the worker touches Redis, the app host or a
 * sandbox. Read from the raw environment so they hold even when the rest of
 * the configuration is invalid.
 */

/** Why this process must not start, or null when it may. */
export function bootRefusal(env: NodeJS.ProcessEnv): string | null {
  if (env.NODE_ENV === "production" && env.RECX_DRIVER === "mock") {
    return [
      "Refusing to start: RECX_DRIVER=mock with NODE_ENV=production.",
      "The mock judge driver executes no code and fabricates every verdict.",
      "It exists for Windows development only. Use RECX_DRIVER=isolate on a Linux judge host.",
    ].join("\n");
  }
  if (env.NODE_ENV === "production" && env.RECX_DEV_ALLOW_UNHARDENED_HOST !== undefined && env.RECX_DEV_ALLOW_UNHARDENED_HOST !== "") {
    return [
      "Refusing to start: RECX_DEV_ALLOW_UNHARDENED_HOST is set with NODE_ENV=production.",
      "It lets a development box whose kernel hardening check failed take jobs anyway.",
      "A production judge host must pass the hardening check; remove the variable and fix the host.",
    ].join("\n");
  }
  return null;
}

/** Print the refusal and exit non-zero. Must be called before any connection is opened. */
export function enforceBootChecks(env: NodeJS.ProcessEnv = process.env): void {
  const refusal = bootRefusal(env);
  if (refusal) {
    process.stderr.write(`[judge-worker] FATAL\n${refusal}\n`);
    process.exit(1);
  }
}
