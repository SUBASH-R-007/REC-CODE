import type { IsolateMeta } from "./types";

/**
 * Parse isolate's --meta file ("key:value" per line). Unknown keys are
 * ignored; a malformed number is treated as absent rather than guessed.
 */
export function parseIsolateMeta(text: string): IsolateMeta {
  const values = new Map<string, string>();
  for (const line of text.split("\n")) {
    const colon = line.indexOf(":");
    if (colon <= 0) continue;
    values.set(line.slice(0, colon).trim(), line.slice(colon + 1).trim());
  }

  const num = (key: string): number | null => {
    const raw = values.get(key);
    if (raw === undefined || raw === "") return null;
    const n = Number(raw);
    return Number.isFinite(n) ? n : null;
  };
  const status = values.get("status");

  return {
    status: status === "RE" || status === "SG" || status === "TO" || status === "XX" ? status : null,
    timeSec: num("time"),
    wallSec: num("time-wall"),
    maxRssKb: num("max-rss"),
    cgMemKb: num("cg-mem"),
    cgOomKilled: values.get("cg-oom-killed") === "1",
    exitCode: num("exitcode"),
    exitSignal: num("exitsig"),
    killed: values.get("killed") === "1",
    message: values.get("message") ?? null,
  };
}

/** A meta record for an empty / missing file — what an isolate crash before writing looks like. */
export function isMetaEmpty(meta: IsolateMeta): boolean {
  return meta.status === null && meta.timeSec === null && meta.exitCode === null && meta.exitSignal === null;
}
