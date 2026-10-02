import { sameQualifiedId } from "../../domain/ids/QualifiedId";
import type { QualifiedId } from "../../domain/ids/QualifiedId";
import type { AssetMessage, Conversation, ConversationMember, TextMessage, CompositeButtonAction, TextEditedMessage } from "@wireapp/wire-apps-js-sdk";
import { WireEventsHandler, ConversationRole } from "@wireapp/wire-apps-js-sdk";
import type { AnswerQuestion } from "../../application/usecases/general/AnswerQuestion";
import type { RaiseSupportRequest } from "../../application/usecases/jira/RaiseSupportRequest";
import type { SetChannelTimezone } from "../../application/usecases/general/SetChannelTimezone";
import type { CompletePartOrder } from "../../application/usecases/jira/CompletePartOrder";
import type { ListSupportRequests } from "../../application/usecases/jira/ListSupportRequests";
import type { ResolveSupportRequest } from "../../application/usecases/jira/ResolveSupportRequest";
import type { GetIssueStatus } from "../../application/usecases/jira/GetIssueStatus";
import type { ConfirmOffer } from "../../application/usecases/jira/ConfirmOffer";
import type { ReplyToServiceDesk } from "../../application/usecases/jira/ReplyToServiceDesk";
import type { OfferCommand, PendingOfferStore } from "../../application/ports/PendingOfferPort";
import type { ConversationMessageBuffer } from "../../application/services/ConversationMessageBuffer";
import type { ConversationMemberCache, CachedMember } from "../../domain/services/ConversationMemberCache";
import type { ChannelConfigRepository } from "../../domain/repositories/ChannelConfigRepository";
import type { WireOutboundPort } from "../../application/ports/WireOutboundPort";
import type { Logger } from "../../application/ports/Logger";
import type { InMemoryProcessingQueue } from "../queue/InMemoryProcessingQueue";
import type { ProcessingPipeline, MessageJob } from "../pipeline/ProcessingPipeline";
import { toChannelId } from "../../domain/ids/channelId";
import { hasMultipleCommands } from "./hasMultipleCommands";
import { matchIssueStatusRequest } from "./matchIssueStatusRequest";
import { splitSupportText } from "./splitSupportText";
import { welcomeText, type SupportWelcome } from "./welcomeText";
import { BUILT_IN_BOT_NAME } from "./renameBot";
import type { OfferAttachment } from "../../application/usecases/jira/OfferAttachment";
import type { CreatedConversations } from "./CreatedConversations";
import { ATTACHMENT_MAX_BYTES, attachableKind } from "../../application/services/attachments";
import type { WireReplyContext } from "./WireReplyContext";
import { classifyConfirmation } from "../../application/usecases/jira/ConfirmOffer";
import { YES_NO_LABELS, decisionAt, parseOfferButtonId } from "../../application/services/offerButtons";
import { NOT_AN_ANSWER_LINE, closeEndedOfferPrompts, closeOfferPrompt, type OfferPromptClosing } from "../../application/services/offerPromptClosing";

const CONTEXT_WINDOW = 10;
const NAME_TTL_MS = 24 * 60 * 60 * 1000; // re-fetch display names after 24 h to catch renames

/** True for a support offer that orders a replacement part, complete or not. */
function isPartOrder(command: OfferCommand): boolean {
  return command.kind === "support" && command.requestKind === "part";
}

function toCachedRole(role: ConversationRole): CachedMember["role"] {
  return role === ConversationRole.ADMIN ? "admin" : "member";
}

export interface WireEventRouterDeps {
  logger: Logger;
  /** Answers questions addressed to the bot and follow-ups to its own questions. */
  answerQuestion: AnswerQuestion;
  /** Sets or shows the channel's timezone (`@bot timezone Europe/Berlin`). */
  setChannelTimezone?: SetChannelTimezone;
  /** Timezone for channels the bot newly joins; UTC when absent. */
  defaultTimezone?: string;
  raiseSupportRequest: RaiseSupportRequest;
  /** Fills a pending part order's missing essentials from the requester's next message, in code. */
  completePartOrder: CompletePartOrder;
  /** What the welcome says about the service desk. */
  supportWelcome: SupportWelcome;
  /** Offers to attach posted photos and documents to an open request; wired only with passive help on. */
  offerAttachment?: OfferAttachment;
  /**
   * Groups the app created for requester and agent and has not yet left, also those still owed
   * a leave after a restart; ignored entirely meanwhile.
   */
  createdConversations?: CreatedConversations;
  listSupportRequests: ListSupportRequests;
  resolveSupportRequest: ResolveSupportRequest;
  getIssueStatus: GetIssueStatus;
  replyToServiceDesk: ReplyToServiceDesk;
  /** Offers made by the answer path and passive help, confirmed with a short "yes" or "no". */
  pendingOffers: PendingOfferStore;
  confirmOffer: ConfirmOffer;
  // Infrastructure
  botUserId: QualifiedId;
  wireOutbound: WireOutboundPort;
  replyContext?: WireReplyContext;
  messageBuffer: ConversationMessageBuffer;
  memberCache: ConversationMemberCache;
  /** The channel's timezone. */
  channelConfig: ChannelConfigRepository;
  /** Passive service-desk help for unaddressed messages; absent when passive help is off. */
  processingQueue?: InMemoryProcessingQueue<MessageJob>;
  pipeline?: ProcessingPipeline;
}

