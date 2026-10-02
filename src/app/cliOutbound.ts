import { randomUUID } from "node:crypto";
import type { CompositeButtonAction } from "@wireapp/wire-apps-js-sdk";
import type { CompositeButton, OutboundTextOptions, WireOutboundPort } from "../application/ports/WireOutboundPort";
import type { QualifiedId } from "../domain/ids/QualifiedId";

/** A member of the CLI's simulated conversation. */
export interface CliMember {
  name: string;
  id: QualifiedId;
}

/** The latest button question the CLI printed: its synthetic message ID and its buttons, in order. */
export interface CliPrompt {
  messageId: string;
  buttons: CompositeButton[];
}

/** The CLI's outbound port and the latest button question it printed. */
export interface CliOutbound {
  wireOutbound: WireOutboundPort;
  latestPrompt(): CliPrompt | undefined;
}

/**
 * The outbound port of the CLI: bot replies go to `write` (stdout) prefixed with
 * "[Wire Support Bot]". A button question is printed with its options numbered under it; the CLI
 * has no message IDs, so synthetic ones are returned, and no button confirmations. A closed
 * question is shown by its closing line, for example "(Question closed: Answered by Alice: No)".
 */
export function createCliOutbound(members: readonly CliMember[], write: (text: string) => void): CliOutbound {
  let latest: CliPrompt | undefined;
  const syntheticRef = () => ({ messageId: `cli-${randomUUID()}`, sha256: "0".repeat(64) });
  const wireOutbound: WireOutboundPort = {
    async sendPlainText(_convId: QualifiedId, text: string, _opts?: OutboundTextOptions) {
      write(`[Wire Support Bot] ${text}\n`);
      // Synthetic: the CLI has no message IDs, but use cases store and quote whatever they get.
      return syntheticRef();
    },
    async sendCompositePrompt(_convId: QualifiedId, text: string, buttons: CompositeButton[]) {
      const options = buttons.map((button, index) => `  ${index + 1}. ${button.label}`).join("\n");
      write(`[Wire Support Bot] ${text}\n${options ? `${options}\n` : ""}`);
      const ref = syntheticRef();
      latest = { messageId: ref.messageId, buttons: [...buttons] };
      return ref;
    },
    // The CLI shows no confirmation: the result is printed as text.
    async sendButtonConfirmation() {},
    // The question stays in the scrollback; only the closing line (the text's last line) is printed.
    async closeButtonPrompt(_convId: QualifiedId, messageId: string, text: string) {
      const line = text.trimEnd().split("\n").pop() ?? "";
      write(`[Wire Support Bot] (Question closed: ${line})\n`);
      if (latest?.messageId === messageId) latest = undefined;
    },
    async sendReaction(_conversationId, _messageId, emoji) {
      const emojis = typeof emoji === "string" ? [emoji] : [...emoji];
      write(`[Wire Support Bot reaction] ${emojis.join(" ")}\n`);
    },
    async sendFile() {},
    // The CLI has no typing indicator.
    withTyping: (_conversationId, work) => work(),
    async getUserProfile(userId: QualifiedId) {
      const m = members.find((mem) => mem.id.id === userId.id);
      return m ? { id: userId, name: m.name } : null;
    },
  };
  return { wireOutbound, latestPrompt: () => latest };
}

/**
 * A bare option number ("2") typed after a button question is a click on that option of the
 * latest question, sent by `sender`; null for any other line, which the CLI sends as text (so
 * "yes", "SD-41" or "new" answer as they do in Wire). When the question has buttons labeled with
 * numbers (the quick quantities [1] [2] [5]), a bare number clicks only the button with that label
 * and any other number is sent as text, so typing "3" answers a quantity of 3 instead of
 * clicking the third button.
 */
export function cliButtonClick(
  text: string, sender: QualifiedId, conversationId: QualifiedId, prompt: CliPrompt | undefined,
): CompositeButtonAction | null {
  const match = /^(\d{1,2})$/.exec(text.trim());
  if (!match || !prompt) return null;
  const numbered = prompt.buttons.some((b) => /^\d+$/.test(b.label));
  const button = numbered ? prompt.buttons.find((b) => b.label === String(Number(match[1]))) : prompt.buttons[Number(match[1]) - 1];
  if (!button) return null;
  return {
    type: "composite_button_action",
    id: `cli-click-${randomUUID()}`,
    conversationId,
    sender,
    buttonId: button.id,
    referenceMessageId: prompt.messageId,
  };
}
