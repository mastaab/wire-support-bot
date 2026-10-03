import type { Logger } from "../../application/ports/Logger";

const SAFE_TOKEN = /^[A-Za-z0-9._:-]+$/;
const MAX_TOKEN_LENGTH = 64;
const DETAIL_FIELDS = ["status", "code", "label"] as const;

/** A finite number, or a short identifier-like string; anything else is dropped. */
function safeValue(value: unknown): string | number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.length <= MAX_TOKEN_LENGTH && SAFE_TOKEN.test(value)) return value;
  return undefined;
}

/** Reads one property without letting a throwing getter escape into the SDK. */
function read(source: unknown, key: string): unknown {
  if (source === null || (typeof source !== "object" && typeof source !== "function")) return undefined;
  try {
    return (source as Record<string, unknown>)[key];
  } catch {
    return undefined;
  }
}

/** The error's `name`, or its constructor's name when `name` is missing, unsafe or the generic "Error". */
function errorName(error: Error): string | undefined {
  const name = safeValue(read(error, "name"));
  if (typeof name === "string" && name !== "Error") return name;
  const ctor = safeValue(read(read(error, "constructor"), "name"));
  if (typeof ctor === "string") return ctor;
  return typeof name === "string" ? name : undefined;
}

/**
 * Content-free fields of the first Error among the SDK's arguments: its class name, and an
 * HTTP status, error code or backend label held on the error itself (WireApiException has
 * `code` and `label`, RetryableHttpStatusError has `status`) or one level deep in its
 * `response` or `cause` (WireException subclasses keep the original error as `cause`).
 * Messages, stacks, paths, other fields and nested objects never reach the log. Without an
 * Error, the fields of `sdkObjectDetails`.
 */
export function sdkErrorDetails(args: unknown[]): Record<string, string | number> {
  const error = args.find((arg): arg is Error => arg instanceof Error);
  if (!error) return sdkObjectDetails(args);
  const details: Record<string, string | number> = {};
  const name = errorName(error);
  if (name) details.errorName = name;
  const sources = [error, read(error, "response"), read(error, "cause")];
  for (const field of DETAIL_FIELDS) {
    for (const source of sources) {
      const value = safeValue(read(source, field));
      if (value !== undefined) {
        details[field] = value;
        break;
      }
    }
  }
  return details;
}

/** A short identifier such as an event type ("error", "close"). */
const SHORT_IDENTIFIER = /^[A-Za-z][A-Za-z0-9_-]{0,31}$/;

/**
 * Content-free fields for a warning or error without an Error, such as the SDK's "Websocket
 * Error:" with the WebSocket error event: the class name of the first non-null object argument
 * (never "Object", so a plain object adds nothing) and, for such an object, its `type` when that
 * is a short identifier. Messages, other fields and nested content never reach the log.
 */
export function sdkObjectDetails(args: unknown[]): Record<string, string> {
  const object = args.find((arg): arg is object => typeof arg === "object" && arg !== null);
  if (!object) return {};
  const objectType = safeValue(read(read(object, "constructor"), "name"));
  if (typeof objectType !== "string" || objectType === "Object") return {};
  const type = read(object, "type");
  return typeof type === "string" && SHORT_IDENTIFIER.test(type) ? { objectType, eventType: type } : { objectType };
}

/** WIRE_SUPPORT_BOT_SDK_LOG_LEVEL: the lowest SDK severity written, or `off`. */
export const SDK_LOG_LEVELS = ["off", "error", "warn", "info", "debug"] as const;
export type SdkLogLevel = (typeof SDK_LOG_LEVELS)[number];

/**
 * WIRE_SUPPORT_BOT_SDK_LOG_CONTENT: `none` writes only the content-free fields, `messages` adds the
 * SDK's message text (`sdkMessage`), `full` also its extra arguments (`sdkArgs`).
 */