/** The details of a file preview that an upload event may lack. */
interface AssetPreview {
  mimeType: string;
  name: string | null;
  sizeInBytes: AssetMessage["sizeInBytes"];
  expiresAfterMillis: number | null;
  timestamp: Date;
}

export class WireEventRouter extends WireEventsHandler {
  constructor(private readonly deps: WireEventRouterDeps) {
    super();
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Entry point
  // ─────────────────────────────────────────────────────────────────────────

  private readonly handlers = new Map<string, Promise<void>>();

  async onTextMessageReceived(wireMessage: TextMessage): Promise<void> {
    await this.inOrder(wireMessage.conversationId as QualifiedId, () => {
      const process = () => this.processTextMessage(wireMessage);
      return this.deps.replyContext ? this.deps.replyContext.withMessage(wireMessage, process) : process();
    });
  }

  /**
   * Runs `work` after the conversation's earlier messages, files and clicks, one at a time. Then
   * closes the button questions the offer store noticed as expired or replaced meanwhile.
   */
  private async inOrder(conversationId: QualifiedId, work: () => Promise<void>): Promise<void> {
    const channelId = toChannelId(conversationId);
    const previous = this.handlers.get(channelId) ?? Promise.resolve();
    const current = previous.catch(() => {}).then(work).finally(() => this.closeEndedPrompts());
    this.handlers.set(channelId, current);
    try { await current; } finally {
      if (this.handlers.get(channelId) === current) this.handlers.delete(channelId);
    }
  }

  private async processTextMessage(wireMessage: TextMessage): Promise<void> {
    if (this.deps.createdConversations?.has(wireMessage.conversationId as QualifiedId)) return;
    const text = wireMessage.text ?? "";
    const convId = wireMessage.conversationId as QualifiedId;
    const sender = wireMessage.sender as QualifiedId;
    const channelId = toChannelId(convId);
    let senderMember = this.deps.memberCache.getMembers(convId).find((m) => sameQualifiedId(m.userId, sender));

    // Name resolution strategy:
    //   a) Name missing (not yet fetched, or sender not in cache): AWAIT the profile call so
    //      that senderName is correct for the buffer, the pipeline job and all command handlers.
    //   b) Name present but older than NAME_TTL_MS: fire-and-forget refresh; we already have
    //      a valid name to use for this message, and the next message gets the refreshed value.
    const nameAge = senderMember?.nameResolvedAt
      ? Date.now() - senderMember.nameResolvedAt.getTime()
      : Infinity;
    if (!senderMember?.name) {
      try {
        const profile = await this.deps.wireOutbound.getUserProfile(sender);
        if (profile?.name) {
          if (senderMember) {
            this.deps.memberCache.updateMemberName(convId, sender, profile.name, profile.handle);
          } else {
            // Sender not in cache: may happen if the bot missed a join event.
            this.deps.memberCache.addMembers(convId, [{
              userId: sender,
              role: "member",
              name: profile.name,
              handle: profile.handle,
              nameResolvedAt: new Date(),
            }]);
          }
          // Re-read so messageBuffer and handleTextMessage see the resolved name.
          senderMember = this.deps.memberCache.getMembers(convId).find((m) => sameQualifiedId(m.userId, sender));
        }
      } catch { /* non-fatal: proceed without name */ }
    } else if (nameAge > NAME_TTL_MS) {
      // Stale but present: background refresh only.
      void this.deps.wireOutbound.getUserProfile(sender).then((profile) => {
        if (profile?.name) this.deps.memberCache.updateMemberName(convId, sender, profile.name, profile.handle);
      });
    }

    // Child logger is created after name resolution so senderName is always available.
    const log = this.deps.logger.child({
      conversationId: convId.id,
      senderId: sender.id,
      senderName: senderMember?.name || undefined,
      messageId: wireMessage.id,
    });

    try {
      await this.handleTextMessage(wireMessage, text, convId, sender, channelId, log);
    } catch (err) {
      log.error("Handler failed", { err: (err instanceof Error ? err.name : "UnknownError"), errorType: err instanceof Error ? err.name : undefined });
      try {
        await this.deps.wireOutbound.sendPlainText(convId, "Something went wrong. Please try again.", {
          replyToMessageId: wireMessage.id,
        });
      } catch (sendErr) {
        log.error("Failed to send error reply", { err: (sendErr instanceof Error ? sendErr.name : "UnknownError") });
      }
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Core message handler
  // ─────────────────────────────────────────────────────────────────────────

  private async handleTextMessage(
    wireMessage: TextMessage,
    text: string,
    convId: QualifiedId,
    sender: QualifiedId,
    channelId: string,
    log: Logger,
  ): Promise<void> {
    const lowered = text.trim().toLowerCase();
    const botMentioned = wireMessage.mentions?.some((m) => sameQualifiedId(m.userId, this.deps.botUserId)) ?? false;
    const isBotAddressed = botMentioned || this.startsWithBotName(lowered);
    const addressedText = isBotAddressed ? this.stripAddressedBotPrefix(text, wireMessage) : text.trim();
    // Pasted command examples may retain inline-code delimiters around the ID,
    // command prefix, or whole command. Do not unwrap prose, fences or multiline code.
    const commandText = addressedText.replace(/^`([^`\r\n]+)`(?=\s|$)/, "$1");
    const commandLowered = commandText.toLowerCase();

    const cachedMembers = this.deps.memberCache.getMembers(convId);
    const senderEntry = cachedMembers.find((m) => sameQualifiedId(m.userId, sender));
    const senderDisplayName = senderEntry?.name || undefined;

    const members = cachedMembers.map((m) => ({
      id: m.userId.id,
      domain: m.userId.domain,
      name: m.name,
    }));

    // A short "yes"/"no" to a pending offer. Checked before commands, before the multi-command
    // guard and before the follow-up handling further down, which would otherwise send the
    // "yes" to the read-only answer path. Only the member who received the offer can confirm
    // it, and only with their next message: anything else drops the offer, so a later "yes"
    // meant for a different question can never confirm it. A bare "yes" shortly after a
    // dropped or expired offer is also handed over, so it gets an answer instead of silence. A
    // dropped offer travels with this message to the answer path, so a correction can produce
    // a revised offer.
    let droppedOffer: OfferCommand | undefined;
    const pendingOffers = this.deps.pendingOffers;
    if (pendingOffers.has(convId, sender) || pendingOffers.recentlyDropped(convId, sender)) {
      const live = pendingOffers.find(convId, sender);
      const confirm = () => this.deps.confirmOffer.execute({
        text: commandText, conversationId: convId, requesterId: sender,
        requesterName: senderDisplayName, replyToMessageId: wireMessage.id,
      });
      // A yes or a picked option raises, replies to or resolves a ticket, which the requester waits for.
      const handled = classifyConfirmation(commandText) === "yes" || live?.choices ? await this.typing(convId, confirm) : await confirm();
      if (handled) {
        // Record the answer so the answer model sees the offer as closed, not pending, and a bot
        // entry after it, so the offer's "(yes or no)?" no longer counts as the bot's latest
        // question: otherwise the requester's next message would be taken as a follow-up.
        this.recordHandled(convId, wireMessage.id, sender, senderDisplayName, text, "(Answered the offer above.)");
        return;
      }
      droppedOffer = pendingOffers.drop(convId, sender) ?? undefined;
      // A dropped choice is not a draft to amend or complete: the requester has moved on. A
      // button question for a part-order essential is the exception: its draft stays, so a typed
      // value or a correction completes it below.
      if (live?.choices && !live.fillsPart) droppedOffer = undefined;
      // With no live offer, only a recently dropped one brought us here and the requester has
      // moved on, so a later yes (perhaps to a colleague) is not answered about it.
      if (!droppedOffer) pendingOffers.forgetDropped(convId, sender);
      // A part-order draft: an answer ("two, deliver to depot north") or a correction ("actually
      // three") is merged in code, without relying on the answer model to return a revised offer.
      // A message to the bot (a command or a question) is not an answer to the draft.
      if (droppedOffer && isPartOrder(droppedOffer) && !isBotAddressed) {
        // The bot asked for the missing details, so the requester is waiting for its answer.
        const draft = droppedOffer;
        const completed = await this.typing(convId, () => this.deps.completePartOrder.execute({
          text: commandText, conversationId: convId, requesterId: sender, pending: draft, replyToMessageId: wireMessage.id,
          ...(live ? { answering: live } : {}), requesterName: senderDisplayName,
        }));
        if (completed) {
          // The typed answer decided the question (CompletePartOrder closed its message as
          // answered), so a later click on its buttons changes nothing.
          if (live?.id) pendingOffers.markAnswered(convId, live.id);
          this.recordHandled(convId, wireMessage.id, sender, senderDisplayName, text, "(Updated the part order draft.)");
          return;
        }
      }
      // The requester's next message was not an answer, so their button question is closed.
      if (live?.messageId) await closeOfferPrompt(this.promptClosing(log), convId, live.messageId, NOT_AN_ANSWER_LINE);
    }

    // A message that displaced the requester's offer is about that offer, even when the offer
    // came from passive help and is not in the conversation buffer, so a correction ("the
    // description should mention X", "also add the comment 'thanks'") reaches the answer path
    // to be revised.
    const amendsOffer = droppedOffer?.kind === "support" || droppedOffer?.kind === "reply" || droppedOffer?.kind === "resolve";

    // Reject a command bundle before any write, buffering or model work.
    if (hasMultipleCommands(text, wireMessage.mentions ?? [], this.deps.botUserId, this.deps.getIssueStatus.projectKey)) {
      await this.deps.wireOutbound.sendPlainText(convId,
        "Please send one command per message. I have not run any commands from this message.",
        { replyToMessageId: wireMessage.id });
      return;
    }

    // @Wire Support Bot timezone [Europe/Berlin], "set our time zone to Europe/Berlin",
    // "timezone: Europe/Berlin". An argument that does not look like a zone name ("timezone
    // differences?") is a question for the normal routing.
    if (isBotAddressed) {
      const timezoneMatch = commandText.match(
        /^(?:(?:set|change)\s+(?:(?:our|the|this\s+channel['’]s|the\s+channel['’]s)\s+)?)?time\s*zone(?:[.!?]|(?:\s*:\s*|\s+(?:to\s+)?)(\S.*?))?\s*$/i,
      );
      const timezoneArg = timezoneMatch?.[1]?.replace(/[.!]$/, "");
      if (timezoneMatch && this.deps.setChannelTimezone
          && (timezoneArg === undefined || /^[A-Za-z_]+(?:\/[A-Za-z0-9_+\-]+)*$/.test(timezoneArg))) {
        await this.deps.setChannelTimezone.execute({
          conversationId: convId, channelId, actorId: sender,
          ...(timezoneArg ? { timezone: timezoneArg } : {}),
          replyToMessageId: wireMessage.id,
        });
        return;
      }
    }

    this.deps.messageBuffer.push(convId, {
      messageId: wireMessage.id,
      senderId: sender,
      senderName: senderDisplayName ?? "",
      text,
      timestamp: new Date(),
    });

    // Support commands. Writes to the service desk need the bot to be addressed, so a
    // teammate's chat that happens to start with "support:", "resolve SD-4" or "reply to SD-4:"
    // never reaches the tracker. Only keys of the configured project match.
    const projectKey = this.deps.getIssueStatus.projectKey;
    const supportMatch = isBotAddressed ? commandText.match(/^support\s*:\s*([\s\S]+)$/i) : null;
    if (supportMatch) {
      const { summary, description } = splitSupportText(supportMatch[1]!);
      await this.typing(convId, () => this.deps.raiseSupportRequest.execute({
        summary, description, conversationId: convId, requesterId: sender,
        requesterName: senderDisplayName, replyToMessageId: wireMessage.id, requestKind: "fault",
      }));
      return;
    }

    const resolveMatch = isBotAddressed
      ? commandText.match(new RegExp(`^(?:resolve|close)\\s+(${projectKey}-\\d+)(?:\\s*:\\s*([\\s\\S]+)|[.!]?\\s*)$`, "i"))
      : null;
    if (resolveMatch) {
      // `resolve SD-6: <comment>` adds a closing comment before resolving.
      const comment = resolveMatch[2]?.trim();
      await this.typing(convId, () => this.deps.resolveSupportRequest.execute({
        issueKey: resolveMatch[1]!.toUpperCase(), conversationId: convId, actorId: sender,
        ...(comment ? { comment } : {}), replyToMessageId: wireMessage.id,
      }));
      return;
    }

    const replyMatch = isBotAddressed
      ? commandText.match(new RegExp(`^reply\\s+to\\s+(${projectKey}-\\d+)\\s*:\\s*([\\s\\S]+)$`, "i"))
      : null;
    if (replyMatch) {
      await this.typing(convId, () => this.deps.replyToServiceDesk.execute({
        reference: replyMatch[1]!.toUpperCase(), body: replyMatch[2]!, conversationId: convId,
        actorId: sender, replyToMessageId: wireMessage.id,
      }));
      return;
    }

    const supportListMatch = isBotAddressed
      ? commandLowered.match(/^(my\s+)?(?:open\s+)?support\s+requests?[?.]?\s*$/)
      : null;
    if (supportListMatch) {
      await this.typing(convId, () => this.deps.listSupportRequests.execute({
        conversationId: convId, ...(supportListMatch[1] ? { requesterId: sender } : {}), replyToMessageId: wireMessage.id,
      }));
      return;
    }

    // Status lookups: the exact command, or natural phrasing when the bot is addressed. Only
    // keys of the configured project match; see matchIssueStatusRequest.
    const issueReference = isBotAddressed ? matchIssueStatusRequest(commandText, projectKey) : null;
    if (issueReference) {
      const timezone = await this.channelTimezone(channelId);
      await this.typing(convId, () => this.deps.getIssueStatus.execute({
        reference: issueReference, conversationId: convId, timezone, replyToMessageId: wireMessage.id,
      }));
      return;
    }

    // ── Follow-up detection ───────────────────────────────────────────────────
    // If the bot's most recent message (within the last 3 buffered messages) ended with a
    // question mark, treat the next human message as a follow-up even without a mention.
    const isFollowUp = (() => {
      if (botMentioned) return false;
      const recent = this.deps.messageBuffer.getLastN(convId, 3);
      const lastBot = [...recent].reverse().find(m => sameQualifiedId(m.senderId, this.deps.botUserId));
      // Check the last line of the bot's message: in a multi-paragraph answer the question may
      // not be the very last sentence.
      if (lastBot == null) return false;
      const lastSentence = lastBot.text.trim().split(/\n+/).filter(Boolean).pop() ?? "";
      return lastSentence.trimEnd().endsWith("?");
    })();

    // ── Mention or follow-up: answer ─────────────────────────────────────────
    if (botMentioned || isFollowUp || amendsOffer) {
      await this.answerInChannel({
        wireMessage, text, commandText, convId, sender, channelId, senderDisplayName, members,
        droppedOffer, amendOnly: amendsOffer && !botMentioned && !isFollowUp, isFollowUp, log,
      });
      return;
    }
    // ── Otherwise: passive service-desk help ─────────────────────────────────
    this.enqueueForPipeline(wireMessage, text, convId, sender, channelId, senderDisplayName, log);
  }

  /** Buffers a message the offer handling consumed, followed by a bot entry that closes the offer. */
  private recordHandled(
    convId: QualifiedId, messageId: string, sender: QualifiedId, senderName: string | undefined, text: string, botNote: string,
  ): void {
    const now = new Date();
    this.deps.messageBuffer.push(convId, { messageId, senderId: sender, senderName: senderName ?? "", text, timestamp: now });
    this.deps.messageBuffer.push(convId, {
      messageId: `bot-${now.getTime()}`, senderId: this.deps.botUserId, senderName: BUILT_IN_BOT_NAME, text: botNote, timestamp: now,
    });
  }

  /** The channel's stored timezone, or the default one when the channel has none. */
  private async channelTimezone(channelId: string): Promise<string> {
    const config = await this.deps.channelConfig.get(channelId);
    return config?.timezone ?? this.deps.defaultTimezone ?? "UTC";
  }

  /**
   * The answer path: a mentioned question, a follow-up to the bot's question, or a message that
   * displaced the requester's offer (`amendOnly` when it did not address the bot).
   */
  private async answerInChannel(input: {
    wireMessage: TextMessage;
    text: string;
    commandText: string;
    convId: QualifiedId;
    sender: QualifiedId;
    channelId: string;
    senderDisplayName: string | undefined;
    members: Array<{ id: string; domain: string; name?: string }>;
    droppedOffer: OfferCommand | undefined;
    amendOnly: boolean;
    isFollowUp: boolean;
    log: Logger;
  }): Promise<void> {
    const { wireMessage, text, commandText, convId, sender, channelId, senderDisplayName, droppedOffer, amendOnly, log } = input;
    log.info("Message: dispatched to answerQuestion", { isFollowUp: input.isFollowUp, amendOnly });
    const timezone = await this.channelTimezone(channelId);
    const recentContext = this.deps.messageBuffer.getLastN(convId, CONTEXT_WINDOW).slice(0, -1).map((m) =>
      m.senderName ? `${m.senderName}: ${m.text}` : m.text,
    );
    const answer = await this.typing(convId, () => this.deps.answerQuestion.execute({
      question: commandText,
      requester: { id: sender.id, domain: sender.domain, name: senderDisplayName },
      conversationContext: recentContext,
      conversationId: convId,
      replyToMessageId: wireMessage.id,
      members: input.members,
      ...(droppedOffer ? { pendingOffer: droppedOffer } : {}),
      ...(amendOnly ? { amendOnly: true } : {}),
      timezone,
    }));
    // Not a revision: the message was ordinary conversation, so passive help still sees it.
    if (amendOnly && !answer) {
      this.enqueueForPipeline(wireMessage, text, convId, sender, channelId, senderDisplayName, log);
      return;
    }
    // Buffer the bot's answer so follow-up messages have context.
    this.deps.messageBuffer.push(convId, {
      messageId: `bot-${Date.now()}`,
      senderId: this.deps.botUserId,
      senderName: BUILT_IN_BOT_NAME,
      text: answer,
      timestamp: new Date(),
    });
  }

  private enqueueForPipeline(
    wireMessage: TextMessage,
    text: string,
    convId: QualifiedId,
    sender: QualifiedId,
    channelId: string,
    senderDisplayName: string | undefined,
    log: Logger,
  ): void {
    if (!this.deps.processingQueue || !this.deps.pipeline) return;
    log.info("Message: enqueued for passive help");
    const job: MessageJob = {
      messageId: wireMessage.id,
      channelId,
      conversationId: convId,
      senderId: sender,
      senderName: senderDisplayName ?? "",
      text,
      timestamp: new Date(),
    };
    this.deps.processingQueue.enqueue({
      id: wireMessage.id,
      channelId,
      payload: job,
      enqueuedAt: new Date(),
    });
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Files and photos
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * A photo or document posted in the channel: with passive help on and an open support
   * request, the bot offers to attach it. Runs in the channel's message order and under the
   * same ignore check as text. Wire sends a preview before the upload with the same message
   * ID; only the uploaded event (with download data) counts, once.
   */
  async onAssetMessageReceived(received: AssetMessage): Promise<void> {
    const wireMessage = this.withPreview(received);
    await this.inOrder(wireMessage.conversationId as QualifiedId, () => {
      const process = () => this.processAssetMessage(wireMessage);
      return this.deps.replyContext ? this.deps.replyContext.withMessage(wireMessage, process) : process();
    });
  }

  private async processAssetMessage(wireMessage: AssetMessage): Promise<void> {
    if (this.deps.createdConversations?.has(wireMessage.conversationId as QualifiedId)) return;
    const offerAttachment = this.deps.offerAttachment;
    const sender = wireMessage.sender as QualifiedId | undefined;
    if (!offerAttachment || !sender || sameQualifiedId(sender, this.deps.botUserId)) return;
    // No download data yet (the preview), or a self-deleting message, whose timer Wire must be able to keep.
    if (!wireMessage.remoteData || wireMessage.expiresAfterMillis) return;
    const fileKind = attachableKind(wireMessage.mimeType);
    const sizeInBytes = Number(wireMessage.sizeInBytes);
    if (!fileKind || !Number.isFinite(sizeInBytes) || sizeInBytes <= 0 || sizeInBytes > ATTACHMENT_MAX_BYTES) return;
    if (!this.firstSightOfAsset(wireMessage.id)) return;

    const convId = wireMessage.conversationId as QualifiedId;
    const log = this.deps.logger.child({ conversationId: convId.id, senderId: sender.id, messageId: wireMessage.id });

    const name = wireMessage.name?.trim() || (fileKind === "photo" ? "photo" : "file");
    try {
      const offered = await offerAttachment.execute({
        conversationId: convId, senderId: sender, messageId: wireMessage.id,
        file: { ref: { transport: "wire", data: wireMessage.remoteData }, fileKind, name, mimeType: wireMessage.mimeType, sizeInBytes },
      });
      log.debug("File received", { fileKind, offered });
    } catch (err) {
      log.error("File handler failed", { err: err instanceof Error ? err.name : "UnknownError" });
      return;
    }
    // Context for the next text message, without the file's name or content.
    const senderName = this.deps.memberCache.getMembers(convId).find((m) => sameQualifiedId(m.userId, sender))?.name ?? "";
    this.deps.messageBuffer.push(convId, {
      messageId: wireMessage.id, senderId: sender, senderName, text: fileKind === "photo" ? "(photo)" : "(file)", timestamp: new Date(),
    });
  }

  /**
   * What a file's preview said, by sender and message: the SDK takes the type, name and size only
   * from the preview part, so an upload event without it would read as an empty unknown file.
   * Bounded; an entry is used once.
   */
  private readonly assetPreviews = new Map<string, AssetPreview>();

  /**
   * The upload event completed with its preview's details, and the preview's time, which is the
   * message's time in clients and so the time its quote hash must use. A preview is remembered
   * and returned as it is.
   */
  private withPreview(message: AssetMessage): AssetMessage {
    const sender = message.sender as QualifiedId | undefined;
    const previewKey = JSON.stringify([message.conversationId.id, message.conversationId.domain, sender?.id, sender?.domain, message.id]);
    if (!message.remoteData) {
      this.assetPreviews.set(previewKey, {
        mimeType: message.mimeType, name: message.name ?? null, sizeInBytes: message.sizeInBytes,
        expiresAfterMillis: message.expiresAfterMillis ?? null, timestamp: message.timestamp,
      });
      if (this.assetPreviews.size > 200) this.assetPreviews.delete(this.assetPreviews.keys().next().value!);
      return message;
    }
    const preview = this.assetPreviews.get(previewKey);
    if (!preview) return message;
    this.assetPreviews.delete(previewKey);
    return {
      ...message,
      mimeType: message.mimeType && message.mimeType !== "*/*" ? message.mimeType : preview.mimeType,
      name: message.name ?? preview.name,
      sizeInBytes: Number(message.sizeInBytes) > 0 ? message.sizeInBytes : preview.sizeInBytes,
      expiresAfterMillis: message.expiresAfterMillis || preview.expiresAfterMillis,
      timestamp: preview.timestamp,
    };
  }

  /**
   * Work the requester is waiting for (the answer model, support commands), shown as the app
   * typing in the conversation while it runs.
   */
  private typing<T>(conversationId: QualifiedId, work: () => Promise<T>): Promise<T> {
    return this.deps.wireOutbound.withTyping(conversationId, work);
  }

  /** Recent file message IDs, so a repeated event is handled once; bounded. */
  private readonly seenAssets = new Set<string>();

  private firstSightOfAsset(messageId: string): boolean {
    if (this.seenAssets.has(messageId)) return false;
    this.seenAssets.add(messageId);
    if (this.seenAssets.size > 500) this.seenAssets.delete(this.seenAssets.values().next().value!);
    return true;
  }

  async onTextMessageEdited(_wireMessage: TextEditedMessage): Promise<void> {
    // Edits are intentionally ignored: an edited message could otherwise raise a second offer
    // or answer for the same message.
  }

  /**
   * A click on a button of an offer question. The offer is found by the clicked message and the
   * member who was asked; the button's ID must name that offer and one of its options. The first
   * accepted click of the asked member decides: only that click is confirmed (the confirmation
   * marks the answer for everyone) and runs the option through `ConfirmOffer`, which posts the
   * result as text; the question's message is closed with the answer. A click by another member
   * on an open question changes nothing and gets one text answer per message ("Only <requester>
   * can answer this."). A click on an answered, closed, expired, replaced or unknown question
   * (clients may send one shortly after the message was closed) changes nothing and gets no
   * answer. Repeats stay silent.
   */
  async onButtonClicked(wireMessage: CompositeButtonAction): Promise<void> {
    const convId = wireMessage.conversationId as QualifiedId;
    await this.inOrder(convId, () => this.processButtonClick(wireMessage));
  }

  private async processButtonClick(wireMessage: CompositeButtonAction): Promise<void> {
    const convId = wireMessage.conversationId as QualifiedId;
    const sender = wireMessage.sender as QualifiedId | undefined;
    if (!sender || sameQualifiedId(sender, this.deps.botUserId) || this.deps.createdConversations?.has(convId)) return;
    const { buttonId, referenceMessageId } = wireMessage;
    const log = this.deps.logger.child({ conversationId: convId.id, senderId: sender.id, messageId: referenceMessageId });
    const offers = this.deps.pendingOffers;
    try {
      const prompt = offers.prompt(convId, referenceMessageId);
      const live = prompt ? offers.find(convId, prompt.requesterId) : null;
      const open = !!prompt && !prompt.answered && !prompt.closed && !!live && live.id === prompt.offerId && live.messageId === referenceMessageId;

      if (prompt && open && !sameQualifiedId(sender, prompt.requesterId)) {
        log.info("Button: click by a member who was not asked");
        if (offers.claimNotice(convId, referenceMessageId, "others")) {
          await this.deps.wireOutbound.sendPlainText(convId, `Only ${this.memberName(convId, prompt.requesterId) ?? "the person who was asked"} can answer this.`);
        }
        return;
      }
      if (!prompt || !open || !live) {
        // Silent: the message is closed or about to be, and a client may not have applied the edit yet.
        log.info("Button: click on a question that is no longer open", { known: !!prompt, answered: prompt?.answered ?? false });
        return;
      }

      const parsed = parseOfferButtonId(buttonId);
      if (!parsed || parsed.offerId !== live.id || !decisionAt(live, parsed.index)) {
        log.warn("Button: the button does not belong to the offer");
        return;
      }

      // Accepted: this click decides. It is marked first, so any later click finds it answered.
      offers.markAnswered(convId, parsed.offerId);
      try {
        await this.deps.wireOutbound.sendButtonConfirmation(convId, referenceMessageId, buttonId);
      } catch (err) {
        log.warn("Failed to send button action confirmation", { err: err instanceof Error ? err.name : "UnknownError" });
      }
      const senderName = this.memberName(convId, sender);
      const decision = decisionAt(live, parsed.index);
      const run = () => this.deps.confirmOffer.choose({
        conversationId: convId, requesterId: sender, requesterName: senderName, offerId: parsed.offerId, index: parsed.index,
      });
      // An option that writes is work the requester waits for; declining is not.
      const chosen = decision?.command ? await this.typing(convId, run) : await run();
      log.info("Button: click accepted", { chosen });
      // Like a text answer: the requester's next interaction, which closes the offer for the
      // answer model and ends the question as the bot's latest.
      offers.forgetDropped(convId, sender);
      const label = (live.choices?.[parsed.index]?.label ?? YES_NO_LABELS[parsed.index]) ?? "";
      this.recordHandled(convId, `click-${wireMessage.id}`, sender, senderName, `(Chose "${label}".)`, "(Answered the offer above.)");
    } catch (err) {
      log.error("Button handler failed", { err: err instanceof Error ? err.name : "UnknownError" });
      try {
        await this.deps.wireOutbound.sendPlainText(convId, "Something went wrong. Please try again.");
      } catch (sendErr) {
        log.error("Failed to send error reply", { err: sendErr instanceof Error ? sendErr.name : "UnknownError" });
      }
    }
  }

  /** Closes the button questions that expired or were replaced; never fails the handler it follows. */
  private async closeEndedPrompts(): Promise<void> {
    try {
      await closeEndedOfferPrompts(this.promptClosing());
    } catch (err) {
      this.deps.logger.warn("Closing ended button questions failed", { err: err instanceof Error ? err.name : "UnknownError" });
    }
  }

  /** What closing a button question needs. */
  private promptClosing(logger: Logger = this.deps.logger): OfferPromptClosing {
    return { offers: this.deps.pendingOffers, wireOutbound: this.deps.wireOutbound, logger };
  }

  /** The member's cached display name in the conversation, or undefined. */
  private memberName(convId: QualifiedId, userId: QualifiedId): string | undefined {
    return this.deps.memberCache.getMembers(convId).find((m) => sameQualifiedId(m.userId, userId))?.name || undefined;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Startup hydration: called once after the SDK is initialised
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Pre-populate the member cache from the SDK's persisted conversation store so that
   * display names are available before the first message arrives after a restart.
   *
   * onAppAddedToConversation only fires when the bot is first added to a conversation,
   * not on subsequent restarts. This method covers that gap using the SDK's public
   * getAllConversations() / getMembersInConversation() API.
   *
   * Awaiting this before startListening() ensures no message arrives with an empty cache.
   */
  async hydrateFromSdkStore(
    conversations: Conversation[],
    getMembers: (conv: Conversation) => Promise<ConversationMember[]>,
  ): Promise<void> {
    await Promise.allSettled(
      conversations.map(async (conv) => {
        const convId: QualifiedId = { id: conv.id, domain: conv.domain };
        // Skip if the cache was already populated by a live onAppAddedToConversation event.
        if (this.deps.memberCache.getMembers(convId).length > 0) return;

        const rawMembers = await getMembers(conv);
        const members: CachedMember[] = rawMembers
          .filter((m) => !sameQualifiedId(m.userId, this.deps.botUserId))
          .map((m) => ({
            userId: { id: m.userId.id, domain: m.userId.domain },
            role: toCachedRole(m.role),
          }));

        this.deps.memberCache.setMembers(convId, members);

        // Fetch names now so they're ready for the first arriving message.
        await Promise.allSettled(
          members.map(async (m) => {
            const profile = await this.deps.wireOutbound.getUserProfile(m.userId);
            if (profile?.name) {
              this.deps.memberCache.updateMemberName(convId, m.userId, profile.name, profile.handle);
            }
          }),
        );
      }),
    );
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Conversation lifecycle events
  // ─────────────────────────────────────────────────────────────────────────

  async onAppAddedToConversation(conversation: Conversation, members: ConversationMember[]): Promise<void> {
    const convId = { id: conversation.id, domain: conversation.domain } as QualifiedId;
    // A group the app created for requester and agent: no welcome, no channel config; it is leaving.
    if (this.deps.createdConversations?.has(convId)) return;
    const channelId = toChannelId(convId);
    this.deps.memberCache.setMembers(convId, members.map((m) => ({
      userId: m.userId as QualifiedId,
      role: toCachedRole(m.role),
    })));

    // Resolve display names for all non-bot members before returning, so names are in the
    // cache before the first message from any member in this conversation is processed.
    await Promise.allSettled(
      members
        .filter((m) => !sameQualifiedId(m.userId, this.deps.botUserId))
        .map(async (m) => {
          const profile = await this.deps.wireOutbound.getUserProfile(m.userId as QualifiedId);
          if (profile?.name) {
            this.deps.memberCache.updateMemberName(convId, m.userId as QualifiedId, profile.name, profile.handle);
          }
        }),
    );

    try {
      const existing = await this.deps.channelConfig.get(channelId);
      await this.deps.channelConfig.upsert({
        channelId,
        organisationId: convId.domain,
        timezone: existing?.timezone ?? this.deps.defaultTimezone ?? "UTC",
      });
    } catch { /* non-fatal */ }

    try {
      await this.deps.wireOutbound.sendPlainText(convId, welcomeText(this.deps.supportWelcome));
    } catch { /* non-fatal */ }
  }

  async onConversationDeleted(conversationId: QualifiedId): Promise<void> {
    const channelId = toChannelId(conversationId);
    this.deps.memberCache.clearConversation(conversationId as QualifiedId);
    await this.deps.processingQueue?.cancelChannel(channelId);
    this.deps.messageBuffer.clear(conversationId);
    this.deps.pendingOffers.clearConversation(conversationId);
  }

  async onUserJoinedConversation(conversationId: QualifiedId, members: ConversationMember[]): Promise<void> {
    if (this.deps.createdConversations?.has(conversationId)) return;
    this.deps.memberCache.addMembers(conversationId as QualifiedId, members.map((m) => ({
      userId: m.userId as QualifiedId,
      role: toCachedRole(m.role),
    })));

    // Resolve names for newly joined members before returning.
    await Promise.allSettled(
      members
        .filter((m) => !sameQualifiedId(m.userId, this.deps.botUserId))
        .map(async (m) => {
          const profile = await this.deps.wireOutbound.getUserProfile(m.userId as QualifiedId);
          if (profile?.name) {
            this.deps.memberCache.updateMemberName(conversationId as QualifiedId, m.userId as QualifiedId, profile.name, profile.handle);
          }
        }),
    );
  }

  async onUserLeftConversation(conversationId: QualifiedId, members: QualifiedId[]): Promise<void> {
    this.deps.memberCache.removeMembers(conversationId as QualifiedId, members as QualifiedId[]);
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Addressing
  // ─────────────────────────────────────────────────────────────────────────

  private startsWithBotName(lowered: string): boolean {
    return /^@?(?:wire support bot)\b/i.test(lowered);
  }

  private stripAddressedBotPrefix(text: string, message: TextMessage): string {
    // Wire protobuf mention offsets count UTF-16 code units, as does JS slice.
    // Use the qualified mention identity; registered app labels can change.
    const mention = message.mentions?.find(m =>
      sameQualifiedId(m.userId, this.deps.botUserId)
      && Number.isInteger(m.offset) && Number.isInteger(m.length)
      && m.offset >= 0 && m.length > 0 && m.offset + m.length <= text.length
      && text.slice(0, m.offset).trim() === "" && text[m.offset] === "@",
    );
    if (mention) return text.slice(mention.offset + mention.length).replace(/^[,:]?\s*/, "").trim();
    return this.stripBotPrefix(text);
  }

  private stripBotPrefix(lowered: string): string {
    // Strip @Wire Support Bot or Wire Support Bot, optionally followed by a parenthetical display-name
    // suffix like (DEV) or (Test), then any trailing comma/colon and whitespace.
    return lowered.replace(/^@?(?:wire support bot)(?:\s+\([^)]+\))?[,:]?\s*/i, "").trim();
  }
}
