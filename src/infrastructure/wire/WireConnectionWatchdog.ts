import type { Logger } from "../../application/ports/Logger";
import { NO_METRICS, type MetricsPort } from "../../application/ports/MetricsPort";

/** The connection events of the SDK's backend connection listener. */
export interface WireConnectionObserver {
  onConnected(): void;
  onDisconnected(): void;
}

type TimerHandle = ReturnType<typeof setTimeout>;

/** The timer functions the watchdog uses; tests pass their own or use fake timers. */
export interface WatchdogTimers {
  setTimeout(run: () => void, ms: number): TimerHandle;
  clearTimeout(handle: TimerHandle): void;
}

const GLOBAL_TIMERS: WatchdogTimers = {
  setTimeout: (run, ms) => setTimeout(run, ms),
  clearTimeout: (handle) => clearTimeout(handle),
};

export interface WireConnectionWatchdogOptions {
  /** Minutes without a connection before each action; 0 turns the watchdog off. */
  minutes: number;
  /** Starts the SDK's WebSocket loop again (`sdk.startListening()`). */
  restart: () => Promise<void>;
  /** Ends the process with exit code 1 through the shutdown path. */
  exit: () => void;
  logger: Logger;
  metrics?: MetricsPort;
  timers?: WatchdogTimers;
}

/**
 * Restarts the Wire connection, and then ends the process, when Wire has not been connected for a
 * set time. The SDK stops its WebSocket loop for good after 10 failed reconnect attempts in a row
 * (about 3.5 minutes) without a further connection event, and a failed first connect reports no
 * event at all, so the watchdog counts from `start()` and from every disconnect until the next
 * connect. After one period it calls `restart` once; after a second period still without a
 * connection it calls `exit`, so Docker Compose or Kubernetes starts a fresh process. A connect
 * resets both. Its timers never keep the process alive.
 */
export class WireConnectionWatchdog implements WireConnectionObserver {
  private readonly ms: number;
  private readonly metrics: MetricsPort;
  private readonly timers: WatchdogTimers;
  private timer: TimerHandle | undefined;
  private running = false;
  private stopped = false;
  private connected = false;
  private restarted = false;

  constructor(private readonly options: WireConnectionWatchdogOptions) {
    this.ms = options.minutes * 60_000;
    this.metrics = options.metrics ?? NO_METRICS;
    this.timers = options.timers ?? GLOBAL_TIMERS;
  }

  /** Called when the bot starts listening: counts until the first connect. */
  start(): void {
    if (this.options.minutes <= 0 || this.running || this.stopped) return;
    this.running = true;
    if (!this.connected) this.arm();
  }

  onConnected(): void {
    this.connected = true;
    this.restarted = false;
    this.disarm();
  }

  onDisconnected(): void {
    this.connected = false;
    if (this.running && this.timer === undefined) this.arm();
  }

  /** Clears the timer; the watchdog does nothing more afterwards. */
  stop(): void {
    this.stopped = true;
    this.running = false;
    this.disarm();
  }

  private arm(): void {
    const timer = this.timers.setTimeout(() => this.expire(), this.ms);
    (timer as { unref?: () => unknown }).unref?.();
    this.timer = timer;
  }

  private disarm(): void {
    if (this.timer !== undefined) this.timers.clearTimeout(this.timer);
    this.timer = undefined;
  }

  private expire(): void {
    this.timer = undefined;
    if (!this.running || this.connected) return;
    const { minutes, logger } = this.options;
    if (!this.restarted) {
      this.restarted = true;
      logger.error("Wire not connected for the watchdog period; restarting the connection", { minutes, attempt: 1 });
      this.metrics.wireWatchdogAction("restart");
      // The SDK only logs "already running" while its loop still runs, so a second call is harmless.
      Promise.resolve()
        .then(() => this.options.restart())
        .catch((err: unknown) => logger.error("Wire connection restart failed", { err: err instanceof Error ? err.name : "UnknownError" }));
      this.arm();
      return;
    }
    logger.error("Wire still not connected after a restart; exiting so the orchestrator restarts the bot", { minutes, attempt: 2 });
    this.metrics.wireWatchdogAction("exit");
    this.stop();
    this.options.exit();
  }
}
