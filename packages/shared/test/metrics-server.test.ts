import { createServer } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { startMetricsServer, type MetricsServer } from "../src/metrics-server";

/**
 * The `/metrics` listener the worker and the scheduler run (Phase 10a).
 *
 * Asserted over real HTTP rather than by calling the handler, because every
 * property worth having here is a property of the socket: that port 0 opens
 * nothing at all, that the only path served is `/metrics`, that a render
 * failure answers 500 instead of taking the process down, and that `close()`
 * really stops answering. A test that invoked the request handler directly
 * would pass on a server that never listened.
 */

const listeners: MetricsServer[] = [];

afterEach(async () => {
  for (const server of listeners.splice(0)) await server.close();
});

/**
 * An ephemeral port, found by binding one and letting it go.
 *
 * There is a window between the close and the re-bind in which something
 * else could take it; on a developer's box and in CI that is theoretical,
 * and the alternative — a hard-coded port — fails whenever a previous run is
 * still shutting down, which is not theoretical at all.
 */
async function freePort(): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      const port = typeof address === "object" && address !== null ? address.port : 0;
      probe.close(() => (port > 0 ? resolve(port) : reject(new Error("no ephemeral port"))));
    });
  });
}

async function start(options: { render: () => Promise<string>; onError?: (error: unknown) => void }): Promise<{
  server: MetricsServer;
  url: string;
}> {
  const port = await freePort();
  const server = await startMetricsServer({
    port,
    render: options.render,
    contentType: "text/plain; version=0.0.4; charset=utf-8",
    onError: options.onError,
  });
  if (!server) throw new Error("expected a listener");
  listeners.push(server);
  return { server, url: `http://127.0.0.1:${port}` };
}

describe("port 0 means no listener", () => {
  it("returns null and opens nothing", async () => {
    const server = await startMetricsServer({
      port: 0,
      render: async () => "should never be served",
      contentType: "text/plain",
    });
    expect(server).toBeNull();
  });

  it("treats a negative port the same way rather than throwing", async () => {
    /**
     * `--once` runs and tests pass 0; a misconfigured unit file could pass
     * -1. Neither should take the process down before it has done its work,
     * and neither should silently pick a port of its own.
     */
    expect(await startMetricsServer({ port: -1, render: async () => "", contentType: "text/plain" })).toBeNull();
  });
});

describe("it serves exactly one path", () => {
  it("answers GET /metrics with the exposition and the content type", async () => {
    const { url } = await start({ render: async () => "recx_test_metric 1\n" });
    const response = await fetch(`${url}/metrics`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/plain; version=0.0.4; charset=utf-8");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.text()).toBe("recx_test_metric 1\n");
  });

  it("ignores a query string, as a scrape config may add one", async () => {
    const { url } = await start({ render: async () => "recx_test_metric 2\n" });
    const response = await fetch(`${url}/metrics?collect[]=everything`);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("recx_test_metric 2\n");
  });

  it("404s every other path, including the root", async () => {
    let rendered = 0;
    const { url } = await start({
      render: async () => {
        rendered++;
        return "recx_test_metric 3\n";
      },
    });
    // `/METRICS` is in the list on purpose: the comparison is exact, and a
    // case-insensitive match is the kind of helpfulness that grows a routing
    // table. (`/metrics/..` is not: fetch normalises it away before it is
    // ever sent, so it would test undici, not this server.)
    for (const path of ["/", "/healthz", "/metrics/", "/METRICS", "/admin"]) {
      const response = await fetch(`${url}${path}`);
      expect(response.status, path).toBe(404);
    }
    /**
     * A port scan learns nothing, and — the reason this counts renders —
     * neither does it make the process collect metrics on its behalf.
     */
    expect(rendered, "a 404 must not run the collector").toBe(0);
  });

  it("404s a POST to /metrics, body unread", async () => {
    const { url } = await start({ render: async () => "recx_test_metric 4\n" });
    const response = await fetch(`${url}/metrics`, { method: "POST", body: "ignored" });
    expect(response.status).toBe(404);
  });
});

describe("a failing collector is not an outage", () => {
  it("answers 500 and reports the error instead of throwing", async () => {
    const seen: unknown[] = [];
    const { url } = await start({
      render: async () => {
        throw new Error("registry exploded");
      },
      onError: (error) => seen.push(error),
    });
    const response = await fetch(`${url}/metrics`);
    expect(response.status).toBe(500);
    expect(await response.text()).toBe("metrics unavailable");
    expect((seen[0] as Error | undefined)?.message).toBe("registry exploded");
  });

  it("stays up for the next scrape", async () => {
    let fail = true;
    const { url } = await start({
      render: async () => {
        if (fail) throw new Error("transient");
        return "recx_test_metric 5\n";
      },
      onError: () => {},
    });
    expect((await fetch(`${url}/metrics`)).status).toBe(500);
    fail = false;
    const second = await fetch(`${url}/metrics`);
    expect(second.status).toBe(200);
    expect(await second.text()).toBe("recx_test_metric 5\n");
  });
});

describe("close", () => {
  it("stops answering, and does not hang on a keep-alive socket", async () => {
    const { server, url } = await start({ render: async () => "recx_test_metric 6\n" });
    // A plain fetch leaves a keep-alive connection behind, which is what a
    // Prometheus scrape does and what a graceful shutdown must not wait for.
    expect((await fetch(`${url}/metrics`)).status).toBe(200);
    await server.close();
    listeners.length = 0;
    await expect(fetch(`${url}/metrics`)).rejects.toThrow();
  });
});
