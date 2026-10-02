import type { QualifiedId } from "../../domain/ids/QualifiedId";
import type {
  WireOutboundPort,
  OutboundTextOptions,
  CompositePromptOptions,
  CompositeButton as PromptButton,
  OutboundMention,
  SentMessageRef,
  UserProfile,
} from "../../application/ports/WireOutboundPort";
import type { Logger } from "../../application/ports/Logger";
import { randomUUID } from "node:crypto";
import { TextMessage, CompositeMessage, CompositeEditedMessage, CompositeButton, Reaction, QualifiedId as SdkQualifiedId } from "@wireapp/wire-apps-js-sdk";
import type { WireMessage, WireUser } from "@wireapp/wire-apps-js-sdk";
import type { WireReplyContext } from "./WireReplyContext";
import { renameBot, usableBotName } from "./renameBot";

/**
 * The SDK serialises and accepts this message type but does not export its factory from the
 * package entrypoint, so it is built from the exported union instead.
 */
type ButtonActionConfirmation = Extract<WireMessage, { type: "composite_button_action_confirmation" }>;

/** How long the bot's own display name is reused before it is looked up again. */
const BOT_NAME_TTL_MS = 5 * 60 * 1000;

/**
 * The subset of WireApplicationManager the outbound adapter needs.
 * Kept narrow so tests can supply a fake without the SDK's native dependencies.
 */
export interface ManagerHandle {
  sendMessage(message: WireMessage): Promise<string>;
  processWithTypingIndicator?<T>(conversationId: QualifiedId, process: () => Promise<T>): Promise<T>;
  sendAsset(conversationId: QualifiedId, asset: { data: Uint8Array; name: string; mimeType: string }): Promise<string>;
  getUsers(userIds: QualifiedId[]): Promise<Array<Pick<WireUser, "id" | "name" | "handle">>>;
}

export interface HandlerManagerRef {
  current: { manager?: ManagerHandle } | null;
}

/**
 * The reference a later reply needs: the message ID and the SDK's integrity hash of the text as
 * built. Wire clients check the hash against the send time rounded to the second; the SDK does
 * not return the backend's time, so the local build time is used.
 */
function sentRef(message: TextMessage, messageId: string): SentMessageRef | undefined {
  const digest = TextMessage.createReply({ originalMessage: { ...message, id: messageId }, text: "" }).quotedMessageSha256;
  return digest ? { messageId, sha256: Buffer.from(digest).toString("hex") } : undefined;
}

async function streamToUint8Array(stream: NodeJS.ReadableStream): Promise<Uint8Array> {
  const chunks: Buffer[] = [];
  return new Promise<Uint8Array>((resolve, reject) => {
    stream.on("data", (chunk: Buffer) => chunks.push(chunk));
    stream.on("end", () => resolve(new Uint8Array(Buffer.concat(chunks))));
    stream.on("error", reject);
  });
}

/**
 * Implements WireOutboundPort using @wireapp/wire-apps-js-sdk.
 */
