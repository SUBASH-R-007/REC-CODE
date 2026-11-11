import { readFileSync } from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { classifyRequest, isExamPath, type SwRequestLike, type SwRoute } from "@/components/pwa/sw-routes";

/**
 * The service worker (public/sw.js) cannot import TypeScript, so its
 * classifier is a hand-written twin of src/components/pwa/sw-routes.ts. This
 * suite runs the real sw.js in a sandbox and checks that (1) both agree on
 * every case, (2) the table below holds, and (3) the worker's fetch,
 * install and activate handlers behave: nothing personal is cached, exam
 * routes are never intercepted and make the worker unregister itself.
 */

const ORIGIN = "https://code.rec.example";
const SW_SOURCE = readFileSync(path.resolve(__dirname, "../public/sw.js"), "utf8");

interface Case {
  url: string;
  method?: string;
  mode?: string;
  headers?: Record<string, string>;
}

function asRequest(c: Case): SwRequestLike {
  const headers = new Headers(c.headers ?? {});
  return {
    url: c.url.startsWith("http") ? c.url : `${ORIGIN}${c.url}`,
    method: c.method ?? "GET",
    mode: c.mode ?? "navigate",
    header: (name) => headers.get(name),
  };
}

const TABLE: Array<[name: string, c: Case, expected: SwRoute]> = [
  ["dashboard navigation", { url: "/dashboard" }, "navigate"],
  ["workspace navigation", { url: "/problems/two-sum" }, "navigate"],
  ["offline page navigation", { url: "/offline" }, "navigate"],
  ["judge transparency page", { url: "/judge" }, "navigate"],
  ["a route that only starts like admin", { url: "/administrator" }, "navigate"],
  ["contest lobby (not the arena)", { url: "/contests/c1" }, "navigate"],
  ["assessment overview (not the attempt)", { url: "/assessments/a1" }, "navigate"],
  ["hashed static chunk", { url: "/_next/static/chunks/app-abc123.js", mode: "no-cors" }, "static"],
  ["hashed stylesheet", { url: "/_next/static/css/abc.css", mode: "no-cors" }, "static"],
  ["API search", { url: "/api/search?q=two", mode: "cors" }, "bypass"],
  ["API navigation", { url: "/api/submissions/abc" }, "bypass"],
  ["SSE stream", { url: "/api/submissions/abc/stream", mode: "cors" }, "bypass"],
  ["admin", { url: "/admin" }, "bypass"],
  ["admin subpage", { url: "/admin/judge" }, "bypass"],
  ["percent-encoded admin", { url: "/%61dmin/judge" }, "bypass"],
  ["double-slash admin", { url: "//admin" }, "bypass"],
  ["upper-case admin", { url: "/ADMIN" }, "bypass"],
  ["super-admin console", { url: "/super/settings" }, "bypass"],
  ["assessment attempt", { url: "/assessments/a1/attempt" }, "bypass"],
  ["assessment attempt subpage", { url: "/assessments/a1/attempt/q/2" }, "bypass"],
  ["contest arena", { url: "/contests/c1/arena" }, "bypass"],
  ["contest arena, odd case", { url: "/Contests/c1/ARENA/" }, "bypass"],
  ["contest arena, encoded", { url: "/contests/c1/%61rena" }, "bypass"],
  ["exam static asset is still bypassed", { url: "/assessments/a1/attempt/_next/static/x.js", mode: "no-cors" }, "bypass"],
  ["form POST", { url: "/notes", method: "POST" }, "bypass"],
  ["RSC payload", { url: "/dashboard", mode: "cors", headers: { rsc: "1" } }, "bypass"],
  ["RSC navigation-mode guard", { url: "/dashboard", headers: { rsc: "1" } }, "bypass"],
  ["RSC query param", { url: "/notes?_rsc=abc", mode: "cors" }, "bypass"],
  ["router prefetch", { url: "/notes", mode: "cors", headers: { "next-router-prefetch": "1" } }, "bypass"],
  ["JSON fetch", { url: "/dashboard", headers: { accept: "application/json" } }, "bypass"],
  ["cross-origin static", { url: "https://cdn.example/_next/static/x.js", mode: "no-cors" }, "bypass"],
  ["favicon", { url: "/favicon.ico", mode: "no-cors" }, "bypass"],
  ["self-hosted Monaco", { url: "/monaco/vs/loader.js", mode: "no-cors" }, "bypass"],
  ["malformed escape", { url: "/%E0%A4%A" }, "navigate"],
];

