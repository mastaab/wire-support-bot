/**
 * LLMClientFactory
 *
 * Provides a unified fetch-based OpenAI-compatible client for the model slots
 * (classify and respond). Handles per-slot model selection and a single fallback retry:
 *   - On 503/529 or AbortError (timeout): retry once with the slot's fallback model.
 *   - Both attempts are logged.
 *
 * Each call is recorded in the metrics once, by slot, with its outcome (ok, fallback, timeout or
 * error) and its duration including the fallback attempt.
 *
 * A model that rejects `temperature` as deprecated or unsupported is remembered for
 * the life of the instance, and later requests to it omit the parameter. Share one
 * instance across adapters so each model is learned once per process.
 *
 * Usage:
 *   const factory = new LLMClientFactory(config.llm, logger);
 *   const result = await factory.chatCompletion("classify", messages, { max_tokens: 200 });
 */

import type { LLMConfig, ModelSlot } from "../../app/config";
import type { Logger } from "../../application/ports/Logger";
import { NO_METRICS, secondsSince, type MetricsPort, type ModelCallOutcome } from "../../application/ports/MetricsPort";

export type SlotName = keyof LLMConfig["slots"];

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface ChatCompletionOptions {
  max_tokens?: number;
  temperature?: number;
  response_format?: { type: "json_object" } | { type: "text" };
}

export interface ChatCompletionResult {
  content: string;
  model: string;
  usedFallback: boolean;
}

export class LLMClientFactory {
  private readonly url: string;
  private readonly headers: Record<string, string>;
  /** Models whose provider has rejected `temperature`; requests to them omit it. */
  private readonly modelsRejectingTemperature = new Set<string>();

  constructor(
    private readonly config: LLMConfig,
    private readonly logger: Logger,
    private readonly metrics: MetricsPort = NO_METRICS,
  ) {
    this.url = `${config.baseUrl}/chat/completions`;
    this.headers = {
      "Content-Type": "application/json",
      Authorization: `Bearer ${config.apiKey}`,
    };
  }

  async chatCompletion(
    slot: SlotName,
    messages: ChatMessage[],
    options: ChatCompletionOptions = {},
  ): Promise<ChatCompletionResult> {
    const started = performance.now();
    let outcome: ModelCallOutcome = "error";
    try {
      const result = await this.completeWithFallback(slot, messages, options);
      outcome = result.usedFallback ? "fallback" : "ok";
      return result;
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") outcome = "timeout";
      throw err;
    } finally {
      this.metrics.modelCall(slot, outcome, secondsSince(started));
    }
  }

  private async completeWithFallback(
    slot: SlotName,
    messages: ChatMessage[],
    options: ChatCompletionOptions,
  ): Promise<ChatCompletionResult> {
    const slotCfg: ModelSlot = this.config.slots[slot];

    // Primary attempt
    try {
      const content = await this.attempt(slotCfg.model, messages, options);
      return { content, model: slotCfg.model, usedFallback: false };
    } catch (err) {
      const isFallbackable = this.isFallbackError(err);
      if (!isFallbackable) throw err;
      this.logger.warn("LLM primary attempt failed, retrying with fallback", {
        slot,
        primaryModel: slotCfg.model,
        fallbackModel: slotCfg.fallback,
        err: (err instanceof Error ? err.name : "UnknownError"),
      });
    }

    // Fallback attempt
    const content = await this.attempt(slotCfg.fallback, messages, options);
    return { content, model: slotCfg.fallback, usedFallback: true };
  }

  private async attempt(
    model: string,
    messages: ChatMessage[],
    options: ChatCompletionOptions,
  ): Promise<string> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.config.timeoutMs);

    // Strip temperature for a model already known to reject it.
    const { temperature: _t, ...withoutTemperature } = options;
    const apiOptions: ChatCompletionOptions =
      this.modelsRejectingTemperature.has(model) ? withoutTemperature : options;

    try {
      const res = await fetch(this.url, {
        method: "POST", headers: this.headers,
        body: JSON.stringify({
          model, messages, ...apiOptions,
          ...(this.config.reasoningEffort ? { reasoning_effort: this.config.reasoningEffort } : {}),
        }), signal: controller.signal,
      });
      if (res.status === 503 || res.status === 529) throw new LLMServiceUnavailableError(model, res.status);
      if (!res.ok) {
        // Some models explicitly reject temperature. Remember the model and retry this
        // read-only request once without it; never log the provider body (it may echo input).
        // The retry cannot loop: the model is now remembered, so it sends no temperature.
        if (res.status === 400 && apiOptions.temperature !== undefined) {
          const body = await res.json().catch(() => null) as { error?: { message?: unknown } } | null;
          const message = body?.error?.message;
          if (typeof message === "string" && /temperature/i.test(message) && /deprecated|unsupported|not supported/i.test(message)) {
            clearTimeout(timeout);
            this.modelsRejectingTemperature.add(model);
            this.logger.info("Model rejected temperature; omitting it for this model", { model });
            return await this.attempt(model, messages, options);
          }
        }
        throw new Error(`LLM request failed (${res.status})`);
      }
      const data = (await res.json()) as { choices?: Array<{ message?: { content?: unknown } }> };
      const content = data?.choices?.[0]?.message?.content;
      if (typeof content !== "string" || !content.trim()) throw new Error("LLM returned no text");
      return content.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
    } finally {
      clearTimeout(timeout);
    }
  }

  private isFallbackable(err: unknown): boolean {
    return err instanceof LLMServiceUnavailableError || (err instanceof Error && err.name === "AbortError");
  }

  // alias so we can call it from the catch block where TS narrows to unknown
  private isFallbackError = this.isFallbackable.bind(this);
}

export class LLMServiceUnavailableError extends Error {
  constructor(public readonly model: string, public readonly status: number) {
    super(`LLM service unavailable for model ${model} (HTTP ${status})`);
    this.name = "LLMServiceUnavailableError";
  }
}
