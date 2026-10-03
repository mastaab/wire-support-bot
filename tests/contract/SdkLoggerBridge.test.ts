import { describe, expect, it, vi } from "vitest";
import {
  SDK_ARGS_MAX, logSdkLogContentNotice, makeSdkLoggerBridge, serializeSdkArgs, type SdkLogOptions,
} from "../../src/infrastructure/wire/SdkLoggerBridge";
import { createLogger, initLogging } from "../../src/app/logging";

const marker = "SDK_PRIVATE_CONTEXT_MARKER";

/**
 * Runs the calls against a bridge wired as in the container (a logger at debug, the SDK's level
 * applied by the bridge) under LOG_LEVEL `logLevel`, and returns the parsed stderr lines and raw output.
 */
function capture(
  calls: (bridge: ReturnType<typeof makeSdkLoggerBridge>) => void,
  options: SdkLogOptions = { level: "debug", content: "none" },
  logLevel = "debug",
) {
  const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
  try {
    initLogging(logLevel, { format: "json", stream: "stderr" });
    calls(makeSdkLoggerBridge(createLogger("debug"), options));
    const output = stderr.mock.calls.map(([line]) => String(line));
    return { raw: output.join(""), lines: output.map(line => JSON.parse(line) as Record<string, unknown>) };
  } finally {
    stderr.mockRestore();
  }
}

/** The SDK's WireApiException shape (core/HttpClient.js throws it with the backend's code and label). */
class WireApiException extends Error {
  constructor(readonly code: number, readonly label: string, message: string) {
    super(message);
    this.name = "WireApiException";
  }
}

/** The SDK's RetryableHttpStatusError shape (core/HttpRetryHelper.js). */
class RetryableHttpStatusError extends Error {
  constructor(readonly status: number, readonly path: string) {
    super(`Retryable HTTP ${status} for ${path}`);
    this.name = "RetryableHttpStatusError";
  }
}

/** The SDK's WireException subclasses set the class name and keep the original error as cause. */
class AuthenticationError extends Error {
  constructor(message: string, cause?: Error) {
    super(message);
    this.name = new.target.name;
    this.cause = cause;
  }
}

