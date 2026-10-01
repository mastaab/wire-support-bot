import { describe, expect, it } from "vitest";
import { splitSupportText } from "../../src/infrastructure/wire/splitSupportText";
import { SUPPORT_SUMMARY_MAX } from "../../src/domain/entities/SupportRequest";

describe("splitSupportText", () => {
  it("uses the first non-empty line as the summary and the whole text as the description", () => {
    expect(splitSupportText("\n  VPN   drops \nIt started after the update.\n")).toEqual({
      summary: "VPN drops", description: "VPN   drops \nIt started after the update.",
    });
  });

  it("cuts a long first line at a word boundary within the summary limit", () => {
    const line = "word ".repeat(60).trim();
    const { summary, description } = splitSupportText(line);
    expect(summary.length).toBeLessThanOrEqual(SUPPORT_SUMMARY_MAX);
    expect(summary).toMatch(/^(word )+word\.\.\.$/);
    expect(description).toBe(line);
  });

  it("cuts a long first line without spaces hard", () => {
    const { summary } = splitSupportText("x".repeat(300));
    expect(summary).toBe(`${"x".repeat(SUPPORT_SUMMARY_MAX - 3)}...`);
  });
});
