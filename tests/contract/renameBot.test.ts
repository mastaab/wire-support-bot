import { describe, it, expect } from "vitest";
import { renameBot, usableBotName } from "../../src/infrastructure/wire/renameBot";

const alice = { id: "user-1", domain: "example.com" };

describe("renameBot", () => {
  it("replaces every built-in name with the display name", () => {
    const out = renameBot("Use `@Wire Support Bot status of SD-6` or `@Wire Support Bot timezone <name>`.", "Acme-Support-Bot");
    expect(out.text).toBe("Use `@Acme-Support-Bot status of SD-6` or `@Acme-Support-Bot timezone <name>`.");
  });

  it("moves mentions after a replacement by the change in length and leaves earlier ones", () => {
    const text = "@Alice asked; send `@Wire Support Bot help`, @Alice.";
    const second = text.lastIndexOf("@Alice");
    const out = renameBot(text, "Desk", [{ userId: alice, offset: 0, length: 6 }, { userId: alice, offset: second, length: 6 }]);
    expect(out.text).toBe("@Alice asked; send `@Desk help`, @Alice.");
    expect(out.mentions.map((m) => out.text.slice(m.offset, m.offset + m.length))).toEqual(["@Alice", "@Alice"]);
  });

  it("drops a mention that overlaps a replaced name", () => {
    const out = renameBot("Hi Wire Support Bot", "Desk", [{ userId: alice, offset: 3, length: 13 }]);
    expect(out.mentions).toEqual([]);
  });

  it("leaves text without the built-in name, and the built-in name itself, unchanged", () => {
    expect(renameBot("Resolved SD-6.", "Desk")).toEqual({ text: "Resolved SD-6.", mentions: [] });
    expect(renameBot("@Wire Support Bot help", "Wire Support Bot").text).toBe("@Wire Support Bot help");
  });

  it("accepts only a one-line, bounded name without backticks", () => {
    expect(usableBotName("  Acme-Support-Bot ")).toBe("Acme-Support-Bot");
    expect(usableBotName("Desk `x`\nBot")).toBe("Desk x Bot");
    expect(usableBotName("")).toBeUndefined();
    expect(usableBotName("x".repeat(65))).toBeUndefined();
    expect(usableBotName(undefined)).toBeUndefined();
  });
});