describe("SDK logging privacy", () => {
  it("preserves severity without SDK strings, nested events or error bodies", () => {
    const { raw, lines } = capture(bridge => {
      for (const level of ["debug", "info", "warn", "error"] as const) {
        bridge[level](`SDK exception: ${marker}`, { payload: { content: marker } }, new Error(marker));
      }
    });
    expect(raw).not.toContain(marker);
    expect(lines).toEqual([
      { level: "debug", severity: "DEBUG", msg: "Wire SDK diagnostic", component: "sdk", time: expect.any(String) },
      { level: "info", severity: "INFO", msg: "Wire SDK diagnostic", component: "sdk", time: expect.any(String) },
      { level: "warn", severity: "WARNING", msg: "Wire SDK diagnostic", component: "sdk", time: expect.any(String), errorName: "Error" },
      { level: "error", severity: "ERROR", msg: "Wire SDK diagnostic", component: "sdk", time: expect.any(String), errorName: "Error" },
    ]);
  });

  it("never logs the message, other fields, nested objects, stacks or unsafe values of an error", () => {
    const error = new WireApiException(403, "access-denied", `Denied: ${marker}`) as WireApiException & Record<string, unknown>;
    error.stack = `Error: ${marker}\n    at secret (${marker}.js:1:1)`;
    error.path = `conversations/${marker}`;
    error.body = { content: marker };
    error.response = { status: 403, data: { message: marker }, url: `https://example.invalid/${marker}` };
    const unsafeCode = Object.assign(new Error(marker), { code: `${marker} with spaces`, label: "x".repeat(65), status: { value: 500 } });
    const longCode = Object.assign(new Error(marker), { code: `A${"B".repeat(64)}`, label: `label/${marker}` });
    const nested = Object.assign(new Error(marker), { cause: { cause: { code: "DEEP_CODE", label: marker } } });
    const unsafeName = Object.assign(new Error(marker), { name: `Bad name ${marker}` });
    const { raw, lines } = capture(bridge => {
      bridge.error(`WireApiException - Label: access-denied, Message: ${marker}`, error);
      bridge.warn(`Unsafe: ${marker}`, unsafeCode);
      bridge.error(`Long: ${marker}`, longCode);
      bridge.error(`Nested: ${marker}`, nested);
      bridge.warn(`Name: ${marker}`, unsafeName);
      bridge.warn(`No error: ${marker}`, { code: "SAFE_BUT_NOT_AN_ERROR", payload: marker });
    });
    expect(raw).not.toContain(marker);
    expect(raw).not.toContain("DEEP_CODE");
    expect(raw).not.toContain("SAFE_BUT_NOT_AN_ERROR");
    expect(raw).not.toContain("BBBB");
    const fields = lines.map(({ time: _time, level: _level, severity: _severity, msg: _msg, component: _component, ...rest }) => rest);
    expect(fields).toEqual([
      { errorName: "WireApiException", status: 403, code: 403, label: "access-denied" },
      { errorName: "Error" },
      { errorName: "Error" },
      { errorName: "Error" },
      { errorName: "Error" },
      {},
    ]);
  });

  it("logs the class name, status, code and label of realistic SDK error shapes for warnings and errors", () => {
    const { raw, lines } = capture(bridge => {
      bridge.error("Unable to retrieve access token, Error:", new WireApiException(403, "invalid-credentials", `Invalid ${marker}`));
      bridge.warn("Retrying", new RetryableHttpStatusError(503, `conversations/${marker}`));
      bridge.error("Websocket Error:", new AuthenticationError(`Expired ${marker}`, new WireApiException(401, "invalid-credentials", marker)));
      bridge.error("Websocket Error:", Object.assign(new Error(marker), { response: { status: 502 } }));
      bridge.error("Connection error:", Object.assign(new Error(marker), { cause: Object.assign(new Error(marker), { code: "ECONNRESET" }) }));
      bridge.error("Failed to sync missed notifications:", new (class NamelessSdkError extends Error {})(marker));
    });
    expect(raw).not.toContain(marker);
    expect(lines.map(({ level, errorName, status, code, label }) => ({ level, errorName, status, code, label }))).toEqual([
      { level: "error", errorName: "WireApiException", status: undefined, code: 403, label: "invalid-credentials" },
      { level: "warn", errorName: "RetryableHttpStatusError", status: 503, code: undefined, label: undefined },
      { level: "error", errorName: "AuthenticationError", status: undefined, code: 401, label: "invalid-credentials" },
      { level: "error", errorName: "Error", status: 502, code: undefined, label: undefined },
      { level: "error", errorName: "Error", status: undefined, code: "ECONNRESET", label: undefined },
      { level: "error", errorName: "NamelessSdkError", status: undefined, code: undefined, label: undefined },
    ]);
  });

  it("logs the class name and event type of a WebSocket error event, never its message or nested error", () => {
    /**
     * The shape of the `ws` events: the SDK's WebSocketClient logs the ErrorEvent as "Websocket
     * Error:" (its `type` is a getter, as in ws/lib/event-target.js).
     */
    class Event {
      readonly #type: string;
      constructor(type: string, readonly target: unknown) {
        this.#type = type;
      }
      get type(): string {
        return this.#type;
      }
    }
    class ErrorEvent extends Event {
      constructor(readonly message: string, readonly error: unknown, target: unknown) {
        super("error", target);
      }
    }
    class CloseEvent extends Event {
      constructor(readonly code: number, readonly reason: string) {
        super("close", null);
      }
    }
    const socket = { url: `wss://example.invalid/${marker}`, readyState: 3 };
    const { raw, lines } = capture(bridge => {
      bridge.error("Websocket Error:", new ErrorEvent(`Connection reset ${marker}`, { code: "ECONNRESET", message: marker }, socket));
      bridge.warn("WebSocket Closed", new CloseEvent(1006, marker));
      bridge.warn("Event:", new Event(`bad type ${marker}`, socket));
      bridge.warn("Event:", new Event("x".repeat(33), socket));
      bridge.error("Plain:", { type: "error", message: marker });
      bridge.error("Unsafe class:", new (class { constructor(readonly type: string) {} })("error"));
      bridge.warn("Null first:", null, new CloseEvent(1000, marker));
      bridge.warn("Text only", marker, 42);
      bridge.info("Info:", new ErrorEvent(marker, null, socket));
    });
    expect(raw).not.toContain(marker);
    expect(raw).not.toContain("ECONNRESET");
    expect(raw).not.toContain("1006");
    const fields = lines.map(({ time: _time, severity: _severity, msg: _msg, component: _component, ...rest }) => rest);
    expect(fields).toEqual([
      { level: "error", objectType: "ErrorEvent", eventType: "error" },
      { level: "warn", objectType: "CloseEvent", eventType: "close" },
      { level: "warn", objectType: "Event" },
      { level: "warn", objectType: "Event" },
      { level: "error" },
      { level: "error" },
      { level: "warn", objectType: "CloseEvent", eventType: "close" },
      { level: "warn" },
      { level: "info" },
    ]);
  });

  it("keeps the Error fields and no object fields when an Error is among the arguments", () => {
    const event = Object.assign(Object.create({ constructor: { name: "ErrorEvent" } }), { type: "error" });
    const { lines } = capture(bridge => bridge.error("Websocket Error:", event, new WireApiException(401, "invalid-credentials", marker)));
    expect(lines[0]).toMatchObject({ errorName: "WireApiException", code: 401, label: "invalid-credentials" });
    expect(lines[0]).not.toHaveProperty("objectType");
    expect(lines[0]).not.toHaveProperty("eventType");
  });

  it("keeps debug and info without error fields", () => {
    const { lines } = capture(bridge => {
      bridge.debug("debug", new WireApiException(404, "not-found", marker));
      bridge.info("info", new RetryableHttpStatusError(503, marker));
    });
    expect(lines).toEqual([
      { level: "debug", severity: "DEBUG", msg: "Wire SDK diagnostic", component: "sdk", time: expect.any(String) },
      { level: "info", severity: "INFO", msg: "Wire SDK diagnostic", component: "sdk", time: expect.any(String) },
    ]);
  });
});

