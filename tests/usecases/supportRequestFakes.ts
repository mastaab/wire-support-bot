import { vi } from "vitest";
import type { SupportRequest } from "../../src/domain/entities/SupportRequest";
import type { QualifiedId } from "../../src/domain/ids/QualifiedId";
import type { SupportRequestListOptions } from "../../src/domain/repositories/SupportRequestRepository";
import type { IssueSnapshot } from "../../src/application/ports/IssueTrackerPort";
import type {
  CompositeButton, CompositePromptOptions, OutboundTextOptions, SentMessageRef,
} from "../../src/application/ports/WireOutboundPort";

/** Shared mocked ports for the support-request use case tests. No DB, network or SDK. */

export const convId: QualifiedId = { id: "conv-1", domain: "example.com" };
export const alice: QualifiedId = { id: "user-1", domain: "example.com" };
export const bob: QualifiedId = { id: "user-2", domain: "example.com" };
export const created = new Date("2026-09-25T09:00:00Z");

export function makeRequest(overrides: Partial<SupportRequest> = {}): SupportRequest {
  return {
    key: "SD-6",
    conversationId: convId,
    requesterId: alice,
    requesterName: "Alice",
    summary: "VPN drops every ten minutes",
    kind: "fault",
    statusCategory: "todo",
    createdAt: created,
    updatedAt: created,
    deleted: false,
    version: 1,
    ...overrides,
  };
}

export function makeSnapshot(overrides: Partial<IssueSnapshot> = {}): IssueSnapshot {
  return {
    key: "SD-6",
    url: "https://jira.test/browse/SD-6",
    summary: "VPN drops every ten minutes",
    statusCategory: "in_progress",
    slas: [
      { name: "Time to first response", state: "met", elapsed: "3m", goal: "4h" },
      { name: "Time to done", state: "running", remaining: "15h", goal: "16h" },
    ],
    ...overrides,
  };
}

/** Repository mock over a fixed set of records; `findByKey` matches the key exactly, like the contract. */
export function makeRequests(records: SupportRequest[] = [makeRequest()]) {
  return {
    create: vi.fn(async (request: SupportRequest) => request),
    findByKey: vi.fn(async (key: string) => records.find((r) => r.key === key) ?? null),
    listByConversation: vi.fn(async (_conversationId: QualifiedId, _options?: SupportRequestListOptions) => records),
    updateStatusCategory: vi.fn(async (key: string, statusCategory: SupportRequest["statusCategory"], updatedAt: Date) => {
      const found = records.find((r) => r.key === key);
      return found ? { ...found, statusCategory, updatedAt, version: found.version + 1 } : null;
    }),
    listWatched: vi.fn(async () => records.filter((r) => !r.deleted)),
    advanceLastSeenReplyAt: vi.fn().mockResolvedValue(undefined),
    setLastMessage: vi.fn().mockResolvedValue(undefined),
    setAssignee: vi.fn().mockResolvedValue(undefined),
    markAgentConversation: vi.fn().mockResolvedValue(true),
    setAgentConversation: vi.fn().mockResolvedValue(undefined),
    markAgentConversationLeft: vi.fn().mockResolvedValue(undefined),
    listAgentConversationsNotLeft: vi.fn(async () => records.filter((r) => r.agentConversationId && !r.agentConversationLeftAt)),
  };
}

export function makeTracker() {
  return {
    projectKey: "SD",
    createIssue: vi.fn(),
    getIssue: vi.fn().mockResolvedValue(makeSnapshot()),
    resolveIssue: vi.fn(),
    listCustomerReplies: vi.fn().mockResolvedValue([]),
    addCustomerReply: vi.fn().mockResolvedValue(undefined),
    listChangedSince: vi.fn().mockResolvedValue([]),
    addCustomerAttachment: vi.fn().mockResolvedValue(undefined),
  };
}

/** The reference `makeWire` returns for the n-th sent message (1-based). */
export function sentRefFor(n: number): SentMessageRef {
  return { messageId: `msg-${n}`, sha256: n.toString(16).padStart(64, "0") };
}

export function makeWire() {
  const sent: string[] = [];
  const wire = {
    sendPlainText: vi.fn(async (_c: QualifiedId, text: string, _o?: OutboundTextOptions): Promise<SentMessageRef | undefined> => {
      sent.push(text);
      return sentRefFor(sent.length);
    }),
    getUserProfile: vi.fn(),
    // An offer question goes with buttons; it is counted and numbered with the plain texts.
    sendCompositePrompt: vi.fn(async (_c: QualifiedId, text: string, _b: CompositeButton[], _o?: CompositePromptOptions): Promise<SentMessageRef | undefined> => {
      sent.push(text);
      return sentRefFor(sent.length);
    }),
    sendButtonConfirmation: vi.fn().mockResolvedValue(undefined),
    closeButtonPrompt: vi.fn().mockResolvedValue(undefined),
    sendReaction: vi.fn(),
    sendFile: vi.fn(),
    withTyping: <T>(_c: QualifiedId, work: () => Promise<T>): Promise<T> => work(),
  };
  return { wire, sent };
}

export function makeAudit() {
  return { append: vi.fn().mockResolvedValue(undefined) };
}

export function makeLogger() {
  return { warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn(), child: vi.fn() };
}

/** Everything a logger received, for checks that bodies never reach logs. */
export function loggedText(logger: ReturnType<typeof makeLogger>): string {
  return JSON.stringify([logger.warn.mock.calls, logger.info.mock.calls, logger.debug.mock.calls, logger.error.mock.calls]);
}

/** The ways a key is outside this conversation's scope, each with the same reply. */
export const OUT_OF_SCOPE: Array<[string, SupportRequest[], string]> = [
  ["raised in another conversation", [makeRequest({ conversationId: { id: "conv-2", domain: "example.com" } })], "SD-6"],
  ["in the same conversation ID on another domain", [makeRequest({ conversationId: { id: "conv-1", domain: "other.example" } })], "SD-6"],
  ["deleted", [makeRequest({ deleted: true })], "SD-6"],
  ["unknown", [], "SD-6"],
  ["from another project", [makeRequest({ key: "OPS-6" })], "OPS-6"],
];
