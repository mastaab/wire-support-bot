import { describe, expect, it } from "vitest";
import {
  OFFER_DESCRIPTION_MAX, REPLY_BODY_MAX, formatResolveQuestion, offerCommandLine, parseOfferMarker,
} from "../../src/application/services/offers";
import { PART_DETAIL_MAX, SUPPORT_DESCRIPTION_MAX, SUPPORT_SUMMARY_MAX } from "../../src/domain/entities/SupportRequest";

const marker = (value: unknown): string => `OFFER: ${JSON.stringify(value)}`;

describe("parseOfferMarker", () => {
  it("separates a support offer on the last line from the answer", () => {
    expect(parseOfferMarker(`I can raise that.\n${marker({ kind: "support", summary: "VPN drops", description: "My VPN drops every ten minutes." })}`)).toEqual({
      text: "I can raise that.",
      command: { kind: "support", requestKind: "fault", summary: "VPN drops", description: "My VPN drops every ten minutes." },
      hadMarker: true,
    });
  });

  it("collapses whitespace in the summary to one line and trims the description", () => {
    const command = parseOfferMarker(marker({ kind: "support", summary: "  VPN \n drops\tagain ", description: "  Line one.\nLine two.  " })).command;
    expect(command).toEqual({ kind: "support", requestKind: "fault", summary: "VPN drops again", description: "Line one.\nLine two." });
  });

  it("accepts reply and resolve offers and normalizes keys", () => {
    expect(parseOfferMarker(`ok\n${marker({ kind: "reply", issueKey: "sd-4", body: "  The draft is attached.  " })}`).command)
      .toEqual({ kind: "reply", issueKey: "SD-4", body: "The draft is attached." });
    expect(parseOfferMarker(`ok\n${marker({ kind: "resolve", issueKey: " sd-6 " })}`).command).toEqual({ kind: "resolve", issueKey: "SD-6" });
  });

  it("accepts a summary and description at their limits", () => {
    const summary = "s".repeat(SUPPORT_SUMMARY_MAX);
    const description = "d".repeat(OFFER_DESCRIPTION_MAX);
    expect(parseOfferMarker(marker({ kind: "support", summary, description })).command).toEqual({ kind: "support", requestKind: "fault", summary, description });
    const body = "b".repeat(REPLY_BODY_MAX);
    expect(parseOfferMarker(marker({ kind: "reply", issueKey: "SD-4", body })).command).toEqual({ kind: "reply", issueKey: "SD-4", body });
  });

  it.each([
    ["bold prefix", (json: string) => `**OFFER**: ${json}`],
    ["bold prefix with colon", (json: string) => `**OFFER:** ${json}`],
    ["whole line in code marks", (json: string) => `\`OFFER: ${json}\``],
    ["code prefix", (json: string) => `\`OFFER:\` ${json}`],
    ["list bullet", (json: string) => `- OFFER: ${json}`],
    ["code fence", (json: string) => `\`\`\`json\nOFFER: ${json}\n\`\`\``],
  ])("honors and hides a marker with Markdown decoration: %s", (_label, decorate) => {
    const json = JSON.stringify({ kind: "support", requestKind: "fault", summary: "Rollers squeal", description: "The rollers on printer 12 squeal" });
    expect(parseOfferMarker(`I can raise that.\n\n${decorate(json)}\n`)).toEqual({
      text: "I can raise that.",
      command: { kind: "support", requestKind: "fault", summary: "Rollers squeal", description: "The rollers on printer 12 squeal" },
      hadMarker: true,
    });
  });

  it("hides a decorated marker in the middle of the answer without honoring it", () => {
    const json = JSON.stringify({ kind: "support", summary: "Rollers squeal", description: "Squeal" });
    expect(parseOfferMarker(`Before.\n**OFFER**: ${json}\nAfter.`)).toEqual({ text: "Before.\nAfter.", command: null, hadMarker: true });
  });

  it("does not take prose that starts with a capitalized Offer for a marker", () => {
    expect(parseOfferMarker("Offer: I can raise this with the service desk.")).toEqual({
      text: "Offer: I can raise this with the service desk.", command: null, hadMarker: false,
    });
  });

  it("ignores trailing blank lines after the marker", () => {
    expect(parseOfferMarker(`ok\n${marker({ kind: "resolve", issueKey: "SD-1" })}\n\n  \n`).command).toEqual({ kind: "resolve", issueKey: "SD-1" });
  });

  it("returns the answer unchanged when there is no marker", () => {
    expect(parseOfferMarker("Nothing to offer.")).toEqual({ text: "Nothing to offer.", command: null, hadMarker: false });
  });

  it.each([
    ["malformed JSON", "OFFER: {kind: support}"],
    ["an array", "OFFER: []"],
    ["an unknown kind", marker({ kind: "delete", issueKey: "SD-1" })],
    ["an unknown raise kind", marker({ kind: "raise", actionId: "ACT-0010" })],
    ["an unknown close kind", marker({ kind: "close", actionId: "ACT-0010" })],
    ["a support offer without a summary", marker({ kind: "support", summary: "   ", description: "It breaks." })],
    ["a support offer without a description", marker({ kind: "support", summary: "It breaks", description: " " })],
    ["a support offer with a non-string summary", marker({ kind: "support", summary: 42, description: "It breaks." })],
    ["a summary that is too long", marker({ kind: "support", summary: "s".repeat(SUPPORT_SUMMARY_MAX + 1), description: "It breaks." })],
    ["a description that is too long for an offer", marker({ kind: "support", summary: "It breaks", description: "d".repeat(OFFER_DESCRIPTION_MAX + 1) })],
    ["a description at the command limit", marker({ kind: "support", summary: "It breaks", description: "d".repeat(SUPPORT_DESCRIPTION_MAX) })],
    ["a reply without a body", marker({ kind: "reply", issueKey: "SD-4", body: "   " })],
    ["a reply with a malformed key", marker({ kind: "reply", issueKey: "SD4", body: "hi" })],
    ["a reply that is too long", marker({ kind: "reply", issueKey: "SD-4", body: "x".repeat(REPLY_BODY_MAX + 1) })],
    ["a resolve without a key", marker({ kind: "resolve" })],
    ["a resolve with an action ID", marker({ kind: "resolve", issueKey: "ACT0010" })],
    ["a resolve with a non-string comment", marker({ kind: "resolve", issueKey: "SD-6", comment: 42 })],
    ["a resolve with a comment that is too long", marker({ kind: "resolve", issueKey: "SD-6", comment: "c".repeat(REPLY_BODY_MAX + 1) })],
  ])("honors no command for %s, and still hides the marker", (_label, line) => {
    expect(parseOfferMarker(`Answer.\n${line}`)).toEqual({ text: "Answer.", command: null, hadMarker: true });
  });

  it("only honors a marker on the last line, but never shows one anywhere", () => {
    expect(parseOfferMarker(`${marker({ kind: "resolve", issueKey: "SD-1" })}\nMore text after it.`)).toEqual({
      text: "More text after it.",
      command: null,
      hadMarker: true,
    });
  });

  it("parses a marker spread over several lines and hides all of it", () => {
    const answer = 'SD-4 is open.\nOFFER: {\n  "kind": "reply",\n  "issueKey": "SD-4",\n  "body": "The draft is attached."\n}';
    expect(parseOfferMarker(answer)).toEqual({
      text: "SD-4 is open.",
      command: { kind: "reply", issueKey: "SD-4", body: "The draft is attached." },
      hadMarker: true,
    });
  });

  it("hides an invalid multi-line marker completely, including its drafted text", () => {
    const answer = 'Answer.\nOFFER: {\n  "kind": "support",\n  "description": "SECRET DRAFT"';
    const parsed = parseOfferMarker(answer);
    expect(parsed).toEqual({ text: "Answer.", command: null, hadMarker: true });
    expect(parsed.text).not.toContain("SECRET DRAFT");
  });

  it("hides a multi-line marker in the middle of the answer without honoring it", () => {
    const answer = 'Before.\nOFFER: {\n  "kind": "resolve",\n  "issueKey": "SD-1"\n}\nAfter the marker.';
    expect(parseOfferMarker(answer)).toEqual({ text: "Before.\nAfter the marker.", command: null, hadMarker: true });
  });
});

