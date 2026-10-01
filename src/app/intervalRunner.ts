import type { Logger } from "../application/ports/Logger";

export interface IntervalRunner {
  /** Stops further runs; resolves once a run in progress has finished. */
  stop(): Promise<void>;
}

/**
 * Runs `task` every `intervalMs`, one run at a time: a tick while a run is still going is
 * skipped. A failed run is logged by error name and the next tick tries again.
 */
export function startIntervalRunner(
  name: string,
  task: () => Promise<unknown>,
  intervalMs: number,
  logger: Logger,
): IntervalRunner {
  let current: Promise<void> | undefined;
  let stopped = false;
  const tick = (): void => {
    if (current || stopped) return;
    current = (async () => {
      try {
        await task();
      } catch (err) {
        logger.warn(`${name}: run failed`, { err: err instanceof Error ? err.name : "UnknownError" });
      } finally {
        current = undefined;
      }
    })();
  };
  const timer = setInterval(tick, intervalMs);
  timer.unref?.();
  return {
    async stop() {
      stopped = true;
      clearInterval(timer);
      await current;
    },
  };
}
