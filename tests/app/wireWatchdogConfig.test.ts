import { describe, expect, it } from "vitest";
import { resolveWireWatchdogMinutes } from "../../src/app/config";

describe("resolveWireWatchdogMinutes", () => {
  it("defaults to 5 minutes when unset or blank", () => {
    expect(resolveWireWatchdogMinutes({})).toBe(5);
    expect(resolveWireWatchdogMinutes({ WIRE_SUPPORT_BOT_WIRE_WATCHDOG_MINUTES: " " })).toBe(5);
  });

  it("reads 0 (off) or a whole number from 2 to 60", () => {
    expect(resolveWireWatchdogMinutes({ WIRE_SUPPORT_BOT_WIRE_WATCHDOG_MINUTES: "0" })).toBe(0);
    expect(resolveWireWatchdogMinutes({ WIRE_SUPPORT_BOT_WIRE_WATCHDOG_MINUTES: " 2 " })).toBe(2);
    expect(resolveWireWatchdogMinutes({ WIRE_SUPPORT_BOT_WIRE_WATCHDOG_MINUTES: "60" })).toBe(60);
  });

  it.each(["1", "61", "-1", "2.5", "five", "5m", "100", "007"])("fails on %s, naming the setting", (value) => {
    expect(() => resolveWireWatchdogMinutes({ WIRE_SUPPORT_BOT_WIRE_WATCHDOG_MINUTES: value }))
      .toThrow("WIRE_SUPPORT_BOT_WIRE_WATCHDOG_MINUTES must be 0 (off) or a whole number from 2 to 60");
  });
});