export function createWireOutboundAdapter(
  handlerRef: HandlerManagerRef,
  logger: Logger,
  replyContext?: WireReplyContext,
  /** The bot's own user; its current Wire display name replaces the built-in name in texts. */
  botUserId?: QualifiedId,
  now: () => number = Date.now,
): WireOutboundPort {
  let botName: { name: string | undefined; at: number } | undefined;
  /** The bot's display name, looked up at most every few minutes; undefined keeps the built-in name. */
  const currentBotName = async (manager: ManagerHandle): Promise<string | undefined> => {
    if (!botUserId) return undefined;
    if (botName && now() - botName.at < BOT_NAME_TTL_MS) return botName.name;
    let name: string | undefined;
    try {
      const [profile] = await manager.getUsers([botUserId]);
      name = usableBotName(profile?.name);
    } catch (err) {
      logger.warn("Bot display name lookup failed", { err: err instanceof Error ? err.name : "UnknownError" });
      name = botName?.name;
    }
    botName = { name, at: now() };
    return name;
  };
  const renamed = async (manager: ManagerHandle, text: string, mentions?: OutboundMention[]) => {
    const name = await currentBotName(manager);
    return name ? renameBot(text, name, mentions) : { text, mentions: mentions ?? [] };
  };

  return {
    async getUserProfile(userId: QualifiedId): Promise<UserProfile | null> {
      const h = handlerRef.current;
      if (!h?.manager) return null;
      try {
        const [profile] = await h.manager.getUsers([userId]);
        if (!profile) return null;
        return {
          id: { id: profile.id.id, domain: profile.id.domain },
          name: profile.name,
          handle: profile.handle,
        };
      } catch {
        return null;
      }
    },

    async sendPlainText(
      conversationId: QualifiedId,
      text: string,
      options?: OutboundTextOptions,
    ): Promise<SentMessageRef | undefined> {
      const h = handlerRef.current;
      if (!h?.manager) return undefined;
      logger.debug("sendPlainText", { conversationId: conversationId.id, textLength: text.length, quote: !!options?.quote });
      const handlerQuote = replyContext?.get(conversationId, options?.replyToMessageId);
      const storedQuote = !options?.replyToMessageId && options?.quote
        ? { quotedMessageId: options.quote.messageId, quotedMessageSha256: Uint8Array.from(Buffer.from(options.quote.sha256, "hex")) }
        : undefined;
      const out = await renamed(h.manager, text, options?.mentions);
      const message: TextMessage = {
        ...TextMessage.create({ conversationId, text: out.text, mentions: out.mentions.length > 0 ? out.mentions : undefined }),
        ...(handlerQuote ?? storedQuote),
      };
      const messageId = await h.manager.sendMessage(message);
      return sentRef(message, messageId);
    },

    async sendCompositePrompt(
      conversationId: QualifiedId,
      text: string,
      buttons: PromptButton[],
      options?: CompositePromptOptions,
    ): Promise<SentMessageRef | undefined> {
      const h = handlerRef.current;
      if (!h?.manager) return undefined;
      logger.debug("sendCompositePrompt", { conversationId: conversationId.id, textLength: text.length, buttons: buttons.map((b) => b.id) });
      const out = await renamed(h.manager, text);
      const textItem: TextMessage = {
        ...TextMessage.create({ conversationId, text: out.text }),
        ...replyContext?.get(conversationId, options?.replyToMessageId),
      };
      const messageId = await h.manager.sendMessage(
        CompositeMessage.create({
          conversationId,
          itemList: [textItem, ...buttons.map((b) => CompositeButton.create({ id: b.id, text: b.label }))],
        }),
      );
      // The quote hash of a composite message is taken over its text, as for a text message.
      return sentRef(textItem, messageId);
    },

    async sendButtonConfirmation(conversationId: QualifiedId, referenceMessageId: string, buttonId: string): Promise<void> {
      const h = handlerRef.current;
      if (!h?.manager) return;
      logger.debug("sendButtonConfirmation", { conversationId: conversationId.id, referenceMessageId, buttonId });
      const confirmation: ButtonActionConfirmation = {
        type: "composite_button_action_confirmation",
        id: randomUUID(),
        conversationId,
        referenceMessageId,
        buttonId,
      };
      await h.manager.sendMessage(confirmation);
    },

    async closeButtonPrompt(conversationId: QualifiedId, messageId: string, text: string): Promise<void> {
      const h = handlerRef.current;
      if (!h?.manager) return;
      logger.debug("closeButtonPrompt", { conversationId: conversationId.id, messageId, textLength: text.length });
      const out = await renamed(h.manager, text);
      // A composite edit with a text item only: clients drop the buttons. A text edit of a
      // composite message is not honoured by the clients.
      await h.manager.sendMessage(CompositeEditedMessage.create({
        conversationId,
        replacingMessageId: messageId,
        itemList: [TextMessage.create({ conversationId, text: out.text })],
      }));
    },

    async withTyping<T>(conversationId: QualifiedId, work: () => Promise<T>): Promise<T> {
      // The SDK starts the work at once, refreshes and clears the indicator in the background,
      // and never lets a typing failure replace the work's result. Without SDK support (not
      // connected yet), the work simply runs.
      const manager = handlerRef.current?.manager;
      if (!manager?.processWithTypingIndicator) return work();
      return manager.processWithTypingIndicator(new SdkQualifiedId(conversationId.id, conversationId.domain), work);
    },

    async sendReaction(
      conversationId: QualifiedId,
      messageId: string,
      emoji: string | readonly string[],
    ): Promise<void> {
      const h = handlerRef.current;
      if (!h?.manager) return;
      logger.debug("sendReaction", { conversationId: conversationId.id, messageId, emoji });
      await h.manager.sendMessage(
        Reaction.create({ conversationId, messageId, emojiSet: new Set(typeof emoji === "string" ? [emoji] : emoji) }),
      );
    },

    async sendFile(
      conversationId: QualifiedId,
      fileStream: NodeJS.ReadableStream,
      name: string,
      mimeType: string,
      _retention?: string,
    ): Promise<void> {
      const h = handlerRef.current;
      if (!h?.manager) return;
      logger.debug("sendFile", { conversationId: conversationId.id, name, mimeType });
      const data = await streamToUint8Array(fileStream);
      await h.manager.sendAsset(conversationId, { data, name, mimeType });
    },
  };
}
