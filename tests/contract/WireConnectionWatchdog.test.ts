import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WireConnectionWatchdog } from "../../src/infrastructure/wire/WireConnectionWatchdog";
import { listenForConnection } from "../../src/infrastructure/wire/WireClient";
import type { Logger } from "../../src/application/ports/Logger";
import { fakeMetrics } from "../metrics/fakeMetrics";

const MINUTE = 60_000;

function fakeLogger(): Logger & { info: ReturnType<typeof vi.fn>; error: ReturnType<typeof vi.fn> } {
  const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), child: () => logger };
  return logger;
}

/** A watchdog on fake timers with a recording restart, exit, logger and metrics. */
function setup(minutes = 5, restart: () => Promise<void> = async () => {}) {
  const logger = fakeLogger();
  const { metrics, of } = fakeMetrics();
  const restarts = vi.fn(restart);
  const exit = vi.fn();
  const watchdog = new WireConnectionWatchdog({ minutes, restart: restarts, exit, logger, metrics });
  return { watchdog, logger, restarts, exit, actions: () => of("wireWatchdogAction") };
}

describe("WireConnectionWatchdog", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it("does nothing when Wire connects in time and stays connected", async () => {
    const { watchdog, restarts, exit, logger, actions } = setup();
    watchdog.start();
    await vi.advanceTimersByTimeAsync(4 * MINUTE);
    watchdog.onConnected();
    await vi.advanceTimersByTimeAsync(60 * MINUTE);
    expect(restarts).not.toHaveBeenCalled();
    expect(exit).not.toHaveBeenCalled();
    expect(logger.error).not.toHaveBeenCalled();
    expect(actions()).toEqual([]);
  });

  it("does nothing when a disconnect is followed by a reconnect within the period", async () => {
    const { watchdog, restarts, exit } = setup();
    watchdog.start();
    watchdog.onConnected();
    watchdog.onDisconnected();
    await vi.advanceTimersByTimeAsync(4 * MINUTE);
    watchdog.onConnected();
    watchdog.onDisconnected();
    await vi.advanceTimersByTimeAsync(4 * MINUTE);
    watchdog.onConnected();
    await vi.advanceTimersByTimeAsync(60 * MINUTE);
    expect(restarts).not.toHaveBeenCalled();
    expect(exit).not.toHaveBeenCalled();
  });

  it("restarts the connection once after one period without a connection, also when the first connect fails", async () => {
    const { watchdog, restarts, exit, logger, actions } = setup();
    watchdog.start();
    await vi.advanceTimersByTimeAsync(5 * MINUTE - 1);
    expect(restarts).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(restarts).toHaveBeenCalledTimes(1);
    expect(exit).not.toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalledWith(
      "Wire not connected for the watchdog period; restarting the connection", { minutes: 5, attempt: 1 },
    );
    expect(actions()).toEqual([["restart"]]);
  });

  it("starts counting at a disconnect, not before", async () => {
    const { watchdog, restarts } = setup();
    watchdog.start();
    watchdog.onConnected();
    await vi.advanceTimersByTimeAsync(20 * MINUTE);
    watchdog.onDisconnected();
    // A repeated disconnect keeps the running timer.
    await vi.advanceTimersByTimeAsync(3 * MINUTE);
    watchdog.onDisconnected();
    await vi.advanceTimersByTimeAsync(2 * MINUTE);
    expect(restarts).toHaveBeenCalledTimes(1);
  });

  it("exits after a second period still without a connection", async () => {
    const { watchdog, restarts, exit, logger, actions } = setup();
    watchdog.start();
    await vi.advanceTimersByTimeAsync(10 * MINUTE - 1);
    expect(exit).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(restarts).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledTimes(1);
    expect(logger.error).toHaveBeenLastCalledWith(
      "Wire still not connected after a restart; exiting so the orchestrator restarts the bot", { minutes: 5, attempt: 2 },
    );
    expect(actions()).toEqual([["restart"], ["exit"]]);
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(60 * MINUTE);
    expect(exit).toHaveBeenCalledTimes(1);
  });

  it("resets everything when Wire connects after a restart, and logs that it was restored", async () => {
    const { watchdog, restarts, exit, logger } = setup();
    watchdog.start();
    await vi.advanceTimersByTimeAsync(5 * MINUTE);
    expect(restarts).toHaveBeenCalledTimes(1);
    watchdog.onConnected();
    expect(logger.info).toHaveBeenCalledWith("Wire connection restored after the watchdog restart", { minutes: 5 });
    watchdog.onDisconnected();
    watchdog.onConnected();
    expect(logger.info).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(60 * MINUTE);
    expect(exit).not.toHaveBeenCalled();
    // A later outage restarts first again, instead of exiting.
    watchdog.onDisconnected();
    await vi.advanceTimersByTimeAsync(5 * MINUTE);
    expect(restarts).toHaveBeenCalledTimes(2);
    expect(exit).not.toHaveBeenCalled();
  });

  it("logs a failed restart by error name only and keeps counting", async () => {
    class SdkStateError extends Error { override name = "SdkStateError"; }
    const { watchdog, exit, logger } = setup(5, async () => { throw new SdkStateError("private detail"); });
    watchdog.start();
    await vi.advanceTimersByTimeAsync(5 * MINUTE);
    expect(logger.error).toHaveBeenCalledWith("Wire connection restart failed", { err: "SdkStateError" });
    expect(JSON.stringify(logger.error.mock.calls)).not.toContain("private detail");
    await vi.advanceTimersByTimeAsync(5 * MINUTE);
    expect(exit).toHaveBeenCalledTimes(1);
  });

  it("is off at 0 minutes", async () => {
    const { watchdog, restarts, exit } = setup(0);
    watchdog.start();
    watchdog.onDisconnected();
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(120 * MINUTE);
    expect(restarts).not.toHaveBeenCalled();
    expect(exit).not.toHaveBeenCalled();
  });

  it("leaves no timer after stop, and a later disconnect starts none", async () => {
    const { watchdog, restarts, exit } = setup();
    watchdog.start();
    expect(vi.getTimerCount()).toBe(1);
    watchdog.stop();
    expect(vi.getTimerCount()).toBe(0);
    watchdog.onDisconnected();
    watchdog.start();
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(60 * MINUTE);
    expect(restarts).not.toHaveBeenCalled();
    expect(exit).not.toHaveBeenCalled();
  });

  it("keeps its timer referenced, so the process stays alive until the watchdog acts", () => {
    vi.useRealTimers();
    const unref = vi.fn();
    const handle = { unref } as unknown as ReturnType<typeof setTimeout>;
    const timers = { setTimeout: vi.fn(() => handle), clearTimeout: vi.fn() };
    const watchdog = new WireConnectionWatchdog({ minutes: 1, restart: async () => {}, exit: () => {}, logger: fakeLogger(), timers });
    watchdog.start();
    expect(timers.setTimeout).toHaveBeenCalledWith(expect.any(Function), MINUTE);
    expect(unref).not.toHaveBeenCalled();
    watchdog.stop();
    expect(timers.clearTimeout).toHaveBeenCalledWith(handle);
  });
});

