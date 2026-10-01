import { describe, it, expect } from "vitest";
import { statedPartDetails } from "../../src/application/services/partDetails";

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
