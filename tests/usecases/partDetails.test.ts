import { describe, it, expect } from "vitest";
import { fillMissingPartDetails, isPartPlaceholder, statedPartDetails } from "../../src/application/services/partDetails";
import type { OfferCommand } from "../../src/application/services/offers";

describe("statedPartDetails", () => {
  it("drops a quantity the requester did not state, such as 1 for \"a new tray\"", () => {
    expect(statedPartDetails({ asset: "printer 7", part: "paper tray", quantity: "1" }, "we need a new paper tray for printer 7"))
      .toEqual({ asset: "printer 7", part: "paper tray" });
  });

  it.each([
    ["two, deliver to depot north", "2"],
    ["two, deliver to depot north", "two"],
    ["3 please", "3"],
    ["a pair of wiper blades", "2"],
    ["zwei Stück, bitte", "2"],
  ])("keeps a quantity stated in %j as %j", (message, quantity) => {
    expect(statedPartDetails({ quantity }, message)).toEqual({ quantity });
  });

  it("does not take the asset's number for a quantity", () => {
    expect(statedPartDetails({ asset: "printer 7", quantity: "7" }, "a new tray for printer 7")).toEqual({ asset: "printer 7" });
  });

  it("drops a quantity that is not a number, and a location the message does not mention", () => {
    expect(statedPartDetails({ quantity: "some", deliverTo: "Hamburg" }, "some mirrors to depot north")).toEqual({});
  });

  it("keeps asset, part and delivery location that share a word with the message", () => {
    expect(statedPartDetails({ asset: "printer 12", part: "toner cartridges", deliverTo: "Depot North" }, "toner cartridges for printer 12 to the north depot"))
      .toEqual({ asset: "printer 12", part: "toner cartridges", deliverTo: "Depot North" });
  });
});

describe("statedPartDetails: every significant word must be stated", () => {
  it("drops a delivery location the model made up from one shared word", () => {
    expect(statedPartDetails({ asset: "truck 12", part: "air filter", deliverTo: "the truck location" }, "please order an air filter for truck 12"))
      .toEqual({ asset: "truck 12", part: "air filter" });
  });

  it("keeps values whose words are all stated, ignoring filler words", () => {
    expect(statedPartDetails({ deliverTo: "to workshop 3" }, "deliver them to workshop 3")).toEqual({ deliverTo: "to workshop 3" });
    expect(statedPartDetails({ deliverTo: "the depot north" }, "depot north please")).toEqual({ deliverTo: "the depot north" });
  });

  it("allows a plural s either way", () => {
    expect(statedPartDetails({ part: "left mirror" }, "we need two new left mirrors")).toEqual({ part: "left mirror" });
    expect(statedPartDetails({ part: "cables" }, "one cable")).toEqual({ part: "cables" });
  });

  it("drops a value made of filler words only, or with any unstated word", () => {
    expect(statedPartDetails({ deliverTo: "the" }, "the printer is broken")).toEqual({});
    expect(statedPartDetails({ part: "replacement toner cartridge" }, "we need toner")).toEqual({});
  });

  it("drops template slots and placeholder words even when the message has their words", () => {
    expect(statedPartDetails({ part: "<part>", quantity: "[quantity]", deliverTo: "{deliverTo}", asset: "unknown" }, "order a part, any quantity, deliver to the unknown depot"))
      .toEqual({});
  });
});

describe("isPartPlaceholder", () => {
  it.each(["<part name or number>", "[delivery location]", "{quantity}", " N/A ", "unknown", "TBD"])("treats %j as a placeholder", (value) => {
    expect(isPartPlaceholder(value)).toBe(true);
  });

  it.each(["air filter", "Depot <North>", "truck 12"])("treats %j as a value", (value) => {
    expect(isPartPlaceholder(value)).toBe(false);
  });
});

describe("fillMissingPartDetails", () => {
  const order = (part?: Record<string, string>): Extract<OfferCommand, { kind: "support" }> =>
    ({ kind: "support", requestKind: "part", summary: "Air filter", description: "Air filter.", ...(part ? { part } : {}) });
  const MESSAGE = "please order two air filters for truck 12 to Depot North";

  it("merges only stated values into the missing essentials", async () => {
    const extractor = { extractPartDetails: async () => ({ asset: "truck 7", part: "air filters", quantity: "2", deliverTo: "Depot South" }) };
    expect((await fillMissingPartDetails(order({ asset: "truck 12" }), MESSAGE, extractor)).part)
      .toEqual({ asset: "truck 12", part: "air filters", quantity: "2" });
  });

  it("returns the command unchanged without an extractor, for another kind and for a complete order", async () => {
    const extractPartDetails = async () => { throw new Error("not called"); };
    const fault: OfferCommand = { kind: "support", requestKind: "fault", summary: "s", description: "d" };
    const complete = order({ asset: "truck 12", part: "air filters", quantity: "2", deliverTo: "Depot North" });
    expect(await fillMissingPartDetails(order(), MESSAGE, undefined)).toEqual(order());
    expect(await fillMissingPartDetails(fault, MESSAGE, { extractPartDetails })).toBe(fault);
    expect(await fillMissingPartDetails(complete, MESSAGE, { extractPartDetails })).toBe(complete);
  });

  it("reports a failed extraction and returns the command unchanged; a non-object result changes nothing", async () => {
    const errors: unknown[] = [];
    const command = order({ asset: "truck 12" });
    expect(await fillMissingPartDetails(command, MESSAGE, { extractPartDetails: async () => { throw new TypeError("x"); } }, (err) => errors.push(err))).toBe(command);
    expect(errors).toHaveLength(1);
    expect(await fillMissingPartDetails(command, MESSAGE, { extractPartDetails: async () => null as never })).toBe(command);
  });
});
