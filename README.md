# Wire Support Bot

> [!IMPORTANT]
> **Demo and proof of concept.** This bot shows how a Wire conversation can work with a service desk. It is not a supported Wire product and not ready for production use as it is. It is meant for evaluation and as a starting point for your own bot. Before you rely on it:
>
> - It depends on the Wire Apps JS SDK, which is at an early version (0.1), and on behavior of that SDK described under "Limitations and notes".
> - Answers, offers and classifications come from a language model and can be wrong; a small local model in particular can add steps of its own to answers from documents.
> - It runs as a single instance and keeps pending offers and the conversation context in memory, so a restart drops them.
> - It has been tested with one Jira Service Management project in a test environment, not under production load.
> - Security, privacy and operations (data flows to the model and embeddings providers, logging, backups, updates) need your own review.
>
> It is provided under the GPL-3.0 license, without warranty.

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
| `@Wire Support Bot resolve SD-42` | Resolves the request by following the workflow transitions toward a done status. `close SD-42` works too. |
| `@Wire Support Bot resolve SD-42: <comment>` | Adds a closing comment as a customer-facing reply, then resolves. |
| `@Wire Support Bot support requests` | Lists the open support requests of this conversation. |
| `@Wire Support Bot my support requests` | Lists the open support requests the sender raised in this conversation. |
| `@Wire Support Bot timezone Europe/Berlin` | Sets the conversation's timezone, used for reply times. Without a name the bot shows the current one. |

Status, reply and resolve only work for requests raised in the same conversation. A key from another conversation is treated like an unknown key.

Raising a request and its status show a link to the ticket. By default it opens the agent view (`https://example.atlassian.net/browse/SD-42`); with `WIRE_SUPPORT_BOT_JIRA_LINKS=portal` it opens the request in the service desk's customer portal (`https://example.atlassian.net/servicedesk/customer/portal/<service desk ID>/SD-42`, the link Jira itself gives for the request). Members can only open portal links for requests they can see in the portal; since the bot raises requests as its own Jira account, that needs more setup first (see the configuration table).

### Natural language and offers

A member can also mention the bot and write in their own words: "the printer on the second floor is broken again, can you raise it?", "tell the desk that it works after a restart", "we can close SD-42". The model drafts a proposal, code checks it, and the bot asks a code-written question with the buttons [Yes] and [No] under it. When the message clearly asks to raise, order, reply or resolve something (the same wording checks that an offer needs; a how-to question such as "how do I raise a ticket?" does not count) and the model's answer makes no offer, the bot asks the model once more, telling it that the answer must end with an offer; it uses the second answer only when that carries a valid offer, otherwise the first answer stands. A line of an answer that suggests a bot command that does not exist (for example `@Wire Support Bot support part "filter"`) is not shown; the bot shows a supported command line instead ("To raise it, send `@Wire Support Bot support: <problem>`.", the matching reply or resolve command, or "Mention me with the command if you'd like me to act."). The buttons show the choices, so the question carries no text answer hint. Nothing is sent to the service desk until the member answers, by clicking a button or by writing "yes" or "no".

The rules for an offer:

- Only the member the offer was made to can confirm it, and only with their next message in the conversation. Any other message from them drops the offer; a correction ("the description should mention the third floor") gets a revised offer.
- Only explicit answers count: "yes", "yes please", "go ahead", "do it", "confirm" and similar, or "no", "cancel", "stop" and similar. "ok", "sure" or "thanks" approve nothing; the bot asks again and keeps the offer.
- An offer expires after 10 minutes.
- The buttons follow the same rules: only the member who was asked can answer, and their first click decides. Clicks by other members change nothing; the bot answers the first of them with "Only <name> can answer this." The result is always posted as text as well.
- When a question ends, the bot edits its message: the buttons disappear for everyone and a last line says how it ended, for example "Answered by Alice: Yes" (also for a text answer, with the matching option), "This question has expired.", "This question was replaced by a newer one." or "Closed, as the next message was not an answer.". A click that still arrives on an ended question (a client may not have applied the edit yet) changes nothing and gets no answer.

#### Choosing instead of guessing

Where the bot would otherwise have to guess which request is meant, it asks, with a button per option:

- **New or existing request.** When a problem described in passing may be one the conversation already has (an open request, or one done in the last 7 days, whose summary shares distinctive words with the problem, or which the model names), the bot quotes the problem, lists up to three of those requests (the model's pick first, then the others by how much they share: numbers and identifiers count strongly, words found in most of the conversation's requests weakly, generic words such as "broken", "not working", "issue" or "again" not at all; a request naming another identifier for the same thing, such as truck 13 for a truck 12 problem, is never listed) and offers [Add to SD-38] … [Raise new request] [Cancel]. Without such a request it offers to raise a new one as before.
- **Which request to resolve or add to.** When a passive offer to resolve a request or to add a detail could fit several open requests and the message names no key, the bot lists up to three of them (the model's pick first, then the member's own, then the newest) and [Cancel].
- **Which request a photo or document belongs to** (see below).

Every choice can also be answered by text: with the request key ("SD-41"), "new", "cancel" or "no", or the option's number. "yes" or "ok" pick nothing; the bot asks again. The options come from the conversation's own stored requests and are checked by code; the model never adds one.

