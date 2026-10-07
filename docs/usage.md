# Using the bot

In the examples, `SD` stands for the configured project key and `SD-42` for a ticket key. The bot's built-in name "Wire Support Bot" is replaced by the app's display name in Wire.

## Addressing the bot

The bot acts on a message when it is mentioned (`@Wire Support Bot ...`) or when the message starts with "Wire Support Bot". Every command that reads from or writes to the service desk needs this, so ordinary chat that happens to start with "support:" never reaches the tracker. Send one command per message: a message with several commands is rejected before anything runs.

## Commands

| Command | What it does |
|---|---|
| `@Wire Support Bot support: <problem>` | Raises a support request at once. The first line becomes the summary (at most 120 characters), the whole text the description. |
| `@Wire Support Bot status of SD-42` | Shows the live status, SLAs and latest desk replies. "any update on SD-42?" works too. |
| `@Wire Support Bot reply to SD-42: <text>` | Sends a customer-facing reply to the request. |
| `@Wire Support Bot resolve SD-42` | Resolves the request by following the workflow transitions toward a done status. `close SD-42` works too. |
| `@Wire Support Bot resolve SD-42: <comment>` | Adds a closing comment as a customer-facing reply, then resolves. |
| `@Wire Support Bot support requests` | Lists the open support requests of this conversation. |
| `@Wire Support Bot my support requests` | Lists the open support requests the sender raised in this conversation. |
| `@Wire Support Bot timezone Europe/Berlin` | Sets the conversation's timezone for reply times; without a name it shows the current one. |

Only keys of the configured project are accepted, and status, reply and resolve only work for requests raised in the same conversation; a key from another conversation is treated as unknown.

Raising a request and its status show a link to the ticket: the agent view (`<site>/browse/SD-42`) by default, or the request in the customer portal with `WIRE_SUPPORT_BOT_JIRA_LINKS=portal`. Members can only open portal links for requests they can see in the portal; since the bot raises requests as its own Jira account, that needs more setup first.

## Natural language and offers

A member can mention the bot and write in their own words: "the printer on the second floor is broken again, can you raise it?", "tell the desk that it works after a restart", "we can close SD-42". The model drafts a proposal, code checks it, and the bot asks a question with [Yes] and [No]. Nothing is sent to the service desk until the member answers.

Details:
- When a message clearly asks to raise, order, reply or resolve something and the model's answer makes no offer, the bot asks the model once more and uses the second answer only if it carries a valid offer. A how-to question ("how do I raise a ticket?") does not count as asking.
- A suggested bot command that does not exist is not shown; the bot shows a supported command instead.
- Questions that ask for no change ("what was the VPN request called?") get an answer from the recent conversation and its support requests. When one of the bot's last three messages ended with a question, the next message counts as a follow-up even without a mention.

The rules for an offer:
- Only the member it was made to can confirm it, and only with their next message. Any other message from them drops the offer; a correction ("the description should mention the third floor") gets a revised offer.
- Only explicit answers count: "yes", "go ahead", "do it", "confirm" and similar, or "no", "cancel", "stop" and similar. "ok", "sure" or "thanks" approve nothing; the bot asks again.
- An offer expires after 10 minutes.
- With buttons, only the member who was asked can answer, and their first click decides. Another member's click changes nothing; the bot answers it once with "Only <name> can answer this." The result is always posted as text as well.
- When a question ends, the bot edits it: the buttons disappear and a last line says how it ended, for example "Answered by Alice: Yes", "This question has expired.", "This question was replaced by a newer one." or "Closed, as the next message was not an answer.".

### Choosing instead of guessing

Where the bot would otherwise have to guess which request is meant, it asks, with a button per option:

- **New or existing request.** When a new problem may be one the conversation already has (an open request, or one done in the last 7 days, with a similar summary, or one the model names), the bot lists up to three of them and offers [Add to SD-38] … [Raise new request] [Cancel]. Shared numbers and identifiers count strongly, generic words such as "broken" or "issue" not at all, and a request naming a different identifier (truck 13 for a truck 12 problem) is never listed.
- **Which request to resolve or add to**, when passive help finds several candidates and the message names no key: up to three, then [Cancel].
- **Which request a photo or document belongs to** (see below).

Every choice can also be answered in text: the key ("SD-41"), "new", "cancel", "no", or the option's number. The options come from the conversation's own stored requests and are checked by code; the model never adds one.

## First-level help

