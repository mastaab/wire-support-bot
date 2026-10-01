import type { PartDetails, SupportRequestKind } from "../../domain/entities/SupportRequest";
import type { QualifiedId } from "../../domain/ids/QualifiedId";
import type { InboundAssetRef } from "./WireAssetPort";

/**
 * Port for offers made by the answer path and confirmed by the requester. The model only
 * proposes a command; code validates it, stores it here, and runs it after confirmation.
 */

export type OfferCommand =
  /**
   * Raise a new support request: `summary` becomes the ticket title, `description` its body,
   * `requestKind` picks the request type. A part order carries its essentials in `part`; while
   * any is missing (see `missingPartDetails`) the offer can be amended but not confirmed.
   */
  | { kind: "support"; requestKind: SupportRequestKind; summary: string; description: string; part?: PartDetails }
  | { kind: "reply"; issueKey: string; body: string }
  /** Resolve a request; a `comment` is sent to it as a customer-facing reply first. */
  | { kind: "resolve"; issueKey: string; comment?: string }
  /**
   * Attach a photo or document posted in the channel to a request. Only code makes this offer
   * (never the answer model), and it cannot be amended: the file is fixed.
   */
  | { kind: "attach"; issueKey: string; file: InboundFile };

/** A file posted in Wire, as offered for attaching: the download reference and what it is, never its bytes. */
export interface InboundFile {
  /** Opaque download reference from the transport (key material included); held only while the offer lives. */
  ref: InboundAssetRef;
  /** "photo" for images, "file" for documents; picks the wording. */
  fileKind: "photo" | "file";
  /** File name as posted, used as the attachment name; a generic name when absent. */
  name: string;
  mimeType: string;
  sizeInBytes: number;
}

/**
 * One option of a choice offer, in button order. Code builds every option from validated data
 * (stored requests of the conversation, the drafted command); model output never adds one.
 */
export interface OfferChoice {
  /** The button label. */
  label: string;
  /**
   * Text answers that pick this option, lower case, besides the option's number. The first one
   * is shown in the question, for example "SD-41", "new" or "cancel".
   */
  answers: readonly string[];
  /** What the option runs once picked; null declines the offer. */
  command: OfferCommand | null;
}

/** The part-order essentials asked for with buttons: a quick quantity or a configured delivery location. */
export type ChoosablePartDetail = "quantity" | "deliverTo";

export interface PendingOffer {
  /**
   * For a yes-or-no offer, what a yes runs. For a choice offer, the option the bot would
   * otherwise have offered, used only to name the offer after it was dropped.
   */
  command: OfferCommand;
  conversationId: QualifiedId;
  /** Only this member's confirmation counts. */
  requesterId: QualifiedId;
  createdAt: Date;
  expiresAt: Date;
  /** Opaque ID; the offer's buttons carry it with the option's index. Absent for an offer asked without buttons. */
  id?: string;
  /** The bot's button message for this offer; a click is matched by it. Absent when the transport returned none. */
  messageId?: string;
  /** A choice between options (targets, new, cancel); absent for a yes-or-no offer. */
  choices?: OfferChoice[];
  /**
   * Set when the choices fill one essential of the part-order draft in `command` ([1] [2] [5]
   * [Other], or the configured delivery locations and [Other]). A chosen option never runs: the
   * order continues with its next question, and [Other] asks for the value in text.
   */
  fillsPart?: ChoosablePartDetail;
}

/** What is remembered about an offer's button message, also after the offer itself has gone. */
export interface OfferPrompt {
  offerId: string;
  /** The member who was asked; only their click counts. */
  requesterId: QualifiedId;
  /** The offer was decided, by a click or a text answer. */
  answered: boolean;
}

/**
 * The one-off texts a button message can get: "others" tells another member who may answer,
 * "stale" says that the question is answered or expired.
 */
export type OfferPromptNotice = "others" | "stale";

export interface PendingOfferStore {
  /** Stores the offer, replacing any pending one for the same requester in the conversation. */
  put(offer: PendingOffer): void;
  /** Removes and returns the requester's pending offer, or null if there is none or it expired. */
  take(conversationId: QualifiedId, requesterId: QualifiedId, now?: Date): PendingOffer | null;
  /** True when the requester has an unexpired offer, without removing it. */
  has(conversationId: QualifiedId, requesterId: QualifiedId, now?: Date): boolean;
  /** The requester's unexpired offer's command, without removing it; null when there is none. */
  peek(conversationId: QualifiedId, requesterId: QualifiedId, now?: Date): OfferCommand | null;
  /** The requester's unexpired offer, without removing it; null when there is none. */
  find(conversationId: QualifiedId, requesterId: QualifiedId, now?: Date): PendingOffer | null;
  /**
   * The button message `messageId` of an offer stored with an ID and a message, while it is
   * remembered (bounded, also after the offer was taken, dropped or expired); null otherwise.
   */
  prompt(conversationId: QualifiedId, messageId: string): OfferPrompt | null;
  /** Records that the offer with this ID was decided, so a later click on its message is answered as stale. */
  markAnswered(conversationId: QualifiedId, offerId: string): void;
  /**
   * True the first time a notice of this kind is claimed for the message, also for a message
   * the store does not know; false afterwards, so each notice is sent at most once per message.
   */
  claimNotice(conversationId: QualifiedId, messageId: string, notice: OfferPromptNotice): boolean;
  /** Drops every pending offer in the conversation, e.g. when the bot leaves it. */
  clearConversation(conversationId: QualifiedId): void;
  /**
   * Removes the requester's pending offer without running it and remembers it as recently
   * dropped. Returns the dropped command, or null when there was no live offer.
   */
  drop(conversationId: QualifiedId, requesterId: QualifiedId, now?: Date): OfferCommand | null;
  /**
   * The requester's offer dropped or expired within `RECENT_DROP_MS`, without removing it.
   * `put` for that requester and `clearConversation` forget it.
   */
  recentlyDropped(conversationId: QualifiedId, requesterId: QualifiedId, now?: Date): OfferCommand | null;
  /** Forgets the requester's recently dropped offer, e.g. once they have moved on or were told. */
  forgetDropped(conversationId: QualifiedId, requesterId: QualifiedId): void;
}
