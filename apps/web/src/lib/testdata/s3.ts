import { createHash, createHmac } from "node:crypto";
import { assertValidKey, ImmutableKeyError, KeyNotFoundError } from "./keys";
import type { TestDataStore } from "./store";

/**
 * S3 / MinIO driver: path-style URLs ({endpoint}/{bucket}/{key}) signed with
 * AWS Signature Version 4, implemented here on node:crypto + fetch so the web
 * app carries no SDK. Only GET, HEAD and PUT are used — there is deliberately
 * no delete, because published test data is immutable.
 */
export interface S3Config {
  endpoint: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
}

const EMPTY_SHA256 = createHash("sha256").update("").digest("hex");
const REQUEST_TIMEOUT_MS = 30_000;
const STREAM_TIMEOUT_MS = 5 * 60_000;

function sha256Hex(data: Buffer | string): string {
  return createHash("sha256").update(data).digest("hex");
}

function hmac(key: Buffer | string, data: string): Buffer {
  return createHmac("sha256", key).update(data).digest();
}

/** RFC 3986 encoding as SigV4 requires (encodeURIComponent leaves !'()* alone). */
function encodeRfc3986(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

function amzDateOf(date: Date): string {
  return date.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
}

export interface SignV4Input {
  method: string;
  url: URL;
  /** Extra headers to sign (the Host, x-amz-date and x-amz-content-sha256 headers are added). */
  headers?: Record<string, string>;
  payloadSha256: string;
  region: string;
  service?: string;
  accessKeyId: string;
  secretAccessKey: string;
  date: Date;
}

export interface SignV4Output {
  /** Headers to send (everything signed except Host, which fetch derives from the URL). */
  headers: Record<string, string>;
  canonicalRequest: string;
  stringToSign: string;
  signature: string;
}

/** AWS Signature Version 4 for a single request. Pure: same input, same output. */
export function signV4(input: SignV4Input): SignV4Output {
  const service = input.service ?? "s3";
  const amzDate = amzDateOf(input.date);
  const day = amzDate.slice(0, 8);
  const scope = `${day}/${input.region}/${service}/aws4_request`;

  const signed: Record<string, string> = {
    host: input.url.host,
    "x-amz-content-sha256": input.payloadSha256,
    "x-amz-date": amzDate,
  };
  for (const [name, value] of Object.entries(input.headers ?? {})) signed[name.toLowerCase()] = value;

  const names = Object.keys(signed).sort();
  const canonicalHeaders = names.map((n) => `${n}:${signed[n]!.trim().replace(/\s+/g, " ")}\n`).join("");
  const signedHeaders = names.join(";");

  const canonicalUri =
    input.url.pathname
      .split("/")
      .map((segment) => encodeRfc3986(decodeURIComponent(segment)))
      .join("/") || "/";
  const canonicalQuery = [...input.url.searchParams.entries()]
    .map(([k, v]) => [encodeRfc3986(k), encodeRfc3986(v)] as const)
    .sort(([a, av], [b, bv]) => (a === b ? (av < bv ? -1 : av > bv ? 1 : 0) : a < b ? -1 : 1))
    .map(([k, v]) => `${k}=${v}`)
    .join("&");

  const canonicalRequest = [
    input.method.toUpperCase(),
    canonicalUri,
    canonicalQuery,
    canonicalHeaders,
    signedHeaders,
    input.payloadSha256,
  ].join("\n");
  const stringToSign = ["AWS4-HMAC-SHA256", amzDate, scope, sha256Hex(canonicalRequest)].join("\n");

  const kDate = hmac(`AWS4${input.secretAccessKey}`, day);
  const kRegion = hmac(kDate, input.region);
  const kService = hmac(kRegion, service);
  const kSigning = hmac(kService, "aws4_request");
  const signature = createHmac("sha256", kSigning).update(stringToSign).digest("hex");

  const { host: _host, ...sendable } = signed;
  return {
    headers: {
      ...sendable,
      authorization: `AWS4-HMAC-SHA256 Credential=${input.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
    },
    canonicalRequest,
    stringToSign,
    signature,
  };
}

export class S3Store implements TestDataStore {
  readonly driver = "s3" as const;

  constructor(private readonly config: S3Config) {}

  private url(key: string): URL {
    assertValidKey(key);
    const base = this.config.endpoint.replace(/\/+$/, "");
    return new URL(`${base}/${encodeRfc3986(this.config.bucket)}/${key}`);
  }

  private async request(
    method: "GET" | "HEAD" | "PUT",
    key: string,
    options: { body?: Buffer; headers?: Record<string, string>; timeoutMs?: number } = {},
  ): Promise<Response> {
    const url = this.url(key);
    const { headers } = signV4({
      method,
      url,
      payloadSha256: options.body ? sha256Hex(options.body) : EMPTY_SHA256,
      region: this.config.region,
      accessKeyId: this.config.accessKeyId,
      secretAccessKey: this.config.secretAccessKey,
      date: new Date(),
    });
    return fetch(url, {
      method,
      headers: { ...headers, ...options.headers },
      body: options.body ? new Uint8Array(options.body) : undefined,
      signal: AbortSignal.timeout(options.timeoutMs ?? REQUEST_TIMEOUT_MS),
    });
  }

  private failure(op: string, key: string, res: Response): Error {
    return new Error(`Test-data store ${op} ${key} failed: HTTP ${res.status}.`);
  }

  async exists(key: string): Promise<boolean> {
    const res = await this.request("HEAD", key);
    if (res.status === 200) return true;
    if (res.status === 404) return false;
    throw this.failure("HEAD", key, res);
  }

  async get(key: string): Promise<Buffer> {
    const res = await this.request("GET", key, { timeoutMs: STREAM_TIMEOUT_MS });
    if (res.status === 404) throw new KeyNotFoundError(key);
    if (!res.ok) throw this.failure("GET", key, res);
    return Buffer.from(await res.arrayBuffer());
  }

  async stream(key: string): Promise<ReadableStream<Uint8Array>> {
    const res = await this.request("GET", key, { timeoutMs: STREAM_TIMEOUT_MS });
    if (res.status === 404) throw new KeyNotFoundError(key);
    if (!res.ok || !res.body) throw this.failure("GET", key, res);
    return res.body;
  }

  async put(key: string, bytes: Buffer): Promise<void> {
    if (await this.exists(key)) return this.assertSame(key, bytes);
    // If-None-Match: * makes the write conditional on servers that support
    // it (AWS S3, current MinIO): a racing writer gets 412 instead of
    // silently replacing the object.
    const res = await this.request("PUT", key, {
      body: bytes,
      headers: { "content-type": "application/octet-stream", "if-none-match": "*" },
    });
    if (res.status === 412 || res.status === 409) return this.assertSame(key, bytes);
    if (!res.ok) throw this.failure("PUT", key, res);
  }

  private async assertSame(key: string, bytes: Buffer): Promise<void> {
    const existing = await this.get(key);
    if (!existing.equals(bytes)) throw new ImmutableKeyError(key);
  }
}
