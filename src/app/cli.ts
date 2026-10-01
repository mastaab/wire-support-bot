/**
 * CLI harness for Wire Support Bot: drives WireEventRouter directly from stdin/stdout.
 *
 * Reads `.env` from the working directory, like the bot itself; settings already in the
 * environment take precedence.
 *
 * Usage (interactive):
 *   npm run cli
 *
 * Usage (scripted):
 *   printf "@Wire Support Bot support requests\n" | npm run cli
 *
 * Message format:
 *   <message>                    sent as the default user (Alice)
 *   <Name>: <message>            sent as a named member (must be in the seeded roster)
 *   <number>                     after a question with buttons: clicks that option (the options
 *                                are printed numbered under the question); when the buttons are
 *                                numbers themselves (quantities), clicks the button with that label
 *
 * Bot replies are printed prefixed with "[Wire Support Bot]". All other log output goes to
 * stderr so stdout stays clean for scripted use.
 *
 * Exit: send EOF (Ctrl-D) or the word "exit" / "quit".
 */

import "reflect-metadata";
import dotenv from "dotenv";
import readline from "readline";
import { randomUUID } from "node:crypto";
import { loadConfig } from "./config";
import { initLogging, getLogger } from "./logging";
import { getPrismaClient } from "../infrastructure/persistence/postgres/PrismaClient";
import { WireEventRouter } from "../infrastructure/wire/WireEventRouter";
import { cliButtonClick, createCliOutbound } from "./cliOutbound";
import type { CliMember } from "./cliOutbound";
import type { QualifiedId } from "../domain/ids/QualifiedId";
import { toChannelId } from "../domain/ids/channelId";
import { PrismaChannelConfigRepository } from "../infrastructure/persistence/postgres/PrismaChannelConfigRepository";
import { PrismaAuditLogRepository } from "../infrastructure/persistence/postgres/PrismaAuditLogRepository";
import { ConversationMessageBuffer } from "../application/services/ConversationMessageBuffer";
import { InMemoryMemberCache } from "../infrastructure/services/InMemoryMemberCache";
import { InMemoryProcessingQueue } from "../infrastructure/queue/InMemoryProcessingQueue";
import { ProcessingPipeline } from "../infrastructure/pipeline/ProcessingPipeline";
import type { MessageJob } from "../infrastructure/pipeline/ProcessingPipeline";
import { LLMClientFactory } from "../infrastructure/llm/LLMClientFactory";
import { OpenAIGeneralAnswerAdapter } from "../infrastructure/llm/OpenAIGeneralAnswerAdapter";
import { OpenAIClassifierAdapter } from "../infrastructure/llm/OpenAIClassifierAdapter";
import { RaiseSupportRequest } from "../application/usecases/jira/RaiseSupportRequest";
import { ListSupportRequests } from "../application/usecases/jira/ListSupportRequests";
import { ResolveSupportRequest } from "../application/usecases/jira/ResolveSupportRequest";
import { PrismaSupportRequestRepository } from "../infrastructure/persistence/postgres/PrismaSupportRequestRepository";
import { GetIssueStatus } from "../application/usecases/jira/GetIssueStatus";
import { CompletePartOrder } from "../application/usecases/jira/CompletePartOrder";
import { OfferSupportFromConversation } from "../application/usecases/jira/OfferSupportFromConversation";
import { OpenAISupportTriageAdapter } from "../infrastructure/llm/OpenAISupportTriageAdapter";
import { JiraServiceManagementAdapter } from "../infrastructure/jira/JiraServiceManagementAdapter";
import { InMemoryPendingOfferStore } from "../infrastructure/services/InMemoryPendingOfferStore";
import { ReplyToServiceDesk } from "../application/usecases/jira/ReplyToServiceDesk";
import { ConfirmOffer } from "../application/usecases/jira/ConfirmOffer";
import { AnswerQuestion } from "../application/usecases/general/AnswerQuestion";
import { SetChannelTimezone } from "../application/usecases/general/SetChannelTimezone";

dotenv.config();

// ── Fixed identities ──────────────────────────────────────────────────────────

const DOMAIN = "cli.local";
const CHANNEL_ID_RAW: QualifiedId = { id: "cli-channel", domain: DOMAIN };
const BOT_ID: QualifiedId = { id: "wire-support-bot", domain: DOMAIN };

