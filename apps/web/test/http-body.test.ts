import { describe, expect, it } from "vitest";
import { MAX_JSON_BYTES, readBoundedBody, readBoundedText, readJsonBody } from "@/lib/http/body";

/**
 * The streaming body cap (Phase 18 security audit).
 *
 * The property that matters is not "an oversized body is rejected" — the
 * code it replaced did that too. It is **that the rejection happens while
 * the body is still arriving**, so the bytes past the cap are never
 * allocated. `request.json()` and friends resolve only once the whole
 * stream has been consumed, which is why a size check written after one of
 * them bounds what is processed and never what is held.
 *
 * So these tests count what the producer was actually asked for. A stream
 * that would be a gigabyte is pulled for a few chunks and then cancelled,
 * and `pulled` proves it.
 */

/** A body of `chunks` x `chunkBytes`, counting how many chunks were taken. */
function countingBody(chunks: number, chunkBytes: number) {
  const state = { pulled: 0, cancelled: false };
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (state.pulled >= chunks) {
        controller.close();
        return;
      }
      state.pulled += 1;
      controller.enqueue(new Uint8Array(chunkBytes).fill(97));
    },
    cancel() {
      state.cancelled = true;
    },
  });
  return { state, stream };
}

function request(body: BodyInit | null, headers: Record<string, string> = {}): Request {
  return new Request("http://localhost/x", { method: "POST", body, headers, duplex: "half" } as RequestInit);
}

describe("readBoundedBody", () => {
  it("returns a body that fits", async () => {
    const read = await readBoundedBody(request("hello"), 1024);
    expect(read.ok).toBe(true);
    if (!read.ok) throw new Error("unreachable");
    expect(new TextDecoder().decode(read.bytes)).toBe("hello");
  });

  it("stops pulling as soon as the cap is passed, and cancels the rest", async () => {
    // A body that would be 100 MB if it were ever drained.
    const { state, stream } = countingBody(100, 1024 * 1024);
    const read = await readBoundedBody(request(stream), 4 * 1024);

    expect(read).toEqual({ ok: false, reason: "too-large" });
    // One chunk is enough to pass a 4 KB cap, so at most one more can have
    // been in flight. The point is that it is not 100.
    expect(state.pulled).toBeLessThanOrEqual(2);
    expect(state.cancelled).toBe(true);
  });

  it("refuses on content-length alone, before draining the body", async () => {
    const { state, stream } = countingBody(10, 1024);
    const read = await readBoundedBody(request(stream, { "content-length": String(50 * 1024) }), 1024);
    expect(read).toEqual({ ok: false, reason: "too-large" });
    // Not zero: building a `Request` around a stream primes one chunk before
    // this function is ever called, so one is the floor the harness allows.
    // Ten would mean the declared length had been ignored.
    expect(state.pulled).toBeLessThanOrEqual(1);
  });

  it("does not trust a content-length that lies about a small body", async () => {
    // The header says 10 bytes; the stream sends a megabyte. The running
    // total is what holds.
    const { state, stream } = countingBody(16, 64 * 1024);
    const read = await readBoundedBody(request(stream, { "content-length": "10" }), 4 * 1024);
    expect(read).toEqual({ ok: false, reason: "too-large" });
    expect(state.pulled).toBeLessThanOrEqual(2);
  });

  it("accepts a body exactly at the cap and refuses one byte more", async () => {
    const at = await readBoundedBody(request("x".repeat(64)), 64);
    expect(at.ok).toBe(true);
    const over = await readBoundedBody(request("x".repeat(65)), 64);
    expect(over).toEqual({ ok: false, reason: "too-large" });
  });

  it("measures BYTES, not characters", async () => {
    // Ten astral-plane characters: 10 UTF-16 code units in `.length`, and
    // 40 bytes on the wire. The reader that compared `text.length` let this
    // through a 16-byte cap.
    const body = "\u{1F600}".repeat(10);
    expect(body.length).toBe(20);
    const read = await readBoundedBody(request(body), 16);
    expect(read).toEqual({ ok: false, reason: "too-large" });
  });

  it("treats a stream that fails as unreadable rather than as a size", async () => {
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.error(new Error("connection reset"));
      },
    });
    const read = await readBoundedBody(request(stream), 1024);
    expect(read).toEqual({ ok: false, reason: "unreadable" });
  });

  it("returns empty for a body that is not there", async () => {
    const read = await readBoundedBody(new Request("http://localhost/x", { method: "POST" }), 1024);
    expect(read.ok).toBe(true);
    if (!read.ok) throw new Error("unreachable");
    expect(read.bytes.byteLength).toBe(0);
  });
});

describe("readJsonBody", () => {
  it("parses a body that fits", async () => {
    const read = await readJsonBody(request(JSON.stringify({ a: 1 })));
    expect(read).toEqual({ ok: true, value: { a: 1 } });
  });

  it("answers 413 for an oversized body and 400 for a malformed one", async () => {
    const big = await readJsonBody(request("x".repeat(MAX_JSON_BYTES + 1)));
    expect(big).toMatchObject({ ok: false, status: 413 });

    const bad = await readJsonBody(request("{not json"));
    expect(bad).toMatchObject({ ok: false, status: 400 });
  });

  it("answers 400 for an empty body rather than parsing nothing", async () => {
    const read = await readJsonBody(new Request("http://localhost/x", { method: "POST" }));
    expect(read).toMatchObject({ ok: false, status: 400 });
  });

  it("never throws, whatever arrives", async () => {
    for (const body of ["", "null", "[", "\u0000", "x".repeat(MAX_JSON_BYTES * 2)]) {
      await expect(readJsonBody(request(body))).resolves.toBeDefined();
    }
  });
});

describe("readBoundedText", () => {
  it("decodes what fits and returns null for what does not", async () => {
    expect(await readBoundedText(request("hello"), 1024)).toBe("hello");
    expect(await readBoundedText(request("x".repeat(100)), 64)).toBeNull();
  });
});
