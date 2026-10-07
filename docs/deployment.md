# Deployment

## Requirements

- **Node.js 22.12 or newer.** The Wire SDK's native crypto library needs glibc 2.38 or newer on Linux x86-64; the provided Dockerfile (Node 22 on Debian trixie) meets this.
- **PostgreSQL.** The Compose file uses Postgres 16; on Kubernetes, bring your own.
- **An OpenAI-compatible chat-completions endpoint,** for example a local Ollama (`http://localhost:11434/v1`) with `qwen3-next:80b`, or a hosted provider. For the optional document index, also an embeddings endpoint.
- **A Wire app,** registered on your Wire backend by a team admin (see below). The team needs the apps feature enabled.
- **A Jira Service Management project** with an API token for an account with the permissions listed in [configuration](configuration.md#jira). Use a scoped service-account token (Bearer, base URL `https://api.atlassian.com/ex/jira/<cloud id>`) or a classic API token with the account's e-mail (Basic). You also need the service desk ID and the request type IDs.

## Register the Wire app

`scripts/register-app.mjs` logs in as a team admin, creates the app and prints the `WIRE_SDK_*` settings. Secrets are masked unless you write them to a file with `--out` (created with mode 0600) or pass `--print-token`.

```bash
npm run register-app -- versions --host https://your-wire-backend.example.com
npm run register-app -- create --host https://your-wire-backend.example.com --email admin@example.com --out .env.wire
```

The admin password is prompted for, or read from `WIRE_ADMIN_PASSWORD`. If the login needs a verification code, request one with `send-code` and pass it with `--code`. `refresh --app-id <id>` issues a new token for an existing app and keeps its crypto key; `list` shows the team's apps.

Copy the printed values into `.env`, then have a team admin add the app to a conversation. Register a separate app for every deployment, including test and staging (see [operations](operations.md#one-instance-per-wire-app)).

## Run with Node

```bash
npm install
cp .env.example .env               # then replace every placeholder
npm run prisma:generate
npx prisma migrate deploy          # applies prisma/migrations to DATABASE_URL
npm run build
npm start
```

`npm start` runs `dist/app/main.js`, which reads `.env`; `npm run dev` runs the TypeScript source.

The Wire SDK keeps its local database and crypto keystore under `./storage`. Keep that directory and `WIRE_SDK_CRYPTO_KEY` together: the key encrypts the store, so if the key is lost or changed, delete the store too. Without the store the bot starts as a new device of the app and rejoins its conversations, but it cannot read messages sent while it had no store.

## Docker Compose

`docker-compose.yml` builds the image from this repository and runs it with Postgres 16. Create `.env` first, then:

```bash
docker compose up -d --build
```

- The entry point applies the migrations and starts the bot.
- Compose sets its own `DATABASE_URL`, binds Postgres to `127.0.0.1` only, and keeps the SDK store in a named volume.
- An Ollama service is included as a commented-out block; to use it, uncomment it and set `WIRE_SUPPORT_BOT_LLM_BASE_URL=http://ollama:11434/v1`.
- After changing the code, run the same command again to rebuild.

## Kubernetes

Use the Helm chart in `charts/wire-support-bot/`; its [README](../charts/wire-support-bot/README.md) covers installation, Secrets, the database connection and metrics.

## Container image

`.github/workflows/image.yml` builds the image for `linux/amd64` only, since the SDK's native crypto library is built for x86-64. Only a version tag publishes it to `quay.io/wire/wire-support-bot`: tag `v1.2.3` publishes `1.2.3`, `1.2` and `latest` (no `latest` for a pre-release such as `v1.2.3-rc.1`). Pushes to `main`, pull requests and manual runs test and build without publishing. The workflow needs the repository secrets `QUAY_USERNAME` and `QUAY_PASSWORD` of a quay.io robot account with write access.

To use your own registry:

```bash
docker build --platform linux/amd64 -t registry.example.com/wire-support-bot:1.0.0 .
docker push registry.example.com/wire-support-bot:1.0.0
```

## The CLI for local testing

The CLI drives the real router and use cases from the terminal, without Wire. It reads `.env` like the bot and needs the full configuration, the database and the model endpoint.

```bash
npm run build
npm run cli
printf "@Wire Support Bot support requests\n" | npm run cli
```

- It simulates one conversation with Alice (the default), Bob, Carol and Dave; prefix a line with `Bob: ` to send it as Bob.
- Bot replies go to stdout, logs to stderr (level `warn` unless `LOG_LEVEL` is set).
- Buttons are printed numbered; a line with only an option's number clicks it (`2`, or `Bob: 2`), and any other line is a text answer. When the buttons are numbers themselves (quantities), a number clicks only the button with that label.
- It has no watch, no files and no agent groups. With the document index on, its answers use it like the bot's.
- End with `exit`, `quit` or Ctrl-D.

> [!WARNING]
> Commands and confirmed offers in the CLI write to the real service desk. Point it at a test project.

## The document index

With `WIRE_SUPPORT_BOT_KNOWLEDGE=on` the bot answers from curated documents (manuals, troubleshooting guides, FAQs) in Markdown or plain text; see [usage](usage.md#first-level-help) for what members see.

### Embeddings endpoint

The index needs an OpenAI-compatible embeddings endpoint (`WIRE_SUPPORT_BOT_EMBED_BASE_URL` and `WIRE_SUPPORT_BOT_EMBED_MODEL`). It never follows the model endpoint, since a chat provider may offer no embeddings: Anthropic, for example, offers none and recommends Voyage AI (`https://api.voyageai.com/v1` with `voyage-4`). Locally, use Ollama: `http://localhost:11434/v1` with `qwen3-embedding:0.6b`, after `ollama pull qwen3-embedding:0.6b`.

### Ingestion

`npm run knowledge:ingest -- <directory>` reads every `.md`, `.markdown` and `.txt` file in the directory and its subdirectories (names starting with a dot are skipped).
- **Splitting:** a document's title is its first `# ` heading, else the file name. Each section becomes an excerpt with its heading path; sections longer than about 3,000 characters are split at paragraphs or sentences, with some overlap.
- **The directory is the full set:** a run adds new documents, skips unchanged ones, replaces changed ones and removes those no longer in the directory. An empty directory is refused, so a wrong path cannot empty the index.
- **Output:** it prints a summary such as `4 added, 0 updated, 0 unchanged, 0 removed; 30 chunks (30 embedded)` and no document content. On an error it exits with code 1; the next run continues where it stopped.
- **Requirements:** it needs the database and the embeddings endpoint, not Wire or Jira, and also runs while the index is off, so you can fill it before turning it on.

### Search

At start-up the bot loads every excerpt embedded with the configured model into memory. For each question addressed to it, the bot embeds the question and passes the best excerpts above the minimum score to the answer model. The search is exact, needs no database extension and suits up to a few thousand excerpts. A new ingestion is picked up within a minute, without a restart.

If the embeddings endpoint cannot be reached, the bot logs a warning and answers without documents. Excerpts embedded with another model are skipped with a warning; after changing the model, run the ingestion again.

### Running the ingestion

`examples/knowledge/` has four invented documents for a truck fleet to try it with.

**Locally:**

```bash
npm run build
npm run knowledge:ingest -- examples/knowledge
```

**With Docker Compose,** in a one-off container, after the bot has started once (which applies the migrations):

```bash
docker compose run --rm --entrypoint node -v "$PWD/examples/knowledge:/knowledge:ro" wire-support-bot dist/app/knowledgeIngest.js /knowledge
```

For an Ollama on the host, set `WIRE_SUPPORT_BOT_EMBED_BASE_URL=http://host.docker.internal:11434/v1` (on Linux, also add `extra_hosts: ["host.docker.internal:host-gateway"]` to the service).

**On Kubernetes,** put the documents in a ConfigMap, mount it, and run the ingestion in the running pod:

```bash
kubectl create configmap support-knowledge --namespace support-bot --from-file=examples/knowledge/
```

```yaml
config:
  knowledge: "on"
extraVolumes:
  - name: knowledge
    configMap: { name: support-knowledge }
extraVolumeMounts:
  - { name: knowledge, mountPath: /knowledge, readOnly: true }
```

```bash
kubectl exec --namespace support-bot deploy/wire-support-bot -- node dist/app/knowledgeIngest.js /knowledge
```

A ConfigMap holds at most 1 MiB, and `--from-file` takes only the files directly in the directory; for a larger set, use a volume of your own. After changing the ConfigMap, wait a minute for Kubernetes to update the files, then run the ingestion again.
