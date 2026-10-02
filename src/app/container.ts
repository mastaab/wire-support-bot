import "reflect-metadata";
import type { WireAppSdk } from "@wireapp/wire-apps-js-sdk";
import { QualifiedId as SdkQualifiedId } from "@wireapp/wire-apps-js-sdk";
import type { Config } from "./config";
import type { Logger } from "./logging";
import { createWireOutboundAdapter, type HandlerManagerRef } from "../infrastructure/wire/WireOutboundAdapter";
import { WireReplyContext } from "../infrastructure/wire/WireReplyContext";
import { WireEventRouter } from "../infrastructure/wire/WireEventRouter";
import { createWireClient } from "../infrastructure/wire/WireClient";
import { PrismaChannelConfigRepository } from "../infrastructure/persistence/postgres/PrismaChannelConfigRepository";
import { PrismaAuditLogRepository } from "../infrastructure/persistence/postgres/PrismaAuditLogRepository";
import { InMemoryMemberCache } from "../infrastructure/services/InMemoryMemberCache";
import { ConversationMessageBuffer } from "../application/services/ConversationMessageBuffer";
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
import { WatchSupportRequests } from "../application/usecases/jira/WatchSupportRequests";
import { DESK_UPDATE_QUESTION_HOURS_DEFAULT, DeskUpdateQuestions } from "../application/services/deskUpdateQuestions";
import { SupportRequestWrites } from "../application/services/SupportRequestWrites";
import { AttachFileToRequest } from "../application/usecases/jira/AttachFileToRequest";
import { OfferAttachment } from "../application/usecases/jira/OfferAttachment";
import { createWireAssetAdapter } from "../infrastructure/wire/WireAssetAdapter";
import { CreatedConversations } from "../infrastructure/wire/CreatedConversations";
import { createWireConversationAdapter } from "../infrastructure/wire/WireConversationAdapter";
import { OpenAgentConversation } from "../application/usecases/jira/OpenAgentConversation";
import { LeavePendingAgentGroups } from "../application/usecases/jira/LeavePendingAgentGroups";
import { AskForAgentConversation } from "../application/usecases/jira/AskForAgentConversation";
import { SubmitFeedback } from "../application/usecases/jira/SubmitFeedback";
import { FeedbackQuestions } from "../application/services/feedbackQuestions";
import { startIntervalRunner, type IntervalRunner } from "./intervalRunner";
import { startOfferPromptSweep } from "./offerPromptSweep";
import { getPrismaClient } from "../infrastructure/persistence/postgres/PrismaClient";
import { OpenAIGeneralAnswerAdapter } from "../infrastructure/llm/OpenAIGeneralAnswerAdapter";
import { LLMClientFactory } from "../infrastructure/llm/LLMClientFactory";
import { OpenAIClassifierAdapter } from "../infrastructure/llm/OpenAIClassifierAdapter";
import { InMemoryProcessingQueue } from "../infrastructure/queue/InMemoryProcessingQueue";
import { ProcessingPipeline } from "../infrastructure/pipeline/ProcessingPipeline";
import type { MessageJob } from "../infrastructure/pipeline/ProcessingPipeline";
import { AnswerQuestion } from "../application/usecases/general/AnswerQuestion";
import { SetChannelTimezone } from "../application/usecases/general/SetChannelTimezone";

export interface Container {
  getWireClient(): Promise<WireAppSdk>;
  shutdown(): Promise<void>;
}

