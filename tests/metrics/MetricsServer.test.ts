import { afterEach, describe, expect, it, vi } from "vitest";
import { startMetricsServer, type MetricsServer, type MetricsSource } from "../../src/infrastructure/metrics/MetricsServer";
import { createPrometheusMetrics } from "../../src/infrastructure/metrics/PrometheusMetrics";

const logger = () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), child: vi.fn() });
const source: MetricsSource = { contentType: "text/plain; version=0.0.4; charset=utf-8", render: async () => "test_metric 1\n" };

let servers: MetricsServer[] = [];
afterEach(async () => {
  await Promise.all(servers.map((server) => server.close()));
  servers = [];
});

async function start(src: MetricsSource = source, log = logger()) {
  const server = await startMetricsServer({ host: "127.0.0.1", port: 0, source: src, logger: log });
  servers.push(server);
  return { server, url: (path: string) => `http://127.0.0.1:${server.port}${path}`, log };
}

describe("startMetricsServer", () => {
  it("serves the metrics in the source's format on GET /metrics", async () => {
    const { url } = await start();
    const res = await fetch(url("/metrics"));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe(source.contentType);
    expect(await res.text()).toBe("test_metric 1\n");
  });

  it("serves the Prometheus adapter's registry", async () => {
    const prometheus = createPrometheusMetrics();
    prometheus.metrics.supportReplySent();
    const { url } = await start(prometheus);
    const text = await (await fetch(url("/metrics?x=1"))).text();
    expect(text).toContain("wire_support_bot_support_replies_sent_total 1");
  });

  it("answers ok on GET /healthz without asking the source", async () => {
    const render = vi.fn(source.render);
    const { url } = await start({ ...source, render });
    const res = await fetch(url("/healthz"));
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ok\n");
    expect(render).not.toHaveBeenCalled();
  });

  it("answers 404 for any other path or method", async () => {
    const { url } = await start();
    for (const [path, method] of [["/", "GET"], ["/metrics/", "GET"], ["/health", "GET"], ["/metrics", "POST"], ["/healthz", "DELETE"]] as const) {
      const res = await fetch(url(path), { method });
      expect(res.status, `${method} ${path}`).toBe(404);
      await res.text();
    }
  });

  it("answers 500 when the metrics cannot be collected, logging only the error name", async () => {
    const { url, log } = await start({ ...source, render: async () => { throw new TypeError("secret detail"); } });
    const res = await fetch(url("/metrics"));
    expect(res.status).toBe(500);
    expect(await res.text()).toBe("error\n");
    expect(log.error).toHaveBeenCalledExactlyOnceWith("Metrics could not be collected", { err: "TypeError" });
  });

  it("rejects with the listen error when the port is taken", async () => {
    const { server } = await start();
    await expect(startMetricsServer({ host: "127.0.0.1", port: server.port, source, logger: logger() }))
      .rejects.toMatchObject({ code: "EADDRINUSE" });
  });

  it("stops listening on close, also with a keep-alive connection open", async () => {
    const { server, url } = await start();
    const res = await fetch(url("/healthz"), { headers: { connection: "keep-alive" } });
    await res.text();
    servers = [];
    await server.close();
    await expect(fetch(url("/healthz"))).rejects.toThrow();
  });
});
