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

const notFound = () =>
  new Response("Not found", {
    status: 404,
    headers: { "cache-control": "no-store", "content-type": "text/plain; charset=utf-8" },
  });

export async function GET(_request: Request, context: { params: Promise<{ platform: string }> }): Promise<Response> {
  const { platform } = await context.params;
  if (!isExamBrowserPlatform(platform)) return notFound();

  const ipHash = await requestIpHash();
  const hit = await hitRateLimit(`exam-browser:download:${ipHash ?? "unknown"}`, DOWNLOAD_RATE_LIMIT);
  if (!hit.allowed) {
    return new Response("Too many downloads from here. Wait a few minutes and try again.", {
      status: 429,
      headers: { "cache-control": "no-store", "content-type": "text/plain; charset=utf-8" },
    });
  }

  const file = await openExamBrowserDownload(platform);
  if (!file) return notFound();

  return new Response(file.stream, {
    status: 200,
    headers: {
      "content-type": "application/octet-stream",
      "content-length": String(file.bytes),
      /**
       * The filename comes out of the manifest and matches
       * `[A-Za-z0-9][A-Za-z0-9._-]*`, so there is nothing in it that could
       * break out of this header. Quoted anyway, because a header built by
       * concatenation is a header somebody will later concatenate
       * something else into.
       */
      "content-disposition": `attachment; filename="${file.filename}"`,
      "x-content-type-options": "nosniff",
      /**
       * Not cached by anything in between. A build can be withdrawn by the
       * switch above, and a proxy holding yesterday's copy would keep
       * handing out a build the college has stopped offering.
       */
      "cache-control": "no-store",
    },
  });
}
