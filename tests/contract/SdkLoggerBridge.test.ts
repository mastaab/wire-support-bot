import { describe, expect, it, vi } from "vitest";
import { makeSdkLoggerBridge } from "../../src/infrastructure/wire/SdkLoggerBridge";
import { initLogging } from "../../src/app/logging";

const marker = "SDK_PRIVATE_CONTEXT_MARKER";

/** Runs the calls against a debug-level bridge and returns the parsed stderr lines and raw output. */
function capture(calls: (bridge: ReturnType<typeof makeSdkLoggerBridge>) => void) {
  const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
  try {
    calls(makeSdkLoggerBridge(initLogging("debug")));
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
      { level: "debug", msg: "Wire SDK diagnostic", component: "sdk", time: expect.any(String) },
      { level: "info", msg: "Wire SDK diagnostic", component: "sdk", time: expect.any(String) },
      { level: "warn", msg: "Wire SDK diagnostic", component: "sdk", time: expect.any(String), errorName: "Error" },
      { level: "error", msg: "Wire SDK diagnostic", component: "sdk", time: expect.any(String), errorName: "Error" },
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
    const fields = lines.map(({ time: _time, level: _level, msg: _msg, component: _component, ...rest }) => rest);
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
    const fields = lines.map(({ time: _time, msg: _msg, component: _component, ...rest }) => rest);
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
      { level: "debug", msg: "Wire SDK diagnostic", component: "sdk", time: expect.any(String) },
      { level: "info", msg: "Wire SDK diagnostic", component: "sdk", time: expect.any(String) },
    ]);
  });
});
