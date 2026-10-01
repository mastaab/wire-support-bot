import { describe, it, expect } from "vitest";
import {
  addToChoice, cancelChoice, choiceHint, decisionAt, doNotAttachChoice, keyChoice, matchChoice, newOfferId, offerButtons,
  parseOfferButtonId, raiseNewChoice,
} from "../../src/application/services/offerButtons";
import type { OfferChoice, OfferCommand } from "../../src/application/ports/PendingOfferPort";

const SUPPORT: OfferCommand = { kind: "support", requestKind: "fault", summary: "Printer jams", description: "Printer jams." };
const reply = (key: string): OfferCommand => ({ kind: "reply", issueKey: key, body: "Printer jams." });

const NEW_OR_EXISTING: OfferChoice[] = [addToChoice("SD-38", reply("SD-38")), addToChoice("SD-40", reply("SD-40")), raiseNewChoice(SUPPORT), cancelChoice()];

describe("offer buttons", () => {
  it("gives a yes-or-no offer [Yes] [No] with opaque IDs of the offer and the index", () => {
    expect(offerButtons("offer-1234", undefined)).toEqual([{ id: "offer-1234:0", label: "Yes" }, { id: "offer-1234:1", label: "No" }]);
  });

  it("gives a choice one button per option, in order, carrying no key or text", () => {
    const buttons = offerButtons("offer-1234", NEW_OR_EXISTING);
    expect(buttons.map((b) => b.label)).toEqual(["Add to SD-38", "Add to SD-40", "Raise new request", "Cancel"]);
    expect(buttons.map((b) => b.id)).toEqual(["offer-1234:0", "offer-1234:1", "offer-1234:2", "offer-1234:3"]);
  });

  it("makes fresh offer IDs that parse back from a button ID", () => {
    const id = newOfferId();
    expect(id).not.toBe(newOfferId());
    expect(parseOfferButtonId(`${id}:2`)).toEqual({ offerId: id, index: 2 });
  });

  it.each(["", "yes", "SD-38", "offer-1234", "offer-1234:", ":1", "offer-1234:x", "offer-1234:123", "short:1", "offer 1234:1"])(
    "rejects %j as a button ID", (buttonId) => {
      expect(parseOfferButtonId(buttonId)).toBeNull();
    },
  );

  it("maps a yes-or-no index to running the offer or declining it, and nothing else", () => {
    const offer = { command: SUPPORT };
    expect(decisionAt(offer, 0)).toEqual({ command: SUPPORT });
    expect(decisionAt(offer, 1)).toEqual({ command: null });
    expect(decisionAt(offer, 2)).toBeUndefined();
    expect(decisionAt(offer, -1)).toBeUndefined();
  });

  it("maps a choice index to its option's command, and an index beyond the options to nothing", () => {
    const offer = { command: SUPPORT, choices: NEW_OR_EXISTING };
    expect(decisionAt(offer, 1)).toEqual({ command: reply("SD-40") });
    expect(decisionAt(offer, 2)).toEqual({ command: SUPPORT });
    expect(decisionAt(offer, 3)).toEqual({ command: null });
    expect(decisionAt(offer, 4)).toBeUndefined();
  });
});

describe("matchChoice", () => {
  it.each<[string, number]>([
    ["SD-40", 1], ["sd-38", 0], ["**SD-40**", 1], ["`SD-38`.", 0], ["add to SD-40", 1], ["Add to SD-38", 0],
    ["new", 2], ["New request", 2], ["raise a new request please", 2], ["a new one", 2],
    ["cancel", 3], ["no", 3], ["No thanks", 3], ["neither", 3],
    ["1", 0], ["2.", 1], ["4", 3], ["(3)", 2],
  ])("picks option %j", (text, index) => {
    expect(matchChoice(NEW_OR_EXISTING, text)).toBe(index);
  });

  it.each(["", "yes", "ok", "5", "0", "SD-41", "SD-40 please and also SD-38", "add it", "the second one", "maybe new?"])(
    "picks nothing for %j", (text) => {
      expect(matchChoice(NEW_OR_EXISTING, text)).toBeNull();
    },
  );

  it("accepts the file wording for declining a file", () => {
    const choices = [keyChoice("SD-40", reply("SD-40")), keyChoice("SD-41", reply("SD-41")), doNotAttachChoice()];
    for (const text of ["do not attach", "Don't attach", "no", "cancel", "3"]) expect(matchChoice(choices, text)).toBe(2);
    expect(matchChoice(choices, "SD-41")).toBe(1);
  });
});

describe("choiceHint", () => {
  it("names the text answers with keys in upper case", () => {
    expect(choiceHint(NEW_OR_EXISTING)).toBe("SD-38, SD-40, new or cancel");
    expect(choiceHint([keyChoice("SD-40", reply("SD-40")), doNotAttachChoice()])).toBe("SD-40 or no");
  });
});