describe("SDK log level", () => {
  const callAll = (bridge: ReturnType<typeof makeSdkLoggerBridge>) => {
    for (const level of ["debug", "info", "warn", "error"] as const) bridge[level](level);
  };

  it("writes SDK debug lines at SDK level debug although LOG_LEVEL is info", () => {
    const { lines } = capture(callAll, { level: "debug", content: "none" }, "info");
    expect(lines.map(line => line.level)).toEqual(["debug", "info", "warn", "error"]);
  });

  it("writes no SDK debug or info lines at SDK level warn although LOG_LEVEL is debug", () => {
    const { lines } = capture(callAll, { level: "warn", content: "none" }, "debug");
    expect(lines.map(line => line.level)).toEqual(["warn", "error"]);
  });

  it("applies each SDK level, and off writes nothing", () => {
    const levels = (level: SdkLogOptions["level"]) => capture(callAll, { level, content: "none" }, "error").lines.map(line => line.level);
    expect(levels("info")).toEqual(["info", "warn", "error"]);
    expect(levels("error")).toEqual(["error"]);
    expect(levels("off")).toEqual([]);
  });
});

describe("SDK log content", () => {
  it("adds only the message text with messages, never the extra arguments", () => {
    const { raw, lines } = capture(bridge => {
      bridge.debug("Decrypted message", { content: marker });
      bridge.error("Websocket Error:", new WireApiException(401, "invalid-credentials", marker));
    }, { level: "debug", content: "messages" });
    expect(raw).not.toContain(marker);
    expect(lines).toEqual([
      { level: "debug", severity: "DEBUG", msg: "Wire SDK diagnostic", component: "sdk", time: expect.any(String), sdkMessage: "Decrypted message" },
      {
        level: "error", severity: "ERROR", msg: "Wire SDK diagnostic", component: "sdk", time: expect.any(String),
        errorName: "WireApiException", code: 401, label: "invalid-credentials", sdkMessage: "Websocket Error:",
      },
    ]);
  });

  it("removes control characters from the message text and cuts it at 500 characters", () => {
    const { lines } = capture(bridge => {
      bridge.info("line one\nline two\r\t\u0000\u001b[31mred\u007f\u0085");
      bridge.info("x".repeat(600));
      bridge.info(`${"y".repeat(499)}\u{1F600}`);
    }, { level: "debug", content: "messages" });
    expect(lines[0]!.sdkMessage).toBe("line oneline two[31mred");
    expect(lines[1]!.sdkMessage).toBe("x".repeat(500));
    expect(lines[2]!.sdkMessage).toBe("y".repeat(499));
  });

  it("adds the extra arguments with full and keeps their nested keys, still removing top-level content keys", () => {
    const { lines } = capture(bridge => {
      bridge.warn("Request failed", { text: "nested text", response: { data: { prompt: "nested prompt" } } }, 42, null);
    }, { level: "debug", content: "full" });
    expect(lines[0]).toMatchObject({
      level: "warn",
      sdkMessage: "Request failed",
      sdkArgs: [{ text: "nested text", response: { data: { prompt: "nested prompt" } } }, 42, null],
    });
    for (const key of ["text", "preview", "raw", "context", "prompt", "response", "stack"]) expect(lines[0]).not.toHaveProperty(key);
  });

  it("writes no sdkArgs without extra arguments", () => {
    const { lines } = capture(bridge => bridge.info("Connected"), { level: "debug", content: "full" });
    expect(lines[0]).not.toHaveProperty("sdkArgs");
    expect(lines[0]).toMatchObject({ sdkMessage: "Connected" });
  });
});

