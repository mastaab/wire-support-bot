import { sameQualifiedId, type QualifiedId } from "../../domain/ids/QualifiedId";

interface Mention {
  userId: QualifiedId;
  offset: number;
  length: number;
}

/**
 * Support command starts, for the configured project only; a validated project key contains
 * only [A-Z0-9]. This is a rejection guard, not a batch parser: ordinary conjunctions and
 * multiline descriptions remain intact.
 */
function supportCommandStart(projectKey: string): RegExp {
  return new RegExp(`^(?:support\\s*:|(?:my\\s+)?(?:open\\s+)?support\\s+requests?[?.]?\\s*$|(?:resolve|close)\\s+${projectKey}-\\d+\\b|(?:jira\\s+)?status\\s+of\\s+${projectKey}-\\d+\\b|reply\\s+to\\s+${projectKey}-\\d+\\s*:)`, "i");
}

/**
 * True when the message holds two or more support commands, which the router refuses. Without
 * a configured project there are no support commands, so nothing is refused.
 */
export function hasMultipleCommands(text: string, mentions: readonly Mention[], botId: QualifiedId, projectKey?: string): boolean {
  if (!projectKey || !/^[A-Z][A-Z0-9]+$/.test(projectKey)) return false;
  // Work from original UTF-16 offsets. Mask person labels so a name containing
  // command syntax cannot become a command. Never infer identity from its label.
  const spans = [...mentions].sort((a, b) => a.offset - b.offset);
  let end = 0;
  for (const m of spans) {
    if (!Number.isInteger(m.offset) || !Number.isInteger(m.length) || m.offset < end
      || m.length < 1 || m.offset + m.length > text.length) return false;
    end = m.offset + m.length;
  }
  let masked = text;
  for (const m of spans.reverse()) {
    const replacement = sameQualifiedId(m.userId, botId) ? "\n" : "@member";
    masked = masked.slice(0, m.offset) + replacement + masked.slice(m.offset + m.length);
  }
  // Fenced examples are not requests. Keep a placeholder so a prose/example
  // introduction cannot accidentally disappear and expose a command prefix.
  masked = masked.replace(/```[\s\S]*?(?:```|$)/g, "[code example]");
  const parts = masked.split(/\r?\n|;|\s+(?:and\s+then|then|and)\s+/i)
    .map(part => part.trim().replace(/^(?:[-*]\s+|\d+[.)]\s+)/, "")
      .replace(/^@?(?:wire support bot)\b(?:\s*\([^)]*\))?\s*[:,]?\s*/i, "")
      .replace(/^`([^`\r\n]+)`(?=\s|$)/, "$1")
      .replace(/^`(?!`)/, "").trim())
    .filter(Boolean);
  const command = supportCommandStart(projectKey);
  const isCommand = (part: string): boolean => command.test(part);
  // Everything after `support:` or `resolve SD-N:` is text for the service desk (a problem
  // description or a closing comment), which may mention "support requests" or "status of" in
  // passing; it is sent as text and never run.
  if (parts.length > 0 && (/^support\s*:/i.test(parts[0]) || new RegExp(`^(?:resolve|close)\\s+${projectKey}-\\d+\\s*:`, "i").test(parts[0]))) return false;
  return parts.length > 1 && isCommand(parts[0]) && parts.slice(1).some(isCommand);
}
