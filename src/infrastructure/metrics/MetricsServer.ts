/**
 * The HTTP endpoint for metrics and liveness, on Node's http module. `GET /metrics` returns the
 * metrics in the Prometheus text format, `GET /healthz` returns 200 "ok" as long as the process
 * serves requests (it checks neither Wire, Jira, the model nor the database, so a lost connection
 * to one of them never gets the pod restarted), and anything else is 404. Responses carry no
 * content beyond the metrics.
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { Logger } from "../../application/ports/Logger";

export interface MetricsSource {
  contentType: string;
  render(): Promise<string>;
}

export interface MetricsServer {
  /** The port listened on (the one asked for, or the one assigned for port 0). */
  readonly port: number;
  /** Stops listening and ends open connections; resolves once the server is closed. */
  close(): Promise<void>;
}

/**
 * Listens on `host` and `port`; rejects with the listen error (such as EADDRINUSE) when the
 * port cannot be bound.
 */
export function startMetricsServer(options: { host: string; port: number; source: MetricsSource; logger: Logger }): Promise<MetricsServer> {
  const { host, port, source, logger } = options;
  const send = (res: ServerResponse, status: number, contentType: string, body: string) => {
    res.writeHead(status, { "Content-Type": contentType, "Cache-Control": "no-store" });
    res.end(body);
  };
  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const path = (req.url ?? "").split("?")[0];
    const read = req.method === "GET" || req.method === "HEAD";
    if (read && path === "/healthz") return send(res, 200, "text/plain; charset=utf-8", "ok\n");
    if (read && path === "/metrics") {
      try {
        return send(res, 200, source.contentType, await source.render());
      } catch (err) {
        logger.error("Metrics could not be collected", { err: err instanceof Error ? err.name : "UnknownError" });
        return send(res, 500, "text/plain; charset=utf-8", "error\n");
      }
    }
    send(res, 404, "text/plain; charset=utf-8", "not found\n");
  };
  const server = createServer((req, res) => void handle(req, res));

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      // Later errors (a failed connection) must not end the process.
      server.on("error", (err: NodeJS.ErrnoException) => logger.warn("Metrics server error", { err: err.code ?? err.name }));
      const bound = (server.address() as AddressInfo).port;
      resolve({
        port: bound,
        close: () => new Promise<void>((done) => {
          server.close(() => done());
          // Keep-alive connections from a scraper would otherwise hold the close.
          server.closeAllConnections();
        }),
      });
    });
  });
}
