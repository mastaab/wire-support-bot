/**
 * Token counts from the `usage` object of an OpenAI-compatible response. Only the counts are read,
 * never any text. A count must be a finite, non-negative whole number; anything else makes the
 * usage unusable, and the caller records it as missing.
 */

import type { MetricsPort, ModelSlotLabel } from "../../application/ports/MetricsPort";

export interface TokenUsage {
  input: number;
  /** Absent for embeddings, which have no output tokens. */
  output?: number;
}

function tokenCount(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : undefined;
}

function usageOf(data: unknown): Record<string, unknown> | undefined {
  const usage = (data as { usage?: unknown } | null)?.usage;
  return usage !== null && typeof usage === "object" ? usage as Record<string, unknown> : undefined;
}

/** A chat completion's usage: `prompt_tokens` as input and `completion_tokens` as output, both required. */
export function chatUsage(data: unknown): TokenUsage | undefined {
  const usage = usageOf(data);
  const input = tokenCount(usage?.prompt_tokens);
  const output = tokenCount(usage?.completion_tokens);
  return input !== undefined && output !== undefined ? { input, output } : undefined;
}

/** An embeddings response's usage: `prompt_tokens`, else `total_tokens` (Voyage reports only that), as input. */
export function embeddingUsage(data: unknown): TokenUsage | undefined {
  const usage = usageOf(data);
  const input = tokenCount(usage?.prompt_tokens) ?? tokenCount(usage?.total_tokens);
  return input !== undefined ? { input } : undefined;
}

/** Records the usage of a successful call under the model that answered, or that it was missing. */
export function recordUsage(metrics: MetricsPort, slot: ModelSlotLabel, model: string, usage: TokenUsage | undefined): void {
  if (usage) metrics.modelTokens(slot, model, usage.input, usage.output);
  else metrics.modelUsageMissing(slot);
}