A question with buttons shows the choices as buttons and leaves out the text answer hint (such as "(yes or no)?" or "(SD-38, new or cancel)?"). The text answers (yes, no, the request key, new, cancel, the option's number) still work. Clients without composite-message support show the question without the hint, and members can still answer there in text. When the bot asks again in text after an unclear answer, that question names the text answers.
Questions that ask for no change ("what was the VPN request called?") get an answer from the recent conversation and the conversation's support requests. When the bot's latest message among the last three ended with a question, the next message is treated as a follow-up even without a mention.

### First-level help

With the document index on (`WIRE_SUPPORT_BOT_KNOWLEDGE=on`, see "The built-in document index"), a member who mentions the bot with a problem gets an answer from the curated documents, a last line naming the best-matching section ("Source: Dashboard warning lights, Yellow lights > Engine check light"), and under it a short question: "Alice, did this help?" [Solved] [Raise a ticket]. Documents come first: when they match, the bot does not offer a new request right away (an offer the model makes for a problem is replaced by this question, and a question for the service desk is dropped), and suggested bot commands are removed from the answer, since the way to a ticket is [Raise a ticket]. Part orders, replies and resolves are offered as usual. The answer is the answer model's wording of the documents, so its quality depends on that model: a capable hosted model kept to the documents in our checks, while a small local model (4B parameters) at times added steps of its own or contradicted a document, under a source line that names the document. Use a capable model for the answer slot (`WIRE_SUPPORT_BOT_MODEL_RESPOND`) when the documents contain safety instructions, and check answers with your model before you rely on them.

- When it is asked: after an answer to a mention or a follow-up that used at least one excerpt of the document index, when the member's message describes a fault. A how-to question ("how do I reset the engine check light?") and a message that names a request ("any news on SD-42?") never get it. For other messages the bot asks the support triage that passive help uses (one more call to the `classify` model slot, also with passive help off), and only a message it drafts as a fault gets the question, not a question to the service desk, a part order, a status question or small talk. It is not asked while the member has another open question in the conversation.
- [Solved] (or "solved", "yes", "it helped", "thanks") closes the question with "Answered by Alice: Solved", and nothing else happens.
- [Raise a ticket] (or "raise a ticket", "ticket", "no", "still broken") closes it with "Answered by Alice: Raise a ticket" and offers to raise the problem, as the triage drafted it, with [Yes] [No] like any other offer. Nothing reaches the service desk before that yes.
- The usual button rules apply: only the member who asked can answer, and their first click decides. Any other message from them closes the question ("Closed, as the next message was not an answer.") and is handled as usual, and a newer question to them replaces it. It can be answered for `WIRE_SUPPORT_BOT_JIRA_UPDATE_QUESTION_HOURS` (4 hours by default, and also when that setting is `0`), since trying a fix can take a while, and is closed as expired after that.

For example:

```text
Alice: @Wire Support Bot the engine check light is on and truck 12 loses power
Bot:   With the engine check light on and reduced power, stop in a safe place and call the fleet desk. (Dashboard warning lights, Yellow lights > Engine check light)
Bot:   Alice, did this help?  [Solved] [Raise a ticket]
Alice: (clicks [Raise a ticket])
Bot:   Shall I report this to the service desk?
       > **Engine check light on, truck 12 loses power**
       > The engine check light is on and truck 12 loses power.  [Yes] [No]
```

### Passive help

With `WIRE_SUPPORT_BOT_JIRA_PASSIVE=on`, messages that do not mention the bot are classified by the model. When the classifier is confident (0.8 or more) that a message concerns the service desk, the bot may:

- offer to raise a new request from the message;
- offer to add what the message says to an open request of the conversation, as a reply;
- offer to resolve an open request the message says is solved;
- answer a status question about an open request.

Every offer follows the same rules as above. With passive help off, the bot only reacts when it is addressed.

### Part orders

A request is a question, a part order or a fault, and each kind can have its own Jira request type. A part order needs four essentials: the item the part is for (the asset, with a configurable label and question), the part, the quantity and the delivery location. When the first offer (from a mentioned message or from passive help) lacks some, the bot first reads the requester's original message once more with the narrow part-details extraction and adds what it states to the missing essentials, never replacing a value the offer already has; a failed or empty extraction changes nothing. Placeholders such as `<part name>` or "unknown" never count as values. When some are still missing, the bot asks for them one step at a time:

1. The asset and the part, which need free text, first and together, in text ("To order it I need the vehicle (fleet or chassis number) and the part (name or number). What are they?").
2. The quantity, with buttons: "How many shall I order?" [1] [2] [5] [Other].
3. The delivery location, with the configured locations as buttons (`WIRE_SUPPORT_BOT_PART_DELIVERY_LOCATIONS`): "Where shall I deliver it?" [Depot north] [Depot south] [Other]. Without that setting the location is asked in text.
4. The complete order, with [Yes] [No].

A click fills the value as chosen; [Other] asks for the value in text. Text answers work at every step: a number for the quantity ("3"), a location's name, or any free text. A typed answer that is not an option is read for the missing values and merged into the draft in code, which also takes a correction ("actually three") at any step; the bot then asks the next question, quoting the values so far after a change. Only values the requester actually stated count: a quantity must be a number written in the message, so "a new filter" does not become a quantity of one. Values chosen by a click come from the bot's own options and count as stated.

### Photos and documents

With passive help on and an open request in the conversation, a photo or document posted in the conversation gets an offer to attach it to the request the bot most recently wrote about (otherwise the newest open one). When the sender has more than one open request of their own in the conversation, the bot asks which one instead: [SD-40] [SD-41] … (up to three, the likeliest first) [Do not attach]. After a yes, the bot downloads the file from Wire and attaches it to the ticket with a customer-facing reply such as "Photo from Wire, sent by <name>. Sent from Wire.". The bytes are held in memory only.

Supported are JPEG, PNG, HEIC, HEIF and WebP images, and PDF, plain text, CSV, Word (`.docx`) and Excel (`.xlsx`) documents, up to 10 MB. Other types and self-deleting messages are not offered. If the sender still has an unanswered offer, the bot asks them to answer it first and post the file again.

### Desk replies and status changes

With `WIRE_SUPPORT_BOT_JIRA_WATCH_SECONDS` set, the bot checks open requests at that interval. New public replies from the service desk (up to three per update) and status changes are posted in the request's conversation, quoting the bot's last message about that request. Button questions do not count as that message, since they are edited when they close; results such as "Raised …", "Added …" or "Resolved …" do. Replies the bot itself sent from Wire are not announced again.

After posting an update, the bot asks the request's requester what to do next, in a separate short message with buttons:

- After a desk reply: "Alice, would you like to reply to the service desk about **SD-42**, or is it solved so I can close it?" [Reply] [Solved, close it].
- After the desk resolved the request (its status moved to a done status), or after a reply on a resolved request: "Alice, is **SD-42** solved for you, or is it still broken?" [Solved] [Still broken].
- After other status changes the bot asks nothing: it only knows the status category (to do, in progress, done), not status names such as "Waiting for customer".

[Reply] and [Still broken] ask for the text ("What shall I send to the service desk?" or "What is still wrong?"); the requester's next message becomes the text, and the bot offers it as a reply to the request with [Yes] [No], as for any other reply. Nothing reaches Jira before that yes; "no" or "cancel" instead of the text cancels, and a command addressed to the bot (such as `status of SD-42`) still runs as a command. [Solved, close it] resolves the request, like the command `resolve SD-42`: choosing the labeled button is the requester's decision. [Solved] and "no" only close the question. The bot does not reopen a request: Jira workflows differ and the bot has no reopen transition, so after [Still broken] the reply goes to the resolved request and the service desk decides whether to reopen it.

The question goes only to the requester; the usual button rules apply (only they can answer, their first click decides, text answers "reply", "solved", "still broken" or "no" work too). It is never the request's last message, so the next update still quotes the update itself. It can be answered for `WIRE_SUPPORT_BOT_JIRA_UPDATE_QUESTION_HOURS` (4 hours by default), since an update may be read hours later, and is closed as expired after that. It never gets in the way of the requester's other questions: it is not asked while the requester has another open question in the conversation, a newer question to them replaces it (closed with "This question was replaced by a newer one."), a file they post (with passive help on) replaces it, and their next message that is not an answer closes it and is handled as usual. It is asked with passive help on or off: it is the bot's own question about the requester's request, and mentioning the bot with a command keeps working either way.

### Satisfaction rating

With `WIRE_SUPPORT_BOT_JIRA_FEEDBACK=on` (off by default), the bot asks the requester for a rating when they answer [Solved] (or "solved") to the question after a resolve by the service desk, and after every resolve from Wire that reached done: `@Wire Support Bot resolve SD-42` (with or without a comment), a yes to an offer to resolve, or [Solved, close it]. The requester is asked also when another member resolved the request, and once per resolve; a failed resolve, or a request found already resolved, asks nothing: "Alice, how did the service desk do on **SD-42**? 1 is poor, 5 is great." [1] [2] [3] [4] [5]. A click or a typed number sends the rating, without a comment, to the request's satisfaction feedback in Jira Service Management and closes the question with "Answered by Alice: 4"; nothing else is posted. "no" or any other message only ends the question. If Jira refuses or fails the rating (for example feedback is turned off in the project, or the bot's account may not rate), the bot posts "I couldn't send the rating to the service desk." and nothing else changes. The question follows the rules of the questions after a desk update: only the requester can answer, it lives `WIRE_SUPPORT_BOT_JIRA_UPDATE_QUESTION_HOURS`, and it is not asked over another open question of the requester. Ratings need those questions (the watch on and that setting above 0). The bot uses Jira's experimental feedback endpoint (`/rest/servicedeskapi/request/{key}/feedback` with the header `X-ExperimentalApi: opt-in`), which Atlassian may change.

### Direct conversation with the assigned agent

With `WIRE_SUPPORT_BOT_JIRA_AGENTS` mapping Jira account IDs to Wire handles, and the watch on, the bot reacts once per request when a mapped agent is assigned to an open request. What it does depends on `WIRE_SUPPORT_BOT_JIRA_AGENT_CHAT`:

- `ask` (the default): the bot asks the requester in the request's conversation, after the request's other update if there is one: "Alice, the service desk assigned Kim Desk to **SD-42**. Would you like a direct conversation with them?" [Open direct chat] [Not now]. [Open direct chat] (or the text answer "open" or "yes") opens the direct conversation as described below; [Not now] (or "not now", "no") only closes the question. The usual button rules apply: only the requester can answer, their first click decides, and the question is closed with "Answered by <name>: <option>". The bot asks once per request, also when the requester answers [Not now] or does not answer.
- `auto`: the bot opens the direct conversation at once, without asking.
- `off`: neither a question nor a group; the mapping is not used.

