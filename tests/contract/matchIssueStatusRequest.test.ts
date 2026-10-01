import { describe, expect, it } from "vitest";
import { matchIssueStatusRequest } from "../../src/infrastructure/wire/matchIssueStatusRequest";

describe("matchIssueStatusRequest", () => {
  it.each([
    ["status of SD-4", "SD-4"],
    ["status of sd-4?", "SD-4"],
    ["jira status of SD-4", "SD-4"],
  ])("matches the exact command: %s", (text, reference) => {
    expect(matchIssueStatusRequest(text, "SD")).toBe(reference);
  });

  it.each([
    // Natural phrasings seen in real use.
    ["whats the status of SD-4", "SD-4"],
    ["whats the status of SD-4 in jira", "SD-4"],
    ["what's the status of SD-4?", "SD-4"],
    ["any update on SD-4?", "SD-4"],
    ["how is SD-4 going", "SD-4"],
    ["has the service desk replied on sd-4?", "SD-4"],
    ["is SD-4 done yet?", "SD-4"],
    ["SD-4?", "SD-4"],
  ])("matches natural phrasing: %s", (text, reference) => {
    expect(matchIssueStatusRequest(text, "SD")).toBe(reference);
  });

  it.each([
    ["a change request", "please close SD-4"],
    ["a reply request", "reply to SD-4 that the draft is attached"],
    ["an escalation", "raise SD-4 again"],
    ["a resolve request", "resolve SD-4 please"],
    ["marking done", "mark SD-4 done"],
    ["another project's key", "what's the status of OPS-1234?"],
    ["a longer project key sharing the prefix", "what's the status of SDX-4?"],
    ["two tickets", "compare SD-4 and SD-3?"],
    ["an action, even with jira wording", "what's the jira status of ACT-0010?"],
    ["another prefix with jira wording", "jira status of ACT-0010"],
    ["a key-like ID with another prefix", "what's the status of DEC-0001?"],
    ["a statement without a status word", "SD-4 needs the legal review first"],
  ])("does not match %s", (_label, text) => {
    expect(matchIssueStatusRequest(text, "SD")).toBeNull();
  });
});
