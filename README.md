# Wire Support Bot

A Wire app that connects a Wire conversation with a Jira Service Management service desk. Team members raise support requests from the conversation, follow them up, reply to the service desk and resolve them, without leaving Wire.

It is based on the [Wire Team Bot](https://github.com/adamlow-wire/wire-team-bot), a proof of concept of an AI-enabled team assistant built with the Wire Apps JS SDK, reduced here to the service-desk use case.

The main flows:

- A member mentions the bot with a command such as `support: <problem>`, or describes the problem in their own words; the bot raises the request with the service desk, or offers to and waits for a yes.
- With passive help on, the bot reads messages that do not mention it and offers to raise a problem, add a detail to an open request or resolve a request that is fixed.
- With the watch on, replies and status changes made by the service desk appear in the conversation.
- Photos and documents posted in the conversation can be attached to an open request.
- When a mapped desk agent is assigned to a request, the bot opens a direct Wire conversation between the agent and the requester, then leaves it.

## How it works for users

### Addressing the bot

The bot acts on a message when it is mentioned (`@Wire Support Bot ...`) or when the message starts with "Wire Support Bot". Every command that reads from or writes to the service desk needs this, so ordinary chat that happens to start with "support:" never reaches the tracker. The built-in name "Wire Support Bot" in the bot's own texts is replaced by the app's display name in Wire. Send one command per message: a message that bundles several commands is rejected before anything runs.

In the examples, `SD` stands for the configured project key and `SD-42` for a ticket key. Only keys of the configured project are accepted.

### Commands

| Command | What it does |
|---|---|
| `@Wire Support Bot support: <problem>` | Raises a support request at once. The first line becomes the summary (cut at 120 characters), the whole text the description. |
| `@Wire Support Bot status of SD-42` | Shows the request's live status, SLAs and latest replies from the service desk. A question such as "any update on SD-42?" works too. |
| `@Wire Support Bot reply to SD-42: <text>` | Sends a customer-facing reply to the request. |
| `@Wire Support Bot resolve SD-42` | Resolves the request by following the workflow transitions towards a done status. `close SD-42` works too. |
| `@Wire Support Bot resolve SD-42: <comment>` | Adds a closing comment as a customer-facing reply, then resolves. |
| `@Wire Support Bot support requests` | Lists the open support requests of this conversation. |
| `@Wire Support Bot my support requests` | Lists the open support requests the sender raised in this conversation. |
| `@Wire Support Bot timezone Europe/Berlin` | Sets the conversation's timezone, used for reply times. Without a name the bot shows the current one. |

Status, reply and resolve only work for requests raised in the same conversation. A key from another conversation is treated like an unknown key.

### Natural language and offers

A member can also mention the bot and write in their own words: "the printer on the second floor is broken again, can you raise it?", "tell the desk that it works after a restart", "we can close SD-42". The model drafts a proposal, code checks it, and the bot asks a code-written question that ends in "(yes or no)?". Nothing is sent to the service desk until the member answers.

The rules for an offer:

- Only the member the offer was made to can confirm it, and only with their next message in the conversation. Any other message from them drops the offer; a correction ("the description should mention the third floor") gets a revised offer.
- Only explicit answers count: "yes", "yes please", "go ahead", "do it", "confirm" and similar, or "no", "cancel", "stop" and similar. "ok", "sure" or "thanks" approve nothing; the bot asks again and keeps the offer.
- An offer expires after 10 minutes.

Questions that ask for no change ("what was the VPN request called?") get an answer from the recent conversation and the conversation's support requests. When the bot's latest message among the last three ended with a question, the next message is treated as a follow-up even without a mention.

### Passive help

With `WIRE_SUPPORT_BOT_JIRA_PASSIVE=on`, messages that do not mention the bot are classified by the model. When the classifier is confident (0.8 or more) that a message concerns the service desk, the bot may:

- offer to raise a new request from the message;
- offer to add what the message says to an open request of the conversation, as a reply;
- offer to resolve an open request the message says is solved;
- answer a status question about an open request.

Every offer follows the same rules as above. With passive help off, the bot only reacts when it is addressed.

### Part orders

A request is a question, a part order or a fault, and each kind can have its own Jira request type. A part order needs four essentials: the item the part is for (the asset, with a configurable label and question), the part, the quantity and the delivery location. When some are missing, the bot asks for them ("To order it I need ..."). The requester's next message is read for the missing values and merged into the draft in code; the bot then asks for what is still missing or shows the complete order for a yes. Only values the requester actually stated count: a quantity must be a number written in the message, so "a new filter" does not become a quantity of one.

### Photos and documents

With passive help on and an open request in the conversation, a photo or document posted in the conversation gets an offer to attach it to the request the bot most recently wrote about (otherwise the newest open one). After a yes, the bot downloads the file from Wire and attaches it to the ticket with a customer-facing reply such as "Photo from Wire, sent by <name>. Sent from Wire.". The bytes are held in memory only.

Supported are JPEG, PNG, HEIC, HEIF and WebP images, and PDF, plain text, CSV, Word (`.docx`) and Excel (`.xlsx`) documents, up to 10 MB. Other types and self-deleting messages are not offered. If the sender still has an unanswered offer, the bot asks them to answer it first and post the file again.

### Desk replies and status changes

With `WIRE_SUPPORT_BOT_JIRA_WATCH_SECONDS` set, the bot checks open requests at that interval. New public replies from the service desk (up to three per update) and status changes are posted in the request's conversation, quoting the bot's last message about that request. Replies the bot itself sent from Wire are not announced again.

### Direct conversation with the assigned agent

With `WIRE_SUPPORT_BOT_JIRA_AGENTS` mapping Jira account IDs to Wire handles, and the watch on, the bot reacts once per request when a mapped agent is assigned to an open request: it creates a group named after the request with the requester and the agent, posts a short introduction, makes both of them admins and leaves. The original conversation gets a notice that contact with the agent has been initiated. The direct conversation is not recorded in the ticket.

### Typing indicator

While the bot works on something a member is waiting for (an answer, a command, a confirmed offer), it shows itself as typing. This uses the Wire SDK's `processWithTypingIndicator`; with an SDK version that does not provide it, the bot works the same way without the indicator.

## Concepts

These are the ideas worth keeping if you build your own bot on this code.

### The model drafts, code validates, a person says yes

The model never performs a write and is told never to claim one. In the answer path it may end its answer with one structured offer line. Code parses it and checks the request kind, the bounds (summary 120 characters, offer description 1,000, reply 2,000), that a named request belongs to this conversation and is in the right state, and that the member's own message asked for that change. Only then does the bot send its own question, and the offer is stored after that question has been sent, so it can never be confirmed unseen. The model's wording around an offer is discarded, because it may imply that the change has already happened. When the member confirms, the regular use case runs and checks scope, state and bounds again.

The explicit commands (`support:`, `reply to`, `resolve`) are themselves the member's decision and run without an offer.

### Scoping to the conversation

Support requests are stored with the qualified conversation ID (ID and domain). Status, reply, resolve, attachments and the model's context only see requests of the current conversation. Offers are kept per conversation and member, both qualified. The watch posts each update only to the conversation the request was raised in.

### What is stored and what is sent where

Stored in Postgres:

- Support request records: key, conversation, requester ID and display name, summary, kind, last known status category, and bookkeeping markers for the watch (last seen reply time, the bot's last message about the request, the last seen assignee, the agent group and when it was left). The problem description is not stored; it lives in the ticket.
- An audit log of creates and updates: actor ID, conversation ID, action, entity and the changed fields (for example a status category or a timezone). It holds no message text and no names.
- Per-conversation settings: the timezone.

Held in memory only, and lost on restart: the recent messages of each conversation (`MESSAGE_BUFFER_SIZE`), pending offers and the member cache.

Logs are structured JSON on stderr. Fields named `text`, `preview`, `raw`, `context`, `prompt`, `response` and `stack` are removed, and the use cases log error names and ticket keys rather than content. Log lines can carry conversation and user IDs and the sender's display name.

The Wire SDK's own log calls are recorded as "Wire SDK diagnostic" at their severity, without their text or data; for warnings and errors the line adds only the error's class name (`errorName`) and an HTTP `status`, error `code` or backend `label` when the error carries one as a number or a short identifier.

Sent to the model endpoint:

- for an answer: the member's message, up to nine earlier messages with the senders' display names, the conversation's member names and IDs, the requester, and the conversation's stored support request records;
- for passive help: the message, recent messages from members, and the key and summary of open requests;
- ticket content (live status, SLAs and up to three recent desk replies per ticket) only when `WIRE_SUPPORT_BOT_JIRA_SHARE_WITH_MODEL=on`.

With the default local endpoint nothing leaves the host. With a remote provider, all of the above goes to that provider.

Sent to Jira: only what a member wrote in a command or confirmed in an offer, plus the requester's display name ("Requested by <name> via Wire."). New tickets carry the label `wire-support-bot`, and replies, closing comments and attachments carry the footer "Sent from Wire.". Internal notes are never read or written.

### The watch

The watch polls rather than receiving webhooks, so the bot needs no inbound connection. Each check asks Jira which watched requests changed since the previous check (with a two-minute overlap, since Jira's search is eventually consistent) and examines only those. Watched requests are the open ones plus those resolved in the last 24 hours, to catch a reopen. A request the bot raises starts with its markers set at creation: replies and the assignee count as seen up to that moment, and the status is stored as "to do". So a desk reply, an assignment to a mapped agent or a status change after creation is acted on at the next check, even if that is the first check that sees the request. Only a request stored without these markers (no reply marker, or no assignee marker) gets a baseline when it is first examined: without a reply marker the bot records its replies and status and announces nothing, and without an assignee marker it records the assignee without opening a direct conversation, so old activity is never posted. The markers only move forward and are stored, so an update is not repeated after a restart. A request being resolved from Wire at that moment is skipped, so the bot never announces its own resolve as the desk's. A request whose update keeps failing is given up after 10 attempts.

### The agent group

The bot stores the group's ID with the request right after creating it, before the introduction and the admin changes. It then tries to leave at once and again after 2, 5 and 10 seconds; a confirmed leave is stored. A group not yet left is retried once after start-up and before every watch check, also when the agent mapping has since been removed. Until the bot has left a group it ignores every message and event from it, also after a restart, since the pending groups are read before the bot starts listening.

One gap remains: if the process stops between creating the group and storing its ID, or storing the ID fails, the bot does not know the group after a restart and stays a member of it.

### What the bot does not do

- It does not store or summarise the conversation, and does not search past conversations.
- It does not read or write internal notes, and does not change assignees, priorities or other fields.
- It does not act on edited messages or on buttons.
- It does not raise anything from an unaddressed message without an explicit yes.
- It does not watch requests raised from the CLI.

## Architecture

The code follows a hexagonal (ports and adapters) layout:

- `src/domain/`: entities, identifiers and repository contracts. It depends on nothing else in the project.
- `src/application/`: use cases (`usecases/`), shared application services (`services/`) and ports (`ports/`), the interfaces the use cases need from the outside world. It depends on the domain and its own ports only, never on Wire, Prisma or HTTP clients.
- `src/infrastructure/`: adapters that implement the ports and repositories: Wire (`wire/`), Jira (`jira/`), the model endpoint (`llm/`), Postgres through Prisma (`persistence/postgres/`), the in-memory queue, offer store and member cache, and the passive-help pipeline (`pipeline/`).
- `src/app/`: configuration (`config.ts`), logging, the entry point (`main.ts`), the CLI (`cli.ts`) and the composition root `src/app/container.ts`, which builds every adapter and use case and wires them together.

### Main modules

| Module | Role |
|---|---|
| `src/infrastructure/wire/WireEventRouter.ts` | Receives Wire events and decides what each message is: an offer answer, a command, a question or passive-help input. |
| `src/application/usecases/general/AnswerQuestion.ts` | The answer path: builds the model's context, parses and validates an offer, sends the answer or the question. |
| `src/application/services/offers.ts` | Offer marker parsing, bounds and the code-written questions. |
| `src/application/usecases/jira/ConfirmOffer.ts` | Classifies a yes or no and runs the confirmed use case. |
| `src/application/usecases/jira/RaiseSupportRequest.ts`, `ReplyToServiceDesk.ts`, `ResolveSupportRequest.ts`, `GetIssueStatus.ts`, `ListSupportRequests.ts` | The support request use cases, scoped to the conversation; writes are audited. |
| `src/application/usecases/jira/OfferSupportFromConversation.ts` | Passive help: raise, add, resolve or status from an unaddressed message. |
| `src/application/usecases/jira/CompletePartOrder.ts` | Fills a part order's missing essentials from the requester's next message. |
| `src/application/usecases/jira/OfferAttachment.ts`, `AttachFileToRequest.ts` | Photos and documents to a request. |
| `src/application/usecases/jira/WatchSupportRequests.ts` | The watch. |
| `src/application/usecases/jira/OpenAgentConversation.ts`, `LeavePendingAgentGroups.ts` | The direct conversation with the agent, and leaving it. |
| `src/infrastructure/pipeline/ProcessingPipeline.ts` | Classifies an unaddressed message and hands service-desk matters to passive help. |
| `src/infrastructure/jira/JiraServiceManagementAdapter.ts` | `IssueTrackerPort` for Jira Service Management. |
| `src/infrastructure/llm/` | Model adapters for answers, classification and triage, and the shared OpenAI-compatible client. |
| `prisma/schema.prisma` | The database schema; migrations are in `prisma/migrations/`. |

### How a message flows

1. The router handles messages one at a time per conversation, resolves the sender's display name and ignores agent groups the bot has not yet left.
2. If the sender has a pending offer, the message is checked as an answer: a yes or no is handled by `ConfirmOffer`; for a part-order draft, `CompletePartOrder` tries to fill the missing essentials; otherwise the offer is dropped.
3. A message that bundles several commands is rejected. A `timezone` command is handled next.
4. The message is added to the conversation's in-memory buffer.
5. If the bot is addressed, the commands are matched in order: `support:`, `resolve` or `close`, `reply to`, `support requests`, then a status request.
6. A message that mentions the bot, follows a question from the bot, or corrects the sender's dropped offer goes to the answer path (`AnswerQuestion`).
7. Anything else goes to the passive-help queue when passive help is on: `ProcessingPipeline` classifies it and, for a service-desk category, calls `OfferSupportFromConversation`. The queue keeps each conversation's messages in order and cancels queued work when a conversation is deleted.

Files take a shorter path: the router checks the type, size and self-deleting flag and hands the file to `OfferAttachment`.

## Extending

### Adding a knowledge source

The answer path has a seam for knowledge: `RetrievalPort` in `src/application/ports/RetrievalPort.ts`.

```ts
interface RetrievalPort {
  retrieve(query: RetrievalQuery): Promise<RetrievalResult[]>;
}
```

The query holds the member's question, the qualified conversation ID and, when known, the requester's ID. A knowledge source returns results of kind `knowledge_article`, each with an `id`, the excerpt as `content`, a `source` for the citation (a title or a link) and a `sourceDate`. `AnswerQuestion` calls the source first, adds the conversation's own support requests and context, and passes everything to the answer model; a failing source is logged and the bot answers without it. The answer adapter puts `knowledge_article` results in a "Knowledge articles" section of the prompt, and the prompt tells the model to cite an article by its source and to say nothing the article does not state.

To add a source, implement `RetrievalPort` in an adapter under `src/infrastructure/` and pass an instance as the fourth argument of `new AnswerQuestion(...)` in `src/app/container.ts` (and in `src/app/cli.ts` if you want it in the CLI), where `undefined` is passed today. Add unit tests with a mocked port, following `tests/usecases/AnswerQuestion.test.ts`.

A motivating example is first-level help: a user describes a problem, the bot suggests an answer from curated knowledge (manuals, troubleshooting guides, FAQs) and names its source, and if that does not solve the problem the member asks the bot to raise a ticket and gets the usual offer. This keeps the principle of the offers: the bot proposes, a person decides. Two typical ways to provide the knowledge:

- The service desk's own knowledge base, searched through its REST API. This needs no storage of your own; the knowledge stays in the service desk.
- Your own document index: manuals split into passages, embedded and searched by similarity. This gives you control over the content and the ranking, but needs an embedding model and a vector store, which this repository does not include. Make sure the embedding model's output dimension matches the database column before you rely on it.

The seam covers the answer path, which needs a mention. Suggesting knowledge for unaddressed messages would be a change to passive help.

### Another tracker

The use cases talk to the service desk only through `IssueTrackerPort` in `src/application/ports/IssueTrackerPort.ts`: create an issue, read it, resolve it by status category, list and add customer-facing replies, list changed issues and add an attachment. To use another tracker, implement that port in a new adapter and construct it instead of `JiraServiceManagementAdapter` in `src/app/container.ts` and `src/app/cli.ts`. Keep the port's guarantees: status categories rather than localised status names, no internal notes, and error messages without response bodies or credentials. The configuration (`JiraConfig` in `src/app/config.ts`) and ticket keys (`src/domain/ids/jiraLink.ts`, keys such as `SD-42`) are Jira-shaped today, so a tracker with a different key format needs changes there too.

## Setup

### Requirements

- Node.js 22.12 or newer (`engines` in `package.json`; the Docker image uses Node 22 on Debian trixie). The Wire SDK uses a native crypto library that needs glibc 2.38 or newer on Linux x86-64; the provided Dockerfile meets this.
- PostgreSQL (the Compose file uses Postgres 16).
- An OpenAI-compatible chat-completions endpoint, for example a local Ollama (`http://localhost:11434/v1`) with a model such as `qwen3-next:80b`, or a hosted provider.
- A Wire app registered on your Wire backend by a team admin with `scripts/register-app.mjs` (see below). The team needs the apps feature enabled.
- A Jira Service Management project and an API token for an account that can, in that project: raise requests through the service desk API, edit issues (to set the label), read issues and their SLAs, follow workflow transitions, read and add public comments, and add attachments. Use either a scoped service-account token (Bearer, with the base URL `https://api.atlassian.com/ex/jira/<cloud id>`) or a classic API token together with the account's e-mail (Basic). You also need the service desk ID and the request type IDs.

### Register the Wire app

The script logs in as a team admin, creates the app and prints the `WIRE_SDK_*` settings. Secrets are masked unless you write them to a file with `--out` (created with mode 0600) or pass `--print-token`.

```bash
npm run register-app -- versions --host https://your-wire-backend.example.com
npm run register-app -- create --host https://your-wire-backend.example.com --email admin@example.com --out .env.wire
```

The admin password is prompted for, or read from `WIRE_ADMIN_PASSWORD`. If the login needs a verification code, request one with `send-code` and pass it with `--code`. `refresh --app-id <id>` issues a new token for an existing app and keeps the existing crypto key; `list` shows the team's apps. Copy the printed values into `.env`, then have a team admin add the app to a conversation.

### Install, migrate, build, run

```bash
npm install
cp .env.example .env               # then replace every placeholder
npm run prisma:generate
npx prisma migrate deploy          # applies prisma/migrations to DATABASE_URL
npm run build
npm start
```

`npm start` runs `dist/app/main.js`, which reads `.env`. `npm run dev` runs the TypeScript source with ts-node. The Wire SDK keeps its local database and crypto keystore under `./storage` in the working directory: keep that directory and `WIRE_SDK_CRYPTO_KEY` together, because losing either loses the bot's end-to-end encryption state.

### Docker Compose

`docker-compose.yml` builds the bot's image from this repository's `Dockerfile` (`build: .`) and runs it with a Postgres 16 database. Before the first start, create `.env` from `.env.example`. After changing the code, rebuild with `docker compose up -d --build`.

```bash
docker compose up -d --build
```

The container's entry point applies the migrations (`prisma migrate deploy`) and starts the bot. Compose overrides `DATABASE_URL` to point at its own database, binds Postgres to `127.0.0.1` only, and keeps the Wire SDK store in a named volume mounted at `/app/storage`. An Ollama service is included as a commented-out block; to use it, uncomment it and set `WIRE_SUPPORT_BOT_LLM_BASE_URL=http://ollama:11434/v1`.

### The CLI for local testing

The CLI drives the real router and use cases from the terminal, without Wire. It simulates one conversation with four members, Alice (the default), Bob, Carol and Dave; prefix a line with `Bob: ` to send it as Bob. Start a line with `@Wire Support Bot` to mention the bot. Bot replies go to stdout and logs to stderr (level `warn` unless `LOG_LEVEL` is set). End with `exit`, `quit` or Ctrl-D.

```bash
npm run build
npm run cli
printf "@Wire Support Bot support requests\n" | npm run cli
```

Like `npm start`, the CLI reads `.env` from the working directory; settings already in the environment take precedence. The CLI needs the full configuration (including the `WIRE_SDK_*` settings, although it does not connect to Wire), the database and the model endpoint. It has no watch, no files and no agent groups.

Support commands and confirmed offers in the CLI write to the real service desk. Point it at a test project, not at your production desk.

## Configuration

All settings are environment variables; `.env.example` lists them with comments. Start-up fails with a message naming the setting when a required one is missing or a value is invalid.

### Wire app

| Setting | Required | Default | Meaning |
|---|---|---|---|
| `WIRE_SDK_API_TOKEN` | yes | | App token from the registration script. |
| `WIRE_SDK_API_HOST` | yes | | Base URL of the Wire backend. |
| `WIRE_SDK_CRYPTO_KEY` | yes | | 32-byte key for the SDK's local crypto store, as 64 hex characters (`openssl rand -hex 32`). |
| `WIRE_SDK_APP_ID` | yes | | The app's user ID; checked against the backend at start-up. |
| `WIRE_SDK_APP_DOMAIN` | yes | | The app's domain; checked at start-up. Agent handles are looked up on this domain. |
| `WIRE_ADMIN_EMAIL` | no | | Only for `scripts/register-app.mjs`: the team admin's e-mail. |
| `WIRE_ADMIN_PASSWORD` | no | prompted | Only for `scripts/register-app.mjs`: the admin's password. |

### Database

| Setting | Required | Default | Meaning |
|---|---|---|---|
| `DATABASE_URL` | yes | | Postgres connection URL. Docker Compose overrides it. |

### Model endpoint and slots

| Setting | Required | Default | Meaning |
|---|---|---|---|
| `WIRE_SUPPORT_BOT_LLM_BASE_URL` | no | `http://localhost:11434/v1` | OpenAI-compatible endpoint; `/chat/completions` is appended. |
| `WIRE_SUPPORT_BOT_LLM_API_KEY` | no | empty | Sent as a Bearer token; Ollama ignores it. |
| `WIRE_SUPPORT_BOT_LLM_TIMEOUT_MS` | no | `60000` | Timeout per model call in milliseconds; a positive whole number. |
| `WIRE_SUPPORT_BOT_LLM_REASONING_EFFORT` | no | not sent | `none`, `low`, `medium` or `high`, sent as `reasoning_effort`. Local thinking models such as Qwen under Ollama need `none`, which `.env.example` sets. |
| `WIRE_SUPPORT_BOT_MODEL_CLASSIFY` | no | `qwen3-next:80b` | Model for passive-help classification, triage and part details. |
| `WIRE_SUPPORT_BOT_FALLBACK_CLASSIFY` | no | `qwen3-next:80b` | Tried once when the classify model times out or returns 503 or 529. |
| `WIRE_SUPPORT_BOT_MODEL_RESPOND` | no | `qwen3-next:80b` | Model for answers to messages addressed to the bot. |
| `WIRE_SUPPORT_BOT_FALLBACK_RESPOND` | no | `qwen3-next:80b` | Tried once when the respond model times out or returns 503 or 529. |

### Jira

| Setting | Required | Default | Meaning |
|---|---|---|---|
| `WIRE_SUPPORT_BOT_JIRA_BASE_URL` | yes | | REST base URL (https); for a scoped token `https://api.atlassian.com/ex/jira/<cloud id>`. |
| `WIRE_SUPPORT_BOT_JIRA_SITE_URL` | yes | | Site URL for ticket links (https), for example `https://your-site.atlassian.net`. |
| `WIRE_SUPPORT_BOT_JIRA_API_TOKEN` | yes | | Scoped token (Bearer), or classic token together with the e-mail (Basic). |
| `WIRE_SUPPORT_BOT_JIRA_EMAIL` | no | | Account e-mail for a classic token; leave unset for a scoped token. |
| `WIRE_SUPPORT_BOT_JIRA_PROJECT_KEY` | yes | | Project key, for example `SD`. Only keys of this project are accepted. |
| `WIRE_SUPPORT_BOT_JIRA_SERVICE_DESK_ID` | yes | | Numeric service desk ID. |
| `WIRE_SUPPORT_BOT_JIRA_REQUEST_TYPES` | yes | | Request type ID per kind, for example `question=10001,part=10002,fault=10003`. `fault` is required and used for any kind without its own entry. |
| `WIRE_SUPPORT_BOT_JIRA_TIMEOUT_MS` | no | `15000` | Timeout per Jira call in milliseconds; a positive whole number, raised to 1000 if lower. |
| `WIRE_SUPPORT_BOT_JIRA_SHARE_WITH_MODEL` | no | `off` | `on` lets live ticket status, SLAs and desk replies reach the answer model. |
| `WIRE_SUPPORT_BOT_JIRA_SERVICE_SCOPE` | no | generic wording | What the service desk handles, in plain words, for the model prompts; at most 500 characters. |
| `WIRE_SUPPORT_BOT_JIRA_AGENTS` | no | | Desk agents who get a direct conversation with the requester when assigned: `<jira account id>=<wire handle>`, comma-separated. Needs the watch. |

### Part orders

| Setting | Required | Default | Meaning |
|---|---|---|---|
| `WIRE_SUPPORT_BOT_PART_ASSET_LABEL` | no | `Asset` | Label of the item a part is for, shown in confirmations and tickets; one line, at most 40 characters. |
| `WIRE_SUPPORT_BOT_PART_ASSET_QUESTION` | no | `the item the part is for (for example a serial number)` | How the bot asks for it, completing "To order it I need ..."; one line, at most 200 characters. |

### Passive help and watch

| Setting | Required | Default | Meaning |
|---|---|---|---|
| `WIRE_SUPPORT_BOT_JIRA_PASSIVE` | no | `off` | `on` lets the bot read unaddressed messages, offer to raise, add to or resolve requests, and offer to attach files. |
| `WIRE_SUPPORT_BOT_JIRA_WATCH_SECONDS` | no | unset (no watch) | Seconds between checks for desk replies, status and assignee changes; a whole number, at least 15. |

### Logging and conversations

| Setting | Required | Default | Meaning |
|---|---|---|---|
| `LOG_LEVEL` | no | `info` (`warn` in the CLI) | `debug`, `info`, `warn` or `error`. |
| `MESSAGE_BUFFER_SIZE` | no | `50` | Recent messages kept in memory per conversation; a positive whole number, capped at 500. |
| `WIRE_SUPPORT_BOT_DEFAULT_TIMEZONE` | no | `UTC` | IANA timezone for conversations the bot newly joins; members can change it per conversation. |

### Example: premium support for a truck manufacturer

The code speaks of a generic service desk; tailoring happens in the configuration. For a truck manufacturer's premium support desk that handles faults and replacement parts for its customers' fleets, the end of `.env.example` has this example:

```bash
WIRE_SUPPORT_BOT_JIRA_SERVICE_SCOPE=faults, breakdowns, damage, maintenance and replacement parts for the trucks of a haulage fleet
WIRE_SUPPORT_BOT_JIRA_REQUEST_TYPES=question=10001,part=10002,fault=10003
WIRE_SUPPORT_BOT_PART_ASSET_LABEL=Vehicle
WIRE_SUPPORT_BOT_PART_ASSET_QUESTION=the vehicle (fleet or chassis number)
```

The service scope tells the classifier and the answer model what counts as a service-desk matter. The request types map questions, part orders and faults to the project's own request types (replace the IDs with yours). The asset label and question make a part order ask for the vehicle ("To order it I need the vehicle (fleet or chassis number) ...") and show "Vehicle: ..." in the confirmation and the ticket. With passive help, the watch and the agent mapping turned on as well, drivers can report a breakdown in their own words, send a photo of the damage and talk to the assigned agent directly.

## Development

```bash
npm test                 # unit and contract tests (vitest)
npm run test:watch       # the same, in watch mode
npm run lint             # ESLint on src and tests; layering violations are errors
npm run typecheck        # type check of src and tests
npm run build            # compile to dist/
```

Unit tests use mocked ports and need no database, network or Wire connection. The database integration tests in `tests/integration/` are skipped unless `INTEGRATION_TESTS=1`. Run them only against a throwaway database, never a shared or production one:

```bash
createdb wire_support_bot_test
DATABASE_URL=postgres://user:password@localhost:5432/wire_support_bot_test npx prisma migrate deploy
INTEGRATION_TESTS=1 DATABASE_URL=postgres://user:password@localhost:5432/wire_support_bot_test npm test
dropdb wire_support_bot_test
```

`npm run prisma:migrate` runs `prisma migrate dev --name init`, which creates a new migration when you have changed `prisma/schema.prisma`. Use it during development only, and `prisma migrate deploy` everywhere else.

## Limitations and notes

- Answer quality, classification and the drafting of offers depend on the model. Code guards every write, but a weaker model makes fewer and worse offers. Try your model with the CLI before you turn on passive help.
- Run one bot process per Wire app and storage directory. The SDK store, pending offers, the message buffer and the guard against double submits belong to the process.
- Pending offers and recent messages are held in memory: a restart drops unanswered offers and the conversation context.
- Desk updates arrive by polling, so they appear up to one interval late (the interval is at least 15 seconds).
- The watch looks at up to 500 requests per check, oldest first, and the bot retries leaving up to 500 pending agent groups per run.
- Edited messages are ignored, and old button messages get a note that buttons are no longer supported.
- Only photos and documents of the listed types, up to 10 MB, are offered for attaching.
- With a remote model provider and sharing on, ticket content leaves your infrastructure; see "What is stored and what is sent where".

## Licence

This project is licensed under the GNU General Public License, version 3 only (`GPL-3.0-only`); see [LICENSE](LICENSE).

Its Wire libraries are GPL-3.0 as well (`@wireapp/wire-apps-js-sdk`, `@wireapp/core-crypto` and `bazinga64`). A bot built from this code runs those libraries in the same process, so if you distribute your bot, the combined work falls under the GPL and you must offer its source to the people you distribute it to. Running the bot only for yourself does not require that. The other dependencies are under permissive licences (MIT, Apache-2.0, BSD) or MPL-2.0, which are compatible with the GPL.
