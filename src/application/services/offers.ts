import type { OfferCommand } from "../ports/PendingOfferPort";
import type { PartAssetWording, PartDetails, SupportRequestKind } from "../../domain/entities/SupportRequest";
import { JIRA_KEY_PATTERN, isKeyInProject } from "../../domain/ids/jiraLink";
import { DEFAULT_PART_ASSET, PART_DETAIL_MAX, SUPPORT_REQUEST_KINDS, SUPPORT_SUMMARY_MAX } from "../../domain/entities/SupportRequest";

/**
 * Offers let the answer model propose a supported Jira change in plain language. The model
 * only proposes: code validates the proposal against the records, writes the question, and
 * runs the existing audited use case after the requester confirms.
 */

export type { OfferCommand, PendingOffer, PendingOfferStore } from "../ports/PendingOfferPort";

/** How long an offer can be confirmed. */
export const OFFER_TTL_MS = 10 * 60 * 1000;

/** How long a dropped or expired offer is remembered, so a late "yes" can be answered. */
export const RECENT_DROP_MS = 10 * 60 * 1000;

/** Longest reply the bot will send to a ticket. */
export const REPLY_BODY_MAX = 2000;

/**
 * Longest description a `support` offer may carry. The confirmation question quotes it in
 * full, so it stays well under the `support:` command limit (`SUPPORT_DESCRIPTION_MAX`).
 */
export const OFFER_DESCRIPTION_MAX = 1000;

/** The single line the answer model may end with. Everything after the prefix is JSON. */
export const OFFER_MARKER_PREFIX = "OFFER:";

/**
 * A marker line as the model may decorate it: Markdown emphasis or code marks around the prefix
 * (`**OFFER**:`, `**OFFER:**`, `` `OFFER: {…}` ``) or a list bullet before it. The prefix must be
 * upper case, so prose such as "Offer: …" is never taken for a marker.
 */
