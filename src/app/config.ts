/**
 * Strongly-typed runtime configuration, built from environment variables (see `.env.example`).
 * The bot's own settings use the WIRE_SUPPORT_BOT_* family; the Wire SDK settings use WIRE_SDK_*.
 * Set WIRE_SUPPORT_BOT_LLM_BASE_URL to a local Ollama endpoint to keep all inference on-premises.
 */

import {
  DEFAULT_PART_ASSET, PART_ASSET_LABEL_MAX, PART_ASSET_QUESTION_MAX, SUPPORT_REQUEST_KINDS,
} from "../domain/entities/SupportRequest";
import type { PartAssetWording, SupportRequestKind } from "../domain/entities/SupportRequest";
import { canonicalTimeZone } from "../domain/services/timeZone";
import { AGENT_CHAT_MODE_DEFAULT, type AgentChatMode } from "../application/usecases/jira/AskForAgentConversation";
import { LOG_FORMATS, type LogFormat } from "./logging";
import {
  SDK_LOG_CONTENTS, SDK_LOG_LEVELS, type SdkLogContent, type SdkLogLevel,
} from "../infrastructure/wire/SdkLoggerBridge";

/**
 * Per-slot model config. Each slot has a primary model and a fallback; all share one
 * provider endpoint.
 */
export interface ModelSlot {
  model: string;
  fallback: string;
}

export interface LLMConfig {
  /** Chat-completions provider endpoint shared by all slots. */
  baseUrl: string;
  apiKey: string;
  timeoutMs: number;
  /**
   * Sent as `reasoning_effort` on every chat request when set (WIRE_SUPPORT_BOT_LLM_REASONING_EFFORT).
   * Local thinking models such as Qwen 3.5 under Ollama need `none`, or they spend the whole
   * token budget on reasoning and return empty content. Unset leaves requests unchanged.
   */
  reasoningEffort?: ReasoningEffort;
  slots: {
    /** Classification for passive help and the support triage. */
    classify: ModelSlot;
    /** Answers to questions addressed to the bot. */
    respond: ModelSlot;
  };
}

export interface Config {
  wire: {
    /** App authentication token issued by the Wire backend for this application. */
    apiToken: string;
    apiHost: string;
    /** 32-byte key protecting the SDK's local CoreCrypto store (WIRE_SDK_CRYPTO_KEY, 64 hex chars). */
    cryptoKey: Uint8Array;
    /** Qualified ID of the application; verified against the backend at startup. */
    appId: string;
    appDomain: string;
  };
  app: {
    logLevel: string;
    /** Format of the log lines (LOG_FORMAT): json (default) or ecs. */
    logFormat: LogFormat;
    /** Lowest Wire SDK severity logged (WIRE_SUPPORT_BOT_SDK_LOG_LEVEL), independent of logLevel; default warn. */
    sdkLogLevel: SdkLogLevel;
    /** What Wire SDK log lines carry beyond content-free fields (WIRE_SUPPORT_BOT_SDK_LOG_CONTENT); default none. */
    sdkLogContent: SdkLogContent;
    messageBufferSize: number;
    /** Timezone for channels the bot newly joins (WIRE_SUPPORT_BOT_DEFAULT_TIMEZONE), canonical IANA name. Default UTC. */
    defaultTimezone: string;
  };
  llm: LLMConfig;
  /** The service desk (Jira Service Management); required. */
  jira: JiraConfig;
  /** How the asset essential of a part order is named and asked for. */
  partAsset: PartAssetWording;
  /**
   * Delivery locations of part orders, offered as buttons with [Other]
   * (WIRE_SUPPORT_BOT_PART_DELIVERY_LOCATIONS). Empty: the location is asked in text.
   */
  partDeliveryLocations: string[];
  /** The metrics and health endpoint; absent when WIRE_SUPPORT_BOT_METRICS_PORT is unset (no HTTP server). */
  metrics?: MetricsConfig;
}

export interface MetricsConfig {
  /** WIRE_SUPPORT_BOT_METRICS_PORT, 1 to 65535. */
  port: number;
  /** WIRE_SUPPORT_BOT_METRICS_HOST, the address to listen on; default 0.0.0.0 (every IPv4 interface). */
  host: string;
}

