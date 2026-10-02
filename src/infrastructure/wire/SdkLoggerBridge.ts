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

/** SDK messages and metadata can include decrypted events and HTTP bodies. */
export function makeSdkLoggerBridge(botLogger: Logger) {
  const log = botLogger.child({ component: "sdk" });
  // Keep severity visible without persisting third-party free-form content; warnings and
  // errors add only the content-free fields from sdkErrorDetails (for a non-Error object such
  // as a WebSocket error event, its class name and event type).
  const details = (args: unknown[]) => {
    const fields = sdkErrorDetails(args);
    return Object.keys(fields).length > 0 ? fields : undefined;
  };
  return {
    debug: (_msg: string, ..._rest: unknown[]) => log.debug("Wire SDK diagnostic"),
    info: (_msg: string, ..._rest: unknown[]) => log.info("Wire SDK diagnostic"),
    warn: (msg: string, ...rest: unknown[]) => log.warn("Wire SDK diagnostic", details([msg, ...rest])),
    error: (msg: string, ...rest: unknown[]) => log.error("Wire SDK diagnostic", details([msg, ...rest])),
  };
}
