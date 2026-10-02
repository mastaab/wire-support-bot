import { describe, expect, it, vi } from "vitest";
import { PassThrough } from "node:stream";
import { guardAgainstBrokenPipe, writeSafely } from "../../src/app/logging";

const brokenPipe = (): NodeJS.ErrnoException => Object.assign(new Error("write EPIPE"), { code: "EPIPE" });

describe("writing logs to a pipe whose reader has gone", () => {
  it("stops writing after the stream reports EPIPE, without throwing", () => {
    const stream = new PassThrough();
    const write = vi.spyOn(stream, "write");
    guardAgainstBrokenPipe(stream);
    writeSafely(stream, "first\n");
    expect(write).toHaveBeenCalledTimes(1);
    stream.emit("error", brokenPipe());
    writeSafely(stream, "second\n");
    writeSafely(stream, "third\n");
    expect(write).toHaveBeenCalledTimes(1);
  });

  it("turns the stream's EPIPE error into a handled event, not an uncaught exception", () => {
    const stream = new PassThrough();
    guardAgainstBrokenPipe(stream);
    expect(() => stream.emit("error", brokenPipe())).not.toThrow();
  });

  it("installs its listener once per stream", () => {
    const stream = new PassThrough();
    guardAgainstBrokenPipe(stream);
    guardAgainstBrokenPipe(stream);
    expect(stream.listenerCount("error")).toBe(1);
  });

  it("treats a write that throws as a closed stream", () => {
    const stream = new PassThrough();
    const write = vi.spyOn(stream, "write").mockImplementation(() => { throw brokenPipe(); });
    expect(() => writeSafely(stream, "x\n")).not.toThrow();
    writeSafely(stream, "y\n");
    expect(write).toHaveBeenCalledTimes(1);
  });

  it("keeps writing to a stream that reports other errors", () => {
    const stream = new PassThrough();
    const write = vi.spyOn(stream, "write");
    guardAgainstBrokenPipe(stream);
    stream.emit("error", Object.assign(new Error("other"), { code: "EIO" }));
    writeSafely(stream, "still\n");
    expect(write).toHaveBeenCalledTimes(1);
  });
});