export interface JiraConfig {
  /** REST base, e.g. https://api.atlassian.com/ex/jira/<cloudId> for service-account tokens. */
  baseUrl: string;
  /** Site URL used for browse links, e.g. https://example.atlassian.net. */
  siteUrl: string;
  apiToken: string;
  /** When set, requests use Basic auth (email + classic token); otherwise Bearer (scoped token). */
  email?: string;
  projectKey: string;
  serviceDeskId: string;
  timeoutMs: number;
  /**
   * Whether live ticket status, SLAs and customer replies may be passed to the answer model.
   * Off by default: with a remote model provider this sends ticket content to that provider.
   */
  shareWithModel: boolean;
  /**
   * Whether the bot watches unaddressed messages for service-desk problems and questions about
   * open requests, offering to raise (confirmed with yes) or answering the status. Off by default.
   */
  passive: boolean;
  /** Request type per kind. `fault` is the general type, used for any kind without its own entry. */
  requestTypes: RequestTypes;
  /** What the service desk handles, in plain words, for the model prompts; generic wording when absent. */
  serviceScope?: string;
  /**
   * Seconds between checks of open support requests for changes made in Jira (new desk replies,
   * status changes), announced in the request's channel. Absent: no watching. At least 15.
   */
  watchSeconds?: number;
  /**
   * Hours a question after a desk update ([Reply] [Solved, close it], [Solved] [Still broken]) can
   * be answered (WIRE_SUPPORT_BOT_JIRA_UPDATE_QUESTION_HOURS); 0 asks none. Absent: the default
   * (`DESK_UPDATE_QUESTION_HOURS_DEFAULT`). Only used with the watch.
   */
  updateQuestionHours?: number;
  /**
   * Desk agents who get a direct Wire conversation with the requester when assigned: Jira account
   * ID to Wire handle (on the bot's own domain). Absent: no direct conversations.
   */
  agents?: ReadonlyMap<string, string>;
  /**
   * What a newly assigned mapped agent gets (WIRE_SUPPORT_BOT_JIRA_AGENT_CHAT): "ask" asks the
   * requester first ([Open direct chat] [Not now]), "auto" opens the group at once, "off" neither.
   * Default "ask". Only used with `agents` and the watch; with "off", `agents` is left out.
   */
  agentChat: AgentChatMode;
  /**
   * Whether the bot asks the requester for a satisfaction rating (1 to 5) after they answered
   * [Solved] or after any resolve from Wire, and sends it to the request's feedback in Jira
   * (WIRE_SUPPORT_BOT_JIRA_FEEDBACK). Off by default. Needs the questions after a desk update.
   */
  feedback: boolean;
}

/** Longest lifetime of a question after a desk update, in hours. */
export const UPDATE_QUESTION_HOURS_MAX = 72;

const JIRA_REQUIRED_KEYS = [
  "WIRE_SUPPORT_BOT_JIRA_BASE_URL",
  "WIRE_SUPPORT_BOT_JIRA_SITE_URL",
  "WIRE_SUPPORT_BOT_JIRA_API_TOKEN",
  "WIRE_SUPPORT_BOT_JIRA_PROJECT_KEY",
  "WIRE_SUPPORT_BOT_JIRA_SERVICE_DESK_ID",
  "WIRE_SUPPORT_BOT_JIRA_REQUEST_TYPES",
] as const;

/** Tracker request type IDs per request kind; `fault` is required and is the fallback. */
export type RequestTypes = { fault: string } & Partial<Record<SupportRequestKind, string>>;

/**
 * Pure resolver for the Jira settings, kept separate from process.env for testing. The service
 * desk is required: start-up fails, naming every missing setting, unless all required keys are set.
 */
