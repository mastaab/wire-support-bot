import type { SupportRequest } from "../../../domain/entities/SupportRequest";
import type { SupportRequestRepository } from "../../../domain/repositories/SupportRequestRepository";
import { sameQualifiedId, type QualifiedId } from "../../../domain/ids/QualifiedId";
import type { DeskUpdateTarget, OfferChoice, PendingOfferStore } from "../../ports/PendingOfferPort";
import type { WireConversationPort, WireUserRef } from "../../ports/WireConversationPort";
import type { SentMessageRef, WireOutboundPort } from "../../ports/WireOutboundPort";
import type { Logger } from "../../ports/Logger";
import { holdsQuestionSlot, newOfferId, offerPromptFields, sendOfferPrompt, withoutAnswerHint } from "../../services/offerButtons";
import { REPLACED_LINE, closeEndedOfferPrompts, closedPromptText } from "../../services/offerPromptClosing";
import type { OpenAgentConversation } from "./OpenAgentConversation";
import { findSupportRequestInConversation } from "./supportRequestScope";

const SOURCE = "AskForAgentConversation";

/** How the bot handles a newly assigned mapped agent (WIRE_SUPPORT_BOT_JIRA_AGENT_CHAT). */
export type AgentChatMode = "ask" | "auto" | "off";

/** The default: ask the requester first. */
export const AGENT_CHAT_MODE_DEFAULT: AgentChatMode = "ask";

/** What asking came to: asked, nothing to ask, the requester's slot is taken, or a failure to retry. */
export type AskForAgentConversationOutcome = "asked" | "skipped" | "busy" | "failed";

/**
 * The question, with its text answer hint in the last paragraph (left out when sent with buttons).
 * Names the requester, since every member sees it.
 */
export function agentChatQuestion(issueKey: string, agentName: string, requesterName?: string): string {
  const name = requesterName?.trim();
  const agent = agentName.trim() || "an agent";
  const lead = name ? `${name}, the service desk assigned` : "The service desk assigned";
  return `${lead} ${agent} to **${issueKey}**. Would you like a direct conversation with them?\n\n(open or not now)?`;
}

/** The options, in button order: [Open direct chat] opens the group, [Not now] only closes the question. */
export function agentChatChoices(issueKey: string, agentHandle: string): OfferChoice[] {
  return [
    {
      label: "Open direct chat",
      answers: ["open", "yes", "yes please", "open it", "open chat", "open direct chat", "open a direct chat", "direct chat", "chat"],
      command: null,
      then: { kind: "openAgentChat", issueKey, agentHandle },
    },
    { label: "Not now", answers: ["not now", "no", "no thanks", "nope", "later", "not yet", "maybe later"], command: null },
  ];
}

/** The reply when [Open direct chat] could not open the group. */
export function agentChatFailed(issueKey: string): string {
  return `I'm afraid I couldn't open the direct conversation for **${issueKey}**.`;
}

/** The reply when the request was resolved before [Open direct chat] was picked. */
export function agentChatRequestDone(issueKey: string): string {
  return `**${issueKey}** is already resolved, so I haven't opened a direct conversation.`;
}

export interface AskForAgentConversationDeps {
  requests: SupportRequestRepository;
  conversations: WireConversationPort;
  offers: PendingOfferStore;
  wireOutbound: WireOutboundPort;
  open: OpenAgentConversation;
  /** Project of the tracker, for the scope check when the answer comes. */
  projectKey: string;
  /** How long the question can be answered. */
  lifetimeMs: number;
  logger?: Logger;
  now?: () => Date;
}

export interface AcceptAgentConversationInput {
  issueKey: string;
  agentHandle: string;
  conversationId: QualifiedId;
  requesterId: QualifiedId;
  replyToMessageId?: string;
}

/**
 * The agent conversation as an opt-in (WIRE_SUPPORT_BOT_JIRA_AGENT_CHAT=ask). When the watch sees
 * a mapped agent newly assigned to an open request, it calls `ask` instead of opening the group:
 * the requester is asked in the request's conversation whether they want a direct conversation
 * with the agent, [Open direct chat] [Not now]. The question uses the requester's question slot
 * like a desk-update question: it is not asked over another open question ("busy", and the watch
 * asks again at its next check), it replaces an open desk-update question, a later desk-update
 * question does not replace it, and any question or file the requester starts does. It is never
 * stored as the request's last message. Asking claims the request (`markAgentConversation`), so
 * it is asked once per request; a "busy" or failed attempt claims nothing.
 *
 * `accept` runs for [Open direct chat] (click or text): the request is checked again (in this
 * conversation, not deleted, not done) and `OpenAgentConversation` opens the group with all its
 * checks, storage, leave and retry. [Not now] only closes the question.
 */
export class AskForAgentConversation {
  constructor(private readonly deps: AskForAgentConversationDeps) {}

  get lifetimeMs(): number {
    return this.deps.lifetimeMs;
  }

