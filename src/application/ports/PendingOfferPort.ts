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
  /**
   * Set on an option of a desk-update question that asks for the reply text instead of running a
   * command ([Reply], [Still broken]); its `command` is null. The requester's next message is
   * then taken as the text and offered as a reply with [Yes] [No].
   */
  asksReplyText?: ReplyTextPrompt;
  /**
   * Set on an option that runs a step other than an offer command once picked, such as opening
   * the direct conversation with the desk agent; its `command` is null.
   */
  then?: ChoiceAction;
  /**
   * Set on an option of a desk-update question that means the requester is satisfied without a
   * write ([Solved]): with satisfaction ratings on, the bot asks for a rating afterwards. [Solved,
   * close it] does not need it: every resolve that reached done asks for a rating itself.
   */
  asksFeedback?: boolean;
}

/**
 * A step an option runs instead of an offer command. Built by code from validated data (a stored
 * request's key, a configured agent handle), never from the click or model output.
 */
export type ChoiceAction =
  /** Open the direct conversation between the requester and the assigned desk agent. */
  | { kind: "openAgentChat"; issueKey: string; agentHandle: string }
  /** Send the requester's satisfaction rating (1 to 5) to the request's feedback. */
  | { kind: "rate"; issueKey: string; rating: number };

/** Which question asks for the reply text: after [Reply], or after [Still broken]. */
export type ReplyTextPrompt = "reply" | "stillBroken";

/** The support request a desk-update question or a request for reply text is about. */
export interface DeskUpdateTarget {
  issueKey: string;
  /** The request's stored summary, for the reply offer that follows. */
  summary: string;
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
  /**
   * The question as sent with the buttons (without its text answer hint). When the question ends,
   * its message is replaced by this text and a closing line, without buttons.
   */
  question?: string;
  /** A choice between options (targets, new, cancel); absent for a yes-or-no offer. */
  choices?: OfferChoice[];
  /**
   * Set when the choices fill one essential of the part-order draft in `command` ([1] [2] [5]
   * [Other], or the configured delivery locations and [Other]). A chosen option never runs: the
   * order continues with its next question, and [Other] asks for the value in text.
   */
  fillsPart?: ChoosablePartDetail;
  /**
   * Set on a question the bot asks the requester about a request on its own: after posting a desk
   * update ([Reply] [Solved, close it], or [Solved] [Still broken]), about the direct conversation
   * with a newly assigned agent ([Open direct chat] [Not now]), or for a satisfaction rating after
   * [Solved] or a resolve from Wire ([1] to [5]). It lives longer than other offers, is never asked over another open
   * question, and a newer question replaces it. A text answer picks an option or says "no"; any
   * other message is not an answer.
   */
  deskUpdate?: DeskUpdateTarget;
  /**
   * Set on a watch question that a later desk-update question does not replace: the question about
   * the agent conversation, which is asked once per request. Other questions still replace it.
   */
  keepsSlot?: boolean;
  /**
   * Set while the bot waits for the text of a reply to this request, after [Reply] or [Still
   * broken]: the requester's next message is the text, offered as a reply with [Yes] [No]. Its
   * `command` is the reply with an empty body, used only to name it after it was dropped.
   */
  awaitsReplyText?: DeskUpdateTarget;
}

/** What is remembered about an offer's button message, also after the offer itself has gone. */
export interface OfferPrompt {
  offerId: string;
  /** The member who was asked; only their click counts. */
  requesterId: QualifiedId;
  /** The offer was decided, by a click or a text answer. */
  answered: boolean;
  /** The message was closed (or is queued to be): replaced by its question and a closing line, without buttons. */
  closed: boolean;
}

/** The one-off text a button message can get: "others" tells another member who may answer. */
export type OfferPromptNotice = "others";

/** Why a button question ended without an answer, noticed by the store. */
export type OfferPromptEnding = "expired" | "replaced";

/** A button message whose question ended without an answer and is to be closed. */
export interface EndedOfferPrompt {
  conversationId: QualifiedId;
  messageId: string;
  /** The question as sent; absent when the offer was stored without it. */
  question?: string;
  reason: OfferPromptEnding;
}

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
  /** Records that the offer with this ID was decided, so a later click on its message changes nothing. */
  markAnswered(conversationId: QualifiedId, offerId: string): void;
  /**
   * Claims the closing of the button message `messageId`: the first time, it is marked closed and
   * its question is returned (`question` absent when the offer was stored without it); null for
   * a message the store does not know or one already closed, so each message is closed at most once.
   */
  claimClose(conversationId: QualifiedId, messageId: string): { question?: string } | null;
  /**
   * Removes and returns the button messages whose question expired or was replaced by a newer
   * question to the same requester, as noticed so far; each is already marked closed.
   */
  takeEndedPrompts(): EndedOfferPrompt[];
  /** Notices every offer expired at `now` (in any conversation), so its button message can be closed. */
  sweepExpired(now: Date): void;
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