export function resolveJiraConfig(env: Record<string, string | undefined>): JiraConfig {
  const value = (name: string) => env[name]?.trim() || undefined;
  const missing = JIRA_REQUIRED_KEYS.filter((k) => value(k) === undefined);
  if (missing.length > 0) {
    throw new Error(`The service desk (Jira) is required; set: ${missing.join(", ")}`);
  }

  const httpsUrl = (name: string) => {
    const raw = value(name)!.replace(/\/+$/, "");
    let url: URL;
    try { url = new URL(raw); } catch { throw new Error(`${name} must be a valid URL`); }
    if (url.protocol !== "https:") throw new Error(`${name} must use https`);
    return raw;
  };
  const numericId = (name: string) => {
    const raw = value(name)!;
    if (!/^\d+$/.test(raw)) throw new Error(`${name} must be a numeric ID`);
    return raw;
  };
  const projectKey = value("WIRE_SUPPORT_BOT_JIRA_PROJECT_KEY")!.toUpperCase();
  if (!/^[A-Z][A-Z0-9]+$/.test(projectKey)) throw new Error("WIRE_SUPPORT_BOT_JIRA_PROJECT_KEY must be a Jira project key");
  const timeout = resolvePositiveInt(env, "WIRE_SUPPORT_BOT_JIRA_TIMEOUT_MS", 15_000);
  const share = (value("WIRE_SUPPORT_BOT_JIRA_SHARE_WITH_MODEL") ?? "off").toLowerCase();
  if (share !== "on" && share !== "off") throw new Error("WIRE_SUPPORT_BOT_JIRA_SHARE_WITH_MODEL must be on or off");
  const passive = (value("WIRE_SUPPORT_BOT_JIRA_PASSIVE") ?? "off").toLowerCase();
  if (passive !== "on" && passive !== "off") throw new Error("WIRE_SUPPORT_BOT_JIRA_PASSIVE must be on or off");
  const requestTypes = parseRequestTypes(value("WIRE_SUPPORT_BOT_JIRA_REQUEST_TYPES")!);
  const serviceScope = value("WIRE_SUPPORT_BOT_JIRA_SERVICE_SCOPE");
  if (serviceScope && serviceScope.length > 500) throw new Error("WIRE_SUPPORT_BOT_JIRA_SERVICE_SCOPE must be at most 500 characters");
  const agents = parseAgents(value("WIRE_SUPPORT_BOT_JIRA_AGENTS"));
  const watchRaw = value("WIRE_SUPPORT_BOT_JIRA_WATCH_SECONDS");
  if (watchRaw !== undefined && (!/^\d+$/.test(watchRaw) || parseInt(watchRaw, 10) < 15)) {
    throw new Error("WIRE_SUPPORT_BOT_JIRA_WATCH_SECONDS must be a whole number of seconds, at least 15");
  }
  const agentChat = (value("WIRE_SUPPORT_BOT_JIRA_AGENT_CHAT") ?? AGENT_CHAT_MODE_DEFAULT).toLowerCase();
  if (agentChat !== "ask" && agentChat !== "auto" && agentChat !== "off") {
    throw new Error("WIRE_SUPPORT_BOT_JIRA_AGENT_CHAT must be ask, auto or off");
  }
  const feedback = (value("WIRE_SUPPORT_BOT_JIRA_FEEDBACK") ?? "off").toLowerCase();
  if (feedback !== "on" && feedback !== "off") throw new Error("WIRE_SUPPORT_BOT_JIRA_FEEDBACK must be on or off");
  const questionHoursRaw = value("WIRE_SUPPORT_BOT_JIRA_UPDATE_QUESTION_HOURS");
  if (questionHoursRaw !== undefined && (!/^\d+$/.test(questionHoursRaw) || parseInt(questionHoursRaw, 10) > UPDATE_QUESTION_HOURS_MAX)) {
    throw new Error(`WIRE_SUPPORT_BOT_JIRA_UPDATE_QUESTION_HOURS must be a whole number of hours from 0 to ${UPDATE_QUESTION_HOURS_MAX}`);
  }

  return {
    baseUrl: httpsUrl("WIRE_SUPPORT_BOT_JIRA_BASE_URL"),
    siteUrl: httpsUrl("WIRE_SUPPORT_BOT_JIRA_SITE_URL"),
    apiToken: value("WIRE_SUPPORT_BOT_JIRA_API_TOKEN")!,
    email: value("WIRE_SUPPORT_BOT_JIRA_EMAIL"),
    projectKey,
    serviceDeskId: numericId("WIRE_SUPPORT_BOT_JIRA_SERVICE_DESK_ID"),
    timeoutMs: Math.max(1000, timeout),
    shareWithModel: share === "on",
    passive: passive === "on",
    requestTypes,
    ...(serviceScope ? { serviceScope } : {}),
    ...(watchRaw !== undefined ? { watchSeconds: parseInt(watchRaw, 10) } : {}),
    ...(questionHoursRaw !== undefined ? { updateQuestionHours: parseInt(questionHoursRaw, 10) } : {}),
    // With the agent conversation off, the mapping is not used at all.
    ...(agents && agentChat !== "off" ? { agents } : {}),
    agentChat,
    feedback: feedback === "on",
  };
}