describe("parseOfferMarker: resolve with a closing comment", () => {
  it("keeps a trimmed comment, at most at the reply limit", () => {
    expect(parseOfferMarker(marker({ kind: "resolve", issueKey: "sd-8", comment: "  The keyboard works again.\nThanks!  " })).command)
      .toEqual({ kind: "resolve", issueKey: "SD-8", comment: "The keyboard works again.\nThanks!" });
    const comment = "c".repeat(REPLY_BODY_MAX);
    expect(parseOfferMarker(marker({ kind: "resolve", issueKey: "SD-8", comment })).command).toEqual({ kind: "resolve", issueKey: "SD-8", comment });
  });

  it("leaves the comment out when the marker has none", () => {
    expect(parseOfferMarker(marker({ kind: "resolve", issueKey: "SD-8" })).command).toEqual({ kind: "resolve", issueKey: "SD-8" });
    expect(parseOfferMarker(marker({ kind: "resolve", issueKey: "SD-8", comment: null })).command).toEqual({ kind: "resolve", issueKey: "SD-8" });
  });

  it("treats an empty or whitespace-only comment as absent", () => {
    expect(parseOfferMarker(marker({ kind: "resolve", issueKey: "SD-8", comment: "" })).command).toEqual({ kind: "resolve", issueKey: "SD-8" });
    expect(parseOfferMarker(marker({ kind: "resolve", issueKey: "SD-8", comment: "  \n " })).command).toEqual({ kind: "resolve", issueKey: "SD-8" });
  });
});