export const SDK_LOG_CONTENTS = ["none", "messages", "full"] as const;
export type SdkLogContent = (typeof SDK_LOG_CONTENTS)[number];

export interface SdkLogOptions {
  level: SdkLogLevel;
  content: SdkLogContent;
}

/** Longest `sdkMessage`, in UTF-16 code units. */
export const SDK_MESSAGE_MAX = 500;

/** The SDK's message text for `sdkMessage`: control characters removed, at most `SDK_MESSAGE_MAX` long. */
export function sanitizeSdkMessage(message: string): string {
  return clip(message.replace(/[\u0000-\u001f\u007f-\u009f]/g, ""), SDK_MESSAGE_MAX);
}

/** The first `max` code units of `text`, without a lone high surrogate at the end. */
function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  return /[\ud800-\udbff]$/.test(cut) ? cut.slice(0, -1) : cut;
}

/** About the largest `sdkArgs` as JSON, in characters. */
export const SDK_ARGS_MAX = 4096;
const ARGS_MAX_DEPTH = 5;
const ARGS_MAX_ENTRIES = 50;
const ARGS_MAX_STRING = 1000;
const TRUNCATED = "[Truncated]";
const UNREADABLE = Symbol("unreadable");

/** One property, or UNREADABLE when its getter throws. */
function readOrMark(source: object, key: string): unknown {
  try {
    return (source as Record<string, unknown>)[key];
  } catch {
    return UNREADABLE;
  }
}

/**
 * The SDK's extra arguments as a JSON-safe value for `sdkArgs` (content mode `full` only):
 * circular references as "[Circular]", objects deeper than `ARGS_MAX_DEPTH` as "[Object]" or
 * "[Array]", at most `ARGS_MAX_ENTRIES` entries per object or array, strings clipped, and
 * "[Truncated]" once about `SDK_ARGS_MAX` characters are used. Errors become their name, message
 * and stack. Throwing getters and proxies become "[Unreadable]"; never throws.
 */
export function serializeSdkArgs(args: unknown[]): unknown {
  let budget = SDK_ARGS_MAX;
  const ancestors: object[] = [];
  const spend = (value: unknown) => {
    budget -= JSON.stringify(value)?.length ?? 4;
    return value;
  };
  const entries = (pairs: Iterable<[string, unknown]>, depth: number): Record<string, unknown> => {
    const out: Record<string, unknown> = {};
    let count = 0;
    for (const [key, value] of pairs) {
      if (budget <= 0 || count++ >= ARGS_MAX_ENTRIES) {
        out["[more]"] = TRUNCATED;
        break;
      }
      spend(key);
      out[key] = visit(value, depth + 1);
    }
    return out;
  };
  const items = (values: Iterable<unknown>, depth: number): unknown[] => {
    const out: unknown[] = [];
    for (const value of values) {
      if (budget <= 0 || out.length >= ARGS_MAX_ENTRIES) {
        out.push(TRUNCATED);
        break;
      }
      out.push(visit(value, depth + 1));
    }
    return out;
  };
  const visit = (value: unknown, depth: number): unknown => {
    if (budget <= 0) return TRUNCATED;
    if (value === UNREADABLE) return spend("[Unreadable]");
    switch (typeof value) {
      case "string": return spend(clip(value, Math.min(ARGS_MAX_STRING, budget)));
      case "number": return spend(Number.isFinite(value) ? value : String(value));
      case "boolean": return spend(value);
      case "bigint": return spend(`${value}n`);
      case "undefined": return spend("[undefined]");
      case "symbol": return spend(String(value));
      case "function": return spend("[Function]");
    }
    if (value === null) return spend(null);
    const object = value as object;
    if (ancestors.includes(object)) return spend("[Circular]");
    if (depth >= ARGS_MAX_DEPTH) return spend(Array.isArray(object) ? "[Array]" : "[Object]");
    ancestors.push(object);
    try {
      if (object instanceof Error) {
        return entries(["name", "message", "stack"].map((key): [string, unknown] => [key, readOrMark(object, key)]), depth);
      }
      if (object instanceof Date) return spend(Number.isNaN(object.getTime()) ? "Invalid Date" : object.toISOString());
      if (ArrayBuffer.isView(object) || object instanceof ArrayBuffer) {
        return spend(`[${object.constructor?.name ?? "Binary"} ${object.byteLength} bytes]`);
      }
      if (object instanceof Map) return items(object.entries(), depth);
      if (object instanceof Set) return items(object.values(), depth);
      if (Array.isArray(object)) return items(object, depth);
      return entries(Object.keys(object).map((key): [string, unknown] => [key, readOrMark(object, key)]), depth);
    } catch {
      return spend("[Unreadable]");
    } finally {
      ancestors.pop();
    }
  };
  try {
    const result = visit(args, 0);
    const json = JSON.stringify(result);
    // The budget is spent per value; escaped characters can still make the JSON longer.
    return json.length <= SDK_ARGS_MAX + 512 ? result : clip(json, SDK_ARGS_MAX);
  } catch {
    return "[Unreadable]";
  }
}