With the document index on (`WIRE_SUPPORT_BOT_KNOWLEDGE=on`, see [deployment](deployment.md#the-document-index)), a member who mentions the bot with a problem gets an answer from your documents, a line naming the best-matching section, and a question: "Alice, did this help?" [Solved] [Raise a ticket].

```text
Alice: @Wire Support Bot the engine check light is on and truck 12 loses power
Bot:   With the engine check light on and reduced power, stop in a safe place and call the fleet desk.
       Source: Dashboard warning lights, Yellow lights > Engine check light
Bot:   Alice, did this help?  [Solved] [Raise a ticket]
Alice: (clicks [Raise a ticket])
Bot:   Shall I report this to the service desk?
       > **Engine check light on, truck 12 loses power**
       > The engine check light is on and truck 12 loses power.  [Yes] [No]
```

- Documents come first: when they match a problem, the bot does not offer a ticket right away and removes suggested bot commands from the answer; the way to a ticket is [Raise a ticket]. Part orders, replies and resolves are offered as usual.
- The question follows only answers that used a document and only messages that describe a fault. A how-to question or a message that names a request never gets it; for other messages the support triage decides (one more call to the `classify` model).
- [Solved] (or "solved", "it helped", "thanks") closes the question. [Raise a ticket] (or "ticket", "no", "still broken") leads to the usual raise offer with [Yes] [No].
- It is not asked while the member has another open question, and it can be answered for `WIRE_SUPPORT_BOT_JIRA_UPDATE_QUESTION_HOURS` (4 hours by default).

The answer is the answer model's wording of the documents. A capable hosted model kept to the documents in our checks; a small local model (4B parameters) at times added steps of its own. Use a capable model for `WIRE_SUPPORT_BOT_MODEL_RESPOND` when your documents contain safety instructions, and check answers before you rely on them.

## Passive help

With `WIRE_SUPPORT_BOT_JIRA_PASSIVE=on`, the model classifies messages that don't mention the bot. When it is confident (0.8 or more) that a message concerns the service desk, the bot may offer to raise a new request, add the message to an open request as a reply, or resolve a request the message says is solved; it may also answer a status question. Every offer follows the rules above. With passive help off, the bot only reacts when it is addressed.

## Part orders

A request is a question, a part order or a fault, and each kind can have its own Jira request type. A part order needs the item the part is for (the asset, with a configurable label), the part, the quantity and the delivery location. What the member's message doesn't state, the bot asks for one step at a time:

1. The asset and the part, in text: "To order it I need the vehicle (fleet or chassis number) and the part (name or number). What are they?"
2. The quantity: "How many shall I order?" [1] [2] [5] [Other].
3. The delivery location, with the configured locations as buttons: [Depot north] [Depot south] [Other]. Without configured locations it is asked in text.
4. The complete order, with [Yes] [No].

[Other] asks for the value in text, and text answers work at every step, including corrections ("actually three"). Only values the requester actually stated count: "a new filter" does not become a quantity of one.

## Photos and documents

With passive help on and an open request in the conversation, a posted photo or document gets an offer to attach it to the request the bot last wrote about. When the sender has several open requests, the bot asks which one: [SD-40] [SD-41] … [Do not attach]. After a yes, the file is attached to the ticket with a customer-facing reply naming the sender. The file is held in memory only.

Supported are JPEG, PNG, HEIC, HEIF and WebP images, and PDF, plain text, CSV, Word (`.docx`) and Excel (`.xlsx`) documents, up to 10 MB. Self-deleting messages are not offered.

## Desk replies and status changes

With the watch on (`WIRE_SUPPORT_BOT_JIRA_WATCH_SECONDS`), new public replies from the service desk (up to three per update) and status changes appear in the request's conversation, quoting the bot's last message about the request. Replies sent from Wire are not announced again.

After an update, the bot asks the requester what to do next:
- After a desk reply: "Alice, would you like to reply to the service desk about **SD-42**, or is it solved so I can close it?" [Reply] [Solved, close it].
- After the desk resolved the request: "Alice, is **SD-42** solved for you, or is it still broken?" [Solved] [Still broken].
- After other status changes it asks nothing.

[Reply] and [Still broken] ask for the text and then offer it as a reply with [Yes] [No]. [Solved, close it] resolves the request. The bot never reopens a request: after [Still broken] the reply goes to the resolved request and the service desk decides.

The question goes only to the requester and can be answered for `WIRE_SUPPORT_BOT_JIRA_UPDATE_QUESTION_HOURS` (4 hours by default). It never gets in the way: it is not asked over another open question of the requester, and a newer question, a posted file or a message that is not an answer replaces or closes it.

## Satisfaction rating

With `WIRE_SUPPORT_BOT_JIRA_FEEDBACK=on`, the bot asks the requester for a rating after [Solved] following a resolve by the desk, and after every resolve from Wire that reached done: "Alice, how did the service desk do on **SD-42**? 1 is poor, 5 is great." [1] … [5]. The rating goes to the request's satisfaction feedback in Jira, without a comment. If Jira refuses it, the bot says so. Ratings need the watch, the questions after a desk update, and customer satisfaction enabled in the project. The bot uses Jira's experimental feedback endpoint, which Atlassian may change.

## Direct conversation with the assigned agent

With `WIRE_SUPPORT_BOT_JIRA_AGENTS` mapping Jira account IDs to Wire handles and the watch on, the bot reacts once per request when a mapped agent is assigned. `WIRE_SUPPORT_BOT_JIRA_AGENT_CHAT` decides how:

- `ask` (default): "Alice, the service desk assigned Kim Desk to **SD-42**. Would you like a direct conversation with them?" [Open direct chat] [Not now].
- `auto`: the bot opens the conversation at once.
- `off`: nothing happens.

To open it, the bot creates a group named after the request with the requester and the agent, posts a short introduction, makes both admins and leaves. The original conversation gets a notice. The direct conversation is not recorded in the ticket. If the requester has another open question, the bot waits and asks at a later watch check.

## Typing indicator

While the bot works on something a member is waiting for, it shows itself as typing.
