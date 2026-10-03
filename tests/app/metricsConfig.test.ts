import { describe, expect, it } from "vitest";
import { resolveMetricsConfig } from "../../src/app/config";

describe("resolveMetricsConfig", () => {
  it("is off (no HTTP server) when the port is unset or blank", () => {
    expect(resolveMetricsConfig({})).toBeUndefined();
    expect(resolveMetricsConfig({ WIRE_SUPPORT_BOT_METRICS_PORT: " " })).toBeUndefined();
    expect(resolveMetricsConfig({ WIRE_SUPPORT_BOT_METRICS_PORT: "", WIRE_SUPPORT_BOT_METRICS_HOST: "127.0.0.1" })).toBeUndefined();
  });

  it("reads the port, with the host defaulting to every IPv4 interface", () => {
    expect(resolveMetricsConfig({ WIRE_SUPPORT_BOT_METRICS_PORT: "9464" })).toEqual({ port: 9464, host: "0.0.0.0" });
    expect(resolveMetricsConfig({ WIRE_SUPPORT_BOT_METRICS_PORT: " 1 ", WIRE_SUPPORT_BOT_METRICS_HOST: " " })).toEqual({ port: 1, host: "0.0.0.0" });
    expect(resolveMetricsConfig({ WIRE_SUPPORT_BOT_METRICS_PORT: "65535", WIRE_SUPPORT_BOT_METRICS_HOST: "127.0.0.1" }))
      .toEqual({ port: 65535, host: "127.0.0.1" });
    expect(resolveMetricsConfig({ WIRE_SUPPORT_BOT_METRICS_PORT: "9100", WIRE_SUPPORT_BOT_METRICS_HOST: "::" })).toEqual({ port: 9100, host: "::" });
  });

  it.each(["0", "65536", "-1", "9464.5", "abc", "9464x", "100000"])("fails on the port %s, naming the setting", (port) => {
    expect(() => resolveMetricsConfig({ WIRE_SUPPORT_BOT_METRICS_PORT: port }))
      .toThrow("WIRE_SUPPORT_BOT_METRICS_PORT must be a port number from 1 to 65535");
  });

  it("fails on a host with spaces, naming the setting", () => {
    expect(() => resolveMetricsConfig({ WIRE_SUPPORT_BOT_METRICS_PORT: "9464", WIRE_SUPPORT_BOT_METRICS_HOST: "a host" }))
      .toThrow("WIRE_SUPPORT_BOT_METRICS_HOST must be a host name or IP address");
  });
});