// ── Sandbox ────────────────────────────────────────────────────────────

interface FakeCache {
  store: Map<string, Response>;
  put: ReturnType<typeof vi.fn>;
  add: ReturnType<typeof vi.fn>;
  keys: ReturnType<typeof vi.fn>;
  delete: ReturnType<typeof vi.fn>;
}

function loadWorker() {
  const listeners = new Map<string, (event: unknown) => void>();
  const cacheStores = new Map<string, FakeCache>();
  const keyOf = (r: unknown) => (typeof r === "string" ? new URL(r, ORIGIN).href : (r as { url: string }).url);
  const openCache = (name: string): FakeCache => {
    let cache = cacheStores.get(name);
    if (!cache) {
      const store = new Map<string, Response>();
      cache = {
        store,
        put: vi.fn(async (req: unknown, res: Response) => void store.set(keyOf(req), res)),
        add: vi.fn(async (req: unknown) => void store.set(keyOf(req), new Response("css"))),
        keys: vi.fn(async () => [...store.keys()].map((url) => ({ url }))),
        delete: vi.fn(async (req: unknown) => store.delete(keyOf(req))),
      };
      cacheStores.set(name, cache);
    }
    return cache;
  };
  const caches = {
    open: vi.fn(async (name: string) => openCache(name)),
    match: vi.fn(async (req: unknown) => {
      for (const cache of cacheStores.values()) {
        const hit = cache.store.get(keyOf(req));
        if (hit) return hit;
      }
      return undefined;
    }),
    keys: vi.fn(async () => [...cacheStores.keys()]),
    delete: vi.fn(async (name: string) => cacheStores.delete(name)),
  };
  const fetchMock = vi.fn(async (_input: unknown, _init?: unknown): Promise<Response> => new Response("network"));
  const self = {
    addEventListener: (type: string, fn: (event: unknown) => void) => listeners.set(type, fn),
    location: { origin: ORIGIN },
    registration: { unregister: vi.fn(async () => true) },
    clients: { claim: vi.fn(async () => undefined) },
    skipWaiting: vi.fn(),
  };
  const sandbox: Record<string, unknown> = { self, caches, fetch: fetchMock, URL, Response, Headers, Promise, console };
  vm.createContext(sandbox);
  vm.runInContext(SW_SOURCE, sandbox, { filename: "sw.js" });
  return {
    sandbox,
    listeners,
    caches,
    cacheStores,
    openCache,
    fetchMock,
    self,
    classify: sandbox.classifyRequest as (r: SwRequestLike, origin: string) => SwRoute,
    exam: sandbox.isExamPath as (p: string) => boolean,
    cacheName: sandbox.CACHE_NAME as string,
  };
}

function fetchEvent(c: Case) {
  const req = asRequest(c);
  const respondWith = vi.fn();
  const waitUntil = vi.fn();
  return {
    event: {
      request: { url: req.url, method: req.method, mode: req.mode, headers: new Headers(c.headers ?? {}) },
      respondWith,
      waitUntil,
    },
    respondWith,
    waitUntil,
  };
}

describe("service worker route classification", () => {
  const worker = loadWorker();

  it.each(TABLE)("%s → expected route (TypeScript)", (_name, c, expected) => {
    expect(classifyRequest(asRequest(c), ORIGIN)).toBe(expected);
  });

  it.each(TABLE)("%s → sw.js agrees with sw-routes.ts", (_name, c) => {
    expect(worker.classify(asRequest(c), ORIGIN)).toBe(classifyRequest(asRequest(c), ORIGIN));
  });

  it.each([
    ["/assessments/a1/attempt", true],
    ["/assessments/a1/attempt/", true],
    ["/assessments/a1/attempt/q/3", true],
    ["/contests/spring-2027/arena", true],
    ["/CONTESTS/x/Arena", true],
    ["/assessments/a1", false],
    ["/assessments/a1/attempts", false],
    ["/contests", false],
    ["/contests/x/arenas", false],
    ["/dashboard", false],
  ])("isExamPath(%s) = %s in both implementations", (p, expected) => {
    expect(isExamPath(p)).toBe(expected);
    expect(worker.exam(p)).toBe(expected);
  });

  it("versions its cache under the recx- prefix", () => {
    expect(worker.cacheName).toMatch(/^recx-static-v\d+$/);
  });
});