const MARKER_LINE = /^(?:[-*+>]\s+)?[*_`]*OFFER[*_`]*\s*:[*_`]*\s*(.*)$/;
/** A Markdown code fence line, which the model may put around the marker. */
const FENCE_LINE = /^```[\w-]*$/;

/** The rest of the line after the marker prefix (the start of its JSON), or null when the line is no marker. */
export function offerMarkerRest(line: string): string | null {
  const match = MARKER_LINE.exec(line.trim());
  return match ? match[1]! : null;
}

export interface ParsedAnswer {
  /** The answer with every marker line removed. */
  text: string;
  /** The command from a well-formed marker block that ends the answer, if any. */
  command: OfferCommand | null;
  /** True when the answer contained any marker line, whether or not it produced a command. */
  hadMarker: boolean;
}

/**
 * Separates the model's optional offer marker from its answer. A marker is an `OFFER:` line
 * plus any following JSON continuation lines, since the model may spread the JSON over
 * several lines. Every marker block is removed, so raw JSON is never shown. Only a block that
 * ends the answer (nothing but blank lines after it) is honoured, and only when it is valid
 * JSON of a known shape.
 */
export function parseOfferMarker(answer: string): ParsedAnswer {
  const lines = answer.split(/\r?\n/);
  const kept: string[] = [];
  let command: OfferCommand | null = null;
  let hadMarker = false;
  for (let i = 0; i < lines.length; i++) {
    const rest = offerMarkerRest(lines[i]!);
    if (rest === null) {
      kept.push(lines[i]!);
      continue;
    }
    hadMarker = true;
    const block = [rest];
    // JSON strings cannot contain raw line breaks, so a continuation line of the marker starts
    // with a structural character or a quote.
    while (i + 1 < lines.length && /^[{}[\]",:]/.test(lines[i + 1]!.trim())) block.push(lines[++i]!);
    // A code fence around the marker belongs to it and is removed with it.
    if (kept.length > 0 && FENCE_LINE.test(kept[kept.length - 1]!.trim())) kept.pop();
    if (i + 1 < lines.length && FENCE_LINE.test(lines[i + 1]!.trim())) i++;
    const endsAnswer = lines.slice(i + 1).every((rest) => !rest.trim());
    command = endsAnswer ? toCommand(block.join("\n")) : null;
  }
  return { text: kept.join("\n").trim(), command, hadMarker };
}

function toCommand(json: string): OfferCommand | null {
  let value: unknown;
  try {
    // Emphasis or code marks closing a decorated marker line (`` `OFFER: {…}` ``).
    value = JSON.parse(json.trim().replace(/[*_`]+$/, ""));
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  const issueKey = typeof v.issueKey === "string" ? v.issueKey.trim().toUpperCase() : "";
  switch (v.kind) {
    case "support": {
      const summary = typeof v.summary === "string" ? v.summary.replace(/\s+/g, " ").trim() : "";
      const description = typeof v.description === "string" ? v.description.trim() : "";
      if (!summary || summary.length > SUPPORT_SUMMARY_MAX) return null;
      if (!description || description.length > OFFER_DESCRIPTION_MAX) return null;
      const requestKind = SUPPORT_REQUEST_KINDS.find((k) => typeof v.requestKind === "string" && k === v.requestKind.trim().toLowerCase()) ?? "fault";
      const part = requestKind === "part" ? toPartDetails(v.part) : null;
      return part
        ? { kind: "support", requestKind, summary, description, part }
        : { kind: "support", requestKind, summary, description };
    }
    case "reply": {
      const body = typeof v.body === "string" ? v.body.trim() : "";
      if (!JIRA_KEY_PATTERN.test(issueKey) || !body || body.length > REPLY_BODY_MAX) return null;
      return { kind: "reply", issueKey, body };
    }
    case "resolve": {
      if (!JIRA_KEY_PATTERN.test(issueKey)) return null;
      // A comment is optional and an empty one counts as absent, but a comment that is not text
      // or is too long drops the offer, so the requester is never asked to resolve without the
      // note they asked for.
      if (v.comment === undefined || v.comment === null) return { kind: "resolve", issueKey };
      if (typeof v.comment !== "string") return null;
      const comment = v.comment.trim();
      if (!comment) return { kind: "resolve", issueKey };
      if (comment.length > REPLY_BODY_MAX) return null;
      return { kind: "resolve", issueKey, comment };
    }
    default:
      return null;
  }
}

/**
 * The part essentials the model found, each collapsed to one line. A number (a quantity such
 * as 2) is taken as text. Any other value that is not a string, is empty or exceeds
 * `PART_DETAIL_MAX` is left out, so the system asks for it instead. Null when none is usable.
 */
function toPartDetails(value: unknown): PartDetails | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const part: PartDetails = {};
  for (const key of PART_DETAIL_KEYS) {
    const field = raw[key];
    const text = typeof field === "string" ? collapseLine(field) : typeof field === "number" && Number.isFinite(field) ? String(field) : "";
    if (text && text.length <= PART_DETAIL_MAX) part[key] = text;
  }
  return Object.keys(part).length > 0 ? part : null;
}

/** Sent instead of the model's text when its offer was dropped, so no unperformed write is claimed. */
export const NO_CHANGE_REPLY = "I haven't changed anything with the service desk.";

/** Sent for a bare yes when the requester's offer was recently dropped or expired. */
export const NOTHING_TO_CONFIRM_REPLY = "There's nothing waiting for your yes: I haven't raised or sent anything.";

/** The line for a marker that produced no command, when the intended kind is unknown. */
export const GENERIC_COMMAND_LINE = "Mention me with the command if you'd like me to act.";

/**
 * The command the requester can send themselves for an offer of this kind. A key is used only
 * when it belongs to `projectKey` (always, when no project key is given, since stored offers
 * were validated); otherwise a `<project>-N` placeholder stands in.
 */
export function offerCommandLine(command: OfferCommand, projectKey?: string): string {
  if (command.kind === "support") return "To raise it, send `@Wire Support Bot support: <problem>`.";
  const key = !projectKey || isKeyInProject(command.issueKey, projectKey) ? command.issueKey : `${projectKey}-N`;
  if (command.kind === "reply") return `To send a reply, use \`@Wire Support Bot reply to ${key}: <text>\`.`;
  if (command.kind === "attach") return "To add it, post the file again.";
  return command.comment
    ? `To resolve it with a comment, use \`@Wire Support Bot resolve ${key}: <comment>\`.`
    : `To resolve it, use \`@Wire Support Bot resolve ${key}\`.`;
}

/**
 * The support confirmation shows exactly what will be sent: the summary in bold and the
 * description quoted line by line, left out when it only repeats the summary. Callers have
 * already bounded both and collapsed the summary to one line. The question ends with "?" so
 * the router treats a non-exact answer as a follow-up.
 */
export function formatSupportQuestion(
  summary: string, description: string, requestKind: SupportRequestKind = "fault", part?: PartDetails,
  asset: PartAssetWording = DEFAULT_PART_ASSET,
): string {
  return `${SUPPORT_QUESTION_LEAD[requestKind]}\n${supportQuote(summary, description, requestKind, part, asset).join("\n")}\n\n(yes or no)?`;
}

/** The quoted request: the summary in bold, a part order's details, and the description unless it repeats the summary. */
function supportQuote(
  summary: string, description: string, requestKind: SupportRequestKind, part: PartDetails | undefined, asset: PartAssetWording,
): string[] {
  const lines = [`> **${summary}**`];
  if (requestKind === "part") {
    for (const { key, label } of partDetailFields(asset)) {
      const value = part?.[key]?.trim();
      if (value) lines.push(`> ${label}: ${collapseLine(value)}`);
    }
  }
  if (collapseLine(description).toLowerCase() !== summary.toLowerCase()) lines.push(...quoteLines(description));
  return lines;
}

/** A request offered as a candidate in a choice: key, summary, and whether it was last known as done. */
export interface CandidateRequest {
  key: string;
  summary: string;
  done?: boolean;
}

/** One line per candidate, in the order of the buttons. */
function candidateLines(candidates: readonly CandidateRequest[]): string[] {
  return candidates.map(({ key, summary, done }) => `- **${key}** "${collapseLine(summary)}"${done ? " (resolved)" : ""}`);
}

/**
 * The choice for a problem that may be one of the conversation's requests: it quotes the request
 * that "new" would raise, lists the candidates, and quotes what would be added to one of them
 * when that differs from the description. `hint` names the text answers ("SD-38, new or cancel").
 */
export function formatNewOrExistingQuestion(
  command: Extract<OfferCommand, { kind: "support" }>, addition: string, candidates: readonly CandidateRequest[], hint: string,
  asset: PartAssetWording = DEFAULT_PART_ASSET,
): string {
  const lead = candidates.length === 1
    ? "This may be the same problem as an existing request. Shall I add it there, or raise a new request?"
    : "This may be the same problem as one of these requests. Shall I add it to one of them, or raise a new request?";
  const lines = [lead, ...supportQuote(command.summary, command.description, command.requestKind, command.part, asset), "", ...candidateLines(candidates)];
  if (collapseLine(addition) !== collapseLine(command.description)) lines.push("", "Added to an existing request, it would say:", ...quoteLines(addition));
  return `${lines.join("\n")}\n\n(${hint})?`;
}

/** The choice of the request to resolve, with the closing comment quoted when there is one. */
export function formatResolveTargetQuestion(candidates: readonly CandidateRequest[], hint: string, comment?: string): string {
  const quoted = comment ? quoteLines(comment) : [];
  const lead = quoted.length > 0
    ? ["Which request shall I resolve with the service desk, adding this comment?", ...quoted]
    : ["Which request shall I resolve with the service desk?"];
  return `${[...lead, "", ...candidateLines(candidates)].join("\n")}\n\n(${hint})?`;
}

/** The choice of the request to add a reply to, with the reply quoted. */
export function formatReplyTargetQuestion(candidates: readonly CandidateRequest[], hint: string, body: string): string {
  return `${["Which request shall I add this to?", ...quoteLines(body), "", ...candidateLines(candidates)].join("\n")}\n\n(${hint})?`;
}

/** The choice of the request a file belongs to; `what` is "this photo" or "this file (<name>)". */
export function formatAttachTargetQuestion(candidates: readonly CandidateRequest[], hint: string, what: string): string {
  return `${[`Which request shall I add ${what} to?`, "", ...candidateLines(candidates)].join("\n")}\n\n(${hint})?`;
}

/** The re-ask after an answer that picks no option of a choice offer; ends with a question. */
export function formatChooseAgain(hint: string): string {
  return `I need you to pick one, so I haven't done anything yet. Which one (${hint})?`;
}

/** The opening of the support confirmation, per kind. */
const SUPPORT_QUESTION_LEAD: Record<SupportRequestKind, string> = {
  question: "Shall I ask the service desk?",
  part: "Shall I order this part?",
  fault: "Shall I report this to the service desk?",
};

/**
 * The question for a part order that still lacks essentials. It names what is missing and ends
 * with "?", so the requester's answer comes back as a follow-up that amends the pending draft.
 */
export function formatMissingPartsQuestion(missing: ReadonlyArray<keyof PartDetails>, asset: PartAssetWording = DEFAULT_PART_ASSET): string {
  const asks = partDetailFields(asset).filter(({ key }) => missing.includes(key)).map(({ ask }) => ask);
  const list = asks.length <= 1 ? asks.join("") : `${asks.slice(0, -1).join(", ")} and ${asks[asks.length - 1]}`;
  return `To order it I need ${list}. What ${asks.length === 1 ? "is it" : "are they"}?`;
}

/** The reply to a yes while a part order still lacks essentials. */
export function formatStillMissingReply(missing: ReadonlyArray<keyof PartDetails>, asset: PartAssetWording = DEFAULT_PART_ASSET): string {
  const asks = partDetailFields(asset).filter(({ key }) => missing.includes(key)).map(({ ask }) => ask);
  const list = asks.length <= 1 ? asks.join("") : `${asks.slice(0, -1).join(", ")} and ${asks[asks.length - 1]}`;
  return `I haven't ordered anything yet: I still need ${list}.`;
}

/**
 * The confirmation for sending text to an existing request, used by every path that offers a
 * reply. It names the request and quotes exactly what will be sent; the caller has bounded the
 * body. Ends with "?" like every offer question.
 */
export function formatReplyQuestion(key: string, summary: string, body: string): string {
  return `Shall I add this to **${key}** "${collapseLine(summary)}"?\n${quoteLines(body).join("\n")}\n\n(yes or no)?`;
}

/**
 * The confirmation for resolving a request. With a closing comment it quotes exactly what will
 * be sent before the resolve; the caller has bounded the comment. Ends with "?" like every
 * offer question.
 */
export function formatResolveQuestion(key: string, summary: string, comment?: string): string {
  const lead = `Shall I resolve **${key}** "${collapseLine(summary)}" with the service desk`;
  const quoted = comment ? quoteLines(comment) : [];
  return quoted.length > 0
    ? `${lead} and add this comment?\n${quoted.join("\n")}\n\n(yes or no)?`
    : `${lead} (yes or no)?`;
}

/** The part-order essentials, in the order they are asked for and shown. */
export const PART_DETAIL_KEYS: ReadonlyArray<keyof PartDetails> = ["asset", "part", "quantity", "deliverTo"];

/** A part-order essential as the bot shows it ("Part: ...") and asks for it ("the part (name or number)"). */
export interface PartDetailField {
  key: keyof PartDetails;
  label: string;
  ask: string;
}

/** The part-order essentials with their labels and questions, in order; the asset's wording is configured. */
export function partDetailFields(asset: PartAssetWording = DEFAULT_PART_ASSET): PartDetailField[] {
  return [
    { key: "asset", label: asset.label, ask: asset.question },
    { key: "part", label: "Part", ask: "the part (name or number)" },
    { key: "quantity", label: "Quantity", ask: "the quantity" },
    { key: "deliverTo", label: "Deliver to", ask: "the delivery location" },
  ];
}

/** The part-order essentials still missing; empty for other kinds and for a complete order. */
export function missingPartDetails(command: OfferCommand): Array<keyof PartDetails> {
  if (command.kind !== "support" || command.requestKind !== "part") return [];
  return PART_DETAIL_KEYS.filter((key) => !command.part?.[key]?.trim());
}

/** Every quoted line is non-empty: an empty "> " line ends the quote in Markdown. */
function quoteLines(text: string): string[] {
  return text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).map((line) => `> ${line}`);
}

function collapseLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}
