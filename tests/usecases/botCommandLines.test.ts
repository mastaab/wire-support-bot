import { describe, it, expect } from "vitest";
import { UNKNOWN_KEY_LINE, replaceInventedCommandLines } from "../../src/application/services/botCommandLines";
import { GENERIC_COMMAND_LINE, offerCommandLine } from "../../src/application/services/offers";

const SUPPORT_LINE = offerCommandLine({ kind: "support", requestKind: "fault", summary: "", description: "" });

describe("replaceInventedCommandLines", () => {
  it.each([
    "Use `@Wire Support Bot support: <problem>` to raise it.",
    "Send `@Wire Support Bot support: the air filter of truck 12 is clogged`.",
    "`@Wire Support Bot support requests` lists the open requests; `@Wire Support Bot my support requests` your own.",
    "`@Wire Support Bot status of SD-42` shows the live status.",
    "`@Wire Support Bot status of SD-NN` shows the live status.",
    "`@Wire Support Bot reply to SD-42: <text>` sends a reply.",
    "`@Wire Support Bot resolve SD-42` resolves it; `@Wire Support Bot resolve SD-42: <comment>` adds a comment first.",
    "`@Wire Support Bot close SD-4.`",
    "`@Wire Support Bot timezone Europe/Berlin` sets the timezone; `@Wire Support Bot timezone` shows it.",
    "Use @Wire Support Bot status of SD-4 to check it.",
    "Just mention @Wire Support Bot and describe the problem.",
    "I am @Wire Support Bot, the service-desk assistant.",
    "Nothing about commands here.",
  ])("keeps %j", (line) => {
    expect(replaceInventedCommandLines(line, "SD")).toBe(line);
  });

  it.each([
    ["To order it, send `@Wire Support Bot support part \"air filter\"`.", SUPPORT_LINE],
    ["Use @Wire Support Bot support part to order it.", SUPPORT_LINE],
    ["`@Wire Support Bot order air filter for truck 12`", SUPPORT_LINE],
    ["`@Wire Support Bot support:`", SUPPORT_LINE],
    ["`@Wire Support Bot reply SD-4 thanks`", offerCommandLine({ kind: "reply", issueKey: "SD-4", body: "" }, "SD")],
    ["`@Wire Support Bot resolve SD-4 now please`", offerCommandLine({ kind: "resolve", issueKey: "SD-4" }, "SD")],
    ["`@Wire Support Bot status of OTHER-4`", GENERIC_COMMAND_LINE],
    ["`@Wire Support Bot help`", GENERIC_COMMAND_LINE],
  ])("replaces the invented command in %j", (line, replacement) => {
    expect(replaceInventedCommandLines(line, "SD")).toBe(replacement);
  });

  it("keeps the other lines and does not repeat a replacement line", () => {
    const answer = [
      "I can help with that.",
      "Send `@Wire Support Bot support part \"filter\"`.",
      "Or `@Wire Support Bot order part filter`.",
      "`@Wire Support Bot support requests` lists what is open.",
    ].join("\n");
    expect(replaceInventedCommandLines(answer, "SD")).toBe([
      "I can help with that.",
      SUPPORT_LINE,
      "`@Wire Support Bot support requests` lists what is open.",
    ].join("\n"));
  });

  it("replaces a line with one invented command among valid ones", () => {
    expect(replaceInventedCommandLines("`@Wire Support Bot support requests` or `@Wire Support Bot list all`", "SD")).toBe(GENERIC_COMMAND_LINE);
  });
});

describe("replaceInventedCommandLines with the known request keys", () => {
  const known = new Set(["SD-4"]);

  it("keeps commands naming a known key, a placeholder or no key", () => {
    const answer = "`@Wire Support Bot status of SD-4`\n`@Wire Support Bot reply to SD-NN: <text>`\n`@Wire Support Bot support requests`";
    expect(replaceInventedCommandLines(answer, "SD", known)).toBe(answer);
  });

  it("replaces a supported command naming an unknown key, in any case", () => {
    expect(replaceInventedCommandLines("Send `@Wire Support Bot resolve sd-6: done`.", "SD", known)).toBe(UNKNOWN_KEY_LINE);
  });

  it("checks no keys without the set", () => {
    const line = "`@Wire Support Bot resolve SD-6`";
    expect(replaceInventedCommandLines(line, "SD")).toBe(line);
  });
});
