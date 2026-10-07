# Design

These are the ideas worth keeping if you build your own bot on this code.

## The model drafts, code validates, a person says yes

The model never performs a write and is told never to claim one. In the answer path it may end its answer with one structured offer line. Code parses it and checks:
- the request kind and the bounds (summary 120 characters, offer description 1,000, reply 2,000);
- that a named request belongs to this conversation and is in the right state;
- that the member's own message asked for that change.

Only then does the bot send its own question. The offer is stored after the question has been sent, so it can never be confirmed unseen. The model's wording around an offer is discarded, since it may imply that the change has already happened. When the member confirms, the regular use case runs and checks scope, state and bounds again.

The explicit commands (`support:`, `reply to`, `resolve`) are themselves the member's decision and run without an offer.

## Buttons

Every offer question is a Wire composite message: text plus buttons. A button's ID carries only the offer's random ID and the option's number, never content; a click is matched to the stored offer of the clicked message, so a key or text is never taken from the click. Code builds every option from validated data.

The click rules:
- The first accepted click of the member who was asked decides. Only that click gets a confirmation, which Wire clients show to everyone.
- Later clicks on the same message, including the same member changing their choice, change nothing.
- Another member's click changes nothing. Their client still marks it locally, so the bot answers once per message with "Only <name> can answer this."
- When a question ends, the bot edits its message once into the question as sent plus a closing line, without buttons. Expired questions are closed by a sweep once a minute, so quiet conversations are closed too.
- A click on an ended or unknown question (for example after a restart) changes nothing and gets no answer.
- A click counts as the member's next interaction, like a text answer, and the confirmed use case runs with all its checks.
- The result is always posted as text as well, so clients without buttons show what happened. Text answers work everywhere.

## Scoping to the conversation

Support requests are stored with the qualified conversation ID (ID and domain). Status, reply, resolve, attachments and the model's context only see requests of the current conversation. Offers are kept per conversation and member. The watch posts each update only to the conversation the request was raised in.

## What is stored and what is sent where

**Stored in Postgres:**
- Support request records: key, conversation, requester ID and display name, summary, kind, last known status category, and the watch's markers (last seen reply, the bot's last message about the request, last seen assignee, the agent group). The problem description is not stored; it lives in the ticket.
- An audit log of creates and updates: actor ID, conversation ID, action, entity and changed fields, without message text or names.
- Per-conversation settings: the timezone.
- With the document index: each document's path, title, content hash, embedding model and ingest time, and its excerpts with heading path, text and embedding. Every member who can ask the bot can get answers from them, so ingest only documents meant for those members.

**Held in memory only**, lost on restart: the recent messages of each conversation (`MESSAGE_BUFFER_SIZE`), pending offers, the bot's open button questions, the member cache, and the loaded document index.

**Sent to the model endpoint:**
- for an answer: the member's message, up to nine earlier messages with the senders' display names, the conversation's member names and IDs, the conversation's stored support requests, and with the document index on, the matching excerpts;
- after a document answer: the member's message once more, to the support triage;
- for passive help: the message, recent messages, and the key and summary of open requests;
- ticket content (live status, SLAs and up to three recent desk replies) only with `WIRE_SUPPORT_BOT_JIRA_SHARE_WITH_MODEL=on`.

**Sent to the embeddings endpoint**, only with the document index: the member's message for each answer; during ingestion, the text of every new or changed excerpt with its title and heading path; a fixed check text at start-up.

With a local endpoint nothing leaves the host. With a remote provider, all of the above goes to that provider.

**Sent to Jira:** only what a member wrote in a command or confirmed in an offer, the requester's display name ("Requested by <name> via Wire."), and with ratings on, the rating. New tickets carry the label `wire-support-bot`; replies, closing comments and attachments carry the footer "Sent from Wire.". Internal notes are never read or written.

**Logs and metrics** carry no message content and no names; see [operations](operations.md).

## The watch

The watch polls Jira rather than receiving webhooks, so the bot needs no inbound connection.
- **What it checks:** each check asks Jira which watched requests changed since the previous check, with a two-minute overlap because Jira's search is eventually consistent. Watched requests are the open ones plus those resolved in the last 24 hours, to catch a reopen.
- **Markers:** a request the bot raises starts with its markers set at creation, so any desk reply, assignment or status change after that is acted on. A request stored without markers gets a baseline when first examined, so old activity is never posted. The markers only move forward and are stored, so an update is not repeated after a restart.
- **Skips and failures:** a request being resolved from Wire at that moment is skipped, so the bot never announces its own resolve as the desk's. A request whose update keeps failing is given up after 10 attempts.

## The agent group

The bot stores the group's ID with the request right after creating it, then tries to leave at once and again after 2, 5 and 10 seconds. A group not yet left is retried after start-up and before every watch check. Until the bot has left a group, it ignores every message and event from it, also after a restart.

One gap remains: if the process stops between creating the group and storing its ID, the bot stays a member of that group.

## What the bot does not do

- It does not store or summarize conversations, and does not search past conversations.
- It does not read or write internal notes, and does not change assignees, priorities or other fields.
- It does not act on edited messages.
- It does not raise anything from an unaddressed message without an explicit yes.
- It does not watch requests raised from the CLI.
- It does not reopen requests.