export function createContainer(config: Config, logger: Logger): Container {
  const handlerRef: HandlerManagerRef = { current: null };

  const replyContext = new WireReplyContext();
  const wireOutbound = createWireOutboundAdapter(handlerRef, logger, replyContext, { id: config.wire.appId, domain: config.wire.appDomain });

  const channelConfigRepo = new PrismaChannelConfigRepository();
  const auditLogRepo = new PrismaAuditLogRepository();
  const botUserId = { id: config.wire.appId, domain: config.wire.appDomain };
  const memberCache = new InMemoryMemberCache();
  const messageBuffer = new ConversationMessageBuffer(config.app.messageBufferSize);

  // One factory for every adapter, so models that reject temperature are learned once.
  const llmFactory = new LLMClientFactory(config.llm, logger);
  // The service desk (Jira Service Management). Ticket content reaches the answer model only
  // when WIRE_SUPPORT_BOT_JIRA_SHARE_WITH_MODEL is on.
  const jira = config.jira;
  const issueTracker = new JiraServiceManagementAdapter(jira, logger);
  logger.info("Service desk connected", { projectKey: issueTracker.projectKey, shareWithModel: jira.shareWithModel, passive: jira.passive });
  const pendingOffers = new InMemoryPendingOfferStore();
  const supportRequestsRepo = new PrismaSupportRequestRepository();
  const generalAnswerAdapter = new OpenAIGeneralAnswerAdapter(llmFactory, logger, {
    jiraProjectKey: jira.projectKey, jiraShareWithModel: jira.shareWithModel, jiraServiceScope: jira.serviceScope, partAsset: config.partAsset,
  });
  const passiveOn = jira.passive;
  // Shared with the router and ConfirmOffer, so a passive offer can be confirmed.
  const getIssueStatus = new GetIssueStatus(supportRequestsRepo, issueTracker, wireOutbound, auditLogRepo, logger);
  // Triage for passive help and for completing part orders.
  const supportTriage = new OpenAISupportTriageAdapter(llmFactory, logger, { serviceScope: jira.serviceScope, partAsset: config.partAsset });
  const completePartOrder = new CompletePartOrder(supportTriage, pendingOffers, wireOutbound, logger, undefined, config.partAsset, config.partDeliveryLocations);

  // Passive help: unaddressed messages are classified and, for a service-desk matter, offered
  // help, one channel at a time in message order. Absent when passive help is off.
  let processingQueue: InMemoryProcessingQueue<MessageJob> | undefined;
  let pipeline: ProcessingPipeline | undefined;
  if (passiveOn) {
    const supportHelp = new OfferSupportFromConversation(
      supportRequestsRepo, supportTriage, getIssueStatus, pendingOffers, wireOutbound, logger, undefined, config.partAsset, config.partDeliveryLocations,
    );
    const classifier = new OpenAIClassifierAdapter(llmFactory, logger, { serviceScope: jira.serviceScope });
    const passivePipeline = new ProcessingPipeline({
      classifier, supportHelp, channelConfig: channelConfigRepo, messageBuffer, botUserId, wireOutbound, logger,
    });
    processingQueue = new InMemoryProcessingQueue<MessageJob>((msg, meta) => logger.warn(msg, meta));
    processingQueue.setWorker((job) => passivePipeline.process(job.payload, job.signal));
    pipeline = passivePipeline;
  }

  // No retrieval source is wired: answers use the conversation and its support requests. A
  // knowledge source plugs in here as a RetrievalPort.
  const answerQuestion = new AnswerQuestion(
    generalAnswerAdapter,
    wireOutbound,
    { tracker: issueTracker, requests: supportRequestsRepo, offers: pendingOffers, auditLog: auditLogRepo, shareWithModel: jira.shareWithModel, passive: passiveOn, partAsset: config.partAsset, partDeliveryLocations: config.partDeliveryLocations, partDetails: supportTriage },
    undefined,
    logger,
  );

  // Support requests, built once so ConfirmOffer shares the router's instances.
  const raiseSupportRequest = new RaiseSupportRequest(supportRequestsRepo, issueTracker, wireOutbound, auditLogRepo, logger, jira.requestTypes, config.partAsset);
  const listSupportRequests = new ListSupportRequests(supportRequestsRepo, issueTracker, wireOutbound, auditLogRepo, logger);
  // Shared by resolve and the watch, so a resolve from Wire is never announced as the desk's.
  const supportRequestWrites = new SupportRequestWrites();
  const replyToServiceDesk = new ReplyToServiceDesk(supportRequestsRepo, issueTracker, wireOutbound, auditLogRepo, logger);
  // Direct conversations between requester and desk agent: groups the app creates and leaves.
  // The router ignores a group until the app has left it; a leave still owed is retried at
  // start-up and before each watch check, also when the agent mapping has since been removed.
  const createdConversations = new CreatedConversations();
  const wireConversations = createWireConversationAdapter(handlerRef, config.wire.appDomain, createdConversations);
  const leavePendingAgentGroups = new LeavePendingAgentGroups(supportRequestsRepo, wireConversations, logger);
  // Absent with WIRE_SUPPORT_BOT_JIRA_AGENT_CHAT=off, even when agents are mapped.
  const agentHandles = jira.agents;
  const openAgentConversation = agentHandles
    ? new OpenAgentConversation(supportRequestsRepo, wireConversations, wireOutbound, auditLogRepo, logger)
    : undefined;
  // Announces changes made in Jira; started once the Wire client is ready (see getWireClient).
  const watchSeconds = jira.watchSeconds;
  // Questions to the requester after a desk reply or resolve; sent also with passive help off,
  // since they answer the bot's own question about the requester's request.
  const questionHours = jira.updateQuestionHours ?? DESK_UPDATE_QUESTION_HOURS_DEFAULT;
  const deskUpdateQuestions = questionHours > 0
    ? new DeskUpdateQuestions({ offers: pendingOffers, wireOutbound, lifetimeMs: questionHours * 60 * 60 * 1000, logger })
    : undefined;
  // With "ask" the requester is asked before the group is opened. The question lives as long as a
  // desk-update question; with those turned off (0 hours) it keeps the default lifetime.
  const agentQuestionHours = questionHours > 0 ? questionHours : DESK_UPDATE_QUESTION_HOURS_DEFAULT;
  const askForAgentConversation = openAgentConversation && jira.agentChat === "ask"
    ? new AskForAgentConversation({
      requests: supportRequestsRepo, conversations: wireConversations, offers: pendingOffers, wireOutbound, open: openAgentConversation,
      projectKey: issueTracker.projectKey, lifetimeMs: agentQuestionHours * 60 * 60 * 1000, logger,
    })
    : undefined;
  const watchSupportRequests = watchSeconds
    ? new WatchSupportRequests(supportRequestsRepo, issueTracker, wireOutbound, auditLogRepo, channelConfigRepo, logger, undefined, {
      writes: supportRequestWrites,
      // The CLI's test conversations (domain "cli.local") have no Wire group to post to.
      skipConversation: (c) => c.domain === "cli.local",
      ...(openAgentConversation && agentHandles
        ? { agents: { handles: agentHandles, open: openAgentConversation, ...(askForAgentConversation ? { ask: askForAgentConversation } : {}) } }
        : {}),
      ...(deskUpdateQuestions ? { questions: deskUpdateQuestions } : {}),
    })
    : undefined;
  if (agentHandles && !watchSupportRequests) logger.warn("WIRE_SUPPORT_BOT_JIRA_AGENTS needs WIRE_SUPPORT_BOT_JIRA_WATCH_SECONDS; direct conversations are off");
  // Satisfaction ratings follow the [Solved] answer of the question after a desk update and every
  // resolve from Wire; they need those questions (and the watch that asks them) and live as long.
  const feedbackOn = jira.feedback && !!deskUpdateQuestions && !!watchSupportRequests;
  if (jira.feedback && !feedbackOn) {
    logger.warn("WIRE_SUPPORT_BOT_JIRA_FEEDBACK needs the watch and WIRE_SUPPORT_BOT_JIRA_UPDATE_QUESTION_HOURS above 0; ratings are off");
  }
  const feedback = feedbackOn
    ? {
      questions: new FeedbackQuestions({ offers: pendingOffers, wireOutbound, lifetimeMs: questionHours * 60 * 60 * 1000, logger }),
      submit: new SubmitFeedback(supportRequestsRepo, issueTracker, wireOutbound, auditLogRepo, logger),
    }
    : undefined;
  // Every resolve from Wire that reached done asks the requester for a rating, when ratings are on.
  const resolveSupportRequest = new ResolveSupportRequest(
    supportRequestsRepo, issueTracker, wireOutbound, auditLogRepo, logger, supportRequestWrites, feedback?.questions,
  );
  // Photos and documents to the service desk: offered only with passive help, since a file cannot carry a mention.
  const attachFileToRequest = new AttachFileToRequest(supportRequestsRepo, issueTracker, createWireAssetAdapter(handlerRef), wireOutbound, auditLogRepo, logger);
  const offerAttachment = passiveOn ? new OfferAttachment(supportRequestsRepo, pendingOffers, wireOutbound, logger) : undefined;
  const confirmOffer = new ConfirmOffer(
    pendingOffers,
    {
      raiseSupportRequest, replyToServiceDesk, resolveSupportRequest, attachFileToRequest,
      ...(askForAgentConversation ? { agentConversation: askForAgentConversation } : {}),
      ...(feedback ? { feedback } : {}),
    },
    wireOutbound, undefined, config.partAsset, config.partDeliveryLocations, logger,
  );

  const router = new WireEventRouter({
    logger,
    botUserId,
    answerQuestion,
    setChannelTimezone: new SetChannelTimezone(channelConfigRepo, auditLogRepo, wireOutbound, config.app.defaultTimezone, undefined, logger),
    defaultTimezone: config.app.defaultTimezone,
    raiseSupportRequest,
    completePartOrder,
    offerAttachment,
    createdConversations,
    supportWelcome: { projectKey: issueTracker.projectKey, passive: passiveOn, watching: !!watchSupportRequests },
    listSupportRequests,
    resolveSupportRequest,
    getIssueStatus,
    replyToServiceDesk,
    pendingOffers,
    confirmOffer,
    wireOutbound,
    replyContext,
    messageBuffer,
    memberCache,
    channelConfig: channelConfigRepo,
    processingQueue,
    pipeline,
  });
  handlerRef.current = router as unknown as HandlerManagerRef["current"];

  /** One attempt to leave every agent group still owed a leave; a failure never stops the caller. */
  const leavePendingSafely = async (): Promise<void> => {
    try {
      await leavePendingAgentGroups.execute();
    } catch (err: unknown) {
      logger.warn("Failed to retry leaving agent groups", { err: errorName(err) });
    }
  };

  let sdkPromise: Promise<WireAppSdk> | null = null;
  let jiraWatch: IntervalRunner | undefined;
  let offerSweep: IntervalRunner | undefined;

  return {
    async getWireClient(): Promise<WireAppSdk> {
      if (!sdkPromise) {
        sdkPromise = createWireClient(config, router, logger).then(async (sdk) => {
          // Before the router receives events (main starts listening after this): groups still owed
          // a leave are ignored like freshly created ones.
          try {
            const pending = await leavePendingAgentGroups.track();
            if (pending > 0) logger.info("Agent groups still to leave", { pending });
          } catch (err: unknown) {
            logger.error("Failed to read the agent groups still to leave", { err: errorName(err) });
          }

          // Hydrate the member cache from the SDK's persisted conversation store before
          // startListening() is called. This ensures display names are available for
          // the first message after a restart (onAppAddedToConversation only fires on
          // first-ever join, not on reconnect).
          try {
            const manager = sdk.getApplicationManager();
            const allConvs = await manager.getAllConversations();
            await router.hydrateFromSdkStore(allConvs, (conv) =>
              manager.getMembersInConversation(new SdkQualifiedId(conv.id, conv.domain)),
            );
            if (allConvs.length > 0) {
              logger.info("Member cache hydrated from SDK store", { conversations: allConvs.length });
            }
          } catch (err: unknown) {
            logger.error("Failed to hydrate member cache from SDK store", { err: errorName(err) });
          }

          await leavePendingSafely();

          // Closes expired button questions, also in conversations where nobody writes.
          offerSweep = startOfferPromptSweep({ offers: pendingOffers, wireOutbound, logger }, logger);

          if (watchSupportRequests && watchSeconds) {
            jiraWatch = startIntervalRunner("Jira watch", async () => {
              await leavePendingSafely();
              return watchSupportRequests.check();
            }, watchSeconds * 1000, logger);
            logger.info("Watching support requests for Jira changes", { intervalSeconds: watchSeconds });
          }

          return sdk;
        });
      }
      return sdkPromise;
    },
    async shutdown(): Promise<void> {
      await jiraWatch?.stop();
      await offerSweep?.stop();
      await getPrismaClient().$disconnect();
    },
  };
}

function errorName(err: unknown): string {
  return err instanceof Error ? err.name : "UnknownError";
}
