# Configuration

All settings are environment variables; `.env.example` lists them with comments. The bot and the CLI read `.env` from the working directory, and settings already in the environment take precedence. Start-up fails with a message naming the setting when a required one is missing or a value is invalid. In the Helm chart, every setting has a value under `config:`, `secrets:` or `database:` (see the [chart's README](../charts/wire-support-bot/README.md)).

## Wire app

| Setting | Required | Default | Meaning |
|---|---|---|---|
| `WIRE_SDK_API_TOKEN` | yes | | App token from the registration script. |
| `WIRE_SDK_API_HOST` | yes | | Base URL of the Wire backend. |
| `WIRE_SDK_CRYPTO_KEY` | yes | | Key for the SDK's local crypto store, 64 hex characters (`openssl rand -hex 32`). If it is lost or changed, delete the store too. |
| `WIRE_SDK_APP_ID` | yes | | The app's user ID; checked at start-up. |
| `WIRE_SDK_APP_DOMAIN` | yes | | The app's domain; checked at start-up. Agent handles are looked up on this domain. |
| `WIRE_SUPPORT_BOT_WIRE_WATCHDOG_MINUTES` | no | `5` | Minutes without a Wire connection before the bot restarts the connection; after as many minutes again it exits with code 1 for a restart. `0` turns it off; otherwise 2 to 60. See [operations](operations.md#wire-connection-recovery). |
| `WIRE_ADMIN_EMAIL` | no | | Only for `scripts/register-app.mjs`: the team admin's e-mail. |
| `WIRE_ADMIN_PASSWORD` | no | prompted | Only for `scripts/register-app.mjs`: the admin's password. |

## Database

| Setting | Required | Default | Meaning |
|---|---|---|---|
| `DATABASE_URL` | yes | | Postgres connection URL. Docker Compose sets its own; the Helm chart reads it from a Secret or builds it from the settings below. |
| `DATABASE_HOST`, `DATABASE_NAME`, `DATABASE_USER`, `DATABASE_PASSWORD` | no | | Alternative to `DATABASE_URL`, used only by the container's entry point when `DATABASE_URL` is unset; then all four are required. Special characters are encoded. |
| `DATABASE_PORT` | no | `5432` | The port for the alternative. |
| `DATABASE_OPTIONS` | no | | Only for the container's entry point: query parameters appended to the URL, for example `sslmode=require`. |

## Model endpoint and slots

| Setting | Required | Default | Meaning |
|---|---|---|---|
| `WIRE_SUPPORT_BOT_LLM_BASE_URL` | no | `http://localhost:11434/v1` | OpenAI-compatible endpoint; `/chat/completions` is appended. |
| `WIRE_SUPPORT_BOT_LLM_API_KEY` | no | | Sent as a Bearer token; Ollama ignores it. |
| `WIRE_SUPPORT_BOT_LLM_TIMEOUT_MS` | no | `60000` | Timeout per model call in milliseconds. |
| `WIRE_SUPPORT_BOT_LLM_REASONING_EFFORT` | no | not sent | `none`, `low`, `medium` or `high`, sent as `reasoning_effort`. Local thinking models such as Qwen under Ollama need `none`. |
| `WIRE_SUPPORT_BOT_MODEL_CLASSIFY` | no | `qwen3-next:80b` | Model for passive-help classification, the support triage and part details. |
| `WIRE_SUPPORT_BOT_FALLBACK_CLASSIFY` | no | `qwen3-next:80b` | Tried once when the classify model times out or returns 503 or 529. |
| `WIRE_SUPPORT_BOT_MODEL_RESPOND` | no | `qwen3-next:80b` | Model for answers to messages addressed to the bot. Use a capable model here. |
| `WIRE_SUPPORT_BOT_FALLBACK_RESPOND` | no | `qwen3-next:80b` | Tried once when the respond model times out or returns 503 or 529. |

## Document index

| Setting | Required | Default | Meaning |
|---|---|---|---|
| `WIRE_SUPPORT_BOT_KNOWLEDGE` | no | `off` | `on` lets answers use the ingested documents and asks "Did this help?" after an answer to a problem. Off, the bot makes no embedding call. |
| `WIRE_SUPPORT_BOT_EMBED_BASE_URL` | with knowledge on | | OpenAI-compatible embeddings endpoint; `/embeddings` is appended, for example `http://localhost:11434/v1` (Ollama) or `https://api.voyageai.com/v1`. It never falls back to the model endpoint. |
| `WIRE_SUPPORT_BOT_EMBED_API_KEY` | no | | Bearer token for the embeddings endpoint; never the model endpoint's key. |
| `WIRE_SUPPORT_BOT_EMBED_MODEL` | with knowledge on | | Embedding model for ingestion and search, for example `qwen3-embedding:0.6b` or `voyage-4`. After a change, run the ingestion again. |
| `WIRE_SUPPORT_BOT_KNOWLEDGE_RESULTS` | no | `4` | Most excerpts passed to the answer model per question, 1 to 10. |
| `WIRE_SUPPORT_BOT_KNOWLEDGE_MIN_SCORE` | no | `0.5` | Lowest cosine similarity of an excerpt passed on, 0 to 1. Raise it when unrelated excerpts show up, lower it when matching ones are missed. |

Embeddings requests use `WIRE_SUPPORT_BOT_LLM_TIMEOUT_MS`. These settings are checked at start-up also while the index is off.

## Jira

| Setting | Required | Default | Meaning |
|---|---|---|---|
| `WIRE_SUPPORT_BOT_JIRA_BASE_URL` | yes | | REST base URL (https); for a scoped token `https://api.atlassian.com/ex/jira/<cloud id>`. |
| `WIRE_SUPPORT_BOT_JIRA_SITE_URL` | yes | | Site URL for ticket links (https), for example `https://your-site.atlassian.net`. |
| `WIRE_SUPPORT_BOT_JIRA_LINKS` | no | `agent` | Where ticket links point: `agent` (`<site>/browse/SD-42`) or `portal` (the request in the customer portal). Keep `agent` for now: the bot raises requests as its own Jira account, so members cannot see them in the portal yet. |
| `WIRE_SUPPORT_BOT_JIRA_API_TOKEN` | yes | | Scoped token (Bearer), or classic token together with the e-mail (Basic). |
| `WIRE_SUPPORT_BOT_JIRA_EMAIL` | no | | Account e-mail for a classic token; unset for a scoped token. |
| `WIRE_SUPPORT_BOT_JIRA_PROJECT_KEY` | yes | | Project key, for example `SD`. Only keys of this project are accepted. |
| `WIRE_SUPPORT_BOT_JIRA_SERVICE_DESK_ID` | yes | | Numeric service desk ID. |
| `WIRE_SUPPORT_BOT_JIRA_REQUEST_TYPES` | yes | | Request type ID per kind, for example `question=10001,part=10002,fault=10003`. `fault` is required and used for any kind without its own entry. |
| `WIRE_SUPPORT_BOT_JIRA_TIMEOUT_MS` | no | `15000` | Timeout per Jira call in milliseconds, at least 1000. |
| `WIRE_SUPPORT_BOT_JIRA_SHARE_WITH_MODEL` | no | `off` | `on` lets live ticket status, SLAs and desk replies reach the answer model. |
| `WIRE_SUPPORT_BOT_JIRA_SERVICE_SCOPE` | no | generic wording | What the service desk handles, in plain words, for the model prompts; at most 500 characters. |
| `WIRE_SUPPORT_BOT_JIRA_AGENTS` | no | | Desk agents who get a direct conversation with the requester when assigned: `<jira account id>=<wire handle>`, comma-separated. Needs the watch. |
| `WIRE_SUPPORT_BOT_JIRA_AGENT_CHAT` | no | `ask` | What a newly assigned mapped agent gets: `ask` (ask the requester first), `auto` (open at once) or `off`. |

The Jira account needs to be able, in the project, to raise requests through the service desk API, edit issues (to set the label), read issues and their SLAs, follow workflow transitions, read and add public comments, and add attachments.

## Part orders

| Setting | Required | Default | Meaning |
|---|---|---|---|
| `WIRE_SUPPORT_BOT_PART_ASSET_LABEL` | no | `Asset` | Label of the item a part is for, shown in confirmations and tickets; at most 40 characters. |
| `WIRE_SUPPORT_BOT_PART_ASSET_QUESTION` | no | `the item the part is for (for example a machine, vehicle or device)` | Completes "To order it I need ..."; at most 200 characters. |
| `WIRE_SUPPORT_BOT_PART_DELIVERY_LOCATIONS` | no | unset (asked in text) | Delivery locations offered as buttons, plus [Other]: up to 5, separated by `;`, each at most 40 characters. |

## Passive help, watch and questions

| Setting | Required | Default | Meaning |
|---|---|---|---|
| `WIRE_SUPPORT_BOT_JIRA_PASSIVE` | no | `off` | `on` lets the bot read unaddressed messages and offer to raise, add to or resolve requests, and to attach files. |
| `WIRE_SUPPORT_BOT_JIRA_WATCH_SECONDS` | no | unset (no watch) | Seconds between checks for desk replies, status and assignee changes; at least 15. |
| `WIRE_SUPPORT_BOT_JIRA_UPDATE_QUESTION_HOURS` | no | `4` | Hours the requester can answer the question after a desk update, and the rating question; 0 to 72, `0` asks no such questions. The question about the agent conversation and "Did this help?" keep 4 hours when it is `0`. |
| `WIRE_SUPPORT_BOT_JIRA_FEEDBACK` | no | `off` | `on` asks for a 1 to 5 rating after a solved request and sends it to Jira. Needs the watch and the questions after a desk update. |

## Logging and conversations

| Setting | Required | Default | Meaning |
|---|---|---|---|
| `LOG_LEVEL` | no | `info` (`warn` in the CLI) | `debug`, `info`, `warn` or `error`. |
| `LOG_FORMAT` | no | `json` | `json` or `ecs` (Elastic Common Schema). |
| `WIRE_SUPPORT_BOT_SDK_LOG_LEVEL` | no | `warn` | Level of the Wire SDK's own lines: `off`, `error`, `warn`, `info` or `debug`. |
| `WIRE_SUPPORT_BOT_SDK_LOG_CONTENT` | no | `messages` | What the SDK's lines carry: `messages`, `none` or `full`. See [operations](operations.md#wire-sdk-log-lines). |
| `MESSAGE_BUFFER_SIZE` | no | `50` | Recent messages kept in memory per conversation, at most 500. |
| `WIRE_SUPPORT_BOT_DEFAULT_TIMEZONE` | no | `UTC` | IANA timezone for conversations the bot newly joins. |

## Metrics

| Setting | Required | Default | Meaning |
|---|---|---|---|
| `WIRE_SUPPORT_BOT_METRICS_PORT` | no | unset (no HTTP server) | Port for `GET /metrics` and `GET /healthz`. See [operations](operations.md#metrics). |
| `WIRE_SUPPORT_BOT_METRICS_HOST` | no | `0.0.0.0` | Address the endpoint listens on; `127.0.0.1` keeps it local. |

## Example: a truck manufacturer's service desk

The code speaks of a generic service desk; tailoring happens in the configuration. For a premium support desk that handles faults and replacement parts for its customers' fleets, `.env.example` ends with:

```bash
WIRE_SUPPORT_BOT_JIRA_SERVICE_SCOPE=faults, breakdowns, damage, maintenance and replacement parts for the trucks of a haulage fleet
WIRE_SUPPORT_BOT_JIRA_REQUEST_TYPES=question=10001,part=10002,fault=10003
WIRE_SUPPORT_BOT_PART_ASSET_LABEL=Vehicle
WIRE_SUPPORT_BOT_PART_ASSET_QUESTION=the vehicle (fleet or chassis number)
WIRE_SUPPORT_BOT_PART_DELIVERY_LOCATIONS=Depot north; Depot south
```

- **Service scope:** tells the classifier and the answer model what counts as a service-desk matter.
- **Request types:** map questions, part orders and faults to the project's request types; use your own IDs.
- **Asset label and question:** a part order asks for the vehicle and shows "Vehicle: ..." in the confirmation and the ticket.
- **Delivery locations:** they become buttons.

With passive help, the watch and the agent mapping on as well, drivers can report a breakdown in their own words, send a photo of the damage and talk to the assigned agent directly. `examples/knowledge/` has four invented documents for this fleet to try the document index with.
