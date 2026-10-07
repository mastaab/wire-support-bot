# Architecture

The code follows a hexagonal (ports and adapters) layout. [CONTRIBUTING.md](../CONTRIBUTING.md) has the rules for changing it.

- `src/domain/`: entities, identifiers and repository contracts. It depends on nothing else in the project.
- `src/application/`: use cases (`usecases/`), shared services (`services/`) and ports (`ports/`), the interfaces the use cases need from outside. It never depends on Wire, Prisma or HTTP clients.
- `src/infrastructure/`: adapters for the ports: Wire (`wire/`), Jira (`jira/`), the model and embeddings endpoints (`llm/`), Postgres through Prisma (`persistence/postgres/`), the document index (`knowledge/`), the passive-help pipeline (`pipeline/`), metrics (`metrics/`), and the in-memory stores.
- `src/app/`: configuration, logging, the entry point (`main.ts`), the CLI (`cli.ts`), the knowledge ingestion command (`knowledgeIngest.ts`) and the composition root (`container.ts`), which builds every adapter and use case.

## Main modules

| Module | Role |
|---|---|
| `src/infrastructure/wire/WireEventRouter.ts` | Receives Wire events and decides what each message is: an offer answer, a command, a question or passive-help input. |
| `src/application/usecases/general/AnswerQuestion.ts` | The answer path: builds the model's context, validates an offer, sends the answer or the question. |
| `src/application/services/offers.ts` | Offer parsing, bounds and the code-written questions. |
| `src/application/services/botCommandLines.ts` | Replaces suggested commands that don't exist with supported ones; removes them from document answers. |
| `src/application/services/offerButtons.ts` | Button IDs, options and text answers to a choice. |
| `src/application/services/offerPromptClosing.ts` | Closes ended button questions and runs the expiry sweep. |
| `src/application/services/deskUpdateQuestions.ts` | The requester's question after a desk update. |
| `src/application/services/feedbackQuestions.ts`, `usecases/jira/SubmitFeedback.ts` | The satisfaction rating and sending it to Jira. |
| `src/application/services/similarRequests.ts` | Ranks existing requests that may describe the same problem. |
| `src/application/services/partOrderSteps.ts`, `usecases/jira/CompletePartOrder.ts` | A part order's questions, and filling in its missing details. |
| `src/application/usecases/jira/ConfirmOffer.ts` | Classifies a yes, no or choice, by text or button, and runs the confirmed use case. |
| `src/application/usecases/jira/RaiseSupportRequest.ts`, `ReplyToServiceDesk.ts`, `ResolveSupportRequest.ts`, `GetIssueStatus.ts`, `ListSupportRequests.ts` | The support request use cases, scoped to the conversation; writes are audited. |
| `src/application/usecases/jira/OfferSupportFromConversation.ts` | Passive help: raise, add, resolve or status from an unaddressed message. |
| `src/application/usecases/jira/OfferAttachment.ts`, `AttachFileToRequest.ts` | Photos and documents to a request. |
| `src/application/usecases/jira/WatchSupportRequests.ts` | The watch. |
| `src/application/usecases/jira/OpenAgentConversation.ts`, `AskForAgentConversation.ts`, `LeavePendingAgentGroups.ts` | The direct conversation with the agent. |
| `src/infrastructure/pipeline/ProcessingPipeline.ts` | Classifies an unaddressed message and hands service-desk matters to passive help. |
| `src/infrastructure/jira/JiraServiceManagementAdapter.ts` | `IssueTrackerPort` for Jira Service Management. |
| `src/infrastructure/llm/` | Model adapters for answers, classification and triage, the shared OpenAI-compatible client, and embeddings. |
| `src/app/knowledgeIngest.ts`, `usecases/knowledge/IngestKnowledge.ts`, `services/knowledgeChunks.ts` | The ingestion command, the ingestion itself and the splitting of documents. |
| `src/infrastructure/knowledge/InMemoryKnowledgeIndex.ts`, `persistence/postgres/PrismaKnowledgeRepository.ts` | The document index: in-memory search and storage in Postgres. |
| `src/application/ports/MetricsPort.ts`, `src/infrastructure/metrics/` | The metrics port, the prom-client adapter and the HTTP server for `/metrics` and `/healthz`. |
| `prisma/schema.prisma` | The database schema; migrations are in `prisma/migrations/`. |

