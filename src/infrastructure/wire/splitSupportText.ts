import { SUPPORT_SUMMARY_MAX } from "../../domain/entities/SupportRequest";

/**
 * Splits the text of `support: <problem>` into a ticket summary and description. The first
 * non-empty line, with whitespace collapsed, is the summary, cut at a word boundary when it
 * is too long; the whole text is the description. Bounds are validated by the use case.
 */
export function splitSupportText(text: string): { summary: string; description: string } {
  const description = text.trim();
  const firstLine = description.split(/\r?\n/).find((line) => line.trim()) ?? "";
  let summary = firstLine.replace(/\s+/g, " ").trim();
  if (summary.length > SUPPORT_SUMMARY_MAX) {
    const cut = summary.slice(0, SUPPORT_SUMMARY_MAX - 3);
    const lastSpace = cut.lastIndexOf(" ");
    summary = `${(lastSpace > SUPPORT_SUMMARY_MAX / 2 ? cut.slice(0, lastSpace) : cut).trimEnd()}...`;
  }
  return { summary, description };
}