/** Seeded roster: members available to send messages as. */
const MEMBERS: CliMember[] = [
  { name: "Alice", id: { id: "alice", domain: DOMAIN } },
  { name: "Bob",   id: { id: "bob",   domain: DOMAIN } },
  { name: "Carol", id: { id: "carol", domain: DOMAIN } },
  { name: "Dave",  id: { id: "dave",  domain: DOMAIN } },
];

// ── Fake TextMessage builder ──────────────────────────────────────────────────

function buildMessage(text: string, sender: QualifiedId): object {
  const botMentionPattern = /^@(?:wire support bot)\b/i;
  const mentions = botMentionPattern.test(text.trim())
    ? [{ userId: BOT_ID, offset: text.indexOf("@"), length: text.trim().match(botMentionPattern)![0].length }]
    : [];
  // The synthetic roster's @names model actual Wire person mentions.
  for (const match of text.matchAll(/@(Alice|Bob|Carol|Dave)\b/gi)) {
    const member = MEMBERS.find(m => m.name.toLowerCase() === match[1].toLowerCase())!;
    mentions.push({ userId: member.id, offset: match.index!, length: match[0].length });
  }
  return {
    id: `cli-msg-${randomUUID()}`,
    conversationId: CHANNEL_ID_RAW,
    sender,
    text,
    mentions,
  };
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const config = loadConfig();
  // Suppress info logs to stderr so stdout stays clean for scripted use
  initLogging(process.env.LOG_LEVEL ?? "warn");
  const logger = getLogger();

  const prisma = getPrismaClient();

  const channelConfigRepo = new PrismaChannelConfigRepository();
  const auditLogRepo      = new PrismaAuditLogRepository();
  const messageBuffer     = new ConversationMessageBuffer(config.app.messageBufferSize);
  const memberCache       = new InMemoryMemberCache();
  const llmFactory        = new LLMClientFactory(config.llm, logger);

  // Seed member cache with the CLI roster + bot
  const channelId = toChannelId(CHANNEL_ID_RAW);
  memberCache.setMembers(CHANNEL_ID_RAW, [
    ...MEMBERS.map(m => ({ userId: m.id, role: "member" as const, name: m.name })),
    { userId: BOT_ID, role: "member" as const },
  ]);

  // Ensure the channel has a config
  const existing = await channelConfigRepo.get(channelId);
  if (!existing) {
    await channelConfigRepo.upsert({
      channelId,
      organisationId: DOMAIN,
      timezone: config.app.defaultTimezone,
    });
  }

  const cliOutbound = createCliOutbound(MEMBERS, (text) => process.stdout.write(text));
  const wireOutbound = cliOutbound.wireOutbound;

  // The service desk. Passive help also needs WIRE_SUPPORT_BOT_JIRA_PASSIVE.
  const jira = config.jira;
  const issueTracker = new JiraServiceManagementAdapter(jira, logger);
  const pendingOffers = new InMemoryPendingOfferStore();
  const supportRequestsRepo = new PrismaSupportRequestRepository();
  const getIssueStatus = new GetIssueStatus(supportRequestsRepo, issueTracker, wireOutbound, auditLogRepo, logger);
  const passiveOn = jira.passive;
  // Triage for passive help and for completing part orders.
  const supportTriage = new OpenAISupportTriageAdapter(llmFactory, logger, { serviceScope: jira.serviceScope, partAsset: config.partAsset });
  const completePartOrder = new CompletePartOrder(supportTriage, pendingOffers, wireOutbound, logger, undefined, config.partAsset, config.partDeliveryLocations);

  // Passive help
  let processingQueue: InMemoryProcessingQueue<MessageJob> | undefined;
  let pipeline: ProcessingPipeline | undefined;
  if (passiveOn) {
    const supportHelp = new OfferSupportFromConversation(
      supportRequestsRepo, supportTriage, getIssueStatus, pendingOffers, wireOutbound, logger, undefined, config.partAsset, config.partDeliveryLocations,
    );
    const classifier = new OpenAIClassifierAdapter(llmFactory, logger, { serviceScope: jira.serviceScope });
    const passivePipeline = new ProcessingPipeline({
      classifier, supportHelp, channelConfig: channelConfigRepo, messageBuffer, botUserId: BOT_ID, wireOutbound, logger,
    });
    processingQueue = new InMemoryProcessingQueue<MessageJob>((msg, meta) => logger.warn(msg, meta));
    processingQueue.setWorker(job => passivePipeline.process(job.payload, job.signal));
    pipeline = passivePipeline;
  }

  const answerQuestion = new AnswerQuestion(
    new OpenAIGeneralAnswerAdapter(llmFactory, logger, {
      jiraProjectKey: jira.projectKey, jiraShareWithModel: jira.shareWithModel, jiraServiceScope: jira.serviceScope, partAsset: config.partAsset,
    }),
    wireOutbound,
    { tracker: issueTracker, requests: supportRequestsRepo, offers: pendingOffers, auditLog: auditLogRepo, shareWithModel: jira.shareWithModel, passive: passiveOn, partAsset: config.partAsset, partDeliveryLocations: config.partDeliveryLocations },
    undefined,
    logger,
  );

  // Support requests, built once so ConfirmOffer shares the router's instances.
  const raiseSupportRequest = new RaiseSupportRequest(supportRequestsRepo, issueTracker, wireOutbound, auditLogRepo, logger, jira.requestTypes, config.partAsset);
  const listSupportRequests = new ListSupportRequests(supportRequestsRepo, issueTracker, wireOutbound, auditLogRepo, logger);
  const resolveSupportRequest = new ResolveSupportRequest(supportRequestsRepo, issueTracker, wireOutbound, auditLogRepo, logger);
  const replyToServiceDesk = new ReplyToServiceDesk(supportRequestsRepo, issueTracker, wireOutbound, auditLogRepo, logger);
  // The CLI has no file transport, so no attachments.
  const confirmOffer = new ConfirmOffer(
    pendingOffers, { raiseSupportRequest, replyToServiceDesk, resolveSupportRequest }, wireOutbound, undefined, config.partAsset, config.partDeliveryLocations,
  );
  const router = new WireEventRouter({
    logger,
    botUserId: BOT_ID,
    answerQuestion,
    setChannelTimezone: new SetChannelTimezone(channelConfigRepo, auditLogRepo, wireOutbound, config.app.defaultTimezone, undefined, logger),
    defaultTimezone: config.app.defaultTimezone,
    raiseSupportRequest,
    completePartOrder,
    // The CLI does not watch Jira.
    supportWelcome: { projectKey: issueTracker.projectKey, passive: passiveOn, watching: false },
    listSupportRequests,
    resolveSupportRequest,
    getIssueStatus,
    replyToServiceDesk,
    pendingOffers,
    confirmOffer,
    wireOutbound,
    memberCache,
    messageBuffer,
    channelConfig: channelConfigRepo,
    processingQueue,
    pipeline,
  });

  const isInteractive = process.stdin.isTTY;

  if (isInteractive) {
    process.stderr.write(`Wire Support Bot CLI: type messages, prefix with "Name: " to change sender\n`);
    process.stderr.write(`Members: ${MEMBERS.map(m => m.name).join(", ")}\n`);
    process.stderr.write(`Type "exit" or Ctrl-D to quit.\n\n`);
  }

  const rl = readline.createInterface({ input: process.stdin, output: undefined, terminal: false });

  for await (const line of rl) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (trimmed === "exit" || trimmed === "quit") break;

    // Parse "Name: message" or default to Alice
    const senderMatch = trimmed.match(/^([A-Za-z][A-Za-z0-9 ]*?):\s+(.+)$/);
    let sender = MEMBERS[0]!.id;
    let text = trimmed;

    if (senderMatch) {
      const name = senderMatch[1]!.trim();
      const found = MEMBERS.find(m => m.name.toLowerCase() === name.toLowerCase());
      if (found) {
        sender = found.id;
        text = senderMatch[2]!;
      }
    }

    if (isInteractive) {
      const senderName = MEMBERS.find(m => m.id.id === sender.id)?.name ?? sender.id;
      process.stderr.write(`[${senderName}] ${text}\n`);
    }

    // A bare number after a button question clicks that option, as a member would in Wire.
    const click = cliButtonClick(text, sender, CHANNEL_ID_RAW, cliOutbound.latestPrompt());
    if (click) {
      await router.onButtonClicked(click);
      continue;
    }
    const msg = buildMessage(text, sender);
    await router.onTextMessageReceived(msg as Parameters<typeof router.onTextMessageReceived>[0]);
  }

  // Let queued passive help finish before closing the DB connection.
  await processingQueue?.waitForIdle(180_000);
  await prisma.$disconnect();
}

main().catch(() => {
  process.stderr.write("CLI failed; verify configuration and service availability\n");
  process.exit(1);
});
