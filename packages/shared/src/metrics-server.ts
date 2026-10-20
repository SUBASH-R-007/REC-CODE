import { createServer, type Server } from "node:http";

/**
 * The `/metrics` listener for the two Node processes (Phase 10a).
 *
 * Its own subpath export (`@recx/shared/metrics-server`) and NOT re-exported
 * from the package index, because it imports `node:http`: the index is
 * imported by client components for things like `TOPIC_LABEL`, and a
 * top-level `node:http` there would break the browser bundle. One definition
 * for the worker and the scheduler, reachable only by the code that needs it.
 *
 * Deliberately minimal, and the shape is the security decision:
 *
 *   - it binds to **127.0.0.1 by default**. The judge host has no public
 *     listener at all (Phase 2) and the scheduler's port is published to the
 *     monitoring network by compose rather than by this process. A metrics
 *     server that defaulted to 0.0.0.0 would be exposed the first time
 *     somebody ran it outside compose.
 *   - it serves exactly one path. Anything else is 404 — including `/`, so a
 *     port scan learns nothing about what is behind it.
 *   - it never reads a request body and has no routing table, so there is
 *     nothing here to get wrong.
 *
 * The web process does not use this: it already has a listener, and its
 * `/metrics` is a route handler with a bearer token because it is the one
 * host with a public interface.
 */

export interface MetricsServerOptions {
  readonly port: number;
  /** Default 127.0.0.1. Publishing is compose's job, not this process's. */
  readonly host?: string;
  /** Returns the exposition payload. */
  readonly render: () => Promise<string>;
  readonly contentType: string;
  readonly onError?: (error: unknown) => void;
}

export interface MetricsServer {
  readonly port: number;
  close(): Promise<void>;
}

/**
 * Start the listener, or resolve to null when `port` is 0.
 *
 * Zero means "no metrics listener", which is what `--once` runs and tests
 * want: a scheduler invoked for a single tick must not leave a socket open
 * and must not fail because a port was taken.
 */
export async function startMetricsServer(options: MetricsServerOptions): Promise<MetricsServer | null> {
  if (options.port <= 0) return null;
  const host = options.host ?? "127.0.0.1";

  const server: Server = createServer((request, response) => {
    void (async () => {
      try {
        if (request.method !== "GET" || (request.url ?? "").split("?")[0] !== "/metrics") {
          response.writeHead(404, { "content-type": "text/plain", "cache-control": "no-store" });
          response.end("Not found");
          return;
        }
        const body = await options.render();
        response.writeHead(200, { "content-type": options.contentType, "cache-control": "no-store" });
        response.end(body);
      } catch (error) {
        options.onError?.(error);
        // A scrape that fails must not take the process down with it: the
        // metrics listener exists to describe failures, not to cause them.
        response.writeHead(500, { "content-type": "text/plain", "cache-control": "no-store" });
        response.end("metrics unavailable");
      }
    })();
  });

  server.on("error", (error) => options.onError?.(error));

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port, host, () => {
      server.off("error", reject);
      resolve();
    });
  });

  return {
    port: options.port,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        // Open keep-alive sockets would hold a graceful shutdown past its
        // deadline; a scrape connection is never worth waiting for.
        server.closeAllConnections?.();
      }),
  };
}
