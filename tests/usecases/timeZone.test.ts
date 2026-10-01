import { describe, expect, it } from "vitest";
import { canonicalTimeZone } from "../../src/domain/services/timeZone";
import { resolveDefaultTimezone } from "../../src/app/config";

describe("canonicalTimeZone", () => {
  it.each([["Europe/Berlin", "Europe/Berlin"], ["europe/berlin", "Europe/Berlin"], [" UTC ", "UTC"], ["utc", "UTC"],["America/New_York", "America/New_York"]])(
    "accepts %s as %s", (input, expected) => {
      expect(canonicalTimeZone(input)).toBe(expected);
    });

  it.each(["", "Mars/Olympus", "CEST", "Berlin time", "est", "cet", "gmt", "+01:00", "Etc/GMT+1"])("rejects %j", (input) => {
    expect(canonicalTimeZone(input)).toBeNull();
  });
});

describe("resolveDefaultTimezone", () => {
  it("defaults to UTC, canonicalises a valid name and rejects an unknown one", () => {
    expect(resolveDefaultTimezone({})).toBe("UTC");
    expect(resolveDefaultTimezone({ WIRE_SUPPORT_BOT_DEFAULT_TIMEZONE: "europe/berlin" })).toBe("Europe/Berlin");
    expect(() => resolveDefaultTimezone({ WIRE_SUPPORT_BOT_DEFAULT_TIMEZONE: "Mars/Olympus" })).toThrow(/IANA/);
  });
});
