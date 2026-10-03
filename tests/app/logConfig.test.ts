import { describe, expect, it } from "vitest";
import { resolveLogSettings } from "../../src/app/config";

describe("resolveLogSettings", () => {
  it("defaults to json, SDK level warn and SDK content none", () => {
    expect(resolveLogSettings({})).toEqual({ logFormat: "json", sdkLogLevel: "warn", sdkLogContent: "none" });
    expect(resolveLogSettings({ LOG_FORMAT: " ", WIRE_SUPPORT_BOT_SDK_LOG_LEVEL: "", WIRE_SUPPORT_BOT_SDK_LOG_CONTENT: "" }))
      .toEqual({ logFormat: "json", sdkLogLevel: "warn", sdkLogContent: "none" });
  });

  it("reads every value, in any case", () => {
    expect(resolveLogSettings({ LOG_FORMAT: "ECS", WIRE_SUPPORT_BOT_SDK_LOG_LEVEL: "Debug", WIRE_SUPPORT_BOT_SDK_LOG_CONTENT: " full " }))
      .toEqual({ logFormat: "ecs", sdkLogLevel: "debug", sdkLogContent: "full" });
    for (const level of ["off", "error", "warn", "info", "debug"]) {
      expect(resolveLogSettings({ WIRE_SUPPORT_BOT_SDK_LOG_LEVEL: level }).sdkLogLevel).toBe(level);
    }
    for (const content of ["none", "messages", "full"]) {
      expect(resolveLogSettings({ WIRE_SUPPORT_BOT_SDK_LOG_CONTENT: content }).sdkLogContent).toBe(content);
    }
  });

  it("fails on an unknown value, naming the setting and its values", () => {
    expect(() => resolveLogSettings({ LOG_FORMAT: "text" })).toThrow("LOG_FORMAT must be json or ecs");
    expect(() => resolveLogSettings({ WIRE_SUPPORT_BOT_SDK_LOG_LEVEL: "trace" }))
      .toThrow("WIRE_SUPPORT_BOT_SDK_LOG_LEVEL must be off, error, warn, info or debug");
    expect(() => resolveLogSettings({ WIRE_SUPPORT_BOT_SDK_LOG_CONTENT: "all" }))
      .toThrow("WIRE_SUPPORT_BOT_SDK_LOG_CONTENT must be none, messages or full");
  });
});
