import { mkdtemp, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  blobKey,
  bundleKey,
  ImmutableKeyError,
  InvalidKeyError,
  isValidKey,
  KeyNotFoundError,
  manifestKey,
} from "@/lib/testdata/keys";
import { LocalFsStore } from "@/lib/testdata/local-fs";
import { signV4 } from "@/lib/testdata/s3";

describe("test-data keys", () => {
  it("accepts the store's own key shapes", () => {
    expect(isValidKey(blobKey("a".repeat(64)))).toBe(true);
    expect(isValidKey(bundleKey("cmabc123", 4))).toBe(true);
    expect(manifestKey("cmabc123", 4)).toBe("problems/cmabc123/v4/manifest.json");
  });

  it.each(["", "/abs", "../up", "a/../b", "a/./b", "a//b", "a/", ".hidden", "a\\b", "a b", "a/.."])(
    "rejects %j",
    (key) => {
      expect(isValidKey(key)).toBe(false);
    },
  );

  it("rejects bad problem refs and blob hashes", () => {
    expect(() => bundleKey("../x", 1)).toThrow(InvalidKeyError);
    expect(() => bundleKey("p", 0)).toThrow(InvalidKeyError);
    expect(() => blobKey("ABC")).toThrow(InvalidKeyError);
  });
});

describe("LocalFsStore", () => {
  let root: string;
  let store: LocalFsStore;

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "recx-store-"));
    store = new LocalFsStore(root);
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("puts, reads back and reports existence", async () => {
    const key = "problems/p1/v1/manifest.json";
    expect(await store.exists(key)).toBe(false);
    await store.put(key, Buffer.from("{}\n"));
    expect(await store.exists(key)).toBe(true);
    expect((await store.get(key)).toString()).toBe("{}\n");
  });

  it("treats a put of identical bytes as a no-op", async () => {
    await store.put("blobs/x", Buffer.from("same"));
    await expect(store.put("blobs/x", Buffer.from("same"))).resolves.toBeUndefined();
    expect((await store.get("blobs/x")).toString()).toBe("same");
  });

  it("refuses to change an existing key", async () => {
    await store.put("blobs/x", Buffer.from("original"));
    await expect(store.put("blobs/x", Buffer.from("changed"))).rejects.toThrow(ImmutableKeyError);
    expect((await store.get("blobs/x")).toString()).toBe("original");
  });

  it("lets exactly one of two racing writers with different bytes win", async () => {
    const results = await Promise.allSettled([
      store.put("race/key", Buffer.from("A")),
      store.put("race/key", Buffer.from("B")),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
    expect(rejected.reason).toBeInstanceOf(ImmutableKeyError);
    expect(["A", "B"]).toContain((await store.get("race/key")).toString());
  });

  it("leaves no temp files behind", async () => {
    await store.put("dir/a", Buffer.from("1"));
    await store.put("dir/a", Buffer.from("1"));
    await store.put("dir/a", Buffer.from("2")).catch(() => undefined);
    expect(await readdir(path.join(root, "dir"))).toEqual(["a"]);
  });

  it("throws KeyNotFoundError for a missing key", async () => {
    await expect(store.get("nope/missing")).rejects.toThrow(KeyNotFoundError);
    await expect(store.stream("nope/missing")).rejects.toThrow(KeyNotFoundError);
  });

  it("refuses keys that would escape the root", async () => {
    await expect(store.put("../escape", Buffer.from("x"))).rejects.toThrow(InvalidKeyError);
    await expect(store.get("a/../../etc/passwd")).rejects.toThrow(InvalidKeyError);
    await expect(store.exists("/etc/passwd")).rejects.toThrow(InvalidKeyError);
  });

  it("streams a key's bytes", async () => {
    const bytes = Buffer.alloc(300_000, 0x5a);
    await store.put("blobs/big", bytes);
    const chunks: Uint8Array[] = [];
    const reader = (await store.stream("blobs/big")).getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
    }
    expect(Buffer.concat(chunks).equals(bytes)).toBe(true);
  });
});

describe("AWS Signature V4", () => {
  // The published worked example "GET Object" from the AWS S3 SigV4 docs.
  it("reproduces the AWS documentation test vector", () => {
    const signed = signV4({
      method: "GET",
      url: new URL("https://examplebucket.s3.amazonaws.com/test.txt"),
      headers: { range: "bytes=0-9" },
      payloadSha256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
      region: "us-east-1",
      accessKeyId: "AKIAIOSFODNN7EXAMPLE",
      secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
      date: new Date("2013-05-24T00:00:00Z"),
    });
    expect(signed.canonicalRequest).toBe(
      [
        "GET",
        "/test.txt",
        "",
        "host:examplebucket.s3.amazonaws.com",
        "range:bytes=0-9",
        "x-amz-content-sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
        "x-amz-date:20130524T000000Z",
        "",
        "host;range;x-amz-content-sha256;x-amz-date",
        "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
      ].join("\n"),
    );
    expect(signed.stringToSign.split("\n").at(-1)).toBe(
      "7344ae5b7ee6c3e7e6b0fe0640412a37625d1fbfff95c48bbb2dc43964946972",
    );
    expect(signed.signature).toBe("f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41");
    expect(signed.headers.authorization).toContain(
      "Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request",
    );
    expect(signed.headers).not.toHaveProperty("host");
  });

  it("signs path-style MinIO URLs with the port in the host", () => {
    const signed = signV4({
      method: "HEAD",
      url: new URL("http://127.0.0.1:9000/recx-testdata/blobs/abc"),
      payloadSha256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
      region: "us-east-1",
      accessKeyId: "minio",
      secretAccessKey: "minio-secret",
      date: new Date("2026-01-01T00:00:00Z"),
    });
    expect(signed.canonicalRequest).toContain("\n/recx-testdata/blobs/abc\n");
    expect(signed.canonicalRequest).toContain("host:127.0.0.1:9000\n");
    expect(signed.headers["x-amz-date"]).toBe("20260101T000000Z");
  });
});