describe("serializeSdkArgs", () => {
  it("marks circular references", () => {
    const event: Record<string, unknown> = { type: "error" };
    event.self = event;
    event.list = [event];
    expect(serializeSdkArgs([event])).toEqual([{ type: "error", self: "[Circular]", list: ["[Circular]"] }]);
  });

  it("keeps a value shared by two branches, which is not circular", () => {
    const shared = { id: 1 };
    expect(serializeSdkArgs([{ a: shared, b: shared }])).toEqual([{ a: { id: 1 }, b: { id: 1 } }]);
  });

  it("cuts deep objects", () => {
    const deep = { l1: { l2: { l3: { l4: { l5: { l6: "deep" } } } } } };
    expect(serializeSdkArgs([deep])).toEqual([{ l1: { l2: { l3: { l4: "[Object]" } } } }]);
  });

  it("keeps large strings and many values to about 4 KB", () => {
    const big = serializeSdkArgs(["z".repeat(100_000), { body: "w".repeat(100_000) }, Array.from({ length: 1000 }, (_, i) => `item ${i}`)]);
    const json = JSON.stringify(big);
    expect(json.length).toBeLessThanOrEqual(SDK_ARGS_MAX + 512);
    expect(json).toContain("[Truncated]");
    const many = JSON.stringify(serializeSdkArgs([Object.fromEntries(Array.from({ length: 500 }, (_, i) => [`k${i}`, i]))]));
    expect(many.length).toBeLessThanOrEqual(SDK_ARGS_MAX + 512);
    expect(many).toContain("[Truncated]");
  });

  it("writes Errors as name, message and stack", () => {
    const error = new WireApiException(403, "access-denied", "Denied");
    const [value] = serializeSdkArgs([error]) as [Record<string, unknown>];
    expect(Object.keys(value)).toEqual(["name", "message", "stack"]);
    expect(value).toMatchObject({ name: "WireApiException", message: "Denied" });
    expect(value.stack).toEqual(expect.stringContaining("WireApiException: Denied"));
  });

  it("never throws, whatever the arguments hold", () => {
    const throwing = Object.defineProperty({}, "secret", { enumerable: true, get() { throw new Error("getter"); } });
    const proxy = new Proxy({}, { ownKeys() { throw new Error("proxy"); } });
    const value = serializeSdkArgs([throwing, proxy, 10n, Symbol("s"), () => 1, undefined, NaN, new Date(0), new Uint8Array(3), new Map([["k", 1]]), new Set([1])]);
    expect(value).toEqual([
      { secret: "[Unreadable]" }, "[Unreadable]", "10n", "Symbol(s)", "[Function]", "[undefined]", "NaN",
      "1970-01-01T00:00:00.000Z", "[Uint8Array 3 bytes]", [["k", 1]], [1],
    ]);
  });
});

describe("SDK log content notice at start-up", () => {
  const notices = (options: SdkLogOptions) => {
    const logger = { child: vi.fn(), debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    logSdkLogContentNotice(logger, options);
    return logger;
  };

  it("warns for full and names the risk", () => {
    const logger = notices({ level: "warn", content: "full" });
    expect(logger.warn).toHaveBeenCalledWith(expect.stringMatching(/decrypted messages and HTTP bodies.*short troubleshooting/), expect.anything());
    expect(logger.info).not.toHaveBeenCalled();
  });

  it("logs nothing for messages, the default", () => {
    const logger = notices({ level: "warn", content: "messages" });
    expect(logger.info).not.toHaveBeenCalled();
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("says nothing for none or with the SDK logs off", () => {
    for (const options of [{ level: "warn", content: "none" }, { level: "off", content: "full" }] as const) {
      const logger = notices(options);
      expect(logger.warn).not.toHaveBeenCalled();
      expect(logger.info).not.toHaveBeenCalled();
    }
  });
});
