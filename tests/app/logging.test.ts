import { afterEach, describe, expect, it, vi } from "vitest";
import { ECS_VERSION, createLogger, formatLogLine, initLogging } from "../../src/app/logging";

const TIME = new Date("2026-01-02T03:04:05.678Z");
const CONTENT = { text: "t", preview: "p", raw: "r", context: "c", prompt: "q", response: "s", stack: "k" };

/** Spies on both streams, runs `write` and returns the lines written to each, parsed. */
function captureStreams(write: () => void) {
  const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);
  const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
  try {
    write();
    const parse = (spy: typeof stdout) => spy.mock.calls.map(([line]) => JSON.parse(String(line)) as Record<string, unknown>);
    return { stdout: parse(stdout), stderr: parse(stderr) };
  } finally {
    stdout.mockRestore();
    stderr.mockRestore();
  }
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("log stream", () => {
  it("writes to stdout when asked, as the bot does", () => {
    const { stdout, stderr } = captureStreams(() => initLogging("info", { stream: "stdout" }).info("hello"));
    expect(stdout).toHaveLength(1);
    expect(stderr).toEqual([]);
  });

  it("writes to stderr by default, as the CLI does", () => {
    const { stdout, stderr } = captureStreams(() => initLogging("info").info("hello"));
    expect(stdout).toEqual([]);
    expect(stderr).toHaveLength(1);
  });

  it("writes to stderr before initLogging, at LOG_LEVEL and in LOG_FORMAT", async () => {
    vi.resetModules();
    vi.stubEnv("LOG_LEVEL", "warn");
    vi.stubEnv("LOG_FORMAT", "ecs");
    const fresh = await import("../../src/app/logging");
    const { stdout, stderr } = captureStreams(() => {
      fresh.getLogger().info("dropped");
      fresh.getLogger().error("Startup failed");
    });
    expect(stdout).toEqual([]);
    expect(stderr).toEqual([expect.objectContaining({ message: "Startup failed", severity: "ERROR" })]);
  });

  it("gives createLogger the root's stream and format at its own level", () => {
    const { stdout } = captureStreams(() => {
      initLogging("error", { stream: "stdout", format: "ecs" });
      createLogger("debug").child({ component: "sdk" }).debug("diagnostic");
    });
    expect(stdout).toEqual([expect.objectContaining({ "log.level": "debug", message: "diagnostic", component: "sdk" })]);
  });
});

describe("log line format", () => {
  it("maps each level to its Cloud Logging severity", () => {
    const severities = (["debug", "info", "warn", "error"] as const).map(
      (level) => JSON.parse(formatLogLine("json", level, "m", {}, TIME)).severity,
    );
    expect(severities).toEqual(["DEBUG", "INFO", "WARNING", "ERROR"]);
  });

  it("writes json with level, severity, msg and time first, then the fields, as one line", () => {
    const line = formatLogLine("json", "warn", "Jira call failed", { component: "jira", status: 503 }, TIME);
    expect(line.endsWith("\n")).toBe(true);
    expect(line.slice(0, -1)).not.toContain("\n");
    expect(line).toBe('{"level":"warn","severity":"WARNING","msg":"Jira call failed","time":"2026-01-02T03:04:05.678Z","component":"jira","status":503}\n');
  });

  it("writes ecs with @timestamp, log.level, message, ecs.version and severity, keeping the fields top-level", () => {
    const line = JSON.parse(formatLogLine("ecs", "info", "Wire client connected", { component: "wire", conversationId: "c1" }, TIME));
    expect(line).toEqual({
      "@timestamp": "2026-01-02T03:04:05.678Z",
      "log.level": "info",
      message: "Wire client connected",
      "ecs.version": ECS_VERSION,
      severity: "INFO",
      component: "wire",
      conversationId: "c1",
    });
    expect(ECS_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("removes the content keys at the top level in both formats, keeping nested values", () => {
    for (const format of ["json", "ecs"] as const) {
      const line = JSON.parse(formatLogLine(format, "info", "m", { ...CONTENT, keep: 1, sdkArgs: [{ text: "nested" }] }, TIME));
      for (const key of Object.keys(CONTENT)) expect(line).not.toHaveProperty(key);
      expect(line).toMatchObject({ keep: 1, sdkArgs: [{ text: "nested" }] });
    }
  });

  it("removes the content keys from bindings and data written through a logger", () => {
    const { stderr } = captureStreams(() => initLogging("debug", { format: "ecs" }).child({ prompt: "p" }).info("m", { text: "t", id: 7 }));
    expect(stderr).toEqual([expect.not.objectContaining({ prompt: "p", text: "t" })]);
    expect(stderr[0]).toMatchObject({ id: 7 });
  });

  it("keeps the fixed fields when data uses their names", () => {
    expect(JSON.parse(formatLogLine("json", "info", "real", { level: "error", severity: "ERROR", msg: "fake", time: "x" }, TIME)))
      .toEqual({ level: "info", severity: "INFO", msg: "real", time: TIME.toISOString() });
    expect(JSON.parse(formatLogLine("ecs", "info", "real", { message: "fake", "log.level": "error" }, TIME)))
      .toMatchObject({ message: "real", "log.level": "info" });
  });

  it("takes LOG_FORMAT when initLogging gets no format, and json when it is unknown", () => {
    vi.stubEnv("LOG_FORMAT", "ECS");
    expect(captureStreams(() => initLogging("info").info("m")).stderr[0]).toHaveProperty("@timestamp");
    vi.stubEnv("LOG_FORMAT", "text");
    expect(captureStreams(() => initLogging("info").info("m")).stderr[0]).toHaveProperty("msg", "m");
  });
});
