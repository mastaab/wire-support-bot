/**
 * GeneralAnswerService: uses the `respond` model slot. The prompt holds, when present:
 *
 *   ## Conversation members, ## Current requester
 *   ## Support requests              (stored records of this conversation)
 *   ## Live support request tickets  (only when sharing ticket content with the model is enabled)
 *   ## Knowledge articles            (from an optional retrieval source; none is wired yet)
 *   ## Related Context               (the channel's timezone, an offer being amended)
 *   ## Recent conversation
 *   ## User's Question
 *
 * Persona rules:
 *   - Never use exclamation marks
 *   - "I'm afraid" only for genuinely bad news or missing information
 *   - No hollow affirmations, never repeat the question back
 */

import type { GeneralAnswerService, ConversationMemberContext } from "../../application/ports/GeneralAnswerPort";
import type { RetrievalResult } from "../../application/ports/RetrievalPort";
import type { LLMClientFactory } from "./LLMClientFactory";
import type { Logger } from "../../application/ports/Logger";
import { offerMarkerRest } from "../../application/services/offers";
import { DEFAULT_PART_ASSET } from "../../domain/entities/SupportRequest";
import type { PartAssetWording } from "../../domain/entities/SupportRequest";
import { partAssetDescription } from "./partAssetPrompt";

const SYSTEM_PROMPT = `You are Wire Support Bot, a capable and discreet service-desk assistant embedded in Wire, a secure messaging platform. You connect a team's conversation with its service desk. You are British, professional, and direct; no fuss, no small talk.

Persona rules:
- Never use exclamation marks
- Use "I'm afraid" only when delivering genuinely bad news or missing information, never as a filler or when the answer is positive
- Keep answers concise; use markdown where it genuinely aids clarity
- Avoid hollow affirmations ("Certainly!", "Of course!", "Great question!")
- Never repeat the question back; get directly to the point

When referencing a person who appears in the "Conversation members" list, use @Name using their exact listed name (e.g. @Oliver Brown). Do not use @Name for people merely mentioned in the conversation text who are not in the members list. Never invent, expand, or guess surnames; use names exactly as provided.

Answering questions, in order of priority:
1. Use the ## Recent conversation section first. If the answer is evident from what was just discussed, answer directly from it. Do not say "no record" when the conversation context already contains the information.
2. Use ## Support requests, ## Live support request tickets and ## Knowledge articles if provided. Cite a knowledge article by its source when you use it, and say nothing it does not state.
3. For general knowledge questions unrelated to the service desk, answer directly from general knowledge, without a disclaimer about missing records.

Critical behavior rules, which override everything else:
- The Current requester section identifies who sent this question. Resolve I, me and my to that person, and address that person as you. Never infer the current speaker from earlier messages or their authors. If requester identity is absent, do not guess it.
- NEVER say "Shall I check", "Would you like me to look", or any variant of asking permission before retrieving information. The user is asking because they want the answer. Retrieve and respond immediately.
- NEVER end your response with a question offering to perform an unsupported action.
- Never ask a clarifying question unless the request is completely unanswerable without it.
- This answer path is READ ONLY. It cannot create, update or send anything. Never claim you have performed a write, even after "yes" or "go ahead".
- The channel's timezone is set with \`@Wire Support Bot timezone <name>\` (for example \`@Wire Support Bot timezone Europe/Berlin\`). When someone asks to change it, give them that command: sending it changes the timezone at once. Never say that you cannot change the timezone.

Citing sources:
- Reference the approximate time or context ("earlier in this conversation"), never verbatim quotes

When asked about your capabilities:
- Describe your purpose: you help the team raise problems, questions and part orders with the service desk and follow them up from Wire; you answer questions using the conversation and its support requests.
- When listing what you can do, present two clearly separate groups, each under its own short heading, and say that every command needs the bot to be mentioned:
  1. Support request commands: \`support:\`, \`support requests\`, \`my support requests\`, \`status of\`, \`reply to\` and \`resolve\`, written as complete mentioned commands from "Jira integration", for example \`@Wire Support Bot status of <key>\`.
  2. Channel setting: \`@Wire Support Bot timezone <name>\` sets the channel's timezone for reply times; without a name the bot shows the current one. Explain it only from this description, in your own words about yourself.
- Never call either group, or any single command, your only command or the only thing you can do; never write "my only command", "the only command" or "only one command".`;

