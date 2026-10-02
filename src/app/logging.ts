/**
 * Structured logging setup. Correlates by conversation ID, user ID, entity IDs.
 * Emits content-free structured diagnostic fields to stderr.
 */

export type LogLevel = "debug" | "info" | "warn" | "error";

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

function createConsoleLogger(level: LogLevel, bindings: Record<string, unknown> = {}): Logger {
  guardAgainstBrokenPipe(process.stderr);
  const numericLevel = { debug: 0, info: 1, warn: 2, error: 3 }[level];
  const min = numericLevel;
  const log = (l: string, msg: string, data?: Record<string, unknown>) => {
    const fields = { ...bindings, ...data };
    for (const key of ["text", "preview", "raw", "context", "prompt", "response", "stack"]) delete fields[key];
    const out = { level: l, msg, time: new Date().toISOString(), ...fields };
    writeSafely(process.stderr, JSON.stringify(out) + "\n");
  };
  return {
    child(childBindings: Record<string, unknown>) {
      return createConsoleLogger(level, { ...bindings, ...childBindings });
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

export function initLogging(logLevel: string): Logger {
  const level = (logLevel in { debug: 1, info: 1, warn: 1, error: 1 }
    ? logLevel
    : "info") as LogLevel;
  rootLogger = createConsoleLogger(level);
  return rootLogger;
}

export function getLogger(): Logger {
  if (!rootLogger) return initLogging(process.env.LOG_LEVEL ?? "info");
  return rootLogger;
}
