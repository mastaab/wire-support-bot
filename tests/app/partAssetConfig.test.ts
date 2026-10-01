import { describe, expect, it } from "vitest";
import { resolvePartAsset } from "../../src/app/config";
import { DEFAULT_PART_ASSET } from "../../src/domain/entities/SupportRequest";

describe("resolvePartAsset", () => {
  it("uses the generic wording when nothing is configured", () => {
    expect(resolvePartAsset({})).toEqual(DEFAULT_PART_ASSET);
    expect(resolvePartAsset({ WIRE_SUPPORT_BOT_PART_ASSET_LABEL: "  ", WIRE_SUPPORT_BOT_PART_ASSET_QUESTION: "" }))
      .toEqual({ label: "Asset", question: "the item the part is for (for example a serial number)" });
  });

  it("reads the configured label and question, trimmed", () => {
    expect(resolvePartAsset({
      WIRE_SUPPORT_BOT_PART_ASSET_LABEL: " Device ",
      WIRE_SUPPORT_BOT_PART_ASSET_QUESTION: " the device (asset tag or room number) ",
    })).toEqual({ label: "Device", question: "the device (asset tag or room number)" });
  });

  it("keeps the default for the setting that is not configured", () => {
    expect(resolvePartAsset({ WIRE_SUPPORT_BOT_PART_ASSET_LABEL: "Device" }))
      .toEqual({ label: "Device", question: DEFAULT_PART_ASSET.question });
  });

  it("fails at startup for an overlong or multi-line value", () => {
    expect(() => resolvePartAsset({ WIRE_SUPPORT_BOT_PART_ASSET_LABEL: "x".repeat(41) })).toThrow(/WIRE_SUPPORT_BOT_PART_ASSET_LABEL.*40/);
    expect(() => resolvePartAsset({ WIRE_SUPPORT_BOT_PART_ASSET_QUESTION: "x".repeat(201) })).toThrow(/WIRE_SUPPORT_BOT_PART_ASSET_QUESTION.*200/);
    expect(() => resolvePartAsset({ WIRE_SUPPORT_BOT_PART_ASSET_QUESTION: "the room\nand the floor" })).toThrow(/one line/);
  });
});
