import { describe, it, expect } from "vitest";
import { welcomeText } from "../../src/infrastructure/wire/welcomeText";

describe("welcomeText", () => {
  it("leads with the service desk, offers from ordinary messages and desk updates when passive help and the watch are on", () => {
    const text = welcomeText({ projectKey: "SD", passive: true, watching: true });
    expect(text.startsWith("I'm Wire Support Bot, and I connect this channel with the service desk.")).toBe(true);
    expect(text).toContain("Tell me about a fault, a question or a part you need, and I'll offer to raise it with the service desk; nothing is sent without your yes.");
    expect(text).toContain("`status of SD-N`");
    expect(text).toContain("Replies and status changes from the service desk appear here.");
    expect(text).toContain("`timezone <name>`");
  });

  it("asks for a mention and gives the direct command without passive help, and leaves out updates without the watch", () => {
    const text = welcomeText({ projectKey: "SD", passive: false, watching: false });
    expect(text).toContain("Mention me and tell me about a fault");
    expect(text).toContain("`@Wire Support Bot support: <problem>` raises it at once.");
    expect(text).not.toContain("appear here");
  });

  it("never says the service desk is not connected", () => {
    for (const passive of [false, true]) {
      expect(welcomeText({ projectKey: "SD", passive, watching: false })).not.toMatch(/not connected/i);
    }
  });

  it("mentions no commands the bot does not have", () => {
    for (const text of [welcomeText({ projectKey: "SD", passive: false, watching: false }), welcomeText({ projectKey: "SD", passive: true, watching: true })]) {
      expect(text).not.toMatch(/decision|action:|pause|secure mode|resume|context:/i);
    }
  });
});