/**
 * `<jira account id>=<wire handle>` pairs, comma-separated; a leading `@` on the handle is
 * allowed. Malformed entries and repeated account IDs fail at startup.
 */
function parseAgents(raw: string | undefined): ReadonlyMap<string, string> | undefined {
  if (raw === undefined) return undefined;
  const agents = new Map<string, string>();
  for (const entry of raw.split(",").map((e) => e.trim()).filter(Boolean)) {
    const m = entry.match(/^([A-Za-z0-9:_-]{1,128})\s*=\s*@?([a-z0-9._-]{2,256})$/i);
    if (!m || agents.has(m[1]!)) throw new Error("WIRE_SUPPORT_BOT_JIRA_AGENTS must look like <jira account id>=<wire handle>,...");
    agents.set(m[1]!, m[2]!.toLowerCase());
  }
  if (agents.size === 0) throw new Error("WIRE_SUPPORT_BOT_JIRA_AGENTS must list at least one <jira account id>=<wire handle>");
  return agents;
}

/**
 * `question=102,part=103,fault=101`. `fault` is required; unknown or repeated kinds,
 * non-numeric IDs and malformed entries fail at startup.
 */
function parseRequestTypes(raw: string): RequestTypes {
  const types: Partial<Record<SupportRequestKind, string>> = {};
  for (const entry of raw.split(",").map((e) => e.trim()).filter(Boolean)) {
    const [kind, id, extra] = entry.split("=").map((part) => part?.trim() ?? "");
    if (extra !== undefined || !(SUPPORT_REQUEST_KINDS as readonly string[]).includes(kind ?? "") || !/^\d+$/.test(id ?? "")
        || types[kind as SupportRequestKind] !== undefined) {
      throw new Error("WIRE_SUPPORT_BOT_JIRA_REQUEST_TYPES must look like question=102,part=103,fault=101");
    }
    types[kind as SupportRequestKind] = id;
  }
  if (!types.fault) {
    throw new Error("WIRE_SUPPORT_BOT_JIRA_REQUEST_TYPES must include fault=<id>, the general request type");
  }
  return { ...types, fault: types.fault };
}

/**
 * The asset essential of part orders: WIRE_SUPPORT_BOT_PART_ASSET_LABEL (shown as "<label>: ...")
 * and WIRE_SUPPORT_BOT_PART_ASSET_QUESTION (asked as "To order it I need <question>."). Each falls
 * back to the generic default when unset; a value over its bound or spanning lines fails at startup.
 */
export function resolvePartAsset(env: Record<string, string | undefined>): PartAssetWording {
  const read = (name: string, max: number, fallback: string): string => {
    const raw = env[name]?.trim();
    if (!raw) return fallback;
    if (/[\r\n]/.test(raw) || raw.length > max) throw new Error(`${name} must be one line of at most ${max} characters`);
    return raw;
  };
  return {
    label: read("WIRE_SUPPORT_BOT_PART_ASSET_LABEL", PART_ASSET_LABEL_MAX, DEFAULT_PART_ASSET.label),
    question: read("WIRE_SUPPORT_BOT_PART_ASSET_QUESTION", PART_ASSET_QUESTION_MAX, DEFAULT_PART_ASSET.question),
  };
}

/** Most delivery locations offered as buttons; [Other] is added to them. */
export const PART_DELIVERY_LOCATIONS_MAX = 5;
/** Longest delivery location, so it fits a button. */
export const PART_DELIVERY_LOCATION_MAX = 40;

/**
 * WIRE_SUPPORT_BOT_PART_DELIVERY_LOCATIONS: the delivery locations offered as buttons, separated
 * by ";", each trimmed. Unset or blank: none, so the location is asked in text. An empty entry, a
 * repeated one (ignoring case), "Other", a value over `PART_DELIVERY_LOCATION_MAX` characters or
 * spanning lines, or more than `PART_DELIVERY_LOCATIONS_MAX` locations fail at startup.
 */
