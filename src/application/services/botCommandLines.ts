import type { OfferCommand } from "../ports/PendingOfferPort";
import { GENERIC_COMMAND_LINE, offerCommandLine } from "./offers";

/**
 * The answer model sometimes suggests a bot command that does not exist ("`@Wire Support Bot
 * support: part`" is fine, "`@Wire Support Bot support part "filter"`" is not). Following it
 * would do nothing useful, so a line with such a command is replaced by a code-written line
 * naming a supported command. The model writes the built-in name; the outbound adapter renames it.
 */

/** The bot's mention as the model writes it. */
const BOT_MENTION = /@wire\s+support\s+bot\b/gi;

/** Words that start prose after a mention ("mention @Wire Support Bot and describe it"), not a command. */
const PROSE_AFTER_MENTION = /^(?:and|or|but|with|to|in|on|at|if|when|for|is|are|was|will|can|first|directly|again|here|there|yourself)\b/i;

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * The supported commands, each anchored at the start of the text after the mention: a real key
 * of the project, its documented placeholder (`SD-NN`, `SD-N`) or an angle-bracket slot.
 */
function commandPatterns(projectKey: string): RegExp[] {
  const key = `(?:${escapeRegExp(projectKey)}-(?:\\d+|NN?)|<[^<>]+>)`;
  return [
    /^support\s*:\s*\S/i,
    new RegExp(`^reply\\s+to\\s+${key}\\s*:\\s*\\S`, "i"),
    new RegExp(`^(?:resolve|close)\\s+${key}(?:\\s*:\\s*\\S)?`, "i"),
    /^(?:my\s+)?(?:open\s+)?support\s+requests?/i,
    new RegExp(`^(?:jira\\s+)?status\\s+of\\s+${key}`, "i"),
    /^time\s*zone(?:\s+(?:[A-Za-z_]+(?:\/[A-Za-z0-9_+-]+)*|<[^<>]+>))?/i,
  ];
}

/**
 * True when `command` (the text after the mention) is a supported command. In a code span the
 * whole span must be the command, apart from final punctuation; in prose the command must end
 * at a word boundary, since a sentence may continue after it.
 */
function isSupportedCommand(command: string, projectKey: string, inCodeSpan: boolean): boolean {
  for (const pattern of commandPatterns(projectKey)) {
    const match = pattern.exec(command);
    if (!match) continue;
    const rest = command.slice(match[0].length);
    // A command that takes free text after a colon ends where the text ends.
    if (/:\s*\S/.test(match[0]) && !/^time/i.test(match[0])) return true;
    if (inCodeSpan ? /^\s*[.!?]?\s*$/.test(rest) : /^(?:$|[\s.,;!?)"'*_])/.test(rest)) return true;
  }
  return false;
}

/**
 * The commands after each mention of the bot in the line that look like a command attempt (they
 * start with a word that is not prose), each with whether it is in a code span.
 */
function commandAttempts(line: string): Array<{ command: string; inCodeSpan: boolean }> {
  const attempts: Array<{ command: string; inCodeSpan: boolean }> = [];
  for (const match of line.matchAll(BOT_MENTION)) {
    const start = match.index + match[0].length;
    const inCodeSpan = match.index > 0 && line[match.index - 1] === "`";
    const end = inCodeSpan ? line.indexOf("`", start) : -1;
    const command = line.slice(start, end >= 0 ? end : undefined).trim();
    if (!/^[A-Za-z]/.test(command) || PROSE_AFTER_MENTION.test(command)) continue;
    attempts.push({ command, inCodeSpan });
  }
  return attempts;
}

/** The supported command line for an invented command: the matching offer's line when its kind and key are clear, else the generic line. */
function replacementLine(command: string, projectKey: string): string {
  const key = new RegExp(`\\b${escapeRegExp(projectKey)}-\\d+\\b`, "i").exec(command)?.[0]?.toUpperCase();
  let kind: OfferCommand | null = null;
  if (/^(?:support|raise|report|order|part|create)\b/i.test(command)) {
    kind = { kind: "support", requestKind: "fault", summary: "", description: "" };
  } else if (key && /^repl/i.test(command)) {
    kind = { kind: "reply", issueKey: key, body: "" };
  } else if (key && /^(?:resolve|close)/i.test(command)) {
    kind = { kind: "resolve", issueKey: key };
  }
  return kind ? offerCommandLine(kind, projectKey) : GENERIC_COMMAND_LINE;
}

/**
 * The answer with every line that suggests an unsupported bot command replaced by a supported
 * command line (the same line is not repeated). Lines with supported commands stay as written.
 */
export function replaceInventedCommandLines(answer: string, projectKey: string): string {
  const lines: string[] = [];
  for (const line of answer.split("\n")) {
    const invented = commandAttempts(line).find(({ command, inCodeSpan }) => !isSupportedCommand(command, projectKey, inCodeSpan));
    if (!invented) {
      lines.push(line);
      continue;
    }
    const replacement = replacementLine(invented.command, projectKey);
    if (!lines.includes(replacement)) lines.push(replacement);
  }
  return lines.join("\n");
}