describe("service worker handlers", () => {
  let w: ReturnType<typeof loadWorker>;
  beforeEach(() => {
    w = loadWorker();
  });

  const dispatch = (type: string, event: unknown) => {
    const handler = w.listeners.get(type);
    if (!handler) throw new Error(`no ${type} listener`);
    handler(event);
  };

  it("never answers API, admin or exam requests, and steps aside on an exam navigation", () => {
    for (const url of ["/api/search?q=ab", "/admin/judge", "/super", "/contests/c1/arena"]) {
      const { event, respondWith } = fetchEvent({ url });
      dispatch("fetch", event);
      expect(respondWith).not.toHaveBeenCalled();
    }
    expect(w.fetchMock).not.toHaveBeenCalled();

    const exam = fetchEvent({ url: "/assessments/a1/attempt" });
    dispatch("fetch", exam.event);
    expect(exam.respondWith).not.toHaveBeenCalled();
    expect(exam.waitUntil).toHaveBeenCalledTimes(1);
    expect(w.self.registration.unregister).toHaveBeenCalled();
  });

  it("serves navigations from the network and never caches them", async () => {
    const { event, respondWith } = fetchEvent({ url: "/dashboard" });
    dispatch("fetch", event);
    expect(respondWith).toHaveBeenCalledTimes(1);
    const response = (await respondWith.mock.calls[0]?.[0]) as Response;
    expect(await response.text()).toBe("network");
    for (const cache of w.cacheStores.values()) expect(cache.put).not.toHaveBeenCalled();
  });

  it("falls back to the cached /offline page when the network is down", async () => {
    w.openCache(w.cacheName).store.set(`${ORIGIN}/offline`, new Response("offline page"));
    w.fetchMock.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    const { event, respondWith } = fetchEvent({ url: "/problems" });
    dispatch("fetch", event);
    const response = (await respondWith.mock.calls[0]?.[0]) as Response;
    expect(await response.text()).toBe("offline page");
  });

  it("caches static chunks cache-first", async () => {
    // A same-origin browser response is type "basic"; Node's Response says "default".
    const basic = Object.defineProperty(new Response("chunk"), "type", { value: "basic" });
    w.fetchMock.mockResolvedValueOnce(basic);
    const first = fetchEvent({ url: "/_next/static/chunks/a.js", mode: "no-cors" });
    dispatch("fetch", first.event);
    await first.respondWith.mock.calls[0]?.[0];
    const cache = w.openCache(w.cacheName);
    expect(cache.put).toHaveBeenCalledTimes(1);

    w.fetchMock.mockClear();
    const second = fetchEvent({ url: "/_next/static/chunks/a.js", mode: "no-cors" });
    dispatch("fetch", second.event);
    await second.respondWith.mock.calls[0]?.[0];
    expect(w.fetchMock).not.toHaveBeenCalled();
  });

  it("precaches /offline without credentials, plus its stylesheets", async () => {
    w.fetchMock.mockResolvedValueOnce(
      new Response('<html><head><link rel="stylesheet" href="/_next/static/css/app.css" data-precedence="next"/></head></html>'),
    );
    const waitUntil = vi.fn();
    dispatch("install", { waitUntil });
    await waitUntil.mock.calls[0]?.[0];
    expect(w.fetchMock).toHaveBeenCalledWith("/offline", expect.objectContaining({ credentials: "omit" }));
    const cache = w.openCache(w.cacheName);
    expect(cache.store.has(`${ORIGIN}/offline`)).toBe(true);
    expect(cache.add).toHaveBeenCalledWith("/_next/static/css/app.css");
    expect(w.self.skipWaiting).toHaveBeenCalled();
  });

  it("removes its own old caches on activate, and only those", async () => {
    w.openCache("recx-static-v0");
    w.openCache(w.cacheName);
    w.openCache("someone-elses-cache");
    const waitUntil = vi.fn();
    dispatch("activate", { waitUntil });
    await waitUntil.mock.calls[0]?.[0];
    expect([...w.cacheStores.keys()].sort()).toEqual([w.cacheName, "someone-elses-cache"].sort());
    expect(w.self.clients.claim).toHaveBeenCalled();
  });
});
