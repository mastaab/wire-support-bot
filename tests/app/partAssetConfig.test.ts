import { describe, expect, it } from "vitest";
import { PART_DELIVERY_LOCATIONS_MAX, PART_DELIVERY_LOCATION_MAX, resolvePartAsset, resolvePartDeliveryLocations } from "../../src/app/config";
import { DEFAULT_PART_ASSET } from "../../src/domain/entities/SupportRequest";

describe("resolvePartAsset", () => {
  it("uses the generic wording when nothing is configured", () => {
    expect(resolvePartAsset({})).toEqual(DEFAULT_PART_ASSET);
    expect(resolvePartAsset({ WIRE_SUPPORT_BOT_PART_ASSET_LABEL: "  ", WIRE_SUPPORT_BOT_PART_ASSET_QUESTION: "" }))
      .toEqual({ label: "Asset", question: "the item the part is for (for example a machine, vehicle or device)" });
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

describe("resolvePartDeliveryLocations", () => {
  const NAME = "WIRE_SUPPORT_BOT_PART_DELIVERY_LOCATIONS";

  it("is empty when unset, empty or blank, so the delivery location is asked in text", () => {
    expect(resolvePartDeliveryLocations({})).toEqual([]);
    expect(resolvePartDeliveryLocations({ [NAME]: "" })).toEqual([]);
    expect(resolvePartDeliveryLocations({ [NAME]: "   " })).toEqual([]);
  });

  it("reads the locations separated by semicolons, trimmed, in order", () => {
    expect(resolvePartDeliveryLocations({ [NAME]: " Depot north;Depot south ; Workshop 3 " })).toEqual(["Depot north", "Depot south", "Workshop 3"]);
    expect(resolvePartDeliveryLocations({ [NAME]: "Depot north" })).toEqual(["Depot north"]);
  });

  it(`accepts up to ${PART_DELIVERY_LOCATIONS_MAX} locations of up to ${PART_DELIVERY_LOCATION_MAX} characters`, () => {
    const five = ["A", "B", "C", "D", "x".repeat(PART_DELIVERY_LOCATION_MAX)];
    expect(resolvePartDeliveryLocations({ [NAME]: five.join(";") })).toEqual(five);
  });

  it.each([
    ["too many locations", "A;B;C;D;E;F"],
    ["an over-long location", `Depot north;${"x".repeat(PART_DELIVERY_LOCATION_MAX + 1)}`],
    ["an empty entry", "Depot north;;Depot south"],
    ["a trailing separator", "Depot north;"],
    ["a location spanning lines", "Depot\nnorth;Depot south"],
    ["a tab", "Depot\tnorth"],
    ["a repeated location", "Depot north;depot NORTH"],
    ["Other, which the bot adds itself", "Depot north;other"],
  ])("fails at startup for %s", (_label, value) => {
    expect(() => resolvePartDeliveryLocations({ [NAME]: value })).toThrow(/WIRE_SUPPORT_BOT_PART_DELIVERY_LOCATIONS must list up to 5 different locations separated by ";"/);
  });
});
