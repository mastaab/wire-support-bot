import { describe, expect, it } from "vitest";
import { resolveWireWatchdogMinutes } from "../../src/app/config";

describe("resolveWireWatchdogMinutes", () => {
  it("defaults to 5 minutes when unset or blank", () => {
    expect(resolveWireWatchdogMinutes({})).toBe(5);
    expect(resolveWireWatchdogMinutes({ WIRE_SUPPORT_BOT_WIRE_WATCHDOG_MINUTES: " " })).toBe(5);
  });

  it("reads a whole number from 0 (off) to 60", () => {
    expect(resolveWireWatchdogMinutes({ WIRE_SUPPORT_BOT_WIRE_WATCHDOG_MINUTES: "0" })).toBe(0);
    expect(resolveWireWatchdogMinutes({ WIRE_SUPPORT_BOT_WIRE_WATCHDOG_MINUTES: " 1 " })).toBe(1);
    expect(resolveWireWatchdogMinutes({ WIRE_SUPPORT_BOT_WIRE_WATCHDOG_MINUTES: "60" })).toBe(60);
  });

  it.each(["61", "-1", "2.5", "five", "5m", "100", "007"])("fails on %s, naming the setting", (value) => {
    expect(() => resolveWireWatchdogMinutes({ WIRE_SUPPORT_BOT_WIRE_WATCHDOG_MINUTES: value }))
      .toThrow("WIRE_SUPPORT_BOT_WIRE_WATCHDOG_MINUTES must be a whole number from 0 to 60");
  });
});
