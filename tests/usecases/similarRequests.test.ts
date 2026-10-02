import { describe, it, expect } from "vitest";
import { namesOtherIdentifier, rankSimilarRequests } from "../../src/application/services/similarRequests";

const request = (key: string, summary: string) => ({ key, summary });
const keys = (summary: string, requests: Array<{ key: string; summary: string }>) => rankSimilarRequests(summary, requests).map((r) => r.key);

describe("rankSimilarRequests", () => {
  it("does not list another truck's request for a truck 12 problem", () => {
    expect(keys("Truck 12 makes a grinding noise when braking", [request("SD-1", "Truck 13 is broken")])).toEqual([]);
  });

  it("lists a request with the same identifier", () => {
    expect(keys("Truck 12 makes a grinding noise when braking", [request("SD-1", "Truck 12 brakes squeal")])).toEqual(["SD-1"]);
  });

  it("matches plural and singular forms", () => {
    expect(keys("The brakes of the van squeal", [request("SD-1", "Van brake squeals")])).toEqual(["SD-1"]);
    expect(keys("Printers on floor 2 jam", [request("SD-2", "The printer jams")])).toEqual(["SD-2"]);
  });

  it("ignores generic words", () => {
    expect(keys("The coffee machine is broken again, not working", [request("SD-1", "VPN not working, broken again, new issue")])).toEqual([]);
  });

  it("ranks by shared distinctive words, numbers strongest, and drops one sharing only a word common to most", () => {
    const requests = [
      request("SD-1", "Laptop screen flickers"),
      request("SD-2", "Room 4 laptop screen flickers after the update"),
      request("SD-3", "Laptop keyboard sticks"),
      request("SD-4", "Room 4 projector"),
    ];
    expect(keys("Laptop screen flickers in room 4", requests)).toEqual(["SD-2", "SD-4", "SD-1"]);
  });

  it("weights a word found in most requests weakly, so it alone does not tie them", () => {
    const requests = [
      request("SD-1", "Truck tire is flat"),
      request("SD-2", "Truck oil leak"),
      request("SD-3", "Truck mirror cracked"),
      request("SD-4", "Truck windshield wiper torn"),
    ];
    expect(keys("Truck brakes grind", requests)).toEqual([]);
    expect(keys("Truck mirror is loose", requests)).toEqual(["SD-3"]);
  });

  it("keeps the given order for equal scores", () => {
    expect(keys("Scanner jams", [request("SD-9", "Scanner is slow"), request("SD-8", "Scanner beeps")])).toEqual(["SD-9", "SD-8"]);
  });

  it("keeps a request that names the same identifier among others", () => {
    expect(keys("Truck 12 grinding brakes", [request("SD-1", "Truck 12 and truck 13 need brake checks")])).toEqual(["SD-1"]);
  });
});

describe("namesOtherIdentifier", () => {
  it.each([
    ["Truck 12 grinds", "Truck 13 is broken", true],
    ["Printer 7 jams", "printer 8 is out of toner", true],
    ["Printers 7 jam", "printer 8 jams", true],
    ["Truck 12 grinds", "truck 12 brake noise", false],
    ["Truck grinds", "Truck 13 is broken", false],
    ["Truck 12 grinds", "Printer 13 jams", false],
    ["VPN drops every 10 minutes", "VPN drops every 5 minutes", false],
  ])("%j and %j: %s", (a, b, expected) => {
    expect(namesOtherIdentifier(a, b)).toBe(expected);
  });
});
