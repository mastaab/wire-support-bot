import type { QualifiedId } from "../../../domain/ids/QualifiedId";
import { DEFAULT_PART_ASSET } from "../../../domain/entities/SupportRequest";
import type { PartAssetWording } from "../../../domain/entities/SupportRequest";
import {
  NOTHING_TO_CONFIRM_REPLY, formatMissingPartsQuestion, formatStillMissingReply, missingPartDetails, offerCommandLine,
} from "../../services/offers";
import type { OfferCommand, PendingOfferStore } from "../../services/offers";
import type { WireOutboundPort } from "../../ports/WireOutboundPort";
import type { RaiseSupportRequest } from "./RaiseSupportRequest";
import type { ReplyToServiceDesk } from "./ReplyToServiceDesk";
import type { ResolveSupportRequest } from "./ResolveSupportRequest";
import type { AttachFileToRequest } from "./AttachFileToRequest";
import { describeFile } from "../../services/attachments";

export type Confirmation = "yes" | "no";

/** Each use case re-validates scope, state and bounds at the moment the offer is confirmed. */
export interface ConfirmOfferHandlers {
  raiseSupportRequest: RaiseSupportRequest;
  replyToServiceDesk: ReplyToServiceDesk;
  resolveSupportRequest: ResolveSupportRequest;
  /** Absent when attachments are not wired; an attach offer is then never made. */
  attachFileToRequest?: AttachFileToRequest;
}

export interface ConfirmOfferInput {
  text: string;
  conversationId: QualifiedId;
  requesterId: QualifiedId;
  /** Wire display name of the requester, for the requester line of a `support` offer. */
  requesterName?: string;
  replyToMessageId?: string;
}

/** Explicit forms only: the bot asks "(yes or no)?", so "ok" or "sure" does not approve a write. */
const YES: ReadonlySet<string> = new Set([
  "yes", "yes please", "yep", "yeah", "go ahead", "do it", "please do", "confirm", "confirmed",
]);
const NO: ReadonlySet<string> = new Set(["no", "n", "nope", "no thanks", "cancel", "don't", "do not", "stop"]);

/**
 * Casual replies that answer the offer without deciding it. They never confirm a write; the
 * bot asks again and keeps the offer, instead of dropping it while the requester thinks it
 * is still open.
 */
const ACKNOWLEDGEMENTS: ReadonlySet<string> = new Set([
  "ok", "okay", "k", "sure", "y", "thanks", "thank you", "cheers", "cool", "great", "fine", "alright", "all right",
]);

/** True for a bare acknowledgement such as "ok" or "ok thanks", which is not a decision. */
export function isAcknowledgement(text: string): boolean {
  const normalised = normalise(text);
  if (!normalised) return false;
  return [normalised, normalise(stripCourtesy(normalised))].some((c) => ACKNOWLEDGEMENTS.has(c));
}

/**
 * Classifies a short confirmation reply. Only the listed forms count, optionally with
 * trailing punctuation, backticks or a trailing "thanks", "thank you" or "please"; anything
 * longer ("yes but change the owner first") is not a confirmation.
 */
export function classifyConfirmation(text: string): Confirmation | null {
  const normalised = normalise(text);
  if (!normalised) return null;
  const candidates = [normalised, normalise(stripCourtesy(normalised))];
  if (candidates.some(c => YES.has(c))) return "yes";
  if (candidates.some(c => NO.has(c))) return "no";
  return null;
}

