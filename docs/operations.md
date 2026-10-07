# Operations

## One instance per Wire app

Run one bot process per Wire app and SDK store. The SDK store, pending offers, the message buffer and the guard against double submits belong to the process.

Use a separate Wire app for every deployment, including test and staging. Each SDK store holds its own login cookie, which the Wire backend renews, so a second store logging in as the same app (a new pod, a copied store, a test cluster) can make the backend refuse the first one. The refused bot stops at start-up with `AuthenticationError` and a hint. Its next start logs in again as a new device; while both instances run, they keep refusing each other. Only if that start fails as well is the token itself invalid: issue a new one with `npm run register-app -- refresh`.

A restart drops pending offers and the conversation context. Questions still open at the restart keep their buttons, and a click on them does nothing.

## Wire connection recovery

The Wire SDK stops reconnecting after about 10 failed attempts in a row (about 3.5 minutes of outage) and does not report it. The connection watchdog (`WIRE_SUPPORT_BOT_WIRE_WATCHDOG_MINUTES`, default 5) handles this:
1. After that many minutes without a connection, it restarts the connection.
2. If that doesn't help within as many minutes again, it exits with code 1.
3. Docker Compose (`restart: unless-stopped`) or Kubernetes then starts the bot again.

If the process has nothing left to wait for, it logs "Nothing keeps the bot running (Wire connection gone); exiting" and exits with code 1 as well. Outside Compose or Kubernetes, run it only under a supervisor that restarts it. Connection changes are logged at `info`: "Wire connected", "Wire disconnected" and "Wire connection restored after the watchdog restart".

## Logs

The bot writes one JSON object per line to stdout (the CLI to stderr). Only Prisma's migration output at start-up is plain text. Each line has:
- `severity` (`DEBUG`, `INFO`, `WARNING`, `ERROR`), read by Google Cloud Logging;
- `level`, read by Loki, Datadog and most other tools.

For Elastic, set `LOG_FORMAT=ecs` (`config.logFormat: ecs` in the chart) for Elastic Common Schema fields. Collectors such as Fluent Bit, Vector, Grafana Alloy or the OpenTelemetry Collector need no parser beyond JSON.

**Levels:** at the default level `info` the bot logs start-up, connection changes, watchdog actions, warnings and errors. Per-message lines (`Message handled` with the message kind, route and duration, and the passive-help classifier result) are at `debug`.

**Privacy:** fields with content (`text`, `preview`, `raw`, `context`, `prompt`, `response`, `stack`) and personal data (`name`, `senderName`, `requesterName`, `displayName`, `handle`, `agentHandle`, `email`, `fileName`) are removed. Lines carry conversation, user and message IDs for correlation, but no names. The use cases log error names and ticket keys rather than content, and the document index never logs a question or document text.

### Wire SDK log lines

The Wire SDK's own log calls appear as "Wire SDK diagnostic" at their severity, filtered by `WIRE_SUPPORT_BOT_SDK_LOG_LEVEL` (default `warn`). `WIRE_SUPPORT_BOT_SDK_LOG_CONTENT` decides what they carry:

- `messages` (default): the SDK's message text as `sdkMessage`, with control characters removed, at most 500 characters. It can contain IDs, request paths and backend error messages, but no message content; the name of a conversation the bot creates is replaced by `[redacted]`. Warnings and errors add the error's class name (`errorName`) and an HTTP `status`, error `code` or backend `label` when present.
- `none`: only the content-free fields.
- `full`: also the SDK's other arguments as `sdkArgs`, which can contain decrypted messages and HTTP bodies, and possibly tokens. The bot logs a warning at start-up. Use it only for short troubleshooting.

## Metrics

With `WIRE_SUPPORT_BOT_METRICS_PORT` set (for example `9464`), the bot serves from start-up on, before it connects to Wire:
- `GET /metrics`: Prometheus text format.
- `GET /healthz`: `200 ok` as long as the process answers. It does not check Wire, Jira, the model or the database, so a Jira outage never restarts the bot; watch those through the metrics.

The endpoint has no authentication: keep it inside the cluster or on a local address. With Docker Compose, publish the port (a commented mapping is in `docker-compose.yml`). In Kubernetes, set `metrics.enabled` in the chart.

Metrics are labeled only from small fixed sets (and the configured model names for tokens). They carry no message content and no conversation, user, message or ticket IDs.

Every name starts with `wire_support_bot_`. The Node runtime metrics (`wire_support_bot_process_*`, `wire_support_bot_nodejs_*`) come first; the bot's own are listed here without the prefix:

| Metric | Type | Labels | Meaning |
|---|---|---|---|
| `wire_messages_received_total` | counter | `kind`: `text`, `file`, `button_click`, `other` | Events received from Wire. `other`: edits, pings, locations, reactions, deletions. |
| `wire_connection_events_total` | counter | `event`: `connected`, `disconnected` | WebSocket connections opened and lost. |
| `wire_connected` | gauge | | 1 while the WebSocket is connected. |
| `wire_watchdog_actions_total` | counter | `action`: `restart`, `exit` | What the connection watchdog did. |
| `wire_sdk_problems_total` | counter | `severity`: `warn`, `error` | Warnings and errors the Wire SDK logged, whatever the SDK log level. |
| `model_calls_total` | counter | `slot`: `classify`, `respond`, `embed`; `outcome`: `ok`, `fallback`, `timeout`, `error` | Model calls; `fallback` means the fallback model answered. |
| `model_call_duration_seconds` | histogram | `slot` | Duration of a model call, fallback included. |
| `model_tokens_total` | counter | `slot`; `model`: the configured model that answered; `direction`: `input`, `output` | Tokens of successful calls as the provider reported them. `embed` counts only input tokens. |
| `model_usage_missing_total` | counter | `slot` | Successful calls whose response reported no usable token usage. |
| `jira_requests_total` | counter | `operation`: `create_issue`, `get_issue`, `resolve_issue`, `list_customer_replies`, `add_customer_reply`, `list_changed_since`, `add_customer_attachment`, `submit_feedback`; `outcome`: `2xx`, `4xx`, `5xx`, `timeout`, `error` | Jira HTTP requests by the operation that made them (one operation can make several). `error`: no response. |
| `jira_request_duration_seconds` | histogram | `operation` | Duration of a Jira HTTP request. |
| `watch_checks_total` | counter | `outcome`: `ok`, `error` | Watch checks. |
| `watch_check_duration_seconds` | histogram | | Duration of a watch check, including the updates it posts. |
| `watched_requests` | gauge | | Requests the last successful watch check looked at. |
| `support_requests_raised_total` | counter | `kind`: `question`, `part`, `fault` | Requests raised. |
| `support_replies_sent_total` | counter | | Replies sent to the service desk from Wire. |
| `support_requests_resolved_total` | counter | | Resolves from Wire that reached done. |
| `offers_total` | counter | `event`: `made`, `accepted`, `declined`, `expired` | Offers and questions put to a member, and how they ended. |
| `button_clicks_total` | counter | `outcome`: `accepted`, `not_asked`, `late`, `invalid` | Button clicks: the deciding click, a member who wasn't asked, a question no longer open, a button not of the question. |
| `ratings_total` | counter | `outcome`: `ok`, `refused`, `unconfirmed`, `not_sent` | Satisfaction ratings sent to Jira. |
| `pending_offers` | gauge | | Offers and questions waiting for an answer. |
| `queue_length` | gauge | | Messages waiting in the passive-help queue. |
| `knowledge_retrievals_total` | counter | `outcome`: `hit`, `miss`, `error` | Searches of the document index. |
| `knowledge_help_answers_total` | counter | `outcome`: `solved`, `ticket`, `ended`, `expired` | How "Did this help?" ended. |
| `knowledge_chunks` | gauge | | Excerpts of the document index loaded. |

Every series starts at 0 at start-up (token series for each configured model), so rates and absence checks see the first event.

Token counts are what the provider reports. Anthropic's thinking tokens, through its OpenAI compatibility layer, are included in the output tokens. Token counts are not invoices: caching, discounts and billing rules are not visible in them.

### Example queries and alerts

```promql
# Share of Jira requests that failed over 15 minutes
sum(rate(wire_support_bot_jira_requests_total{outcome!="2xx"}[15m]))
  / sum(rate(wire_support_bot_jira_requests_total[15m])) > 0.2

# 95th percentile of model call duration per slot
histogram_quantile(0.95, sum by (slot, le) (rate(wire_support_bot_model_call_duration_seconds_bucket[30m])))

# Tokens per minute by slot, model and direction
sum by (slot, model, direction) (rate(wire_support_bot_model_tokens_total[5m])) * 60

# Model calls that needed the fallback or failed
sum by (slot, outcome) (increase(wire_support_bot_model_calls_total{outcome!="ok"}[1h]))

# No message from Wire for 6 hours (adjust to how busy your conversations are)
sum(increase(wire_support_bot_wire_messages_received_total[6h])) == 0

# The WebSocket has been down for 10 minutes
max_over_time(wire_support_bot_wire_connected[10m]) == 0

# The connection watchdog had to act
increase(wire_support_bot_wire_watchdog_actions_total[1h]) > 0

# The watch keeps failing
increase(wire_support_bot_watch_checks_total{outcome="error"}[30m]) > 3
```

### Grafana dashboard

`dashboards/grafana/wire-support-bot.json` is a Grafana dashboard for these metrics. Import it (Dashboards, New, Import) and pick a Prometheus-compatible data source such as Prometheus or VictoriaMetrics. It selects the bot by the `namespace` and `pod` labels that the scraper adds (the chart's ServiceMonitor sets them).

Rows: Overview, Wire, Model, Tokens, Jira, Support flow, Runtime.

## Known operational limits

- The watch looks at up to 500 requests per check, oldest first; the bot retries leaving up to 500 pending agent groups per run.
- Desk updates appear up to one watch interval late.
- Edited messages are ignored.
- Only photos and documents of the supported types, up to 10 MB, are offered for attaching.
