# wire-support-bot Helm chart

Runs the [Wire Support Bot](../../README.md), a demo and proof of concept that connects Wire conversations with a Jira Service Management service desk.

- **One pod,** with a persistent volume for the Wire SDK store.
- **External Postgres:** the chart contains no database. Use a managed Postgres or an operator such as CloudNativePG.
- **No inbound traffic:** the bot connects out to the Wire backend, Jira and the model endpoint, so there is no Ingress. A Service exists only for scraping metrics.

Requires Helm 3 or newer. `values.yaml` documents every value, and `values.schema.json` rejects unknown keys and invalid values.

## Install

1. Register a Wire app for this deployment ([deployment guide](../../docs/deployment.md#register-the-wire-app)). Don't reuse the app of another deployment.
2. Create the Secrets. Optional keys are `WIRE_SUPPORT_BOT_LLM_API_KEY`, `WIRE_SUPPORT_BOT_EMBED_API_KEY` and `WIRE_SUPPORT_BOT_JIRA_EMAIL` (classic Jira token only).

   ```bash
   kubectl create namespace support-bot
   kubectl create secret generic wire-support-bot-credentials --namespace support-bot \
     --from-literal=WIRE_SDK_API_TOKEN=... \
     --from-literal=WIRE_SDK_CRYPTO_KEY=... \
     --from-literal=WIRE_SUPPORT_BOT_JIRA_API_TOKEN=...
   kubectl create secret generic wire-support-bot-database --namespace support-bot \
     --from-literal=password=...
   ```

3. Write `my-values.yaml`:

   ```yaml
   existingSecret: wire-support-bot-credentials
   database:
     secretName: wire-support-bot-database
     host: { value: postgres.example.com }
     name: { value: wire_support_bot }
     user: { value: wirebot }
     password: { secretKey: password }
     options: sslmode=require
   config:
     wireApiHost: https://wire-backend.example.com
     wireAppId: 00000000-0000-0000-0000-000000000000
     wireAppDomain: wire.example.com
     llmBaseUrl: http://ollama.ollama.svc:11434/v1
     jiraBaseUrl: https://api.atlassian.com/ex/jira/<cloud id>
     jiraSiteUrl: https://your-site.atlassian.net
     jiraProjectKey: SD
     jiraServiceDeskId: "1"
     jiraRequestTypes: question=10001,part=10002,fault=10003
     jiraPassive: "on"
   ```

4. Install from a checkout of this repository (the chart is not published to a chart registry):

   ```bash
   helm install wire-support-bot ./charts/wire-support-bot --namespace support-bot -f my-values.yaml
   kubectl logs --namespace support-bot deployment/wire-support-bot --follow
   ```

## Values

| Value | Default | Meaning |
|---|---|---|
| `image.repository`, `image.tag` | `quay.io/wire/wire-support-bot`, the chart's `appVersion` | The bot's image. |
| `existingSecret` | | Secret with the Wire, Jira and model credentials. Without it, the chart creates one from `secrets.*`. |
| `database.*` | | The Postgres connection; see below. |
| `config.*` | | Every non-secret setting of the [configuration reference](../../docs/configuration.md), for example `config.jiraPassive` for `WIRE_SUPPORT_BOT_JIRA_PASSIVE`. An empty value leaves the bot's default. |
| `persistence.size`, `persistence.storageClass`, `persistence.existingClaim` | `1Gi`, cluster default | The claim for the SDK store. |
| `metrics.enabled` | `false` | Metrics, a Service for them and a liveness probe. |
| `metrics.serviceMonitor.enabled`, `metrics.serviceMonitor.labels` | `false` | A ServiceMonitor for the Prometheus Operator. |
| `metrics.podAnnotations` | `false` | `prometheus.io/*` annotations for annotation-based discovery. |
| `resources`, `nodeSelector`, `tolerations`, `affinity` | | As usual. |
| `extraEnv`, `extraVolumes`, `extraVolumeMounts`, `extraContainers` | | For CA certificates, documents to ingest, or a database proxy sidecar. |

Point `config.llmBaseUrl` at a model endpoint the pod can reach; the default `http://localhost:11434/v1` is the pod itself. Quote `"on"` and `"off"`, because YAML reads a bare `on` as true. A change to the values restarts the pod on `helm upgrade`.

## Database connection

The connection comes from Secrets in the release's namespace, in one of two modes:

- **A complete URL:** `database.url.secretName` names the Secret and `database.url.secretKey` (default `uri`) the key.
- **The parts:** `database.secretName` names a Secret with the password (`database.password.secretKey`, default `password`). Each of `host`, `port`, `name` and `user` is either a plain `value` or, with `secretKey` set, a key of that Secret. The password is never a plain value.

`database.options` is appended as query parameters in both modes, for example `sslmode=require`. The entry point builds the URL and encodes special characters.

Examples for the Secrets that common operators create (`postgres` is the cluster's name):

```yaml
# CloudNativePG, Secret <cluster>-app, the complete URL:
database:
  url: { secretName: postgres-app, secretKey: uri }

# CloudNativePG, the same Secret, the parts:
database:
  secretName: postgres-app
  host: { secretKey: host }
  port: { secretKey: port }
  name: { secretKey: dbname }
  user: { secretKey: username }
  password: { secretKey: password }

# Crunchy PGO, Secret <cluster>-pguser-<user> (also has uri for the complete URL):
database:
  secretName: postgres-pguser-wirebot
  host: { secretKey: host }
  port: { secretKey: port }
  name: { secretKey: dbname }
  user: { secretKey: user }
  password: { secretKey: password }

# Zalando postgres-operator, Secret <user>.<cluster>.credentials.postgresql.acid.zalan.do
# (user name and password only; the host is the cluster's Service):
database:
  secretName: wirebot.postgres.credentials.postgresql.acid.zalan.do
  host: { value: postgres }
  name: { value: wire_support_bot }
  user: { secretKey: username }
  password: { secretKey: password }
```

**CA certificate:** mount it and name the file in the options:

```yaml
database:
  options: sslmode=require&sslcert=/etc/postgres-ca/ca.crt
extraVolumes:
  - name: postgres-ca
    secret: { secretName: postgres-ca }
extraVolumeMounts:
  - { name: postgres-ca, mountPath: /etc/postgres-ca, readOnly: true }
```

**Cloud SQL:** run the Cloud SQL Auth Proxy as a sidecar and connect to `127.0.0.1`. The pod's service account needs the Cloud SQL Client role, for example through Workload Identity. If the bot starts before the proxy listens, the migrations fail and Kubernetes restarts the bot's container.

```yaml
database:
  secretName: wire-support-bot-database
  host: { value: 127.0.0.1 }
  password: { secretKey: password }
extraContainers:
  - name: cloud-sql-proxy
    image: gcr.io/cloud-sql-connectors/cloud-sql-proxy:2.14.0
    args: ["--port=5432", "example-project:europe-west1:postgres"]
    securityContext:
      runAsNonRoot: true
      allowPrivilegeEscalation: false
      capabilities: { drop: [ALL] }
```

Limits:
- Secrets are read from the release's namespace only. If an operator creates its Secret elsewhere, copy it, for example with External Secrets or reflector.
- IAM login without a password (RDS IAM authentication, Cloud SQL IAM without the proxy) is not supported, since Prisma does not refresh the short-lived tokens.

## Metrics

```yaml
metrics:
  enabled: true
  serviceMonitor:
    enabled: true
    labels: { release: prometheus }   # the labels your Prometheus selects ServiceMonitors by
```

The bot serves `/metrics` and `/healthz` on `metrics.port` (9464). The liveness probe on `/healthz` only checks that the process answers, never Wire, Jira, the model or the database. See [operations](../../docs/operations.md#metrics) for the metrics, example alerts and the Grafana dashboard.

## How the chart runs the bot

- **One replica,** replaced with the `Recreate` strategy, so an upgrade stops the old pod before the new one starts. Never run a second instance with the same Wire app elsewhere (Docker Compose, a local process) while the release is installed.
- **Start-up:** the entry point applies the database migrations, then starts the bot.
- **The SDK store** is a `ReadWriteOnce` claim at `/app/storage`, and `helm uninstall` keeps it. Without the store, the bot starts as a new device and cannot read messages sent meanwhile. If `WIRE_SDK_CRYPTO_KEY` is lost or changed, delete the claim's contents too.
- **Security:** the pod runs as user and group 1000 with no privilege escalation and no capabilities, and mounts no service account token.
- **Restarts:** a failed start or a Wire connection that cannot be restored exits the process, and Kubernetes restarts the pod. There is no readiness probe, since nothing routes traffic to the pod.
