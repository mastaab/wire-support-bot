import { describe, expect, it } from "vitest";
import { hasMultipleCommands } from "../../src/infrastructure/wire/hasMultipleCommands";

const botId = { id: "bot", domain: "wire.test" };

describe("combined-command guard", () => {
  it.each([
    "status of SD-42\nsupport requests",
    "support requests; status of SD-4",
    "resolve SD-6; reply to SD-7: fixed",
    "reply to SD-6: fixed\nsupport requests",
    "1. `status of SD-1`\n2. `status of SD-2`",
    "@Wire Support Bot support requests\n@Wire Support Bot status of SD-3",
    "status of SD-1 and then resolve SD-1",
  ])("recognizes separate support commands: %s", text => {
    expect(hasMultipleCommands(text, [], botId, "SD")).toBe(true);
  });

  it.each([
    "support: VPN drops\nit fails when I resolve DNS names",
    "support: Printer broken and my support requests page is blank",
    "support: VPN drops\nstatus of SD-3",
    "resolve SD-6: fixed\nstatus of SD-3",
    "status of OPS-12\nstatus of OPS-13",
    "Examples:\nstatus of SD-1\nstatus of SD-2",
    "```\nstatus of SD-1\nstatus of SD-2\n```",
    "> status of SD-1\n> status of SD-2",
    "We should check the printer and then tell the desk",
  ])("leaves a single command or non-request alone: %s", text => {
    expect(hasMultipleCommands(text, [], botId, "SD")).toBe(false);
  });

  it("refuses nothing without a configured project", () => {
    expect(hasMultipleCommands("status of SD-42\nsupport requests", [], botId)).toBe(false);
    expect(hasMultipleCommands("status of SD-42\nsupport requests", [], botId, "not a key")).toBe(false);
  });

  it("masks command-like person labels using their qualified structured identity", () => {
    const name = "@Someone; support requests";
    const text = `status of SD-1 for ${name}`;
    const mention = { offset: text.indexOf(name), length: name.length, userId: { id: "person", domain: "wire.test" } };
    expect(hasMultipleCommands(text, [mention], botId, "SD")).toBe(false);
  });

  it("does not remove a matching bot ID from another domain", () => {
    const name = "@Someone";
    const text = `status of SD-1 ${name} support requests`;
    const mention = { offset: text.indexOf(name), length: name.length, userId: { id: "bot", domain: "other.test" } };
    expect(hasMultipleCommands(text, [mention], botId, "SD")).toBe(false);
  });

  it("splits at a real bot mention", () => {
    const label = "@Bot";
    const text = `status of SD-1 ${label} support requests`;
    const mention = { offset: text.indexOf(label), length: label.length, userId: botId };
    expect(hasMultipleCommands(text, [mention], botId, "SD")).toBe(true);
  });

  it("ignores malformed mention spans", () => {
    expect(hasMultipleCommands("status of SD-1\nsupport requests", [{ offset: -1, length: 4, userId: botId }], botId, "SD")).toBe(false);
  });
});
