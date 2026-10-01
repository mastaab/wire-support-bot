import { describe, it, expect } from "vitest";
import { cliButtonClick, createCliOutbound } from "../../src/app/cliOutbound";
import type { QualifiedId } from "../../src/domain/ids/QualifiedId";

const convId: QualifiedId = { id: "cli-channel", domain: "cli.local" };
const alice: QualifiedId = { id: "alice", domain: "cli.local" };
const bob: QualifiedId = { id: "bob", domain: "cli.local" };
const members = [{ name: "Alice", id: alice }, { name: "Bob", id: bob }];

function setup() {
  const out: string[] = [];
  const cli = createCliOutbound(members, (text) => out.push(text));
  return { out, cli };
}

describe("CLI fallback for buttons", () => {
  it("prints a button question with its options numbered under it and returns a reference", async () => {
    const { out, cli } = setup();
    const ref = await cli.wireOutbound.sendCompositePrompt(convId, "Shall I resolve **SD-6** (yes or no)?", [
      { id: "offer-1234:0", label: "Yes" }, { id: "offer-1234:1", label: "No" },
    ]);
    expect(out).toEqual(["[Wire Support Bot] Shall I resolve **SD-6** (yes or no)?\n  1. Yes\n  2. No\n"]);
    expect(ref?.messageId).toMatch(/^cli-/);
    expect(cli.latestPrompt()).toEqual({ messageId: ref!.messageId, buttons: [{ id: "offer-1234:0", label: "Yes" }, { id: "offer-1234:1", label: "No" }] });
  });

  it("prints plain text as before and shows no confirmation", async () => {
    const { out, cli } = setup();
    await cli.wireOutbound.sendPlainText(convId, "Understood, I won't.");
    await cli.wireOutbound.sendButtonConfirmation(convId, "cli-1", "offer-1234:0");
    expect(out).toEqual(["[Wire Support Bot] Understood, I won't.\n"]);
    expect(cli.latestPrompt()).toBeUndefined();
  });

  it("turns a bare option number into a click on the latest question by the sender", async () => {
    const { cli } = setup();
    const ref = await cli.wireOutbound.sendCompositePrompt(convId, "Which request (SD-40, SD-41 or cancel)?", [
      { id: "offer-1234:0", label: "SD-40" }, { id: "offer-1234:1", label: "SD-41" }, { id: "offer-1234:2", label: "Cancel" },
    ]);
    expect(cliButtonClick(" 2 ", bob, convId, cli.latestPrompt())).toMatchObject({
      type: "composite_button_action", conversationId: convId, sender: bob, buttonId: "offer-1234:1", referenceMessageId: ref!.messageId,
    });
  });

  it("leaves any other line as text, so text answers work as in Wire", async () => {
    const { cli } = setup();
    expect(cliButtonClick("1", alice, convId, undefined)).toBeNull();
    await cli.wireOutbound.sendCompositePrompt(convId, "Shall I? (yes or no)?", [{ id: "offer-1234:0", label: "Yes" }, { id: "offer-1234:1", label: "No" }]);
    for (const line of ["yes", "SD-41", "0", "3", "1 please", "12a"]) expect(cliButtonClick(line, alice, convId, cli.latestPrompt())).toBeNull();
  });

  it("looks up the simulated members' names", async () => {
    const { cli } = setup();
    expect(await cli.wireOutbound.getUserProfile(bob)).toEqual({ id: bob, name: "Bob" });
    expect(await cli.wireOutbound.getUserProfile({ id: "zed", domain: "cli.local" })).toBeNull();
  });
});
