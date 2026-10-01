import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startIntervalRunner } from "../../src/app/intervalRunner";

const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), child: vi.fn() };

describe("startIntervalRunner", () => {
  beforeEach(() => { vi.useFakeTimers(); logger.warn.mockClear(); });
  afterEach(() => { vi.useRealTimers(); });

  it("runs the task at each interval until stopped", async () => {
    const task = vi.fn().mockResolvedValue(undefined);
    const runner = startIntervalRunner("watch", task, 1000, logger);
    expect(task).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(3000);
    expect(task).toHaveBeenCalledTimes(3);
    await runner.stop();
    await vi.advanceTimersByTimeAsync(3000);
    expect(task).toHaveBeenCalledTimes(3);
  });

  it("skips ticks while a run is still going", async () => {
    let finish: () => void = () => {};
    const task = vi.fn(() => new Promise<void>((resolve) => { finish = resolve; }));
    const runner = startIntervalRunner("watch", task, 1000, logger);
    await vi.advanceTimersByTimeAsync(3500);
    expect(task).toHaveBeenCalledTimes(1);
    finish();
    await vi.advanceTimersByTimeAsync(1000);
    expect(task).toHaveBeenCalledTimes(2);
    finish();
    await runner.stop();
  });

  it("waits for a run in progress when stopped", async () => {
    let finish: () => void = () => {};
    const task = vi.fn(() => new Promise<void>((resolve) => { finish = resolve; }));
    const runner = startIntervalRunner("watch", task, 1000, logger);
    await vi.advanceTimersByTimeAsync(1000);
    let stopped = false;
    const stopping = runner.stop().then(() => { stopped = true; });
    await vi.advanceTimersByTimeAsync(0);
    expect(stopped).toBe(false);
    finish();
    await stopping;
    expect(stopped).toBe(true);
  });

  it("logs a failed run by error name only and tries again at the next tick", async () => {
    const task = vi.fn().mockRejectedValueOnce(new TypeError("reply text must not be logged")).mockResolvedValue(undefined);
    const runner = startIntervalRunner("watch", task, 1000, logger);
    await vi.advanceTimersByTimeAsync(2000);
    expect(task).toHaveBeenCalledTimes(2);
    expect(logger.warn).toHaveBeenCalledWith("watch: run failed", { err: "TypeError" });
    expect(JSON.stringify(logger.warn.mock.calls)).not.toContain("reply text");
    await runner.stop();
  });
});