  async ask(request: SupportRequest, agentHandle: string): Promise<AskForAgentConversationOutcome> {
    const { conversationId, requesterId, key } = request;
    if (this.busy(conversationId, requesterId)) {
      this.deps.logger?.debug(`${SOURCE}: the requester has an open question; asking later`, { key });
      return "busy";
    }

    let agent: WireUserRef | null;
    try {
      agent = await this.deps.conversations.findUserByHandle(agentHandle);
    } catch (err) {
      this.deps.logger?.warn(`${SOURCE}: resolving the agent failed`, { key, err: errorName(err) });
      return "failed";
    }
    if (!agent) {
      this.deps.logger?.warn(`${SOURCE}: the agent's handle did not resolve`, { key });
      return "skipped";
    }
    if (sameQualifiedId(agent.id, requesterId)) {
      this.deps.logger?.info(`${SOURCE}: the agent is the requester`, { key });
      return "skipped";
    }

    const question = agentChatQuestion(key, agent.name, request.requesterName);
    const choices = agentChatChoices(key, agentHandle);
    const offerId = newOfferId();
    let sent: SentMessageRef | undefined;
    try {
      sent = await sendOfferPrompt(this.deps.wireOutbound, conversationId, question, offerId, choices);
    } catch (err) {
      this.deps.logger?.warn(`${SOURCE}: sending the question failed`, { key, err: errorName(err) });
      return "failed";
    }
    // Another question may have been asked meanwhile; it is kept and this one is closed and asked later.
    if (this.busy(conversationId, requesterId)) {
      this.deps.logger?.debug(`${SOURCE}: another question was asked meanwhile; asking later`, { key });
      if (sent) await this.closeUnstored(conversationId, sent.messageId, question);
      return "busy";
    }

    const now = this.now();
    let claimed: boolean;
    try {
      claimed = await this.deps.requests.markAgentConversation(key, now);
    } catch (err) {
      this.deps.logger?.error(`${SOURCE}: claiming the request failed`, { key, err: errorName(err) });
      if (sent) await this.closeUnstored(conversationId, sent.messageId, question);
      return "failed";
    }
    if (!claimed) {
      if (sent) await this.closeUnstored(conversationId, sent.messageId, question);
      return "skipped";
    }

    const target: DeskUpdateTarget = { issueKey: key, summary: request.summary };
    this.deps.offers.put({
      // Remembered as declined once dropped or expired: nothing to confirm later.
      command: { kind: "reply", issueKey: key, body: "" },
      conversationId,
      requesterId,
      createdAt: now,
      expiresAt: new Date(now.getTime() + this.deps.lifetimeMs),
      ...offerPromptFields(offerId, sent, question),
      choices,
      deskUpdate: target,
      keepsSlot: true,
    });
    // A desk-update question it replaced is closed now, not at the next sweep.
    try {
      await closeEndedOfferPrompts({ offers: this.deps.offers, wireOutbound: this.deps.wireOutbound, logger: this.deps.logger });
    } catch (err) {
      this.deps.logger?.warn(`${SOURCE}: closing ended questions failed`, { err: errorName(err) });
    }
    return "asked";
  }

  /**
   * [Open direct chat]: opens the group for the request, when it is still a request of this
   * conversation and not done. A request gone or out of scope, a skipped or failed open gets one
   * short reply; an opened group posts its own notice. Never throws.
   */
  async accept(input: AcceptAgentConversationInput): Promise<void> {
    const { issueKey: key, conversationId, replyToMessageId } = input;
    const reply = async (text: string): Promise<void> => {
      try {
        await this.deps.wireOutbound.sendPlainText(conversationId, text, { replyToMessageId });
      } catch (err) {
        this.deps.logger?.warn(`${SOURCE}: sending the reply failed`, { key, err: errorName(err) });
      }
    };
    let request: SupportRequest | null;
    try {
      request = await findSupportRequestInConversation(this.deps.requests, key, conversationId, this.deps.projectKey);
    } catch (err) {
      this.deps.logger?.warn(`${SOURCE}: reading the request failed`, { key, err: errorName(err) });
      await reply(agentChatFailed(key));
      return;
    }
    if (!request || !sameQualifiedId(request.requesterId, input.requesterId)) {
      this.deps.logger?.info(`${SOURCE}: the request is no longer the requester's in this conversation`, { key });
      await reply(agentChatFailed(key));
      return;
    }
    if (request.statusCategory === "done") {
      await reply(agentChatRequestDone(key));
      return;
    }
    let outcome;
    try {
      outcome = await this.deps.open.execute({ request, agentHandle: input.agentHandle, claimed: true });
    } catch (err) {
      this.deps.logger?.warn(`${SOURCE}: opening the conversation failed`, { key, err: errorName(err) });
      outcome = "failed" as const;
    }
    if (outcome !== "opened") await reply(agentChatFailed(key));
  }

  /**
   * True when the requester has an open question this one must not replace: anything but a
   * question the bot asked on its own, such as a desk-update question (another agent-conversation
   * question counts).
   */
  private busy(conversationId: QualifiedId, requesterId: QualifiedId): boolean {
    return holdsQuestionSlot(this.deps.offers.find(conversationId, requesterId, this.now()));
  }

  private async closeUnstored(conversationId: QualifiedId, messageId: string, question: string): Promise<void> {
    try {
      await this.deps.wireOutbound.closeButtonPrompt(conversationId, messageId, closedPromptText(withoutAnswerHint(question), REPLACED_LINE));
    } catch (err) {
      this.deps.logger?.warn("Closing a button question failed", { err: errorName(err) });
    }
  }

  private now(): Date {
    return this.deps.now ? this.deps.now() : new Date();
  }
}

function errorName(err: unknown): string {
  return err instanceof Error ? err.name : "UnknownError";
}
