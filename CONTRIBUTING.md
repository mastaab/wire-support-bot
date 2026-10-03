# Contributing

A short guide for developers changing this code. The README explains what the bot does, how it is set up and how it is built.

## Layering

The code follows a hexagonal (ports and adapters) layout. Keep the dependency direction:

- `src/domain/` depends only on the domain: entities, identifiers, repository contracts and pure domain services.
- `src/application/` depends on the domain and on its own ports. Use cases never call Wire, Prisma, Jira or the model endpoint directly; they go through a port or a repository contract.
- `src/infrastructure/` implements ports and repositories (Wire, Jira, the model endpoint, Postgres, in-memory stores, the passive-help pipeline).
- `src/app/` is the composition root: configuration, logging, the entry point, the CLI and `src/app/container.ts`.

`eslint.config.mjs` reports an error, and `npm run lint` fails, when the domain or application layer imports from an outer layer, the Wire SDK, Prisma or prom-client.

## Where things go

- Entities and repository contracts: `src/domain/`.
- Ports: `src/application/ports/`.
- Use cases: `src/application/usecases/`, one use case per file; shared application logic in `src/application/services/`.
- Adapters: `src/infrastructure/`, grouped by the system they talk to.
- Wiring: `src/app/container.ts`, and `src/app/cli.ts` when the CLI should have the feature too.
- Settings: read only in `src/app/config.ts`, validated at start-up, and listed in `.env.example` with a comment. Secrets come from the environment and are never committed.
- Schema changes: `prisma/schema.prisma` plus a migration in `prisma/migrations/`.
- Metrics: record through `MetricsPort` (`src/application/ports/MetricsPort.ts`), never prom-client directly, at the narrowest place that sees every event: an adapter for calls to the outside (the Jira adapter, the model client), the use case or store that decides an outcome. A new metric needs a method on the port, its definition in `src/infrastructure/metrics/PrometheusMetrics.ts`, a test with the fake in `tests/metrics/fakeMetrics.ts`, and a row in the README's "Metrics" table. Label values come only from the port's small fixed sets: never a conversation, user, message, ticket or request ID, and never text.

Keep one concern per module, use explicit types, and match the existing style. Add a dependency only when it is clearly needed.

## Rules that protect users

- The model proposes, code validates, a person confirms. Never let model output reach the service desk without validation and an explicit yes, and never let the bot claim a write it has not done.
- Buttons follow the same rule. Build every option in code from validated data (never from model output alone), keep button IDs opaque (offer ID and option index, checked against the stored offer), accept only the first click of the member who was asked, confirm only that click, and always post the result as text. Close every button question when it ends (answered, expired, replaced or dropped) through `closeOfferPrompt` or the store's ended prompts in `offerPromptClosing.ts`, at most once per message, and never make the offer logic depend on the edit succeeding; a click on an ended question changes nothing and gets no answer. Do not store a button question as a request's last message: it is edited later. Every button question must stay answerable in text, but is sent without a text answer hint such as "(yes or no)?": the buttons show the choices (`withoutAnswerHint` in `offerButtons.ts`).
- Questions after a desk update (`deskUpdateQuestions.ts`) go only to the request's requester, are never asked over their other open question, and never write without a decision: [Solved, close it] runs the existing resolve, and [Reply] or [Still broken] lead to the existing reply offer, which needs a [Yes]. Their [Solved] and "no" change nothing, so their only result is the closing line. The watch must never fail or repeat an update because of such a question. The question about the agent conversation (`AskForAgentConversation.ts`) follows the same rules, claims the request when it is asked (once per request), is not replaced by a later desk-update question (`keepsSlot`), and runs the existing `OpenAgentConversation` for [Open direct chat]. An option that runs a step other than an offer command carries it in `then` (`ChoiceAction`), built by code from stored data. The satisfaction rating (`feedbackQuestions.ts`, `SubmitFeedback.ts`) is asked only after an option marked `asksFeedback` ([Solved], or [Solved, close it] once the request is done), and a rating write follows the usual rules: scope checked, audited without names or text, failures logged by error name and status.
- Scope every read and write to the qualified conversation (ID and domain), also when a record is looked up by its key.
- Validate bounds, identities and state transitions before a write, and audit domain creates, updates and deletes through `AuditLogRepository`.
- Do not store or log message text, ticket content or file contents. Log error names and keys, not bodies.

## Tests

- New use cases and non-trivial logic need tests. Unit tests use mocked ports and need no database, network or Wire connection; follow `tests/usecases/` and `tests/pipeline/`.
- Changes to Wire event routing or outbound mapping need contract tests in `tests/contract/`, including button clicks (the asked member, other members, repeated and late clicks, and clicks together with text answers) and how each question is closed.
- Repository changes need integration tests in `tests/integration/`, run with `INTEGRATION_TESTS=1` against a throwaway database. Never point tests at a shared or production database.
- For behavior that depends on the model, try it with the CLI (see the README) against a test project before you rely on it.

## Gates

Run these before you commit:

```bash
npm test
npm run typecheck        # src and tests
npm run lint
npm run build
```

`npm run typecheck` checks `src` with `tsconfig.json` and the tests with `tsconfig.test.json`.

When you change the Helm chart, also run:

```bash
scripts/check-chart.sh
```

It runs `helm lint --strict` and `helm template` for every fixture in `tests/helm/fixtures/` (each on top of the base `values.yaml` there) and checks that every fixture in `tests/helm/fixtures/invalid/` fails with the message it names. It needs Helm and no cluster.

A new setting needs a value in the chart (`values.yaml`, `values.schema.json` and `templates/configmap.yaml`, or `templates/secret.yaml` for a credential; the database settings are in the `databaseEnv` helper in `templates/_helpers.tpl`); `tests/helm/chartConfig.test.ts` fails when the chart and the app's settings differ. The workflow `.github/workflows/image.yml` runs the type check, lint, tests and chart checks before it builds the image. Type the mocks in tests properly rather than loosening an assertion to make them compile.

## Writing conventions

- US English in code comments, bot texts and documentation.
- Plain, direct sentences. No em-dashes.
- In Markdown, write each paragraph and list item on one line; do not hard-wrap.
- Use placeholders in examples, such as `SD-42` for a ticket key and `https://your-site.atlassian.net` for a Jira site. Never commit real names, handles, IDs, tokens or conversation content, also not in tests or fixtures.
