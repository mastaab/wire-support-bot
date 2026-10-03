/**
 * ProcessingPipeline: passive service-desk help for unaddressed messages.
 *
 * Classifies the message into the service-desk categories and, for one of them, calls the
 * passive-help use case, which may offer to raise, add to or resolve a request, or answer a
 * status question. Nothing is extracted or stored here: the message text goes to the models
 * and is then forgotten.
 *
 * This class is the worker function of InMemoryProcessingQueue, which keeps the messages of a
 * channel in order and cancels queued work when the bot leaves. All errors are caught and
 * logged; the pipeline never throws.
 */

import type { ClassifierPort, ClassifyResult, MessageCategory } from "../../application/ports/ClassifierPort";
import type { ChannelConfigRepository } from "../../domain/repositories/ChannelConfigRepository";
import type { WireOutboundPort } from "../../application/ports/WireOutboundPort";
import type { Logger } from "../../application/ports/Logger";
import { sameQualifiedId, type QualifiedId } from "../../domain/ids/QualifiedId";
import type { ConversationMessageBuffer } from "../../application/services/ConversationMessageBuffer";
import type { OfferSupportFromConversationPort } from "../../application/usecases/jira/OfferSupportFromConversation";

export interface MessageJob {
  messageId: string;
  channelId: string;
  conversationId: QualifiedId;
  senderId: QualifiedId;
  senderName: string;
  text: string;
  timestamp: Date;
}

export interface PipelineDeps {
  classifier: ClassifierPort;
  /** Passive service-desk help. */
  supportHelp: OfferSupportFromConversationPort;
  /** The channel's timezone, for reply times in a status answer. */
  channelConfig: ChannelConfigRepository;
  /** Recent messages of the conversation, as context for the classifier. */
  messageBuffer: ConversationMessageBuffer;
  /** The bot's own messages are left out of the classifier's context. */
  botUserId: QualifiedId;
  wireOutbound: WireOutboundPort;
  logger: Logger;
}

/** Categories passed on to passive help: updates and blockers may add to or resolve an open request. */
const SERVICE_DESK_CATEGORIES: readonly MessageCategory[] = ["service_request", "request_status", "update", "blocker"];

/** Recent messages read for the classifier's context. */
const RECENT_READ = 10;

export class ProcessingPipeline {
  constructor(private readonly deps: PipelineDeps) {}

  async process(job: MessageJob, signal?: AbortSignal): Promise<void> {
    try { await this.processMessage(job, signal); }
    catch (err) { this.deps.logger.error("Pipeline processing failed", { channelId: job.channelId, messageId: job.messageId, errorType: err instanceof Error ? err.name : "UnknownError" }); }
  }

  private async processMessage(job: MessageJob, signal?: AbortSignal): Promise<void> {
    const { channelId, conversationId, messageId, text } = job;
    const log = this.deps.logger.child({ channelId, messageId });
    if (signal?.aborted) return;

    const recent = this.deps.messageBuffer.getLastN(conversationId, RECENT_READ)
      .filter((m) => !sameQualifiedId(m.senderId, this.deps.botUserId))
      .map((m) => `[${m.senderName || m.senderId.id}] ${m.text}`);

    let result: ClassifyResult;
    try {
      result = await this.deps.classifier.classify(text, { channelId }, recent);
    } catch (err) {
      log.warn("Pipeline: classify failed", { err: (err instanceof Error ? err.name : "UnknownError") });
      return;
    }
    if (signal?.aborted) return;
    log.debug("Pipeline: classify", { categories: result.categories, confidence: result.confidence });

    if (!result.categories.some((category) => SERVICE_DESK_CATEGORIES.includes(category))) return;

    let timezone: string | undefined;
    try {
      timezone = (await this.deps.channelConfig.get(channelId))?.timezone;
    } catch {
      log.warn("Pipeline: channel timezone unavailable, answering in UTC");
    }
    if (signal?.aborted) return;
    await this.offerSupportHelp(job, result, timezone, log, signal);
  }

  /** Calls passive help; its failures are logged and never thrown. */
  private async offerSupportHelp(
    job: MessageJob, result: ClassifyResult, timezone: string | undefined, log: Logger, signal?: AbortSignal,
  ): Promise<void> {
    // A service request or status question usually gets an offer or a status answer, so the
    // sender sees the app typing while the model drafts it. Updates and blockers are checked
    // against open requests too, but rarely answered, so they show nothing.
    const likelyAnswered = result.categories.some((category) => category === "service_request" || category === "request_status");
    const help = () => this.deps.supportHelp.execute({
      text: job.text,
      messageId: job.messageId,
      conversationId: job.conversationId,
      senderId: job.senderId,
      senderName: job.senderName || undefined,
      categories: result.categories,
      confidence: result.confidence,
      timezone,
      signal,
    });
    try {
      await (likelyAnswered ? this.deps.wireOutbound.withTyping(job.conversationId, help) : help());
    } catch (err) {
      log.warn("Pipeline: passive service-desk help failed", { err: (err instanceof Error ? err.name : "UnknownError") });
    }
  }
}
