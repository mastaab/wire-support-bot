import type { OutboundMention } from "../../application/ports/WireOutboundPort";

/** The name the bot's texts and prompts use for itself; replaced by its Wire display name on the way out. */
export const BUILT_IN_BOT_NAME = "Wire Support Bot";

/** Longest display name used in texts; a longer or empty one keeps the built-in name. */
const DISPLAY_NAME_MAX = 64;

/** A display name fit for command examples: one line, no backticks, bounded; undefined otherwise. */
export function usableBotName(raw: string | undefined): string | undefined {
  const name = raw?.replace(/[`\s]+/g, " ").trim();
  return name && name.length <= DISPLAY_NAME_MAX ? name : undefined;
}

/**
 * Replaces the built-in bot name with the bot's current display name, so command examples such
 * as "@Wire Support Bot status of SD-6" match what members see and type. Mention offsets (UTF-16,
 * as JS strings count) after a replacement move by the change in length; a mention that
 * overlaps a replacement is dropped rather than pointing at the wrong text.
 */
export function renameBot(
  text: string, name: string, mentions: readonly OutboundMention[] = [],
): { text: string; mentions: OutboundMention[] } {
  if (name === BUILT_IN_BOT_NAME || !text.includes(BUILT_IN_BOT_NAME)) return { text, mentions: [...mentions] };
  const starts: number[] = [];
  for (let at = text.indexOf(BUILT_IN_BOT_NAME); at >= 0; at = text.indexOf(BUILT_IN_BOT_NAME, at + BUILT_IN_BOT_NAME.length)) {
    starts.push(at);
  }
  const delta = name.length - BUILT_IN_BOT_NAME.length;
  const moved: OutboundMention[] = [];
  for (const mention of mentions) {
    const end = mention.offset + mention.length;
    if (starts.some((s) => s < end && mention.offset < s + BUILT_IN_BOT_NAME.length)) continue;
    const before = starts.filter((s) => s + BUILT_IN_BOT_NAME.length <= mention.offset).length;
    moved.push({ ...mention, offset: mention.offset + before * delta });
  }
  return { text: text.split(BUILT_IN_BOT_NAME).join(name), mentions: moved };
}