## How a message flows

1. The router handles messages one at a time per conversation, resolves the sender's display name and ignores agent groups the bot has not left yet.
2. If the sender has a pending offer, the message is checked as an answer (`ConfirmOffer`, or `CompletePartOrder` for a part order); otherwise the offer is dropped.
3. A message with several commands is rejected; a `timezone` command is handled.
4. The message is added to the conversation's in-memory buffer.
5. If the bot is addressed, the commands are matched: `support:`, `resolve` or `close`, `reply to`, `support requests`, then a status request.
6. A message that mentions the bot, follows a question from the bot or corrects a dropped offer goes to `AnswerQuestion`.
7. Anything else goes to the passive-help queue when passive help is on: `ProcessingPipeline` classifies it and calls `OfferSupportFromConversation` for a service-desk matter.

Files go from the router straight to `OfferAttachment` after a check of type, size and self-deleting flag. Button clicks run in order with the conversation's messages: the router matches the click to its offer and hands an accepted click to `ConfirmOffer`.

## Extending

### Adding a knowledge source

The answer path has a seam for knowledge: `RetrievalPort` in `src/application/ports/RetrievalPort.ts`.

```ts
interface RetrievalPort {
  retrieve(query: RetrievalQuery): Promise<RetrievalResult[]>;
}
```

The query holds the member's question, the conversation ID and, when known, the requester's ID. A source returns results of kind `knowledge_article`, each with an `id`, the excerpt as `content`, a `source` for the citation (a title or a link) and a `sourceDate`. `AnswerQuestion` calls the source first and passes the results to the answer model, which is told to cite them and say nothing they don't state. A failing source is logged and the bot answers without it.

To add a source, implement `RetrievalPort` under `src/infrastructure/` and pass it as the fourth argument of `new AnswerQuestion(...)` in `src/app/container.ts` (and `src/app/cli.ts`), where the document index is passed today. Add unit tests with a mocked port, following `tests/usecases/AnswerQuestion.test.ts`.

Ideas:
- **The service desk's own knowledge base,** searched through its REST API: no storage of your own.
- **A vector database** such as pgvector, behind the same port, when the document set outgrows the in-memory search.

The seam covers the answer path, which needs a mention; suggesting knowledge for unaddressed messages would be a change to passive help.

### Another tracker

The use cases talk to the service desk only through `IssueTrackerPort` in `src/application/ports/IssueTrackerPort.ts`: create, read and resolve an issue by status category, list and add customer-facing replies, list changed issues and add an attachment. To use another tracker, implement that port and construct it instead of `JiraServiceManagementAdapter` in `src/app/container.ts` and `src/app/cli.ts`.

Keep the port's guarantees:
- status categories rather than localized status names;
- no internal notes;
- error messages without response bodies or credentials.

The configuration (`JiraConfig` in `src/app/config.ts`) and ticket keys (`src/domain/ids/jiraLink.ts`) are Jira-shaped today, so a tracker with another key format needs changes there too.

## Development

```bash
npm test                 # unit and contract tests (vitest)
npm run test:watch       # the same, in watch mode
npm run lint             # ESLint; layering violations are errors
npm run typecheck        # type check of src and tests
npm run build            # compile to dist/
```

The database integration tests in `tests/integration/` run only with `INTEGRATION_TESTS=1`, and only against a throwaway database:

```bash
createdb wire_support_bot_test
DATABASE_URL=postgres://user:password@localhost:5432/wire_support_bot_test npx prisma migrate deploy
INTEGRATION_TESTS=1 DATABASE_URL=postgres://user:password@localhost:5432/wire_support_bot_test npm test
dropdb wire_support_bot_test
```

`npm run prisma:migrate` creates a new migration after a change to `prisma/schema.prisma`; use it during development only, and `prisma migrate deploy` everywhere else.