const SEVERITY_RANK = { debug: 0, info: 1, warn: 2, error: 3 } as const;
const LEVEL_THRESHOLD: Record<SdkLogLevel, number> = { off: Infinity, error: 3, warn: 2, info: 1, debug: 0 };

/**
 * SDK messages and metadata can include decrypted events and HTTP bodies. `sdkLogger` must let
 * every severity through: the SDK's own level (`options.level`) is applied here, independent of
 * LOG_LEVEL.
 */
export function makeSdkLoggerBridge(sdkLogger: Logger, options: SdkLogOptions) {
  const log = sdkLogger.child({ component: "sdk" });
  // In content mode none, keep severity visible without persisting third-party free-form content;
  // warnings and errors add only the content-free fields from sdkErrorDetails (for a non-Error
  // object such as a WebSocket error event, its class name and event type). The other modes add
  // the message text and, with full, the extra arguments.
  const write = (severity: keyof typeof SEVERITY_RANK, msg: unknown, rest: unknown[]) => {
    if (SEVERITY_RANK[severity] < LEVEL_THRESHOLD[options.level]) return;
    const fields: Record<string, unknown> = severity === "warn" || severity === "error" ? sdkErrorDetails([msg, ...rest]) : {};
    if (options.content !== "none" && typeof msg === "string") fields.sdkMessage = sanitizeSdkMessage(msg);
    if (options.content === "full" && rest.length > 0) fields.sdkArgs = serializeSdkArgs(rest);
    log[severity]("Wire SDK diagnostic", Object.keys(fields).length > 0 ? fields : undefined);
  };
  return {
    debug: (msg: string, ...rest: unknown[]) => write("debug", msg, rest),
    info: (msg: string, ...rest: unknown[]) => write("info", msg, rest),
    warn: (msg: string, ...rest: unknown[]) => write("warn", msg, rest),
    error: (msg: string, ...rest: unknown[]) => write("error", msg, rest),
  };
}

/**
 * Says at start-up when SDK logs carry content: a warning for `full`, an info line for `messages`;
 * nothing for `none` or with the SDK logs off.
 */
export function logSdkLogContentNotice(logger: Logger, options: SdkLogOptions): void {
  if (options.level === "off") return;
  if (options.content === "full") {
    logger.warn(
      "WIRE_SUPPORT_BOT_SDK_LOG_CONTENT is full: Wire SDK logs may contain decrypted messages and HTTP bodies; use it for short troubleshooting only",
      { sdkLogLevel: options.level, sdkLogContent: options.content },
    );
  } else if (options.content === "messages") {
    logger.info(
      "WIRE_SUPPORT_BOT_SDK_LOG_CONTENT is messages: Wire SDK logs include the SDK's message text",
      { sdkLogLevel: options.level, sdkLogContent: options.content },
    );
  }
}
