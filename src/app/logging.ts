/**
 * Structured logging setup. Correlates by conversation ID, user ID, entity IDs.
 * Emits content-free structured diagnostic fields as one JSON line each, in the format of
 * LOG_FORMAT: the bot writes them to stdout, the CLI to stderr (its stdout carries the replies).
 */

export type LogLevel = "debug" | "info" | "warn" | "error";

/** `json`: `level`, `msg` and `time`; `ecs`: Elastic Common Schema. Both add `severity`. */
export const LOG_FORMATS = ["json", "ecs"] as const;
export type LogFormat = (typeof LOG_FORMATS)[number];

/** The ECS version the `ecs` format follows; entrypoint.sh writes the same. */
export const ECS_VERSION = "9.0.0";

/** Google Cloud Logging's severity names; most other collectors read `level` or `log.level`. */
const SEVERITY: Record<LogLevel, string> = { debug: "DEBUG", info: "INFO", warn: "WARNING", error: "ERROR" };

/**
 * Top-level fields that may hold content or personal data (names, handles, e-mail addresses, file
 * names); never written, in either format. IDs stay, for correlation.
 */
const FILTERED_KEYS = [
  "text", "preview", "raw", "context", "prompt", "response", "stack",
  "name", "senderName", "requesterName", "displayName", "handle", "agentHandle", "email", "fileName",
];

export interface Logger {
  child(bindings: Record<string, unknown>): Logger;
  debug(msg: string, data?: Record<string, unknown>): void;
  info(msg: string, data?: Record<string, unknown>): void;
  warn(msg: string, data?: Record<string, unknown>): void;
  error(msg: string, data?: Record<string, unknown>): void;
}

/**
 * Streams whose reader has gone. When the bot's output is piped (for example into `tee`) and the
 * reader exits first, as on Ctrl+C in a terminal, every write fails with EPIPE. Without a listener
 * that failure is an uncaught exception, which the SDK logs, which writes again: an endless loop
 * that keeps the process busy and blocks its shutdown. So a broken stream is simply not written
 * to any more.
 */
const closedStreams = new WeakSet<NodeJS.WritableStream>();
const guardedStreams = new WeakSet<NodeJS.WritableStream>();

/** Stops writing to `stream` once it reports a broken pipe; installs its listener once per stream. */
export function guardAgainstBrokenPipe(stream: NodeJS.WritableStream): void {
  if (guardedStreams.has(stream)) return;
  guardedStreams.add(stream);
  stream.on("error", (err: NodeJS.ErrnoException) => {
    if (err?.code === "EPIPE" || err?.code === "ERR_STREAM_DESTROYED") closedStreams.add(stream);
  });
}

/** Writes `text` unless the stream's reader has gone; never throws. */
export function writeSafely(stream: NodeJS.WritableStream, text: string): void {
  if (closedStreams.has(stream)) return;
  try {
    stream.write(text);
  } catch {
    closedStreams.add(stream);
  }
}

/** LOG_FORMAT when it is a known format (any case), otherwise undefined. */
export function parseLogFormat(raw: string | undefined): LogFormat | undefined {
  const value = raw?.trim().toLowerCase();
  return (LOG_FORMATS as readonly string[]).includes(value ?? "") ? (value as LogFormat) : undefined;
}

/**
 * One log line with its newline. The fixed fields come first and win over data fields of the
 * same name; the content keys are removed from the top level (nested values are kept).
 */
export function formatLogLine(
  format: LogFormat, level: LogLevel, msg: string, data: Record<string, unknown> = {}, time: Date = new Date(),
): string {
  const head: Record<string, unknown> = format === "ecs"
    ? { "@timestamp": time.toISOString(), "log.level": level, message: msg, "ecs.version": ECS_VERSION, severity: SEVERITY[level] }
    : { level, severity: SEVERITY[level], msg, time: time.toISOString() };
  const line = { ...head };
  for (const [key, value] of Object.entries(data)) {
    if (!(key in head) && !FILTERED_KEYS.includes(key)) line[key] = value;
  }
  return JSON.stringify(line) + "\n";
}

/** Where log lines go: the bot uses stdout, the CLI and anything before `initLogging` stderr. */
export type LogStream = "stdout" | "stderr";

export interface LogOptions {
  /** Default: LOG_FORMAT when valid, otherwise json. */
  format?: LogFormat;
  /** Default: stderr. */
  stream?: LogStream;
}

interface LogOutput {
  format: LogFormat;
  stream: NodeJS.WritableStream;
}

function createConsoleLogger(level: LogLevel, output: LogOutput, bindings: Record<string, unknown> = {}): Logger {
  guardAgainstBrokenPipe(output.stream);
  const min = { debug: 0, info: 1, warn: 2, error: 3 }[level];
  const log = (l: LogLevel, msg: string, data?: Record<string, unknown>) => {
    writeSafely(output.stream, formatLogLine(output.format, l, msg, { ...bindings, ...data }));
  };
  return {
    child(childBindings: Record<string, unknown>) {
      return createConsoleLogger(level, output, { ...bindings, ...childBindings });
    },
    debug(msg: string, data?: Record<string, unknown>) {
      if (min <= 0) log("debug", msg, data);
    },
    info(msg: string, data?: Record<string, unknown>) {
      if (min <= 1) log("info", msg, data);
    },
    warn(msg: string, data?: Record<string, unknown>) {
      if (min <= 2) log("warn", msg, data);
    },
    error(msg: string, data?: Record<string, unknown>) {
      if (min <= 3) log("error", msg, data);
    },
  };
}

let rootLogger: Logger | null = null;
let rootOutput: LogOutput | null = null;

export function initLogging(logLevel: string, options: LogOptions = {}): Logger {
  const level = (logLevel in { debug: 1, info: 1, warn: 1, error: 1 }
    ? logLevel
    : "info") as LogLevel;
  rootOutput = {
    format: options.format ?? parseLogFormat(process.env.LOG_FORMAT) ?? "json",
    stream: options.stream === "stdout" ? process.stdout : process.stderr,
  };
  rootLogger = createConsoleLogger(level, rootOutput);
  return rootLogger;
}

/** The root logger; before `initLogging`, one at LOG_LEVEL and LOG_FORMAT on stderr. */
export function getLogger(): Logger {
  if (!rootLogger) return initLogging(process.env.LOG_LEVEL ?? "info");
  return rootLogger;
}

/**
 * A logger at its own level, independent of LOG_LEVEL, writing to the root logger's stream in its
 * format; for the Wire SDK, whose level is WIRE_SUPPORT_BOT_SDK_LOG_LEVEL.
 */
export function createLogger(level: LogLevel): Logger {
  if (!rootOutput) getLogger();
  return createConsoleLogger(level, rootOutput!);
}
