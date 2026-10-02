/**
 * Classifier for passive service-desk help; uses the `classify` model slot. It sorts an
 * unaddressed message into the service-desk categories and nothing else: the bot keeps no team
 * records, so there is nothing to extract.
 */

import type { ClassifierPort, ClassifyResult, ChannelContext, MessageCategory } from "../../application/ports/ClassifierPort";
import type { LLMClientFactory } from "./LLMClientFactory";
import type { Logger } from "../../application/ports/Logger";

const SERVICE_REQUEST_LINE_MARKER = "{{SERVICE_REQUEST_LINE}}";

const SYSTEM_PROMPT = `You are the classifier for Wire Support Bot, a service-desk assistant in a team conversation. You decide whether a message is something for the service desk.

Classify the message into one or more of these categories:
${SERVICE_REQUEST_LINE_MARKER}- request_status: someone asks about the state of a problem or service request they or others reported
- update: news about ongoing work, such as a change to a problem already reported
- blocker: progress is blocked by an impediment
- other: anything else, such as chat, greetings, acknowledgments, questions to colleagues and bot commands

A message may have several categories: a problem that blocks work is both a service_request and a blocker. Use other only when no other category applies.

Return ONLY valid JSON, no markdown, no explanation:
{"categories":["<cat1>","<cat2>"],"confidence":<0.0-1.0>}`;

const VALID_CATEGORIES: readonly MessageCategory[] = ["service_request", "request_status", "update", "blocker", "other"];

const GENERIC_SERVICE_REQUEST_LINE =
  "- service_request: someone describes a problem, fault or need that a service desk could handle, such as something broken, an error, or access they need, or adds information to a problem already reported (a new detail, a change, it happened again, it now affects more places), or says a reported problem is solved or asks to close a request\n";

/** The `service_request` line when the operator described what the desk handles. */
function scopedServiceRequestLine(scope: string): string {
  return `- service_request: someone brings the service desk something it handles (${scope}): a question to the desk, a fault or need, a replacement part order or a scheduled service all count; or adds information to a problem already reported (a new detail, a change, it happened again, it now affects more places); or says a reported problem is solved or asks to close a request\n`;
}

export interface ClassifierOptions {
  /** What the service desk handles (`WIRE_SUPPORT_BOT_JIRA_SERVICE_SCOPE`); generic wording when absent. */
  serviceScope?: string;
}

const FALLBACK: ClassifyResult = { categories: ["other"], confidence: 0 };

/** Recent messages shown to the model. */
const RECENT_SHOWN = 5;

export class OpenAIClassifierAdapter implements ClassifierPort {
  private readonly systemPrompt: string;

  constructor(
    private readonly llm: LLMClientFactory,
    private readonly logger: Logger,
    options: ClassifierOptions = {},
  ) {
    const scope = options.serviceScope?.replace(/\s+/g, " ").trim().replace(/\.+$/, "");
    const line = scope ? scopedServiceRequestLine(scope) : GENERIC_SERVICE_REQUEST_LINE;
    // A replacer function, so "$" in the operator's scope text is not read as a replacement pattern.
    this.systemPrompt = SYSTEM_PROMPT.replace(SERVICE_REQUEST_LINE_MARKER, () => line);
  }

  async classify(text: string, context: ChannelContext, recent: string[]): Promise<ClassifyResult> {
    const userContent = [
      "Recent conversation context:",
      recent.slice(-RECENT_SHOWN).join("\n") || "(none)",
      "",
      `Message to classify: "${text}"`,
    ].join("\n");

    let result: ChatResult;
    try {
      result = await this.llm.chatCompletion("classify", [
        { role: "system", content: this.systemPrompt },
        { role: "user", content: userContent },
      ], { max_tokens: 150, temperature: 0 });
    } catch (err) {
      this.logger.warn("Classifier LLM call failed", { err: (err instanceof Error ? err.name : "UnknownError") });
      return FALLBACK;
    }

    let parsed: { categories?: unknown; confidence?: unknown };
    try {
      parsed = JSON.parse(result.content.replace(/^```json\s*|\s*```$/g, "").trim()) as typeof parsed;
    } catch {
      this.logger.warn("Classifier: failed to parse LLM response", { responseLength: result.content.length });
      return FALLBACK;
    }

    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return FALLBACK;
    const rawCategories = Array.isArray(parsed.categories) ? parsed.categories : [];
    const categories = rawCategories.filter(
      (c): c is MessageCategory => typeof c === "string" && VALID_CATEGORIES.includes(c as MessageCategory),
    );
    if (categories.length === 0) categories.push("other");

    const confidence = typeof parsed.confidence === "number" && Number.isFinite(parsed.confidence)
      ? Math.min(1, Math.max(0, parsed.confidence)) : 0;

    this.logger.debug("Classifier result", {
      channelId: context.channelId,
      categories,
      confidence,
      usedFallback: result.usedFallback,
    });

    return { categories, confidence };
  }
}

type ChatResult = Awaited<ReturnType<LLMClientFactory["chatCompletion"]>>;
