import type { QualifiedId } from "../../../domain/ids/QualifiedId";
import { DEFAULT_PART_ASSET, PART_DETAIL_MAX } from "../../../domain/entities/SupportRequest";
import type { PartAssetWording, PartDetails } from "../../../domain/entities/SupportRequest";
import type { OfferCommand, PendingOffer, PendingOfferStore } from "../../ports/PendingOfferPort";
import type { SupportTriagePort } from "../../ports/SupportTriagePort";
import type { WireOutboundPort } from "../../ports/WireOutboundPort";
import type { Logger } from "../../ports/Logger";
import { PART_DETAIL_KEYS, missingPartDetails } from "../../services/offers";
import { statedPartDetails } from "../../services/partDetails";
import { askPartOrderStep } from "../../services/partOrderSteps";
import { answeredLine, closeOfferPrompt } from "../../services/offerPromptClosing";

/** Input of `CompletePartOrder`. */
export interface CompletePartOrderInput {
  /** The requester's next message after a part order with missing essentials. */
  text: string;
  conversationId: QualifiedId;
  requesterId: QualifiedId;
  /** The part-order draft the router just took from the requester's pending offers. */
  pending: OfferCommand;
  /**
   * The question the draft was asked with, when it had buttons: once this message moves the order
   * on, its message is closed with "Answered by <name>: <value>".
   */
  answering?: Pick<PendingOffer, "messageId" | "fillsPart">;
  /** Wire display name of the requester, for the closing line. */
  requesterName?: string;
  replyToMessageId?: string;
}

/**
 * Fills a part order that still lacks essentials from the requester's next message, without
 * depending on the answer model returning a revised offer. The triage model only reports which
 * essentials this message states; code merges them into the draft (a value in this message
 * replaces an earlier one), then asks the order's next question (see `partOrderStep`). The
 * message text and the part values are never logged.
 */
export class CompletePartOrder {
  constructor(
    private readonly triage: SupportTriagePort,
    private readonly offers: PendingOfferStore,
    private readonly wireOutbound: WireOutboundPort,
    private readonly logger?: Logger,
    private readonly now: () => Date = () => new Date(),
    /** How the asset essential is named and asked for. */
    private readonly partAsset: PartAssetWording = DEFAULT_PART_ASSET,
    /** Delivery locations offered as buttons; empty asks for the location in text. */
    private readonly deliveryLocations: readonly string[] = [],
  ) {}

  /** True when it replied (a question for what is still missing, or the complete offer) and stored the updated draft. */
  async execute(input: CompletePartOrderInput): Promise<boolean> {
    const pending = input.pending;
    // Any part-order draft: an incomplete one is filled, a complete one corrected ("actually three").
    if (pending.kind !== "support" || pending.requestKind !== "part") return false;

    let extracted: PartDetails;
    try {
      extracted = statedPartDetails(boundedDetails(await this.triage.extractPartDetails(input.text)), input.text);
    } catch (err) {
      this.logger?.warn("CompletePartOrder: extractPartDetails failed", { err: errorName(err) });
      return false;
    }
    if (Object.keys(extracted).length === 0) return false;

    const command: Extract<OfferCommand, { kind: "support" }> = {
      kind: "support",
      requestKind: "part",
      summary: pending.summary,
      description: pending.description,
      part: { ...pending.part, ...extracted },
    };
    // A message that restates what the draft already holds is not an answer; leave it to normal routing.
    if (PART_DETAIL_KEYS.every((key) => (command.part?.[key] ?? "") === (pending.part?.[key] ?? ""))) return false;
    // A changed earlier value is shown with the question, so no overwrite goes unseen.
    const changed = PART_DETAIL_KEYS.some((key) => pending.part?.[key] && command.part?.[key] !== pending.part[key]);
    try {
      // The next question: free-text essentials, then the quantity and the delivery location
      // with buttons, then the complete order with [Yes] [No].
      await askPartOrderStep(
        { wireOutbound: this.wireOutbound, offers: this.offers, now: this.now, asset: this.partAsset, deliveryLocations: this.deliveryLocations },
        { conversationId: input.conversationId, requesterId: input.requesterId, replyToMessageId: input.replyToMessageId },
        command,
        { soFar: changed },
      );
    } catch (err) {
      this.logger?.warn("CompletePartOrder: sending the reply failed", { err: errorName(err) });
      return false;
    }
    if (input.answering?.messageId) {
      await closeOfferPrompt(
        { offers: this.offers, wireOutbound: this.wireOutbound, logger: this.logger },
        input.conversationId, input.answering.messageId, answeredLine(input.requesterName, answeredValue(extracted, pending, input.answering.fillsPart)),
      );
    }
    this.logger?.debug("CompletePartOrder: part order updated", { missing: missingPartDetails(command).length });
    return true;
  }
}

/**
 * The value shown as the answer to the old question: the essential it asked for when this message
 * states it, otherwise the values this message changed, in the usual order.
 */
function answeredValue(extracted: PartDetails, pending: Extract<OfferCommand, { kind: "support" }>, asked: PendingOffer["fillsPart"]): string {
  if (asked && extracted[asked]) return extracted[asked]!;
  return PART_DETAIL_KEYS.filter((key) => extracted[key] && extracted[key] !== pending.part?.[key]).map((key) => extracted[key]!).join(", ");
}

/** Words a small model may write instead of JSON null; never a real value. */
const PLACEHOLDERS = new Set(["null", "none", "unknown", "not stated", "not given", "not specified", "n/a", "na", "-", "?", "tbd"]);

/**
 * The essentials the model reported, each collapsed to one line. A value that is empty, not
 * text, longer than `PART_DETAIL_MAX` or a placeholder is left out, so it never replaces an
 * earlier value.
 */
function boundedDetails(details: PartDetails | null | undefined): PartDetails {
  const bounded: PartDetails = {};
  if (!details || typeof details !== "object") return bounded;
  for (const key of PART_DETAIL_KEYS) {
    const raw: unknown = details[key];
    const value = typeof raw === "string" ? raw.replace(/\s+/g, " ").trim() : "";
    if (value && value.length <= PART_DETAIL_MAX && !PLACEHOLDERS.has(value.toLowerCase())) bounded[key] = value;
  }
  return bounded;
}


function errorName(err: unknown): string {
  return err instanceof Error ? err.name : "UnknownError";
}
