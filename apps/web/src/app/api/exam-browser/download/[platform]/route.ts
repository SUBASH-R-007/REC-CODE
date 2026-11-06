import { hitRateLimit, type RateLimitRule } from "@/lib/rate-limit";
import { isExamBrowserPlatform, openExamBrowserDownload } from "@/lib/exam/exam-browser-downloads";
import { requestIpHash } from "@/lib/ip";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/exam-browser/download/[platform] — the installer (Phase 14i).
 *
 * **Unauthenticated, deliberately.** A candidate setting up a laptop the
 * evening before a paper may be on a machine they have never signed in
 * from, and an installer behind a sign-in is an installer a candidate
 * fetches from somewhere else instead — which is the one outcome
 * `docs/EXAM-BROWSER.md` cares about, since the whole reason the college
 * publishes the file is that the copy installed should be one the
 * department can vouch for. The companion page `/exam-browser` is public
 * for the same reason.
 *
 * So what protects it is not a session:
 *
 *   * the super-admin's switch, which is read on every request rather
 *     than baked into a link — turning it off takes the download away,
 *     not just the button;
 *   * a fixed list of platform keys, so nothing from the request is ever
 *     joined onto a path;
 *   * the manifest the college published, which is where the filename
 *     comes from;
 *   * a rate limit, because this is the one unauthenticated route that
 *     reads a file off the disk.
 *
 * Every "no" is the same 404. The difference between "switched off",
 * "nothing published" and "no such platform" is not a candidate's
 * business, and the page above the button says which it is in words.
 */

/**
 * Generous: a candidate on a bad connection retries, and a hall sets up
 * together. Tight enough that this is not a way to make the server read a
 * file a thousand times a minute.
 */
const DOWNLOAD_RATE_LIMIT = { limit: 20, windowMs: 10 * 60_000 } as const satisfies RateLimitRule;

/**
 * Resuming is counted separately, and higher (Phase 14l).
 *
 * One resumed download is several requests, and a download manager opens
 * a handful of connections for one file, so charging those against the
 * twenty above would mean the candidate with the worst network — the one
 * this feature exists for — is the first to be cut off.
 *
 * The trade is stated rather than hidden. `bytes=0-` is a whole download
 * wearing a range header, so it is charged to the limit above; anything
 * else gets this one. That leaves a deliberate abuser `bytes=1-` as a way
 * to buy 120 near-whole reads instead of 20, which is a bounded
 * amplification of a route that is already handing the file to anybody
 * who asks. Charging resumes strictly would close that at the cost of the
 * candidate it was built for, which is the wrong way round.
 */
const RESUME_RATE_LIMIT = { limit: 120, windowMs: 10 * 60_000 } as const satisfies RateLimitRule;

/**
 * Which bucket a request is charged to, decided from the REQUEST alone.
 *
 * It has to be decided before anything is opened. The limit's job is to
 * stop a stranger making the server stat a directory and read a file as
 * fast as it likes, and a limit checked after that work has happened is a
 * limit on the response rather than on the work.
 */
function isResume(rangeHeader: string | null): boolean {
  if (!rangeHeader) return false;
  const spec = /^bytes=(.*)$/i.exec(rangeHeader.trim());
  if (!spec) return false;
  const asked = (spec[1] ?? "").trim();
  // `bytes=0-` is the whole file; so is an empty or unparseable spec,
  // which `parseRangeHeader` turns into a whole-file answer.
  return asked !== "" && asked !== "0-";
}

const notFound = () =>
  new Response("Not found", {
    status: 404,
    headers: { "cache-control": "no-store", "content-type": "text/plain; charset=utf-8" },
  });

/**
 * The headers every answer carries.
 *
 * `accept-ranges` is the advertisement: a browser that does not see it
 * will not offer to resume an interrupted download, however well the
 * server would have handled the request.
 */
function baseHeaders(filename: string): Record<string, string> {
  return {
    "content-type": "application/octet-stream",
    /**
     * The filename comes out of the manifest and matches
     * `[A-Za-z0-9][A-Za-z0-9._-]*`, so there is nothing in it that could
     * break out of this header. Quoted anyway, because a header built by
     * concatenation is a header somebody will later concatenate
     * something else into.
     */
    "content-disposition": `attachment; filename="${filename}"`,
    "x-content-type-options": "nosniff",
    "accept-ranges": "bytes",
    /**
     * Not cached by anything in between. A build can be withdrawn by the
     * switch above, and a proxy holding yesterday's copy would keep
     * handing out a build the college has stopped offering.
     */
    "cache-control": "no-store",
  };
}

async function answer(platform: string, rangeHeader: string | null, withBody: boolean): Promise<Response> {
  if (!isExamBrowserPlatform(platform)) return notFound();

  const ipHash = await requestIpHash();
  const resume = isResume(rangeHeader);
  const bucket = resume ? "exam-browser:download:resume" : "exam-browser:download";
  const hit = await hitRateLimit(`${bucket}:${ipHash ?? "unknown"}`, resume ? RESUME_RATE_LIMIT : DOWNLOAD_RATE_LIMIT);
  if (!hit.allowed) {
    return new Response("Too many downloads from here. Wait a few minutes and try again.", {
      status: 429,
      headers: { "cache-control": "no-store", "content-type": "text/plain; charset=utf-8" },
    });
  }

  const file = await openExamBrowserDownload(platform, rangeHeader);
  if (!file) return notFound();

  if (file.kind === "unsatisfiable") {
    /**
     * 416 with the real length, so a client that guessed wrong can ask
     * again instead of guessing again. There is no body worth sending:
     * nothing reads it, and the length is the answer.
     */
    return new Response(null, {
      status: 416,
      headers: { "cache-control": "no-store", "content-range": `bytes */${file.total}` },
    });
  }

  if (file.kind === "partial") {
    const { start, end } = file.range;
    return new Response(withBody ? file.stream : null, {
      status: 206,
      headers: {
        ...baseHeaders(file.filename),
        "content-length": String(file.bytes),
        "content-range": `bytes ${start}-${end}/${file.total}`,
      },
    });
  }

  return new Response(withBody ? file.stream : null, {
    status: 200,
    headers: { ...baseHeaders(file.filename), "content-length": String(file.bytes) },
  });
}

export async function GET(request: Request, context: { params: Promise<{ platform: string }> }): Promise<Response> {
  const { platform } = await context.params;
  return answer(platform, request.headers.get("range"), true);
}

/**
 * HEAD, written out rather than left to the framework.
 *
 * Next answers a HEAD by running the GET and dropping the body, which for
 * this route means streaming 116 MB off the disk so it can be thrown
 * away. A client checking whether a build exists, or how big it is before
 * committing a candidate's data allowance to it, should cost a `stat`.
 */
export async function HEAD(request: Request, context: { params: Promise<{ platform: string }> }): Promise<Response> {
  const { platform } = await context.params;
  return answer(platform, request.headers.get("range"), false);
}