function normalise(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/[‘’]/g, "'")
    .replace(/`/g, "")
    .replace(/[\s.!?,;:]+$/, "")
    .replace(/\s+/g, " ")
    .trim();
}

function stripCourtesy(text: string): string {
  return text.replace(/[\s,]+(thanks|thank you|please)$/, "");
}

/**
 * Runs a pending offer when its requester confirms it. The offer is consumed once, and the
 * dispatched use case re-validates scope and state at that moment.
 *
 * The router calls this when the requester has a live offer (`has`) or a recently dropped or
 * expired one (`recentlyDropped`), so a bare yes after a drop is answered instead of ignored.
 */
export class ConfirmOffer {
  constructor(
    private readonly offers: PendingOfferStore,
    private readonly handlers: ConfirmOfferHandlers,
    private readonly wireOutbound: WireOutboundPort,
    private readonly now: () => Date = () => new Date(),
    /** How the asset essential of a part order is named and asked for. */
    private readonly partAsset: PartAssetWording = DEFAULT_PART_ASSET,
  ) {}

  /**
   * True when the message confirmed or declined this requester's pending offer, or was a yes
   * answered with "nothing waiting" because the offer was recently dropped or expired.
   */
  async execute(input: ConfirmOfferInput): Promise<boolean> {
    const answer = classifyConfirmation(input.text);
    const now = this.now();
    if (!answer) {
      if (!isAcknowledgement(input.text) || !this.offers.has(input.conversationId, input.requesterId, now)) return false;
      const pending = this.offers.take(input.conversationId, input.requesterId, now);
      if (!pending) return false;
      // Keep the offer and ask again: an acknowledgement is a response, but not a decision.
      this.offers.put(pending);
      await this.wireOutbound.sendPlainText(input.conversationId, askAgain(pending.command, this.partAsset), { replyToMessageId: input.replyToMessageId });
      return true;
    }

    const offer = this.offers.has(input.conversationId, input.requesterId, now)
      ? this.offers.take(input.conversationId, input.requesterId, now)
      : null;
    if (!offer) return answer === "yes" ? this.nothingToConfirm(input, now) : false;

    const { conversationId, requesterId: actorId, replyToMessageId } = input;
    if (answer === "no") {
      await this.wireOutbound.sendPlainText(conversationId, "Understood, I won't.", { replyToMessageId });
      return true;
    }

    const command = offer.command;
    const missing = missingPartDetails(command);
    if (missing.length > 0) {
      // An incomplete part order can only be amended: keep it so the next answer can fill it.
      this.offers.put(offer);
      await this.wireOutbound.sendPlainText(conversationId, formatStillMissingReply(missing, this.partAsset), { replyToMessageId });
      return true;
    }
    switch (command.kind) {
      case "support":
        await this.handlers.raiseSupportRequest.execute({
          summary: command.summary, description: command.description, conversationId, requesterId: actorId,
          requesterName: input.requesterName, replyToMessageId, requestKind: command.requestKind,
          ...(command.part ? { part: command.part } : {}),
        });
        break;
      case "reply":
        await this.handlers.replyToServiceDesk.execute({
          reference: command.issueKey, body: command.body, conversationId, actorId, replyToMessageId,
        });
        break;
      case "resolve":
        await this.handlers.resolveSupportRequest.execute({
          issueKey: command.issueKey, conversationId, actorId, replyToMessageId,
          ...(command.comment ? { comment: command.comment } : {}),
        });
        break;
      case "attach":
        if (!this.handlers.attachFileToRequest) {
          await this.wireOutbound.sendPlainText(conversationId, "I'm afraid I can't add files to requests here, so nothing was sent.", { replyToMessageId });
          break;
        }
        await this.handlers.attachFileToRequest.execute({
          issueKey: command.issueKey, file: command.file, conversationId, actorId,
          senderName: input.requesterName, replyToMessageId,
        });
        break;
    }
    return true;
  }

  /**
   * A yes with no live offer: when the requester's offer was recently dropped or expired, say
   * that nothing was done and give its command, once: the memory is then forgotten, so a later
   * yes meant for someone else is not answered. Otherwise the yes is not handled here.
   */
  private async nothingToConfirm(input: ConfirmOfferInput, now: Date): Promise<boolean> {
    const dropped = this.offers.recentlyDropped(input.conversationId, input.requesterId, now);
    if (!dropped) return false;
    this.offers.forgetDropped(input.conversationId, input.requesterId);
    await this.wireOutbound.sendPlainText(input.conversationId, `${NOTHING_TO_CONFIRM_REPLY}\n${offerCommandLine(dropped)}`, {
      replyToMessageId: input.replyToMessageId,
    });
    return true;
  }
}

/** The code-written re-ask after an acknowledgement; it ends with a question like the offer itself. */
function askAgain(command: OfferCommand, asset: PartAssetWording): string {
  const missing = missingPartDetails(command);
  if (missing.length > 0) return formatMissingPartsQuestion(missing, asset);
  switch (command.kind) {
    case "support":
      return "I need a clear yes or no, so I haven't raised anything with the service desk yet. Shall I raise it (yes or no)?";
    case "resolve":
      return command.comment
        ? `I need a clear yes or no, so I haven't resolved **${command.issueKey}** yet. Shall I add the comment and resolve it (yes or no)?`
        : `I need a clear yes or no, so I haven't resolved **${command.issueKey}** yet. Shall I resolve it with the service desk (yes or no)?`;
    case "reply":
      return `I need a clear yes or no, so I haven't added this to **${command.issueKey}** yet. Shall I add it (yes or no)?`;
    case "attach":
      return `I need a clear yes or no, so I haven't added ${describeFile(command.file)} to **${command.issueKey}** yet. Shall I add it (yes or no)?`;
  }
}