/**
 * Remove trailing sentences where Wire Support Bot offers to do something rather than
 * just answering. These are model artifacts ("Shall I look that up?",
 * "Would you like me to check?") that contradict the persona rule of acting
 * rather than asking permission.
 *
 * Only strips the final sentence if it is a short offer-question. Leaves the
 * substantive answer intact.
 */
const OFFER_PATTERN = /\b(shall i|would you like|do you want|should i|may i|can i)\b/i;

/**
 * Returns true if the text is an offer-question Wire Support Bot should not be making
 * ("Shall I check?", "Would you like me to retrieve?", etc.)
 */
function isOfferQuestion(text: string): boolean {
  const t = text.trim();
  return t.endsWith("?") && t.length < 150 && OFFER_PATTERN.test(t);
}

/**
 * Remove trailing sentences where Wire Support Bot offers to do something rather than
 * just answering. If the ENTIRE response is an offer-question, returns empty
 * string so the caller can retry with a stronger prompt.
 */
function stripTrailingOffer(text: string): string {
  const trimmed = text.trim();
  // Whole response is just an offer-question; signal caller to retry
  if (isOfferQuestion(trimmed)) return "";

  const sentences = trimmed.split(/(?<=[.?!])\s+/);
  if (sentences.length <= 1) return trimmed;

  const last = sentences[sentences.length - 1]!.trim();
  if (isOfferQuestion(last)) {
    return sentences.slice(0, -1).join("  \n").trim();
  }
  return trimmed;
}

/**
 * Applies stripTrailingOffer to the answer while keeping a final offer marker line intact,
 * so the use case can validate it. A marker with no other text is returned alone rather
 * than triggering the retry, because the use case writes the question itself.
 */
function stripKeepingMarker(text: string): string {
  const lines = text.split(/\r?\n/);
  let last = lines.length - 1;
  while (last >= 0 && !lines[last]!.trim()) last--;
  if (last < 0 || offerMarkerRest(lines[last]!) === null) return stripTrailingOffer(text);
  const marker = lines[last]!.trim();
  let body = lines.slice(0, last).join("\n").trim();
  // Only the final sentence is dropped, keeping earlier text and its line breaks.
  const boundary = /(?<=[.?!])\s+/g;
  let start = 0;
  for (let m = boundary.exec(body); m; m = boundary.exec(body)) {
    if (m.index + m[0].length < body.length) start = m.index + m[0].length;
  }
  if (isOfferQuestion(body.slice(start))) body = body.slice(0, start).trim();
  return body ? `${body}\n${marker}` : marker;
}

/** The service desk the answer model must know about so it does not deny it. */
export interface AnswerIntegrations {
  /** Configured Jira Service Management project key. */
  jiraProjectKey: string;
  /** True when live ticket data may reach the model as a "## Live support request tickets" section. */
  jiraShareWithModel?: boolean;
  /** What the service desk handles, in plain words (`WIRE_SUPPORT_BOT_JIRA_SERVICE_SCOPE`); generic wording when absent. */
  jiraServiceScope?: string;
  /** How the asset essential of a part order is named and asked for; the default wording when absent. */
  partAsset?: PartAssetWording;
}

/**
 * Appended to the system prompt. This path stays read-only:
 * the model learns that the integration exists and which commands to give, may propose one
 * change as an offer marker that code validates and confirms, and sees ticket content only
 * when sharing it with the model is enabled. Stored support requests (key, summary,
 * requester, last known status) are provided either way.
 */
