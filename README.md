# Wire Support Bot

> [!IMPORTANT]
> **Demo and proof of concept.** This is not a supported Wire product and not ready for production use as it is. Use it for evaluation and as a starting point for your own bot. It depends on an early version (0.1) of the Wire Apps JS SDK, its answers come from a language model and can be wrong, it runs as a single instance, and it has been tested with one Jira Service Management project in a test environment. Security, privacy and operations need your own review. It is provided under the GPL-3.0 license, without warranty.

A Wire app that connects a Wire conversation with a Jira Service Management service desk. Team members raise support requests from the conversation, follow them up, reply to the service desk and resolve them, without leaving Wire.

It is based on the [Wire Team Bot](https://github.com/adamlow-wire/wire-team-bot), a proof of concept of an AI-enabled team assistant, reduced here to the service-desk use case.

## What it does

- **Commands:** a member mentions the bot with `support: <problem>`, `status of SD-42`, `reply to SD-42: <text>` or `resolve SD-42`, and the bot acts on the service desk.
- **Natural language:** a member describes a problem in their own words; the bot proposes a request and raises it only after a [Yes].
- **Passive help** (optional): the bot reads messages that don't mention it and offers to raise a problem, add a detail to an open request or resolve a request that is fixed.
- **Desk updates** (optional): replies and status changes from the service desk appear in the conversation, followed by a question to the requester ([Reply] [Solved, close it]).
- **Part orders:** the bot collects the item, part, quantity and delivery location step by step, with buttons.
- **Photos and documents** posted in the conversation can be attached to an open request.
- **First-level help** (optional): answers from your own documents (manuals, FAQs), with the source and a "Did this help?" question before a ticket is raised.
- **Agent chat** (optional): when a mapped desk agent is assigned, the bot opens a direct Wire conversation between the agent and the requester.

```text
Alice: @Wire Support Bot the tail lift of truck 12 is stuck, can you report it?
Bot:   Shall I report this to the service desk?
       > **Tail lift of truck 12 stuck**
       > The tail lift of truck 12 is stuck.            [Yes] [No]
Alice: (clicks [Yes])
Bot:   Raised SD-42 with the service desk: https://your-site.atlassian.net/browse/SD-42
```

See [docs/usage.md](docs/usage.md) for every command and flow.

## How it works

```text
Wire conversation ── Wire Apps SDK ──▶ Wire Support Bot ──▶ Jira Service Management (REST)
                                          │        │
                                          │        └──▶ OpenAI-compatible model endpoint
                                          ▼             (Ollama, or a hosted provider)
                                       Postgres
```

**The model drafts, code validates, a person says yes.** The model never writes to the service desk. When it proposes a change, code checks it (the request belongs to this conversation, the bounds, that the member asked for it) and the bot asks a question with buttons; only a [Yes] from the member who was asked runs the change. Explicit commands are the member's decision and run without a question. Requests are scoped to the conversation they were raised in.

The bot connects out to Wire, Jira and the model endpoint and needs no inbound connection. See [docs/design.md](docs/design.md) for what is stored and sent where.

## Quick start

You need:
- Node.js 22.12 or newer, or Docker;
- PostgreSQL;
- an OpenAI-compatible model endpoint, for example a local [Ollama](https://ollama.com);
- a Jira Service Management project with an API token;
- a Wire team with the apps feature enabled.

1. Register a Wire app on your backend (a team admin's login is needed):

   ```bash
   npm install
   npm run register-app -- create --host https://your-wire-backend.example.com --email admin@example.com --out .env.wire
   ```

2. Create `.env` from `.env.example`, then copy in the values from `.env.wire` and set Jira, the database and the model endpoint (see [Minimum configuration](#minimum-configuration)).

3. Run it, with Docker Compose (bot and Postgres):

   ```bash
   docker compose up -d --build
   ```

   or with Node and your own Postgres:

   ```bash
   npm run prisma:generate
   npx prisma migrate deploy
   npm run build
   npm start
   ```

4. Have a team admin add the app to a conversation, then send `@Wire Support Bot support requests`.

To try the bot without Wire, `npm run cli` simulates a conversation in the terminal; it writes to the real service desk, so point it at a test project. For Kubernetes, use the [Helm chart](charts/wire-support-bot/README.md). See [docs/deployment.md](docs/deployment.md) for the details of each way.

## Minimum configuration

All settings are environment variables, listed with comments in `.env.example`. These are required:

| Setting | Meaning |
|---|---|
| `WIRE_SDK_API_TOKEN`, `WIRE_SDK_API_HOST`, `WIRE_SDK_CRYPTO_KEY`, `WIRE_SDK_APP_ID`, `WIRE_SDK_APP_DOMAIN` | The Wire app, printed by the registration script. |
| `DATABASE_URL` | Postgres connection URL. |
| `WIRE_SUPPORT_BOT_JIRA_BASE_URL`, `WIRE_SUPPORT_BOT_JIRA_SITE_URL` | Jira's REST base URL and site URL. |
| `WIRE_SUPPORT_BOT_JIRA_API_TOKEN` (and `WIRE_SUPPORT_BOT_JIRA_EMAIL` for a classic token) | The Jira account the bot acts as. |
| `WIRE_SUPPORT_BOT_JIRA_PROJECT_KEY`, `WIRE_SUPPORT_BOT_JIRA_SERVICE_DESK_ID`, `WIRE_SUPPORT_BOT_JIRA_REQUEST_TYPES` | The service desk and its request types. |

The model endpoint defaults to a local Ollama (`http://localhost:11434/v1`). The optional features are off until you turn them on: passive help (`WIRE_SUPPORT_BOT_JIRA_PASSIVE`), the document index (`WIRE_SUPPORT_BOT_KNOWLEDGE`) and ratings (`WIRE_SUPPORT_BOT_JIRA_FEEDBACK`). Desk updates need the watch (`WIRE_SUPPORT_BOT_JIRA_WATCH_SECONDS`). See [docs/configuration.md](docs/configuration.md) for every setting and an example for a truck manufacturer's service desk.

## Limitations

- Answers, classifications and offers depend on the model. Code guards every write, but a weaker model makes fewer and worse offers, and a small model can add steps of its own to answers from documents. Try your model with the CLI first.
- Run one process per Wire app and SDK store, and use a separate Wire app for every deployment, including test and staging. Two instances of the same app lock each other out.
- Pending offers and the conversation context are held in memory, so a restart drops them.
- Desk updates arrive by polling, at least 15 seconds late.
- Buttons were checked on Wire web and iOS, not on Android; every question can also be answered in text.
- With a remote model provider, conversation content (and with sharing on, ticket content) leaves your infrastructure.

## Documentation

| Document | Contents |
|---|---|
| [docs/usage.md](docs/usage.md) | Commands, offers and buttons, first-level and passive help, part orders, files, desk updates, ratings, agent chat |
| [docs/design.md](docs/design.md) | Design principles, button rules, what is stored and sent where, the watch, what the bot does not do |
| [docs/configuration.md](docs/configuration.md) | Every setting, and an example configuration |
| [docs/deployment.md](docs/deployment.md) | Requirements, Wire app registration, local run, Docker Compose, Kubernetes, the container image, the CLI, the document index |
| [charts/wire-support-bot/README.md](charts/wire-support-bot/README.md) | The Helm chart: install, Secrets, database connection, metrics |
| [docs/operations.md](docs/operations.md) | Logs, metrics, alerts, the Grafana dashboard, connection recovery, known operational limits |
| [docs/architecture.md](docs/architecture.md) | Code layout, main modules, message flow, extending with knowledge sources or another tracker |
| [CONTRIBUTING.md](CONTRIBUTING.md) | Rules, tests and checks for changing the code |

## License

GNU General Public License, version 3 only (`GPL-3.0-only`); see [LICENSE](LICENSE).

The Wire libraries it uses are GPL-3.0 as well (`@wireapp/wire-apps-js-sdk`, `@wireapp/core-crypto` and `bazinga64`), and a bot built from this code runs them in the same process. If you distribute your bot, the combined work falls under the GPL and you must offer its source to the people you distribute it to; running it only for yourself does not require that. The other dependencies are under permissive licenses (MIT, Apache-2.0, BSD) or MPL-2.0, which are compatible with the GPL.