describe("formatResolveQuestion", () => {
  it("asks without a comment as before", () => {
    expect(formatResolveQuestion("SD-8", "Keyboard  broken\nagain")).toBe('Shall I resolve **SD-8** "Keyboard broken again" with the service desk (yes or no)?');
  });

  it("quotes every non-empty line of the comment", () => {
    expect(formatResolveQuestion("SD-8", "Keyboard broken", "The keyboard works again.\n\n  Thanks for the quick help. "))
      .toBe('Shall I resolve **SD-8** "Keyboard broken" with the service desk and add this comment?\n> The keyboard works again.\n> Thanks for the quick help.\n\n(yes or no)?');
  });
});

describe("offerCommandLine for resolve", () => {
  it("gives the comment form when the offer carried a comment", () => {
    expect(offerCommandLine({ kind: "resolve", issueKey: "SD-8" })).toBe("To resolve it, use `@Wire Support Bot resolve SD-8`.");
    expect(offerCommandLine({ kind: "resolve", issueKey: "SD-8", comment: "Works again." }))
      .toBe("To resolve it with a comment, use `@Wire Support Bot resolve SD-8: <comment>`.");
  });
});

describe("parseOfferMarker: request kinds and part details", () => {
  const base = { kind: "support", summary: "Toner cartridges empty", description: "Need new toner cartridges." };

  it.each(["question", "part", "fault"])("keeps the request kind %s", (requestKind) => {
    expect(parseOfferMarker(marker({ ...base, requestKind })).command).toEqual({
      kind: "support", requestKind, summary: "Toner cartridges empty", description: "Need new toner cartridges.",
    });
  });

  it.each([
    ["absent", undefined],
    ["unknown", "invoice"],
    ["not a string", 3],
  ])("defaults the request kind to fault when it is %s", (_label, requestKind) => {
    expect(parseOfferMarker(marker({ ...base, requestKind })).command).toEqual({
      kind: "support", requestKind: "fault", summary: "Toner cartridges empty", description: "Need new toner cartridges.",
    });
  });

  it("keeps the part details of a part order, trimmed and collapsed to one line", () => {
    const part = { asset: "  printer\n 17 ", part: "toner\tcartridges", quantity: " 2 ", deliverTo: "Depot   North" };
    expect(parseOfferMarker(marker({ ...base, requestKind: "part", part })).command).toEqual({
      kind: "support", requestKind: "part", summary: "Toner cartridges empty", description: "Need new toner cartridges.",
      part: { asset: "printer 17", part: "toner cartridges", quantity: "2", deliverTo: "Depot North" },
    });
  });

  it("reads the request kind regardless of letter case", () => {
    expect(parseOfferMarker(marker({ ...base, requestKind: " Part ", part: { asset: "printer 17" } })).command).toMatchObject({
      requestKind: "part", part: { asset: "printer 17" },
    });
  });

  it("leaves out empty, non-text, overlong and unknown part details, and takes a number as text", () => {
    const part = { asset: "   ", part: { name: "tray" }, quantity: 2, deliverTo: "d".repeat(PART_DETAIL_MAX + 1), color: "red" };
    expect(parseOfferMarker(marker({ ...base, requestKind: "part", part })).command).toEqual({
      kind: "support", requestKind: "part", summary: "Toner cartridges empty", description: "Need new toner cartridges.",
      part: { quantity: "2" },
    });
  });

  it.each([
    ["no part object", undefined],
    ["an array", ["printer 17"]],
    ["a string", "printer 17"],
    ["only empty details", { asset: " ", part: "" }],
  ])("keeps a part order without details when it has %s", (_label, part) => {
    expect(parseOfferMarker(marker({ ...base, requestKind: "part", part })).command).toEqual({
      kind: "support", requestKind: "part", summary: "Toner cartridges empty", description: "Need new toner cartridges.",
    });
  });

  it("ignores part details on other kinds", () => {
    expect(parseOfferMarker(marker({ ...base, requestKind: "fault", part: { asset: "printer 17" } })).command).toEqual({
      kind: "support", requestKind: "fault", summary: "Toner cartridges empty", description: "Need new toner cartridges.",
    });
  });
});
