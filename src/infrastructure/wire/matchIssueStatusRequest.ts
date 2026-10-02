/**
 * Recognizes a request for a Jira ticket's status. The router calls it only
 * when the bot is addressed: every support-request command needs a mention.
 *
 * - The exact command (`status of SD-4`) matches.
 * - Natural phrasing ("what's the status of SD-4 in jira?", "any update on SD-4?") needs
 *   exactly one key of the configured project, plus a status word or a question mark.
 * - Anything phrased as a change is left alone: this lookup is read-only, and the answer
 *   path explains the supported commands.
 *
 * The project key is validated at startup and contains only [A-Z0-9].
 */

const STATUS_WORDS = /\b(?:status|update|updates|progress|going|happening|latest|news|state|stand|where|replies|reply|answered|heard|open|done|resolved|closed|sla|slas)\b/i;
const CHANGE_WORDS = /\b(?:close|resolve|reopen|cancel|assign|reassign|comment|tell|raise|create|push|send|move|transition|delete|mark|set|escalate|reply\s+to|respond\s+to)\b/i;

export function matchIssueStatusRequest(text: string, projectKey: string): string | null {
  const strict = text.match(new RegExp(`^(?:jira\\s+)?status\\s+of\\s+(${projectKey}-\\d+)[?.]?\\s*$`, "i"));
  if (strict) return strict[1]!.toUpperCase();

  const trimmed = text.trim();
  if (CHANGE_WORDS.test(trimmed)) return null;
  if (!STATUS_WORDS.test(trimmed) && !trimmed.endsWith("?")) return null;

  const keys = distinct(trimmed.match(new RegExp(`\\b${projectKey}-\\d+\\b`, "gi")));
  return keys.length === 1 ? keys[0]! : null;
}

function distinct(matches: RegExpMatchArray | null): string[] {
  return [...new Set((matches ?? []).map((m) => m.toUpperCase()))];
}
