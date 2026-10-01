/** What the welcome says about the service desk. */
export interface SupportWelcome {
  /** Configured project key, used in the command examples. */
  projectKey: string;
  /** Whether the bot notices problems in unmentioned messages (`WIRE_SUPPORT_BOT_JIRA_PASSIVE`). */
  passive: boolean;
  /** Whether desk replies and status changes are announced (`WIRE_SUPPORT_BOT_JIRA_WATCH_SECONDS`). */
  watching: boolean;
}

const TIMEZONE_PART = "Mention me with `timezone <name>` to set the channel's timezone for reply times.";

/**
 * The message the bot sends when it is added to a channel. The built-in name is replaced by
 * the app's display name on the way out.
 */
export function welcomeText(support: SupportWelcome): string {
  const raise = support.passive
    ? "Tell me about a fault, a question or a part you need, and I'll offer to raise it with the service desk; nothing is sent without your yes."
    : "Mention me and tell me about a fault, a question or a part you need, and I'll offer to raise it with the service desk; nothing is sent without your yes. `@Wire Support Bot support: <problem>` raises it at once.";
  const follow = `Mention me with \`support requests\` for the open requests or \`status of ${support.projectKey}-N\` for the latest on one, or just ask about a request in your own words.`;
  const updates = support.watching ? " Replies and status changes from the service desk appear here." : "";
  return [
    `I'm Wire Support Bot, and I connect this channel with the service desk. ${raise}`,
    `${follow}${updates}`,
    TIMEZONE_PART,
  ].join("\n\n");
}
