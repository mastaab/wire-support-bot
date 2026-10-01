import { describe, expect, it } from "vitest";
import { formatDateInZone, formatTimeInZone } from "../../src/application/services/formatTimeInZone";

describe("formatDateInZone", () => {
  it("gives the calendar date in the zone", () => {
    const lateEvening = new Date("2026-09-30T23:30:00Z");
    expect(formatDateInZone(lateEvening, "UTC")).toBe("2026-09-30");
    expect(formatDateInZone(lateEvening, "Europe/Berlin")).toBe("2026-10-01");
    expect(formatDateInZone(new Date("2026-10-01T02:00:00Z"), "America/New_York")).toBe("2026-09-30");
  });

  it("falls back to UTC for an unknown zone", () => {
    expect(formatDateInZone(new Date("2026-09-30T23:30:00Z"), "Mars/Olympus")).toBe("2026-09-30");
  });
});

describe("formatTimeInZone", () => {
  it("switches between CEST and CET with daylight saving time", () => {
    expect(formatTimeInZone(new Date("2026-09-26T15:55:00Z"), "Europe/Berlin", "time")).toBe("17:55 CEST");
    expect(formatTimeInZone(new Date("2026-12-01T15:55:00Z"), "Europe/Berlin", "time")).toBe("16:55 CET");
  });

  it("formats each style", () => {
    const date = new Date("2026-09-26T15:55:00Z");
    expect(formatTimeInZone(date, "Europe/Berlin", "dayMonth")).toBe("26 Sept, 17:55 CEST");
    expect(formatTimeInZone(date, "Europe/Berlin", "date")).toBe("26 Sept 2026, 17:55 CEST");
    expect(formatTimeInZone(date, "Europe/Berlin", "weekdayDate")).toBe("Saturday, 26 Sept 2026, 17:55 CEST");
  });

  it("shows UTC for UTC and falls back to UTC for an unknown zone", () => {
    const date = new Date("2026-09-26T15:55:00Z");
    expect(formatTimeInZone(date, "UTC", "time")).toBe("15:55 UTC");
    expect(formatTimeInZone(date, "Mars/Olympus", "dayMonth")).toBe("26 Sept, 15:55 UTC");
  });
});
