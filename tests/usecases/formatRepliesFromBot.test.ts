import { describe, it, expect } from "vitest";
import { formatReplies } from "../../src/application/usecases/jira/formatIssue";

const created = new Date("2026-09-25T09:00:00Z");

describe("formatReplies with the bot's own replies", () => {
  it("labels a reply sent from Wire as the team's", () => {
    expect(formatReplies([
      { author: "WireSupportBotApp", created, body: "Section 3 is attached.\n\nSent from Wire.", fromThisBot: true },
    ], "UTC")).toBe([
      "Latest reply on the ticket:",
      "",
      "**Your team (via Wire)**, 25 Sept, 09:00 UTC",
      "> Section 3 is attached.",
    ].join("\n"));
  });

  it("shows attachment markup as a readable line and still strips the footer before it", () => {
    expect(formatReplies([
      { author: "WireSupportBotApp", created, body: "Photo from Wire, sent by Alice. Sent from Wire.\n\n!IMG_0042.jpg|thumbnail!", fromThisBot: true },
      { author: "Dana", created, body: "Here is the manual [^manual.pdf]" },
    ], "UTC")).toBe([
      "Latest replies on the ticket:",
      "",
      "**Your team (via Wire)**, 25 Sept, 09:00 UTC",
      "> Photo from Wire, sent by Alice.",
      "> (attachment: IMG_0042.jpg)",
      "",
      "**Dana**, 25 Sept, 09:00 UTC",
      "> Here is the manual (attachment: manual.pdf)",
    ].join("\n"));
  });

  it("keeps the account name for other replies", () => {
    const expected = "Latest replies on the ticket:\n\n**Dana**, 25 Sept, 09:00 UTC\n> First\n\n**Lee**, 25 Sept, 09:00 UTC\n> Second";
    expect(formatReplies([
      { author: "Dana", created, body: "First" },
      { author: "Lee", created, body: "Second", fromThisBot: false },
    ], "UTC")).toBe(expected);
  });

  it("labels only the bot's reply in a mixed list", () => {
    const text = formatReplies([
      { author: "Dana", created, body: "Please send the form." },
      { author: "WireSupportBotApp", created, body: "Sent.", fromThisBot: true },
    ], "UTC");
    expect(text).toContain("**Dana**, 25 Sept, 09:00 UTC");
    expect(text).toContain("**Your team (via Wire)**, 25 Sept, 09:00 UTC");
    expect(text).not.toContain("WireSupportBotApp");
  });

  it("keeps every reply in one unbroken quote and starts each author line outside the quote", () => {
    // Regression: a blank line inside a reply produced an empty "> "
    // line, which ended the quote, and the next author line was pulled into the quote above.
    const text = formatReplies([
      { author: "WireSupportBotApp", created, body: "NDA is signed.\n\nSent from Wire.", fromThisBot: true },
      { author: "Dana", created, body: "Thanks.\n\nWe will countersign today." },
    ], "UTC");
    const lines = text.split("\n");
    expect(lines).not.toContain("> ");
    expect(lines).not.toContain(">");
    for (const author of ["**Your team (via Wire)**, 25 Sept, 09:00 UTC", "**Dana**, 25 Sept, 09:00 UTC"]) {
      expect(lines[lines.indexOf(author) - 1]).toBe("");
    }
    expect(text).toContain("> Thanks.\n> We will countersign today.");
    expect(text).not.toContain("Sent from Wire");
  });

  it("strips the footer from the bot's own replies", () => {
    expect(formatReplies([{ author: "WireSupportBotApp", created, body: "It still drops.\n\nSent from Wire.\n", fromThisBot: true }], "UTC"))
      .toBe("Latest reply on the ticket:\n\n**Your team (via Wire)**, 25 Sept, 09:00 UTC\n> It still drops.");
  });

  it("leaves a footer with anything before the full stop in the bot's own replies", () => {
    expect(formatReplies([{ author: "WireSupportBotApp", created, body: "It still drops.\n\nSent from Wire (SD-4).", fromThisBot: true }], "UTC"))
      .toContain("> Sent from Wire (SD-4).");
  });

  it("strips only a trailing footer", () => {
    expect(formatReplies([{ author: "WireSupportBotApp", created, body: "Sent from Wire. Then more text.", fromThisBot: true }], "UTC"))
      .toContain("> Sent from Wire. Then more text.");
  });

  it("keeps the footer text on replies that were not sent by the bot", () => {
    expect(formatReplies([{ author: "Dana", created, body: "Quoting: Sent from Wire." }], "UTC")).toContain("Sent from Wire.");
  });
});