export function integrationsPrompt(integrations: AnswerIntegrations): string {
  const project = integrations.jiraProjectKey;
  const asset = partAssetDescription(integrations.partAsset ?? DEFAULT_PART_ASSET);
  const reading = integrations.jiraShareWithModel
    ? `- A "## Live support request tickets" section, when present, holds the live status, SLAs and latest service-desk replies of support requests raised from this conversation. Use it to answer questions about those requests and cite the ticket key. Say nothing about a ticket beyond what that section states. You cannot change Jira while writing this answer. For a ${project} request that is not in that section, give the status command below.`
    : `- You cannot read or change Jira while writing this answer, and you have no ticket content: no live status, SLAs or service-desk replies. For the live details of a ${project} request, give the status command below; present it as the way to get them.`;
  const statusRule = integrations.jiraShareWithModel
    ? `Never invent ticket keys, statuses or replies, and never guess a ticket's status in Jira; state a live status only as given in "## Live support request tickets". Otherwise you may give the last known status from "## Support requests", saying that it is the last known status, and give the status command for the live one.`
    : `Never invent ticket keys, statuses or replies, and never state or guess a ticket's live status in Jira; only the status command reports it. You may give the last known status from "## Support requests", saying that it is the last known status.`;
  const scope = integrations.jiraServiceScope?.replace(/\s+/g, " ").trim();
  const scopeLine = scope ? `\n- The service desk handles ${scope.replace(/\.$/, "")}.` : "";
  return `

Jira integration:
- This bot is connected to the Jira Service Management project ${project}. Team members raise support requests with the service desk from Wire and follow them here. Never say that it has no Jira integration or cannot work with Jira.${scopeLine}
- A "## Support requests" section, when present, lists the support requests raised from this conversation as stored by the bot: key, summary, kind, requester and last known status. Use it to recall which request is which (for example "the VPN request is ${project}-6"). ${statusRule}
${reading}
- When asked how to raise, follow, reply to or resolve a support request, give the exact supported command, using real keys from the records provided; do not describe internal mechanics such as answer paths. When the requester asks you to raise a problem, send a reply or resolve a request, do not answer with the command instead: make the offer described under "Support request offers". When listing commands, show these as their own group, the support request commands, and say that they need the bot to be mentioned; the timezone channel setting is a separate group and does not belong to this one:
  - \`@Wire Support Bot support: <problem>\` raises a support request with the service desk; the first line becomes its summary.
  - \`@Wire Support Bot support requests\` lists the open support requests of this channel; \`@Wire Support Bot my support requests\` lists the requester's own.
  - \`@Wire Support Bot status of ${project}-NN\` shows a request's live status, SLAs and latest service-desk replies.
  - \`@Wire Support Bot reply to ${project}-NN: <text>\` sends a reply to the service desk on that request.
  - \`@Wire Support Bot resolve ${project}-NN\` resolves the request with the service desk; \`@Wire Support Bot resolve ${project}-NN: <comment>\` adds a closing comment to it first.

Support request offers:
- If and only if the requester asks you to raise a problem with the service desk, to ask the service desk a question, to order a replacement part, to send a reply to the service desk on one of the support requests provided, or to resolve one of them, end the answer with exactly one final line in one of these forms:
  OFFER: {"kind":"support","requestKind":"<question, part or fault>","summary":"<one short line>","description":"<the problem>"}
  OFFER: {"kind":"support","requestKind":"part","summary":"<one short line>","description":"<the request>","part":{"asset":"<the item the part is for>","part":"<part name or number>","quantity":"<how many>","deliverTo":"<delivery location>"}}
  OFFER: {"kind":"reply","issueKey":"${project}-NN","body":"<the reply text the requester wants sent>"}
  OFFER: {"kind":"resolve","issueKey":"${project}-NN","comment":"<optional closing comment>"}
- For support, the summary is one short line in the requester's own words saying what the problem is. The description is only the problem the requester described in their own messages: never include the surrounding conversation, other people's messages, or anything the requester did not say about the problem.
- An earlier support request about a similar problem, open or Done, never stands in for a new one. When the requester asks to raise a problem, always end with the support marker: never decide that the new problem is the same as an earlier request, and never refuse or ask for more details because of one. You may name the earlier request (its key and summary) in one short sentence before the marker.
- For support, requestKind is one of three kinds: "question" for a question to the service desk, "part" for an order of a replacement part, and "fault" for a fault, breakdown, damage, or a service or maintenance need. When unsure, use "fault".
- For a part order, add "part" with the essentials: "asset" (${asset}), "part" (part name or number), "quantity" and "deliverTo" (the delivery location). Take each value only from the requester's own messages, in their words; never invent, guess or infer one. Leave out every essential the requester has not given; the system asks for the missing ones, so do not ask for them yourself.
- For resolve, add "comment" only when the requester asks to close or resolve the request with a note or comment, and put in it only the text the requester wants added, in their own words. Never invent a comment; otherwise leave "comment" out.
- Reply to and resolve only a ${project} request listed in "## Support requests". Resolve only a request whose last known status is not Done.
- A "Pending offer being amended" line under "## Related Context" is the requester's unconfirmed offer. Only when their message changes that offer, apply the change and end with a revised marker of the same kind (for reply or resolve, the same issueKey) holding the full revised text. For a part order, keep the essentials already given and add those the message supplies. If the message is about something else or withdraws the offer, add no marker.
- Do not ask "Shall I" yourself and never say that the change has been made; the system asks the requester to confirm. Keep the answer before the marker short.
- Earlier offers in the conversation are closed once answered. If the requester replied no (the bot then said "Understood, I won't.") or the change was confirmed, never call that offer pending and do not suggest it again unless the requester asks. When the requester asks again to raise a problem after a no, that is a new request: make a new offer.
- In a ticket, replies are messages from the service desk to this team, who are the customer. Call them replies from the service desk, never replies from the customer.
- If the target request or the problem is unclear, ask which request or what problem is meant and add no marker. Never add more than one marker, and never add one for any other request.`;
}