export function resolvePartDeliveryLocations(env: Record<string, string | undefined>): string[] {
  const name = "WIRE_SUPPORT_BOT_PART_DELIVERY_LOCATIONS";
  const raw = env[name]?.trim();
  if (!raw) return [];
  const locations = raw.split(";").map((entry) => entry.trim());
  const malformed = () => new Error(
    `${name} must list up to ${PART_DELIVERY_LOCATIONS_MAX} different locations separated by ";", each one line of at most ${PART_DELIVERY_LOCATION_MAX} characters and not "Other"`,
  );
  if (locations.length > PART_DELIVERY_LOCATIONS_MAX) throw malformed();
  const seen = new Set<string>();
  for (const location of locations) {
    const folded = location.toLowerCase();
    if (!location || /[\r\n\t]/.test(location) || location.length > PART_DELIVERY_LOCATION_MAX || folded === "other" || seen.has(folded)) {
      throw malformed();
    }
    seen.add(folded);
  }
  return locations;
}

/** WIRE_SUPPORT_BOT_DEFAULT_TIMEZONE as a canonical IANA name; UTC when unset; an unknown name fails at startup. */
export function resolveDefaultTimezone(env: Record<string, string | undefined>): string {
  const raw = env.WIRE_SUPPORT_BOT_DEFAULT_TIMEZONE?.trim();
  if (!raw) return "UTC";
  const zone = canonicalTimeZone(raw);
  if (!zone) throw new Error("WIRE_SUPPORT_BOT_DEFAULT_TIMEZONE must be an IANA timezone name such as Europe/Berlin");
  return zone;
}

/** "a, b or c" */
const choices = (values: readonly string[]) => `${values.slice(0, -1).join(", ")} or ${values[values.length - 1]}`;

/**
 * LOG_FORMAT, WIRE_SUPPORT_BOT_SDK_LOG_LEVEL and WIRE_SUPPORT_BOT_SDK_LOG_CONTENT, any case; the
 * defaults (json, warn, none) when unset or blank. An unknown value fails at startup.
 */
export function resolveLogSettings(env: Record<string, string | undefined>): {
  logFormat: LogFormat; sdkLogLevel: SdkLogLevel; sdkLogContent: SdkLogContent;
} {
  const oneOf = <T extends string>(name: string, values: readonly T[], fallback: T): T => {
    const raw = env[name]?.trim().toLowerCase();
    if (!raw) return fallback;
    if (!(values as readonly string[]).includes(raw)) throw new Error(`${name} must be ${choices(values)}`);
    return raw as T;
  };
  return {
    logFormat: oneOf("LOG_FORMAT", LOG_FORMATS, "json"),
    sdkLogLevel: oneOf("WIRE_SUPPORT_BOT_SDK_LOG_LEVEL", SDK_LOG_LEVELS, "warn"),
    sdkLogContent: oneOf("WIRE_SUPPORT_BOT_SDK_LOG_CONTENT", SDK_LOG_CONTENTS, "none"),
  };
}

/**
 * WIRE_SUPPORT_BOT_METRICS_PORT and WIRE_SUPPORT_BOT_METRICS_HOST. An unset or blank port turns
 * the HTTP server off (undefined); otherwise it must be a whole number from 1 to 65535. The host
 * defaults to 0.0.0.0 and must not contain spaces.
 */
export function resolveMetricsConfig(env: Record<string, string | undefined>): MetricsConfig | undefined {
  const rawPort = env.WIRE_SUPPORT_BOT_METRICS_PORT?.trim();
  if (!rawPort) return undefined;
  const port = /^\d{1,5}$/.test(rawPort) ? parseInt(rawPort, 10) : NaN;
  if (!(port >= 1 && port <= 65535)) throw new Error("WIRE_SUPPORT_BOT_METRICS_PORT must be a port number from 1 to 65535");
  const host = env.WIRE_SUPPORT_BOT_METRICS_HOST?.trim() || "0.0.0.0";
  if (/\s/.test(host)) throw new Error("WIRE_SUPPORT_BOT_METRICS_HOST must be a host name or IP address");
  return { port, host };
}

function getEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} must be set`);
  return value;
}

const CRYPTO_KEY_BYTES = 32;

/**
 * Decode WIRE_SDK_CRYPTO_KEY: exactly 32 bytes, hex-encoded (64 chars).
 * Generate one with `openssl rand -hex 32`. Losing it means losing the crypto store.
 */
function parseCryptoKey(name: string): Uint8Array {
  const raw = getEnv(name).trim();
  if (!/^[0-9a-fA-F]{64}$/.test(raw)) {
    throw new Error(`${name} must be ${CRYPTO_KEY_BYTES} bytes hex-encoded (${CRYPTO_KEY_BYTES * 2} hex characters)`);
  }
  return new Uint8Array(Buffer.from(raw, "hex"));
}

function envStr(name: string, defaultVal: string): string {
  return process.env[name] ?? defaultVal;
}

/**
 * A numeric setting as a positive whole number; the default when unset or blank. Anything else
 * (not a number, a fraction, zero or negative) fails at startup, naming the setting.
 */
export function resolvePositiveInt(env: Record<string, string | undefined>, name: string, defaultVal: number): number {
  const raw = env[name]?.trim();
  if (!raw) return defaultVal;
  const n = /^\d+$/.test(raw) ? parseInt(raw, 10) : NaN;
  if (!Number.isSafeInteger(n) || n < 1) throw new Error(`${name} must be a positive whole number, got "${raw}"`);
  return n;
}

export type ReasoningEffort = "none" | "low" | "medium" | "high";

/** The reasoning effort setting as a partial config; an unknown value fails at startup. */
export function optionalReasoningEffort(raw: string | undefined): { reasoningEffort?: ReasoningEffort } {
  const value = raw?.trim().toLowerCase();
  if (!value) return {};
  if (value !== "none" && value !== "low" && value !== "medium" && value !== "high") {
    throw new Error("WIRE_SUPPORT_BOT_LLM_REASONING_EFFORT must be none, low, medium or high");
  }
  return { reasoningEffort: value };
}

function loadLLMConfig(): LLMConfig {
  const baseUrl = envStr("WIRE_SUPPORT_BOT_LLM_BASE_URL", "http://localhost:11434/v1").replace(/\/+$/, "");
  const apiKey = envStr("WIRE_SUPPORT_BOT_LLM_API_KEY", "");
  const slot = (modelEnv: string, fallbackEnv: string, defaultModel: string, defaultFallback: string): ModelSlot => ({
    model: envStr(modelEnv, defaultModel),
    fallback: envStr(fallbackEnv, defaultFallback),
  });
  return {
    baseUrl,
    apiKey,
    timeoutMs: resolvePositiveInt(process.env, "WIRE_SUPPORT_BOT_LLM_TIMEOUT_MS", 60_000),
    ...optionalReasoningEffort(process.env.WIRE_SUPPORT_BOT_LLM_REASONING_EFFORT),
    slots: {
      classify: slot("WIRE_SUPPORT_BOT_MODEL_CLASSIFY", "WIRE_SUPPORT_BOT_FALLBACK_CLASSIFY", "qwen3-next:80b", "qwen3-next:80b"),
      respond:  slot("WIRE_SUPPORT_BOT_MODEL_RESPOND",  "WIRE_SUPPORT_BOT_FALLBACK_RESPOND",  "qwen3-next:80b", "qwen3-next:80b"),
    },
  };
}

export function loadConfig(): Config {
  const wire = {
    apiToken: getEnv("WIRE_SDK_API_TOKEN"),
    apiHost: getEnv("WIRE_SDK_API_HOST"),
    cryptoKey: parseCryptoKey("WIRE_SDK_CRYPTO_KEY"),
    appId: getEnv("WIRE_SDK_APP_ID"),
    appDomain: getEnv("WIRE_SDK_APP_DOMAIN"),
  };

  // Read by Prisma directly; checked here so a missing URL fails with a clear message.
  getEnv("DATABASE_URL");

  const logLevel = process.env.LOG_LEVEL ?? "info";
  const logSettings = resolveLogSettings(process.env);
  const messageBufferSize = Math.min(resolvePositiveInt(process.env, "MESSAGE_BUFFER_SIZE", 50), 500);

  const defaultTimezone = resolveDefaultTimezone(process.env);
  const llm = loadLLMConfig();
  const jira = resolveJiraConfig(process.env);
  const partAsset = resolvePartAsset(process.env);
  const partDeliveryLocations = resolvePartDeliveryLocations(process.env);
  const metrics = resolveMetricsConfig(process.env);

  return {
    wire,
    app: { logLevel, ...logSettings, messageBufferSize, defaultTimezone },
    llm,
    jira,
    partAsset,
    partDeliveryLocations,
    ...(metrics ? { metrics } : {}),
  };
}
