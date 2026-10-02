import { describe, it, expect, vi } from "vitest";
import { InMemoryProcessingQueue } from "../../src/infrastructure/queue/InMemoryProcessingQueue";

describe("processing queue", () => {
  it("serializes channel work, purges queued messages and aborts the in-flight job", async () => {
    const queue = new InMemoryProcessingQueue();
    let release!: () => void;
    const pending = new Promise<void>(resolve => { release = resolve; });
    const worker = vi.fn(async job => {
      if (job.id === "first") {
        await pending;
        expect(job.signal.aborted).toBe(true);
      }
    });
    queue.setWorker(worker);
    for (const id of ["first", "second"]) queue.enqueue({ id, channelId: "one", payload: "private", enqueuedAt: new Date() });
    queue.enqueue({ id: "other", channelId: "two", payload: "public", enqueuedAt: new Date() });
    expect(worker.mock.calls.map(([j]) => j.id)).toEqual(["first", "other"]);
    let canceled = false;
    const canceling = queue.cancelChannel("one").then(() => { canceled = true; });
    await Promise.resolve();
    expect(canceled).toBe(false);
    release();
    await canceling;
    await queue.waitForIdle();
    expect(worker.mock.calls.map(([j]) => j.id)).not.toContain("second");
  });
});