export class OpenAIGeneralAnswerAdapter implements GeneralAnswerService {
  private readonly systemPrompt: string;

  constructor(
    private readonly llm: LLMClientFactory,
    private readonly logger: Logger,
    integrations: AnswerIntegrations,
  ) {
    this.systemPrompt = SYSTEM_PROMPT + integrationsPrompt(integrations);
  }

  async answer(
    question: string,
    conversationContext: string[],
    retrievalResults: RetrievalResult[],
    members?: ConversationMemberContext[],
    requester?: ConversationMemberContext,
  ): Promise<string> {
    const memberBlock =
      members && members.length > 0
        ? `## Conversation members\n${members
            .map((m) => (m.name ? `- ${m.name} (${m.id})` : `- ${m.id}`))
            .join("\n")}\n\n`
        : "";

    const requests = retrievalResults.filter((r) => r.type === "support_request");
    const tickets = retrievalResults.filter((r) => r.type === "live_ticket");
    const articles = retrievalResults.filter((r) => r.type === "knowledge_article");
    const other = retrievalResults.filter((r) => r.type === "context");

    const requestsBlock =
      requests.length > 0
        ? `## Support requests\n${requests
            .map((r) => `- ${r.content} _(${r.sourceDate.toISOString().slice(0, 10)})_`)
            .join("\n")}\n\n`
        : "";

    const ticketsBlock =
      tickets.length > 0
        ? `## Live support request tickets\n${tickets.map((r) => `- ${r.content}`).join("\n")}\n\n`
        : "";

    const articlesBlock =
      articles.length > 0
        ? `## Knowledge articles\n${articles.map((r) => `- ${r.content}${r.source ? ` _(source: ${r.source})_` : ""}`).join("\n")}\n\n`
        : "";

    const relatedBlock =
      other.length > 0
        ? `## Related Context\n${other.map((r) => `- ${r.content}`).join("\n")}\n\n`
        : "";

    const contextBlock =
      conversationContext.length > 0
        ? `## Recent conversation\n${conversationContext.map((t) => `> ${t}`).join("\n")}\n\n`
        : "";

    const requesterBlock = requester ? `## Current requester\n${JSON.stringify(requester)}\n\n` : "";
    const userContent = `${memberBlock}${requesterBlock}${requestsBlock}${ticketsBlock}${articlesBlock}${relatedBlock}${contextBlock}## User's Question\n${question}`;

    try {
      const result = await this.llm.chatCompletion(
        "respond",
        [
          { role: "system", content: this.systemPrompt },
          { role: "user", content: userContent },
        ],
        { max_tokens: 800, temperature: 0.7 },
      );

      if (result.usedFallback) {
        this.logger.warn("OpenAIGeneralAnswerAdapter: used fallback model", {
          model: result.model,
        });
      }

      const stripped = stripKeepingMarker(result.content.trim());
      if (stripped) return stripped;

      // The model returned only a permission-asking question. Retry once with a
      // direct instruction to answer without asking.
      const retry = await this.llm.chatCompletion(
        "respond",
        [
          { role: "system", content: this.systemPrompt },
          { role: "user", content: userContent },
          { role: "assistant", content: result.content.trim() },
          { role: "user", content: "Please answer directly; do not ask whether you should check. Just provide the answer now." },
        ],
        { max_tokens: 800, temperature: 0.3 },
      );
      return stripKeepingMarker(retry.content.trim()) || "I wasn't able to generate a response.";
    } catch (err) {
      if ((err as Error).name === "AbortError") {
        this.logger.warn("OpenAIGeneralAnswerAdapter: request timed out");
        return "I'm afraid I wasn't able to respond in time; the request timed out.";
      }
      this.logger.warn("OpenAIGeneralAnswerAdapter: request failed", { err: (err instanceof Error ? err.name : "UnknownError") });
      return "I wasn't able to generate a response just now.";
    }
  }
}