describe("listenForConnection", () => {
  it("sets one listener that logs each change and feeds both the metrics and the watchdog", () => {
    const sdk = { setBackendConnectionListener: vi.fn() };
    const logger = fakeLogger();
    const { metrics, of } = fakeMetrics();
    const observer = { onConnected: vi.fn(), onDisconnected: vi.fn() };
    listenForConnection(sdk, logger, metrics, observer);
    expect(sdk.setBackendConnectionListener).toHaveBeenCalledTimes(1);
    const listener = sdk.setBackendConnectionListener.mock.calls[0]![0] as { onConnected(): void; onDisconnected(): void };
    listener.onConnected();
    listener.onDisconnected();
    expect(of("wireConnection")).toEqual([["connected"], ["disconnected"]]);
    expect(observer.onConnected).toHaveBeenCalledTimes(1);
    expect(observer.onDisconnected).toHaveBeenCalledTimes(1);
    expect(logger.info.mock.calls).toEqual([["Wire connected"], ["Wire disconnected"]]);
  });

  it("keeps the metrics without a watchdog", () => {
    const sdk = { setBackendConnectionListener: vi.fn() };
    const logger = fakeLogger();
    const { metrics, of } = fakeMetrics();
    listenForConnection(sdk, logger, metrics);
    const listener = sdk.setBackendConnectionListener.mock.calls[0]![0] as { onConnected(): void; onDisconnected(): void };
    listener.onDisconnected();
    listener.onConnected();
    expect(of("wireConnection")).toEqual([["disconnected"], ["connected"]]);
  });
});
