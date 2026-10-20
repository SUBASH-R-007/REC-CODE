import { existsSync } from "node:fs";
import {
  LANGUAGE_CATALOG,
  LANGUAGE_KEYS,
  TOOLCHAIN_ID_PATTERN,
  toolchainDirs,
  type LanguageKey,
  type LanguageRuntime,
} from "@recx/shared";
import { InfraError } from "./errors";

/**
 * Which pinned toolchains this host actually has. A toolchain is a directory
 * /opt/toolchains/<id>; a language is judgeable when every directory it
 * needs exists (Kotlin also needs the JDK).
 */

export type PathExists = (path: string) => boolean;

/** Catalog languages whose toolchain directories all exist on this host. */
export function installedLanguages(exists: PathExists = existsSync): LanguageKey[] {
  return LANGUAGE_KEYS.filter((key) => toolchainDirs(LANGUAGE_CATALOG[key]).every((dir) => exists(dir)));
}

/** Languages the catalog enables by default (what the mock driver claims to support). */
export function defaultLanguages(): LanguageKey[] {
  return LANGUAGE_KEYS.filter((key) => LANGUAGE_CATALOG[key].enabledByDefault);
}

type RuntimeShape = Pick<LanguageRuntime, "key" | "toolchainId" | "extraToolchainIds" | "compile" | "run">;

/**
 * Throws InfraError unless this host can judge the runtime: ids are plain
 * directory names, the directories exist, and every absolute program path
 * (compiler, interpreter, JVM) exists. Checked before a box is created, so a
 * missing toolchain is an infrastructure failure, never a student's CE.
 */
export function assertToolchainsPresent(runtime: RuntimeShape, exists: PathExists = existsSync): void {
  const ids = [runtime.toolchainId, ...runtime.extraToolchainIds];
  const bad = ids.find((id) => !TOOLCHAIN_ID_PATTERN.test(id));
  if (bad !== undefined) throw new InfraError(`illegal toolchain id ${JSON.stringify(bad)} for ${runtime.key}`);

  const missing = toolchainDirs(runtime).filter((dir) => !exists(dir));
  for (const program of [runtime.compile?.argv[0], runtime.run.argv[0]]) {
    if (program?.startsWith("/") && !exists(program)) missing.push(program);
  }
  if (missing.length > 0) {
    throw new InfraError(`toolchain for ${runtime.key} is not installed on this node: ${missing.join(", ")}`);
  }
}