Opening the direct conversation: the bot creates a group named after the request with the requester and the agent, posts a short introduction, makes both of them admins and leaves. The original conversation gets a notice that contact with the agent has been initiated. If the group cannot be created after [Open direct chat] (for example the agent's handle no longer resolves), or the request was resolved meanwhile, the bot says so in one short message. The direct conversation is not recorded in the ticket.

The question uses the requester's question slot like the questions after a desk update. It is not asked while the requester has another open question in the conversation: the bot asks again at each watch check until that question is answered or gone, and gives up after the question's lifetime (`WIRE_SUPPORT_BOT_JIRA_UPDATE_QUESTION_HOURS`, 4 hours by default; with that setting at `0` it keeps the default 4 hours). Waiting is held in memory, so after a restart the bot asks at its first check. Once asked, it replaces an open question after a desk update, a later question after a desk update is not asked while it is open, and a question, file or message of the requester replaces or closes it like any other. It expires after the same lifetime.

### Typing indicator

While the bot works on something a member is waiting for (an answer, a command, a confirmed offer), it shows itself as typing. This uses the Wire SDK's `processWithTypingIndicator`; with an SDK version that does not provide it, the bot works the same way without the indicator.

## Concepts

These are the ideas worth keeping if you build your own bot on this code.

### The model drafts, code validates, a person says yes

The model never performs a write and is told never to claim one. In the answer path it may end its answer with one structured offer line. Code parses it and checks the request kind, the bounds (summary 120 characters, offer description 1,000, reply 2,000), that a named request belongs to this conversation and is in the right state, and that the member's own message asked for that change. Only then does the bot send its own question, and the offer is stored after that question has been sent, so it can never be confirmed unseen. The model's wording around an offer is discarded, because it may imply that the change has already happened. When the member confirms, the regular use case runs and checks scope, state and bounds again.

The explicit commands (`support:`, `reply to`, `resolve`) are themselves the member's decision and run without an offer.

### Buttons

Every offer question is a Wire composite message: the question's text plus buttons. A button's ID carries no content, only the offer's random ID and the option's number; a click is matched by the clicked message and checked against the stored offer, so a key or text is never taken from the click itself. Code builds the options from validated data: [Yes] and [No], the candidate requests of a choice (the conversation's own requests, filtered and ranked by code; a request the model names counts only if it is one of them) plus "new", "cancel" or "do not attach", or a part order's quick quantities and configured delivery locations plus "other", or the fixed options of a question after a desk update, about the agent conversation, for a rating or after an answer from the document index ("Did this help?").

The click rules:

- The first accepted click of the member who was asked decides. Only that click gets a confirmation, and Wire clients apply the confirmation to the message for everyone, so all members see the decision.
- Later clicks on the same message, also the same member changing their choice, change nothing and get no confirmation.
- A click by another member changes nothing. Their client still marks their choice locally, so the bot answers once per message in text ("Only <name> can answer this.") and stays silent for repeats.
- When a question ends, its message is edited (a composite edit with a text item only) into the question as sent and a closing line, without buttons, once per message: "Answered by <name>: <option>" when the asked member's click or text answer is accepted (a typed answer shows the matching option, or the typed value of a part order's step), "This question has expired." (noticed on the next access to the member's offers, and by a sweep once a minute so that quiet conversations are closed too), "This question was replaced by a newer one." (a newer question to the same member), and "Closed, as the next message was not an answer.". A failed edit is logged by error name and changes nothing else.
- A click on an answered, closed, expired, replaced or unknown question (for example after a restart, or shortly after an edit from a client that has not applied it yet) changes nothing and gets no answer and no confirmation.
- A click counts as the member's next interaction, like a text answer: it consumes the offer, and the confirmed use case runs with all its checks, as for a text "yes".
- The result is always posted as text as well, so clients that show no buttons or no confirmation show what happened. Text answers keep working everywhere.

### Scoping to the conversation

Support requests are stored with the qualified conversation ID (ID and domain). Status, reply, resolve, attachments and the model's context only see requests of the current conversation. Offers are kept per conversation and member, both qualified. The watch posts each update only to the conversation the request was raised in.

### What is stored and what is sent where

Stored in Postgres:

- Support request records: key, conversation, requester ID and display name, summary, kind, last known status category, and bookkeeping markers for the watch (last seen reply time, the bot's last message about the request, the last seen assignee, the agent group and when it was left). The problem description is not stored; it lives in the ticket.
- An audit log of creates and updates: actor ID, conversation ID, action, entity and the changed fields (for example a status category or a timezone). It holds no message text and no names.
- Per-conversation settings: the timezone.
- With the document index (see "The built-in document index"): each ingested document's path, title, content hash, embedding model and ingest time, and its excerpts with their heading path, text and embedding. They hold what you ingest, and every member who can ask the bot can get answers from them, so ingest only documents meant for those members.

Held in memory only, and lost on restart: the recent messages of each conversation (`MESSAGE_BUFFER_SIZE`), pending offers, the IDs of the bot's button messages with who was asked and the question as sent (so the message can be closed), the member cache, and with the document index on, its excerpts and embeddings (loaded from Postgres).

Logs are structured JSON lines, on stdout for the bot and on stderr for the CLI. Fields named `text`, `preview`, `raw`, `context`, `prompt`, `response` and `stack` (content) and `name`, `senderName`, `requesterName`, `displayName`, `handle`, `agentHandle`, `email` and `fileName` (personal data) are removed, and the use cases log error names and ticket keys rather than content. Log lines carry conversation, user and message IDs for correlation, but no names. The document index logs the model, counts and error names, never a question or document text. At the default level `info` the bot logs start-up, connection changes, watchdog actions, warnings and errors; per-message lines (`Message handled` with the message kind, the route it took and its duration in milliseconds, and the passive-help classifier result) are at `debug`.

The Wire SDK's own log calls are recorded as "Wire SDK diagnostic" at their severity (`WIRE_SUPPORT_BOT_SDK_LOG_LEVEL`, default `warn`). By default (`WIRE_SUPPORT_BOT_SDK_LOG_CONTENT=messages`) the line carries the SDK's message text as `sdkMessage` (control characters removed, at most 500 characters), but none of its other arguments. The SDK writes that text itself; it can contain conversation, user, message and team IDs, request paths and error messages from the Wire backend, but no message content. The name of a conversation the bot creates (an agent group is named after the request) is replaced by `[redacted]`. For warnings and errors the line also adds the error's class name (`errorName`) and an HTTP `status`, error `code` or backend `label` when the error carries one as a number or a short identifier; a warning or error without an error object adds the class name of its first object argument (`objectType`, never a plain object) and that object's `type` when it is a short identifier (`eventType`).

Two other modes:

- `none` leaves out the message text, so the lines carry only the fields above. A dropped WebSocket connection then shows as an error with `objectType` "ErrorEvent" and `eventType` "error", followed by a warning without fields.
- `full` also adds the SDK's other arguments as `sdkArgs` (about 4 KB at most per line, errors with their message and stack). These can contain decrypted messages, events and HTTP request and response bodies, so the logs then hold message content and possibly tokens. The bot logs a warning at start-up; use it only for short troubleshooting and switch back to `messages`.

Metrics (see "Metrics"), when turned on, are counts, durations and a few current values, labeled only from small fixed sets such as the message kind, the model slot, the Jira operation and an outcome, and for token counts the configured model names. They carry no message text, no ticket content and no conversation, user, message or ticket IDs, and nothing that tells conversations or people apart.

Sent to the model endpoint:

- for an answer: the member's message, up to nine earlier messages with the senders' display names, the conversation's member names and IDs, the requester, the conversation's stored support request records, and with the document index on, the matching excerpts with their sources;
- with the document index on, after an answer that used an excerpt and made no offer: the member's message once more, to the support triage, to decide whether it describes a fault (see "First-level help");
- for passive help: the message, recent messages from members, and the key and summary of open requests;
- ticket content (live status, SLAs and up to three recent desk replies per ticket) only when `WIRE_SUPPORT_BOT_JIRA_SHARE_WITH_MODEL=on`.

Sent to the embeddings endpoint, only with the document index: the member's message for each answer (`WIRE_SUPPORT_BOT_KNOWLEDGE=on`); during an ingestion, the text of every new or changed excerpt with its document's title and heading path; at start-up a fixed check text. By default the embeddings endpoint is the model endpoint.

With the default local endpoint nothing leaves the host. With a remote provider, all of the above goes to that provider.

Sent to Jira: only what a member wrote in a command or confirmed in an offer, plus the requester's display name ("Requested by <name> via Wire."), and with ratings on, the rating the requester picked. New tickets carry the label `wire-support-bot`, and replies, closing comments and attachments carry the footer "Sent from Wire.". Internal notes are never read or written.

### The watch

The watch polls rather than receiving webhooks, so the bot needs no inbound connection. Each check asks Jira which watched requests changed since the previous check (with a two-minute overlap, since Jira's search is eventually consistent) and examines only those. Watched requests are the open ones plus those resolved in the last 24 hours, to catch a reopen. A request the bot raises starts with its markers set at creation: replies and the assignee count as seen up to that moment, and the status is stored as "to do". So a desk reply, an assignment to a mapped agent or a status change after creation is acted on at the next check, even if that is the first check that sees the request. Only a request stored without these markers (no reply marker, or no assignee marker) gets a baseline when it is first examined: without a reply marker the bot records its replies and status and announces nothing, and without an assignee marker it records the assignee without opening or offering a direct conversation, so old activity is never posted. The markers only move forward and are stored, so an update is not repeated after a restart. A request being resolved from Wire at that moment is skipped, so the bot never announces its own resolve as the desk's. A request whose update keeps failing is given up after 10 attempts.

### The agent group

The bot stores the group's ID with the request right after creating it, before the introduction and the admin changes. It then tries to leave at once and again after 2, 5 and 10 seconds; a confirmed leave is stored. A group not yet left is retried once after start-up and before every watch check, also when the agent mapping has since been removed. Until the bot has left a group it ignores every message and event from it, also after a restart, since the pending groups are read before the bot starts listening.

One gap remains: if the process stops between creating the group and storing its ID, or storing the ID fails, the bot does not know the group after a restart and stays a member of it.

### What the bot does not do

- It does not store or summarize the conversation, and does not search past conversations.
- It does not read or write internal notes, and does not change assignees, priorities or other fields.
- It does not act on edited messages, and buttons only answer the bot's own offer questions.
- It does not raise anything from an unaddressed message without an explicit yes.
- It does not watch requests raised from the CLI.
- It does not reopen requests; after [Still broken] the service desk decides.

## Architecture

The code follows a hexagonal (ports and adapters) layout:

- `src/domain/`: entities, identifiers and repository contracts. It depends on nothing else in the project.
- `src/application/`: use cases (`usecases/`), shared application services (`services/`) and ports (`ports/`), the interfaces the use cases need from the outside world. It depends on the domain and its own ports only, never on Wire, Prisma or HTTP clients.
- `src/infrastructure/`: adapters that implement the ports and repositories: Wire (`wire/`), Jira (`jira/`), the model and embeddings endpoints (`llm/`), Postgres through Prisma (`persistence/postgres/`), the document index (`knowledge/`), the in-memory queue, offer store and member cache, the passive-help pipeline (`pipeline/`), and Prometheus metrics with the metrics and health endpoint (`metrics/`).
- `src/app/`: configuration (`config.ts`), logging, the entry point (`main.ts`), the CLI (`cli.ts`), the knowledge ingestion command (`knowledgeIngest.ts`) and the composition root `src/app/container.ts`, which builds every adapter and use case and wires them together.

### Main modules

| Module | Role |
|---|---|
| `src/infrastructure/wire/WireEventRouter.ts` | Receives Wire events and decides what each message is: an offer answer, a command, a question or passive-help input. |
| `src/application/usecases/general/AnswerQuestion.ts` | The answer path: builds the model's context, parses and validates an offer, sends the answer or the question. |
| `src/application/services/offers.ts` | Offer marker parsing, bounds and the code-written questions. |
| `src/application/services/botCommandLines.ts` | Replaces answer lines that suggest a bot command that does not exist, or one for a request key that the member did not name and that is not a request of the conversation, with a supported command line; removes suggested commands from answers that come from the document index. |
| `src/application/services/offerButtons.ts` | Offer buttons and choices: button IDs, options, text answers to a choice. |
| `src/application/services/deskUpdateQuestions.ts` | The requester's question after a desk reply or resolve: texts, options, lifetime, and not asking over another open question. |
| `src/application/services/feedbackQuestions.ts`, `src/application/usecases/jira/SubmitFeedback.ts` | The satisfaction rating after [Solved] or a resolve from Wire, and sending it to Jira. |
| `src/application/services/offerPromptClosing.ts` | Closes ended button questions: the closing lines, one edit per message, the expiry sweep. |
| `src/application/services/similarRequests.ts` | Ranks the conversation's requests that may describe the same problem as a new one. |
| `src/application/services/partOrderSteps.ts` | A part order's questions, one step at a time: free-text essentials, quantity and delivery location buttons, the complete order. |
| `src/application/usecases/jira/ConfirmOffer.ts` | Classifies a yes, no or choice, by text or button, and runs the confirmed use case. |
| `src/application/usecases/jira/RaiseSupportRequest.ts`, `ReplyToServiceDesk.ts`, `ResolveSupportRequest.ts`, `GetIssueStatus.ts`, `ListSupportRequests.ts` | The support request use cases, scoped to the conversation; writes are audited. |
| `src/application/usecases/jira/OfferSupportFromConversation.ts` | Passive help: raise, add, resolve or status from an unaddressed message. |
| `src/application/usecases/jira/CompletePartOrder.ts` | Fills a part order's missing essentials from the requester's next message. |
| `src/application/usecases/jira/OfferAttachment.ts`, `AttachFileToRequest.ts` | Photos and documents to a request. |
| `src/application/usecases/jira/WatchSupportRequests.ts` | The watch. |
| `src/application/usecases/jira/OpenAgentConversation.ts`, `AskForAgentConversation.ts`, `LeavePendingAgentGroups.ts` | The direct conversation with the agent, the question that offers it, and leaving it. |
| `src/infrastructure/pipeline/ProcessingPipeline.ts` | Classifies an unaddressed message and hands service-desk matters to passive help. |
| `src/infrastructure/jira/JiraServiceManagementAdapter.ts` | `IssueTrackerPort` for Jira Service Management. |
| `src/infrastructure/llm/` | Model adapters for answers, classification and triage, the shared OpenAI-compatible client, and the embeddings adapter. |
| `src/app/knowledgeIngest.ts`, `src/application/usecases/knowledge/IngestKnowledge.ts`, `src/application/services/knowledgeChunks.ts` | The knowledge ingestion command, the ingestion (add, skip, replace, remove) and the splitting of documents into excerpts. |
| `src/infrastructure/knowledge/InMemoryKnowledgeIndex.ts`, `src/infrastructure/persistence/postgres/PrismaKnowledgeRepository.ts` | The document index: the in-memory search behind `RetrievalPort`, and the documents and excerpts in Postgres. |
| `src/application/ports/MetricsPort.ts`, `src/infrastructure/metrics/` | The metrics port with its fixed label sets, the prom-client adapter, and the HTTP server for `/metrics` and `/healthz`. |
| `prisma/schema.prisma` | The database schema; migrations are in `prisma/migrations/`. |

### How a message flows

1. The router handles messages one at a time per conversation, resolves the sender's display name and ignores agent groups the bot has not yet left.
2. If the sender has a pending offer, the message is checked as an answer: a yes, a no or a choice is handled by `ConfirmOffer`; for a part-order draft, `CompletePartOrder` tries to fill the missing essentials; otherwise the offer is dropped.
3. A message that bundles several commands is rejected. A `timezone` command is handled next.
4. The message is added to the conversation's in-memory buffer.
5. If the bot is addressed, the commands are matched in order: `support:`, `resolve` or `close`, `reply to`, `support requests`, then a status request.
6. A message that mentions the bot, follows a question from the bot, or corrects the sender's dropped offer goes to the answer path (`AnswerQuestion`).
7. Anything else goes to the passive-help queue when passive help is on: `ProcessingPipeline` classifies it and, for a service-desk category, calls `OfferSupportFromConversation`. The queue keeps each conversation's messages in order and cancels queued work when a conversation is deleted.

Files take a shorter path: the router checks the type, size and self-deleting flag and hands the file to `OfferAttachment`. Button clicks run in the same order as the conversation's messages: the router matches the click to the offer of the clicked message and its requester (see "Buttons") and hands an accepted click to `ConfirmOffer`.

## Extending

### Adding a knowledge source

The answer path has a seam for knowledge: `RetrievalPort` in `src/application/ports/RetrievalPort.ts`.

```ts
interface RetrievalPort {
  retrieve(query: RetrievalQuery): Promise<RetrievalResult[]>;
}
```

The query holds the member's question, the qualified conversation ID and, when known, the requester's ID. A knowledge source returns results of kind `knowledge_article`, each with an `id`, the excerpt as `content`, a `source` for the citation (a title or a link) and a `sourceDate`. `AnswerQuestion` calls the source first, adds the conversation's own support requests and context, and passes everything to the answer model; a failing source is logged and the bot answers without it. The answer adapter puts `knowledge_article` results in a "Knowledge articles" section of the prompt, and the prompt tells the model to cite an article by its source and to say nothing the article does not state.

The seam covers the answer path, which needs a mention. Suggesting knowledge for unaddressed messages would be a change to passive help.

#### The built-in document index

With `WIRE_SUPPORT_BOT_KNOWLEDGE=on` the bot answers from curated documents (manuals, troubleshooting guides, FAQs) in Markdown or plain text. A member who mentions the bot with a problem or a question gets an answer that uses the matching excerpts and names their source, for example "Dashboard warning lights, Yellow lights > Engine check light". For a problem, the bot then asks "Did this help?" with [Solved] and [Raise a ticket] (see "First-level help"); [Raise a ticket], or asking the bot to raise a ticket at any time, leads to the usual offer: the bot proposes, a person decides.

- Ingestion: `npm run knowledge:ingest -- <directory>` reads every `.md`, `.markdown` and `.txt` file in the directory and its subdirectories (names starting with a dot are skipped). A document's title is its first `# ` heading, else the file name. Each section under a heading becomes an excerpt (a chunk) with its heading path below the title; a section longer than about 3,000 characters (about 750 tokens) is split at paragraphs, lines, sentences or spaces, never inside a word, and each further part starts with the end of the one before. Every chunk is embedded together with its title and heading path, and stored in Postgres with its embedding.
- The directory is the full set: a run adds new documents, skips unchanged ones (same content hash and embedding model), replaces changed ones and removes the documents that are no longer in the directory. A directory without documents is refused, so a wrong path cannot empty the index. The command prints a summary such as `4 added, 0 updated, 0 unchanged, 0 removed; 30 chunks (30 embedded)` and no document content, and exits with code 1 on an error; a failed run keeps the documents stored so far, and the next run continues. It uses the bot's settings and `.env`, needs the database and the embeddings endpoint (not Wire or Jira), and also runs while `WIRE_SUPPORT_BOT_KNOWLEDGE` is off, so you can fill the index before you turn it on.
- Search: at start-up the bot loads every chunk embedded with `WIRE_SUPPORT_BOT_EMBED_MODEL` into memory and logs one line with the model, the number of documents and chunks and the dimension. For each question addressed to the bot it embeds the question, ranks the chunks by cosine similarity, and passes up to `WIRE_SUPPORT_BOT_KNOWLEDGE_RESULTS` of them with a similarity of at least `WIRE_SUPPORT_BOT_KNOWLEDGE_MIN_SCORE` to the answer model as knowledge articles. The search is exact and needs no database extension; it suits curated sets of up to a few thousand chunks. The bot checks for a new ingestion at most once a minute, on the next question, and reloads without a restart.
- Failures: when the embeddings endpoint cannot be reached, at start-up or for a question, the bot logs a warning and answers without knowledge. Chunks embedded with another model are skipped with a warning that asks for a new ingestion; changing the model means running the ingestion again, which embeds every document anew.

The embeddings endpoint is OpenAI-compatible (`/embeddings` is appended to `WIRE_SUPPORT_BOT_EMBED_BASE_URL`), and it and `WIRE_SUPPORT_BOT_EMBED_MODEL` must be set with knowledge on: they never follow the model endpoint, since a chat provider may offer no embeddings (Anthropic, for example, offers none and recommends Voyage AI, whose `https://api.voyageai.com/v1` with `voyage-4` works here). For a local setup, use Ollama: `http://localhost:11434/v1` with `qwen3-embedding:0.6b` (`ollama pull qwen3-embedding:0.6b`). Excerpts and questions go to that endpoint (see "What is stored and what is sent where"). `examples/knowledge/` holds four invented documents for a truck fleet to try it with.

Locally, with the bot's `.env`:

```bash
npm run build
npm run knowledge:ingest -- examples/knowledge
```

With Docker Compose, run the ingestion in a one-off container of the bot's image with the directory mounted, after the bot has started once (its entry point applies the migrations). The entry point would start the bot, so `--entrypoint node` replaces it:

```bash
docker compose run --rm --entrypoint node -v "$PWD/examples/knowledge:/knowledge:ro" wire-support-bot dist/app/knowledgeIngest.js /knowledge
```

The container needs to reach the embeddings endpoint: for an Ollama on the host, set `WIRE_SUPPORT_BOT_EMBED_BASE_URL=http://host.docker.internal:11434/v1` in `.env` (on Linux also add `extra_hosts: ["host.docker.internal:host-gateway"]` to the service), or use the Ollama service of the Compose file.

On Kubernetes, put the documents in a ConfigMap (or another volume), mount it into the pod with `extraVolumes` and `extraVolumeMounts`, and run the ingestion in the running pod, where it uses the pod's settings:

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

A ConfigMap holds at most 1 MiB, and `--from-file` with a directory takes only the files directly in it; for a larger set use a volume of your own. Kubernetes updates the files of a mounted ConfigMap a minute or so after the ConfigMap changes; run the ingestion again after that.

#### Another source

To add a source, implement `RetrievalPort` in an adapter under `src/infrastructure/` and pass an instance as the fourth argument of `new AnswerQuestion(...)` in `src/app/container.ts` (and in `src/app/cli.ts` if you want it in the CLI), where the document index is passed today (`undefined` when it is off). Add unit tests with a mocked port, following `tests/usecases/AnswerQuestion.test.ts`. An example is the service desk's own knowledge base, searched through its REST API: this needs no storage of your own, and the knowledge stays in the service desk. A vector database such as pgvector could replace the in-memory search behind the same port when the document set outgrows it.

### Another tracker

The use cases talk to the service desk only through `IssueTrackerPort` in `src/application/ports/IssueTrackerPort.ts`: create an issue, read it, resolve it by status category, list and add customer-facing replies, list changed issues and add an attachment. To use another tracker, implement that port in a new adapter and construct it instead of `JiraServiceManagementAdapter` in `src/app/container.ts` and `src/app/cli.ts`. Keep the port's guarantees: status categories rather than localized status names, no internal notes, and error messages without response bodies or credentials. The configuration (`JiraConfig` in `src/app/config.ts`) and ticket keys (`src/domain/ids/jiraLink.ts`, keys such as `SD-42`) are Jira-shaped today, so a tracker with a different key format needs changes there too.

## Setup

### Requirements

- Node.js 22.12 or newer (`engines` in `package.json`; the Docker image uses Node 22 on Debian trixie). The Wire SDK uses a native crypto library that needs glibc 2.38 or newer on Linux x86-64; the provided Dockerfile meets this.
- PostgreSQL (the Compose file uses Postgres 16; on Kubernetes an external one, see "Kubernetes (Helm)").
- An OpenAI-compatible chat-completions endpoint, for example a local Ollama (`http://localhost:11434/v1`) with a model such as `qwen3-next:80b`, or a hosted provider. For the optional document index, also an embeddings endpoint (the same Ollama with `qwen3-embedding:0.6b`, for example).
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

`npm start` runs `dist/app/main.js`, which reads `.env`. `npm run dev` runs the TypeScript source with ts-node. The Wire SDK keeps its local database and crypto keystore under `./storage` in the working directory: keep that directory and `WIRE_SDK_CRYPTO_KEY` together; the key encrypts the store, so if the key is lost or changed, delete the store too. Without the store the bot starts as a new device of the app, logs in with `WIRE_SDK_API_TOKEN` and rejoins its conversations, but it cannot read messages sent while it had no store, and members may see a new device.

### Docker Compose

`docker-compose.yml` builds the bot's image from this repository's `Dockerfile` (`build: .`) and runs it with a Postgres 16 database. Before the first start, create `.env` from `.env.example`. After changing the code, rebuild with `docker compose up -d --build`.

```bash
docker compose up -d --build
```

The container's entry point applies the migrations (`prisma migrate deploy`) and starts the bot. Compose overrides `DATABASE_URL` to point at its own database, binds Postgres to `127.0.0.1` only, and keeps the Wire SDK store in a named volume mounted at `/app/storage`. An Ollama service is included as a commented-out block; to use it, uncomment it and set `WIRE_SUPPORT_BOT_LLM_BASE_URL=http://ollama:11434/v1`.

### Kubernetes (Helm)

The chart in `charts/wire-support-bot/` runs the bot as one pod with a persistent volume for the Wire SDK store. It needs Helm 3 or newer and an external Postgres: the chart contains no database, so use a managed Postgres or an operator such as CloudNativePG and name the Secret that holds its connection URL or credentials (see "Database connection" below). The bot has no inbound traffic (it connects out to the Wire backend, Jira and the model endpoint), so the chart has no Ingress, and a Service only for scraping metrics when `metrics.enabled` is set (see "Metrics"). Point `config.llmBaseUrl` at a model endpoint the pod can reach; the default `http://localhost:11434/v1` is the pod itself.

Keep the Wire and Jira credentials in a Secret of your own and name it in `existingSecret`. It holds `WIRE_SDK_API_TOKEN`, `WIRE_SDK_CRYPTO_KEY` and `WIRE_SUPPORT_BOT_JIRA_API_TOKEN`, and optionally `WIRE_SUPPORT_BOT_LLM_API_KEY`, `WIRE_SUPPORT_BOT_EMBED_API_KEY` and `WIRE_SUPPORT_BOT_JIRA_EMAIL`. Without `existingSecret`, the chart creates the Secret from `secrets.*` in your values. The database credentials come from `database.*` (see "Database connection" below); this example keeps the database password in a Secret of its own.

```bash
kubectl create namespace support-bot
kubectl create secret generic wire-support-bot-credentials --namespace support-bot \
  --from-literal=WIRE_SDK_API_TOKEN=... \
  --from-literal=WIRE_SDK_CRYPTO_KEY=... \
  --from-literal=WIRE_SUPPORT_BOT_JIRA_API_TOKEN=...
kubectl create secret generic wire-support-bot-database --namespace support-bot \
  --from-literal=password=...
helm install wire-support-bot ./charts/wire-support-bot --namespace support-bot \
  --set existingSecret=wire-support-bot-credentials -f my-values.yaml
kubectl logs --namespace support-bot deployment/wire-support-bot --follow
```

`my-values.yaml` sets the database connection under `database:` and the non-secret settings under `config:`, for example:

```yaml
database:
  secretName: wire-support-bot-database
  host: { value: postgres.example.com }
  name: { value: wire_support_bot }
  user: { value: wirebot }
  password: { secretKey: password }
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

Every setting in "Configuration" has a value under `config:` (or under `secrets:` for credentials, and under `database:` for the database); `values.yaml` lists them with their defaults and comments, and `values.schema.json` rejects unknown keys and invalid values. Quote `on` and `off`, because YAML reads a bare `on` as true. An empty value leaves the setting unset, so the bot's own default applies. A change to the values restarts the pod on `helm upgrade`.

#### Logs

The bot writes one JSON object per line to stdout; only Prisma's migration output at start-up is plain text, and a missing or invalid database setting is reported as one JSON line on stderr before the container stops. Each line has `severity` (`DEBUG`, `INFO`, `WARNING`, `ERROR`), which Google Cloud Logging reads, and `level`, which Loki, Datadog and most other tools read. For Elastic, set `config.logFormat: ecs` for Elastic Common Schema fields (`@timestamp`, `log.level`, `message`, `ecs.version`) instead of `level`, `msg` and `time`. Collectors such as Fluent Bit, Vector, Grafana Alloy or the OpenTelemetry Collector need no parser setup beyond JSON. `config.sdkLogLevel` and `config.sdkLogContent` control the Wire SDK's own lines (see "What is stored and what is sent where").

#### Metrics

Set `metrics.enabled: true` for Prometheus metrics, a ClusterIP Service on `metrics.port` (default 9464) and a liveness probe on `/healthz`. With the Prometheus Operator, also set `metrics.serviceMonitor.enabled: true` (and `metrics.serviceMonitor.labels` to the labels your Prometheus selects ServiceMonitors by; kube-prometheus-stack by default selects `release: <its Helm release name>`); for a Prometheus that discovers pods by annotations, set `metrics.podAnnotations: true`. See "Metrics" for the metrics themselves.

```yaml
metrics:
  enabled: true
  serviceMonitor:
    enabled: true
    labels: { release: prometheus }
```

#### Database connection

The chart reads the database connection from Secrets, in one of two modes:

- A complete URL: `database.url.secretName` names a Secret and `database.url.secretKey` (default `uri`) its key with the URL.
- The parts: `database.secretName` names a Secret that holds the password (`database.password.secretKey`, default `password`). Each of `database.host`, `database.port`, `database.name` and `database.user` is either a plain `value` or, when its `secretKey` is set, a key of that Secret. The password is never a plain value.

`database.options` is appended to the URL in both modes as query parameters, for example `sslmode=require`. The container's entry point builds the URL from the parts before it runs the migrations; it encodes special characters in the user, password and database name. Examples for the Secrets that common operators create (`postgres` is the cluster's name):

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

# A Secret of your own with only the password:
database:
  secretName: wire-support-bot-database
  host: { value: postgres.example.com }
  name: { value: wire_support_bot }
  user: { value: wirebot }
  password: { secretKey: password }
```

For a database that needs a CA certificate, mount it with `extraVolumes` and `extraVolumeMounts` and name the file in `database.options`:

```yaml
database:
  options: sslmode=require&sslcert=/etc/postgres-ca/ca.crt
extraVolumes:
  - name: postgres-ca
    secret: { secretName: postgres-ca }
extraVolumeMounts:
  - { name: postgres-ca, mountPath: /etc/postgres-ca, readOnly: true }
```

For Cloud SQL, run the Cloud SQL Auth Proxy as a sidecar with `extraContainers` and connect to it on `127.0.0.1`. The proxy encrypts the connection; the pod's service account needs the Cloud SQL Client role, for example through Workload Identity. If the bot starts before the proxy listens, the migrations fail and Kubernetes restarts the bot's container.

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

- A Secret reference reads Secrets in the bot's own namespace only. When the operator creates its Secret in another namespace, copy it into the bot's namespace, for example with External Secrets or reflector.
- IAM login without a password (RDS IAM authentication, Cloud SQL IAM authentication without the proxy) is not supported: Prisma does not refresh the short-lived tokens.

How the chart runs the bot:

- Exactly one replica, replaced with the `Recreate` strategy, so an upgrade stops the old pod before the new one starts. Two instances must never use the same Wire app and store; do not run the bot elsewhere (Docker Compose, a local process) with the same app while the release is installed.
- The entry point applies the migrations and starts the bot, as with Docker Compose.
- The SDK store is a `ReadWriteOnce` claim mounted at `/app/storage` (`persistence.size`, default 1Gi; `persistence.storageClass`; or `persistence.existingClaim`). `helm uninstall` keeps the claim. Without the store the bot starts as a new device of the app, logs in with `WIRE_SDK_API_TOKEN` and rejoins its conversations, but it cannot read messages sent while it had no store, and members may see a new device. If `WIRE_SDK_CRYPTO_KEY` is lost or changed, delete the claim's contents too.
- The pod runs as user and group 1000 (the `node` user of the base image) with `fsGroup` 1000, no privilege escalation and no capabilities, and does not mount a service account token.
- A failed start exits the process, and Kubernetes restarts the pod. With `metrics.enabled` the pod also has a liveness probe on `/healthz`, which only checks that the process answers (see "Metrics"); there is no readiness probe, since nothing routes traffic to the pod.

### Container image

The workflow `.github/workflows/image.yml` builds the image from the `Dockerfile`, for `linux/amd64` only (the Wire SDK's native crypto library is built for x86-64). Only a version tag publishes it to `quay.io/wire/wire-support-bot`: a tag `v1.2.3` publishes `1.2.3`, `1.2` and `latest` (no `latest` for a pre-release such as `v1.2.3-rc.1`). Pushes to `main`, pull requests and manual runs test and build the image without publishing it. The chart uses the tag of its `appVersion` unless `image.tag` is set. The workflow needs the repository secrets `QUAY_USERNAME` and `QUAY_PASSWORD` of a quay.io robot account with write access.

To use your own registry, build and push the image yourself and set `image.repository` (and `imagePullSecrets` for a private registry):

```bash
docker build --platform linux/amd64 -t registry.example.com/wire-support-bot:1.0.0 .
docker push registry.example.com/wire-support-bot:1.0.0
```

### The CLI for local testing

The CLI drives the real router and use cases from the terminal, without Wire. It simulates one conversation with four members, Alice (the default), Bob, Carol and Dave; prefix a line with `Bob: ` to send it as Bob. Start a line with `@Wire Support Bot` to mention the bot. Bot replies go to stdout and logs to stderr (level `warn` unless `LOG_LEVEL` is set). A question with buttons is printed with its options numbered under it; a line with only an option's number (`2`, or `Bob: 2`) clicks that option of the latest question, and any other line is a text answer. When the buttons are numbers themselves (the quantities [1] [2] [5]), a number clicks only the button with that label and any other number (`3`) is a typed quantity. The CLI shows no confirmation; a closed question is shown by its closing line, for example "(Question closed: Answered by Alice: No)", and a number no longer clicks it. End with `exit`, `quit` or Ctrl-D.

```bash
npm run build
npm run cli
printf "@Wire Support Bot support requests\n" | npm run cli
```

Like `npm start`, the CLI reads `.env` from the working directory; settings already in the environment take precedence. The CLI needs the full configuration (including the `WIRE_SDK_*` settings, although it does not connect to Wire), the database and the model endpoint. It has no watch, no files and no agent groups; with `WIRE_SUPPORT_BOT_KNOWLEDGE=on` its answers use the document index like the bot's.

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
| `WIRE_SUPPORT_BOT_WIRE_WATCHDOG_MINUTES` | no | `5` | Minutes without a Wire connection, from start-up or from a lost connection, before the bot restarts the connection; after as many minutes again without a connection it exits with code 1, so Docker Compose or Kubernetes starts it again. `0` turns the watchdog off; otherwise a whole number from 2 to 60 (shorter would exit while the SDK still reconnects normally: it notices a drop after about a minute and waits up to 30 seconds between attempts). See "Limitations and notes". |
| `WIRE_ADMIN_EMAIL` | no | | Only for `scripts/register-app.mjs`: the team admin's e-mail. |
| `WIRE_ADMIN_PASSWORD` | no | prompted | Only for `scripts/register-app.mjs`: the admin's password. |

### Database

| Setting | Required | Default | Meaning |
|---|---|---|---|
| `DATABASE_URL` | yes | | Postgres connection URL. Docker Compose overrides it; the Helm chart reads it from a Secret or builds it from the settings below. |
| `DATABASE_HOST` | no | | Alternative to `DATABASE_URL`, used only by the container's entry point and only when `DATABASE_URL` is unset: the Postgres host. Required in that case, like `DATABASE_NAME`, `DATABASE_USER` and `DATABASE_PASSWORD`. |
| `DATABASE_PORT` | no | 5432 | The Postgres port for the alternative. |
| `DATABASE_NAME` | no | | The database name for the alternative. |
| `DATABASE_USER` | no | | The user for the alternative. |
| `DATABASE_PASSWORD` | no | | The password for the alternative. The entry point encodes special characters in the user, password and database name. |
| `DATABASE_OPTIONS` | no | | Used only by the container's entry point: query parameters appended to the URL (from `DATABASE_URL` or built), for example `sslmode=require`. |

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

### Document index

| Setting | Required | Default | Meaning |
|---|---|---|---|
| `WIRE_SUPPORT_BOT_KNOWLEDGE` | no | `off` | `on` lets answers use the ingested documents (see "The built-in document index") and asks "Did this help?" after an answer to a problem (see "First-level help"). Off, the bot makes no embedding call. |
| `WIRE_SUPPORT_BOT_EMBED_BASE_URL` | with knowledge on | | OpenAI-compatible endpoint for embeddings (http or https); `/embeddings` is appended, for example `http://localhost:11434/v1` (Ollama) or `https://api.voyageai.com/v1`. It never falls back to the model endpoint, whose provider may offer no embeddings. Questions and document excerpts are sent to it. |
| `WIRE_SUPPORT_BOT_EMBED_API_KEY` | no | none | Sent as a Bearer token to the embeddings endpoint; never the model endpoint's key. |
| `WIRE_SUPPORT_BOT_EMBED_MODEL` | with knowledge on | | Embedding model, for example `qwen3-embedding:0.6b` (Ollama) or `voyage-4`, for the ingestion and the search alike; after a change, run the ingestion again. |
| `WIRE_SUPPORT_BOT_KNOWLEDGE_RESULTS` | no | `4` | Most excerpts passed to the answer model per question; a whole number from 1 to 10. |
| `WIRE_SUPPORT_BOT_KNOWLEDGE_MIN_SCORE` | no | `0.5` | Lowest cosine similarity of an excerpt passed to the answer model, from 0 to 1. Raise it when unrelated excerpts show up, lower it when matching ones are missed; good values depend on the model. |

The embeddings requests use `WIRE_SUPPORT_BOT_LLM_TIMEOUT_MS`. The settings are checked at start-up also while the index is off.

### Jira

| Setting | Required | Default | Meaning |
|---|---|---|---|
| `WIRE_SUPPORT_BOT_JIRA_BASE_URL` | yes | | REST base URL (https); for a scoped token `https://api.atlassian.com/ex/jira/<cloud id>`. |
| `WIRE_SUPPORT_BOT_JIRA_SITE_URL` | yes | | Site URL for ticket links (https), for example `https://your-site.atlassian.net`. |
| `WIRE_SUPPORT_BOT_JIRA_LINKS` | no | `agent` | Where ticket links point: `agent` to the agent view (`<site>/browse/SD-42`), `portal` to the request in the service desk's customer portal. Keep `agent` for now: the bot raises requests as its own Jira account, so members cannot see them in the portal yet. |
| `WIRE_SUPPORT_BOT_JIRA_API_TOKEN` | yes | | Scoped token (Bearer), or classic token together with the e-mail (Basic). |
| `WIRE_SUPPORT_BOT_JIRA_EMAIL` | no | | Account e-mail for a classic token; leave unset for a scoped token. |
| `WIRE_SUPPORT_BOT_JIRA_PROJECT_KEY` | yes | | Project key, for example `SD`. Only keys of this project are accepted. |
| `WIRE_SUPPORT_BOT_JIRA_SERVICE_DESK_ID` | yes | | Numeric service desk ID. |
| `WIRE_SUPPORT_BOT_JIRA_REQUEST_TYPES` | yes | | Request type ID per kind, for example `question=10001,part=10002,fault=10003`. `fault` is required and used for any kind without its own entry. |
| `WIRE_SUPPORT_BOT_JIRA_TIMEOUT_MS` | no | `15000` | Timeout per Jira call in milliseconds; a positive whole number, raised to 1000 if lower. |
| `WIRE_SUPPORT_BOT_JIRA_SHARE_WITH_MODEL` | no | `off` | `on` lets live ticket status, SLAs and desk replies reach the answer model. |
| `WIRE_SUPPORT_BOT_JIRA_SERVICE_SCOPE` | no | generic wording | What the service desk handles, in plain words, for the model prompts; at most 500 characters. |
| `WIRE_SUPPORT_BOT_JIRA_AGENTS` | no | | Desk agents who get a direct conversation with the requester when assigned: `<jira account id>=<wire handle>`, comma-separated. Needs the watch. |
| `WIRE_SUPPORT_BOT_JIRA_AGENT_CHAT` | no | `ask` | What a newly assigned mapped agent gets: `ask` asks the requester first ([Open direct chat] [Not now]), `auto` opens the direct conversation at once, `off` neither. |

### Part orders

| Setting | Required | Default | Meaning |
|---|---|---|---|
| `WIRE_SUPPORT_BOT_PART_ASSET_LABEL` | no | `Asset` | Label of the item a part is for, shown in confirmations and tickets; one line, at most 40 characters. |
| `WIRE_SUPPORT_BOT_PART_ASSET_QUESTION` | no | `the item the part is for (for example a machine, vehicle or device)` | How the bot asks for it, completing "To order it I need ..."; one line, at most 200 characters. |
| `WIRE_SUPPORT_BOT_PART_DELIVERY_LOCATIONS` | no | unset (asked in text) | Delivery locations offered as buttons, with [Other] added: up to 5, separated by `;`, each one line of at most 40 characters; empty entries, repeats and "Other" fail at start-up. |

### Passive help and watch

| Setting | Required | Default | Meaning |
|---|---|---|---|
| `WIRE_SUPPORT_BOT_JIRA_PASSIVE` | no | `off` | `on` lets the bot read unaddressed messages, offer to raise, add to or resolve requests, and offer to attach files. |
| `WIRE_SUPPORT_BOT_JIRA_WATCH_SECONDS` | no | unset (no watch) | Seconds between checks for desk replies, status and assignee changes; a whole number, at least 15. |
| `WIRE_SUPPORT_BOT_JIRA_UPDATE_QUESTION_HOURS` | no | `4` | Hours the requester can answer the question after a desk reply or resolve, and the rating question; a whole number from 0 to 72, `0` asks no such questions. Needs the watch. Also the lifetime of the question about the agent conversation and of "Did this help?", which keep 4 hours when it is `0`. |
| `WIRE_SUPPORT_BOT_JIRA_FEEDBACK` | no | `off` | `on` asks the requester for a satisfaction rating (1 to 5) after [Solved] or any resolve from Wire and sends it to the request's feedback in Jira. Needs the watch and the questions after a desk update. Ratings need customer satisfaction enabled in the service desk project's settings. |

### Logging and conversations

| Setting | Required | Default | Meaning |
|---|---|---|---|
| `LOG_LEVEL` | no | `info` (`warn` in the CLI) | `debug`, `info`, `warn` or `error`. |
| `LOG_FORMAT` | no | `json` | `json` (fields `level`, `msg`, `time`) or `ecs` (Elastic Common Schema: `@timestamp`, `log.level`, `message`, `ecs.version`). Both add `severity` (`DEBUG`, `INFO`, `WARNING`, `ERROR`). |
| `WIRE_SUPPORT_BOT_SDK_LOG_LEVEL` | no | `warn` | Level of the Wire SDK's own log lines, independent of `LOG_LEVEL`: `off`, `error`, `warn`, `info` or `debug`. |
| `WIRE_SUPPORT_BOT_SDK_LOG_CONTENT` | no | `messages` | What the Wire SDK's log lines carry: `messages` (the SDK's message text, with IDs and backend error texts but no message content), `none` (content-free fields only) or `full` (also its arguments, which may contain decrypted messages and HTTP bodies; for short troubleshooting only). See "What is stored and what is sent where". |
| `MESSAGE_BUFFER_SIZE` | no | `50` | Recent messages kept in memory per conversation; a positive whole number, capped at 500. |
| `WIRE_SUPPORT_BOT_DEFAULT_TIMEZONE` | no | `UTC` | IANA timezone for conversations the bot newly joins; members can change it per conversation. |

### Metrics

| Setting | Required | Default | Meaning |
|---|---|---|---|
| `WIRE_SUPPORT_BOT_METRICS_PORT` | no | unset (no HTTP server) | Port of the HTTP endpoint with `GET /metrics` and `GET /healthz`, from 1 to 65535. See "Metrics". |
| `WIRE_SUPPORT_BOT_METRICS_HOST` | no | `0.0.0.0` | Address the endpoint listens on; `127.0.0.1` keeps it local to the host. |

### Example: premium support for a truck manufacturer

The code speaks of a generic service desk; tailoring happens in the configuration. For a truck manufacturer's premium support desk that handles faults and replacement parts for its customers' fleets, the end of `.env.example` has this example:

```bash
WIRE_SUPPORT_BOT_JIRA_SERVICE_SCOPE=faults, breakdowns, damage, maintenance and replacement parts for the trucks of a haulage fleet
WIRE_SUPPORT_BOT_JIRA_REQUEST_TYPES=question=10001,part=10002,fault=10003
WIRE_SUPPORT_BOT_PART_ASSET_LABEL=Vehicle
WIRE_SUPPORT_BOT_PART_ASSET_QUESTION=the vehicle (fleet or chassis number)
WIRE_SUPPORT_BOT_PART_DELIVERY_LOCATIONS=Depot north; Depot south
```

The service scope tells the classifier and the answer model what counts as a service-desk matter. The request types map questions, part orders and faults to the project's own request types (replace the IDs with yours). The asset label and question make a part order ask for the vehicle ("To order it I need the vehicle (fleet or chassis number) ...") and show "Vehicle: ..." in the confirmation and the ticket; the delivery locations become buttons ([Depot north] [Depot south] [Other]). With passive help, the watch and the agent mapping turned on as well, drivers can report a breakdown in their own words, send a photo of the damage and talk to the assigned agent directly.

## Metrics

With `WIRE_SUPPORT_BOT_METRICS_PORT` set, the bot serves an HTTP endpoint on that port (on `WIRE_SUPPORT_BOT_METRICS_HOST`, default every interface) from start-up on, before it connects to Wire:

- `GET /metrics`: the metrics in the Prometheus text format.
- `GET /healthz`: `200 ok` as long as the process answers. It does not check Wire, Jira, the model endpoint or the database, so a Jira outage never gets the bot restarted; watch it through the metrics instead. A lost Wire connection is handled by the connection watchdog (`WIRE_SUPPORT_BOT_WIRE_WATCHDOG_MINUTES`), which ends the process when restarting the connection does not help.
- Anything else: 404.

Locally, set `WIRE_SUPPORT_BOT_METRICS_PORT=9464` in `.env`, start the bot and open `http://localhost:9464/metrics`. With Docker Compose, also publish the port (a commented mapping is in `docker-compose.yml`). In Kubernetes, set `metrics.enabled` in the chart (see "Kubernetes (Helm)"). The endpoint has no authentication: keep it inside the cluster or on a local address. A port that cannot be bound stops start-up with an error line naming the port.

Every metric name starts with `wire_support_bot_`. The Node runtime metrics of prom-client (`wire_support_bot_process_*`, `wire_support_bot_nodejs_*`: CPU, memory, event loop lag, garbage collection) come first; the bot's own are:

| Metric | Type | Labels | Meaning |
|---|---|---|---|
| `wire_support_bot_wire_messages_received_total` | counter | `kind`: `text`, `file`, `button_click`, `other` | Events received from Wire. A file counts once, when it is uploaded; `other` is edits, pings, locations, reactions and deletions. |
| `wire_support_bot_wire_connection_events_total` | counter | `event`: `connected`, `disconnected` | WebSocket connections opened and lost, as the Wire SDK reports them; each reconnect adds one of each. |
| `wire_support_bot_wire_connected` | gauge | | 1 while the WebSocket is connected, 0 before the first connection and after a loss until the SDK has reconnected. |
| `wire_support_bot_wire_watchdog_actions_total` | counter | `action`: `restart`, `exit` | What the connection watchdog did after `WIRE_SUPPORT_BOT_WIRE_WATCHDOG_MINUTES` without a Wire connection: restarted the connection, or ended the process after a second period. |
| `wire_support_bot_wire_sdk_problems_total` | counter | `severity`: `warn`, `error` | Warnings and errors the Wire SDK logged, also those below `WIRE_SUPPORT_BOT_SDK_LOG_LEVEL`. |
| `wire_support_bot_model_calls_total` | counter | `slot`: `classify`, `respond`, `embed`; `outcome`: `ok`, `fallback`, `timeout`, `error` | Model calls. `fallback`: the fallback model answered after the primary was unavailable or timed out; `timeout`: the last attempt timed out. `embed` counts each embeddings request of the document index (a question, or the start-up check), which has no fallback. |
| `wire_support_bot_model_call_duration_seconds` | histogram | `slot` | Duration of a model call, fallback included; buckets from 0.25 s to 120 s. |
| `wire_support_bot_model_tokens_total` | counter | `slot`: `classify`, `respond`, `embed`; `model`: the configured name of the model that answered; `direction`: `input`, `output` | Tokens of successful model calls, as the response's `usage` reported them. After a fallback the tokens count under the fallback model's name. `embed` counts only input tokens (`prompt_tokens`, or `total_tokens` for providers that report only that), once per embeddings request. Failed calls count nothing. |
| `wire_support_bot_model_usage_missing_total` | counter | `slot`: `classify`, `respond`, `embed` | Successful model calls whose response reported no usable token usage (missing, or a count that is not a non-negative whole number); their tokens are not counted. |
| `wire_support_bot_jira_requests_total` | counter | `operation`: `create_issue`, `get_issue`, `resolve_issue`, `list_customer_replies`, `add_customer_reply`, `list_changed_since`, `add_customer_attachment`, `submit_feedback`; `outcome`: `2xx`, `4xx`, `5xx`, `timeout`, `error` | Jira HTTP requests, by the tracker operation that made them (one operation can make several, such as reading the SLAs or following transitions). `get_service_desk`: the lookup of the customer portal's address for portal links. `error`: no response, such as a DNS or connection failure. |
| `wire_support_bot_jira_request_duration_seconds` | histogram | `operation` | Duration of a Jira HTTP request; buckets from 25 ms to 15 s. |
| `wire_support_bot_watch_checks_total` | counter | `outcome`: `ok`, `error` | Watch checks; `error` when the watched requests or Jira's changes could not be read. |
| `wire_support_bot_watch_check_duration_seconds` | histogram | | Duration of a watch check, including the updates it posts. |
| `wire_support_bot_watched_requests` | gauge | | Requests the last successful watch check looked at. |
| `wire_support_bot_support_requests_raised_total` | counter | `kind`: `question`, `part`, `fault` | Requests raised with the service desk. |
| `wire_support_bot_support_replies_sent_total` | counter | | Replies sent to the service desk from Wire. |
| `wire_support_bot_support_requests_resolved_total` | counter | | Resolves from Wire that reached done. |
| `wire_support_bot_offers_total` | counter | `event`: `made`, `accepted`, `declined`, `expired` | Offers and questions put to a member (yes-or-no offers, choices, part-order steps, questions after a desk update, ratings, "Did this help?") and how they ended. Offers replaced, dropped or lost on a restart are not counted as ended. |
| `wire_support_bot_button_clicks_total` | counter | `outcome`: `accepted`, `not_asked`, `late`, `invalid` | Button clicks: the deciding click, a click by a member who was not asked, a click on a question that is no longer open, a button that does not belong to the question. |
| `wire_support_bot_ratings_total` | counter | `outcome`: `ok`, `refused`, `unconfirmed`, `not_sent` | Satisfaction ratings: accepted, rejected by Jira, a timeout or server error (it may have arrived), or stopped before Jira. |
| `wire_support_bot_pending_offers` | gauge | | Offers and questions waiting for an answer, read at each scrape. |
| `wire_support_bot_queue_length` | gauge | | Messages waiting in the passive-help queue, read at each scrape; 0 with passive help off. |
| `wire_support_bot_knowledge_retrievals_total` | counter | `outcome`: `hit`, `miss`, `error` | Searches of the document index for an answer: at least one excerpt passed on, none similar enough (or an empty index), or the question could not be embedded or the index not read. Only with the document index on. |
| `wire_support_bot_knowledge_help_answers_total` | counter | `outcome`: `solved`, `ticket`, `ended`, `expired` | How "Did this help?" after an answer from the document index ended: [Solved] or a text answer for it, [Raise a ticket] or a text answer for it (which leads to the raise offer, counted in `wire_support_bot_offers_total`), another message, a file or a newer question ended it without a decision, or it was not answered in time. |
| `wire_support_bot_knowledge_chunks` | gauge | | Excerpts of the document index loaded for searching, read at each scrape; 0 with the index off. |

The counters with labels start at 0 for every label value, so rates and absence checks work from the start. The exception is `wire_support_bot_model_tokens_total`: its `model` values come from the configuration, so its series appear with the first counted call. The metrics carry no content and no IDs (see "What is stored and what is sent where").

Token counts are what the provider reports in each response. The thinking tokens of Anthropic's models through its OpenAI compatibility layer are included in the output tokens and not shown separately. Token counts are not invoices: prompt caching, discounts and the provider's billing rules are not visible in them. A provider that reports no usage shows up in `wire_support_bot_model_usage_missing_total`.

Example queries and alert ideas:

```promql
# Share of Jira requests that failed (4xx, 5xx, timeout, no response) over 15 minutes
sum(rate(wire_support_bot_jira_requests_total{outcome!="2xx"}[15m]))
  / sum(rate(wire_support_bot_jira_requests_total[15m])) > 0.2

# 95th percentile of model call duration per slot
histogram_quantile(0.95, sum by (slot, le) (rate(wire_support_bot_model_call_duration_seconds_bucket[30m])))

# Tokens per minute by slot, model and direction
sum by (slot, model, direction) (rate(wire_support_bot_model_tokens_total[5m])) * 60

# Share of output tokens in the chat slots over an hour
sum(increase(wire_support_bot_model_tokens_total{slot!="embed",direction="output"}[1h]))
  / sum(increase(wire_support_bot_model_tokens_total{slot!="embed"}[1h]))

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

`dashboards/grafana/wire-support-bot.json` is a Grafana dashboard for these metrics. Import it in Grafana (Dashboards, New, Import, upload the file) and pick a Prometheus-compatible data source, such as Prometheus or VictoriaMetrics. It selects the bot by the `namespace` and `pod` labels the scraper adds (with the chart's ServiceMonitor these are set automatically), and has these rows:

- Overview: Wire connection, uptime, messages received and requests raised in the selected time range, pending offers, and watchdog actions (above 0 means Wire was unreachable for minutes).
- Wire: messages by kind, connection events and watchdog actions, SDK warnings and errors.
- Model: calls by slot and outcome, latency (p50, p95), and the share of failed calls.
- Tokens: input and output tokens in the selected time range, calls whose response reported no usage, the output share of chat tokens, tokens per minute by slot and model, and tokens per call by slot.
- Jira: requests by outcome, failures by operation, latency (p95) by operation, watch checks, their duration and the number of watched requests.
- Support flow: requests raised, replies and resolves, offers and questions, button clicks, ratings, pending offers and the passive-help queue, and the document index (empty while it is off).
- Runtime: CPU, memory, event loop lag and garbage collection time.

The latency panels and garbage collection stay empty until the first model call, Jira call and garbage collection, since a histogram has no series before its first value.

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
- Run one bot process per Wire app and storage directory. The SDK store, pending offers, the message buffer and the guard against double submits belong to the process. Use a separate Wire app for every deployment, including test and staging setups: each SDK store holds its own login cookie, which the Wire backend renews, so a second store logging in as the same app (a new pod, a copy of the store, a test cluster) can make the backend refuse the first one. The refused bot stops at start-up with `AuthenticationError` and a hint, after the SDK has dropped the refused cookie. The next start (Docker Compose and Kubernetes restart it by themselves) logs in again with `WIRE_SDK_API_TOKEN` as a new device; while both instances run, they keep refusing each other in turn. Only if that start fails as well is the token itself no longer valid: issue a new one with `npm run register-app -- refresh`.
- Pending offers and recent messages are held in memory: a restart drops unanswered offers and the conversation context.
- Desk updates arrive by polling, so they appear up to one interval late (the interval is at least 15 seconds).
- The watch looks at up to 500 requests per check, oldest first, and the bot retries leaving up to 500 pending agent groups per run.
- Edited messages are ignored.
- Buttons were checked on Wire web and iOS; Android was not tested. On every client the result is also posted as text, and every question can be answered in text.
- Offers live in memory, so after a restart a click on an earlier question does nothing, and a question still open at the restart keeps its buttons (it is not closed).
- Only photos and documents of the listed types, up to 10 MB, are offered for attaching.
- With a remote model provider and sharing on, ticket content leaves your infrastructure; see "What is stored and what is sent where".
- The Wire SDK stops reconnecting after about 10 failed attempts in a row (about 3.5 minutes of outage) and does not report it, so the bot would stay up without receiving messages, or end without a log line once nothing else keeps the process running. The connection watchdog (`WIRE_SUPPORT_BOT_WIRE_WATCHDOG_MINUTES`, default 5 minutes) restarts the connection and, when that does not help, exits with code 1; Docker Compose (`restart: unless-stopped`) and Kubernetes (the pod's restart policy) then start the bot again. If the process has nothing left to wait for, it logs "Nothing keeps the bot running (Wire connection gone); exiting" and exits with code 1 as well. Run it elsewhere only under a supervisor that restarts it. Each change of the connection is logged at info ("Wire connected", "Wire disconnected", and "Wire connection restored after the watchdog restart").

## License

This project is licensed under the GNU General Public License, version 3 only (`GPL-3.0-only`); see [LICENSE](LICENSE).

Its Wire libraries are GPL-3.0 as well (`@wireapp/wire-apps-js-sdk`, `@wireapp/core-crypto` and `bazinga64`). A bot built from this code runs those libraries in the same process, so if you distribute your bot, the combined work falls under the GPL and you must offer its source to the people you distribute it to. Running the bot only for yourself does not require that. The other dependencies are under permissive licenses (MIT, Apache-2.0, BSD) or MPL-2.0, which are compatible with the GPL.
