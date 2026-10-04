import { describe, it, expect, vi } from "vitest";
import { KNOWLEDGE_FIRST_RULE, OpenAIGeneralAnswerAdapter, integrationsPrompt } from "../../src/infrastructure/llm/OpenAIGeneralAnswerAdapter";
import type { AnswerIntegrations } from "../../src/infrastructure/llm/OpenAIGeneralAnswerAdapter";
import type { RetrievalResult } from "../../src/application/ports/RetrievalPort";
import { parseOfferMarker } from "../../src/application/services/offers";

const date = new Date("2026-09-25T10:00:00Z");

function result(id: string, type: RetrievalResult["type"], content: string): RetrievalResult {
  return { id, type, content, sourceDate: date };
}

function setup(content: string | string[], integrations: AnswerIntegrations = { jiraProjectKey: "SD" }) {
  const replies = Array.isArray(content) ? content : [content];
  const llm = { chatCompletion: vi.fn() };
  for (const reply of replies) llm.chatCompletion.mockResolvedValueOnce({ content: reply, model: "test", usedFallback: false });
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), child: vi.fn().mockReturnThis() };
  const adapter = new OpenAIGeneralAnswerAdapter(llm as never, logger, integrations);
  return { llm, adapter };
}

const support = 'OFFER: {"kind":"support","summary":"VPN drops","description":"My VPN drops every ten minutes."}';

describe("integrationsPrompt", () => {
  it("is part of every system prompt, since the service desk is required", async () => {
    const { llm, adapter } = setup("Hello.");
    await adapter.answer("hello", [], []);
    expect(llm.chatCompletion.mock.calls[0][1][0].content).toContain("connected to the Jira Service Management project SD");
  });

  it("lists the support request commands and offer kinds when Jira is on without sharing", () => {
    const prompt = integrationsPrompt({ jiraProjectKey: "SD" });
    expect(prompt).toContain("connected to the Jira Service Management project SD");
    expect(prompt).toContain("Never say that it has no Jira integration");
    expect(prompt).toContain("You cannot read or change Jira while writing this answer, and you have no ticket content");
    expect(prompt).toContain("never state or guess a ticket's live status in Jira");
    expect(prompt).toContain('A "## Support requests" section');
    expect(prompt).toContain("`@Wire Support Bot support: <problem>`");
    expect(prompt).toContain("`@Wire Support Bot support requests`");
    expect(prompt).toContain("`@Wire Support Bot my support requests`");
    expect(prompt).toContain("`@Wire Support Bot status of SD-NN`");
    expect(prompt).toContain("If the message is about something else or withdraws the offer, add no marker.");
    expect(prompt).toContain("`@Wire Support Bot reply to SD-NN: <text>`");
    expect(prompt).toContain("`@Wire Support Bot resolve SD-NN`");
    expect(prompt).toContain("do not describe internal mechanics");
    expect(prompt).not.toContain("## Live support request tickets");
    expect(prompt).toContain('OFFER: {"kind":"support","requestKind":"<question, part or fault>","summary":"<one short line>","description":"<the problem>"}');
    expect(prompt).toContain('OFFER: {"kind":"reply","issueKey":"SD-NN","body":');
    expect(prompt).toContain('OFFER: {"kind":"resolve","issueKey":"SD-NN","comment":"<optional closing comment>"}');
    expect(prompt).toContain("one short line in the requester's own words");
    expect(prompt).toContain("never include the surrounding conversation, other people's messages");
    expect(prompt).not.toMatch(/decision|reminder|ACT-/i);
    expect(prompt).toContain('Do not ask "Shall I" yourself');
    expect(prompt).toContain("add no marker");
  });

  it("offers a closing comment on resolve only in the requester's words, with its command form", () => {
    const prompt = integrationsPrompt({ jiraProjectKey: "SD" });
    expect(prompt).toContain("`@Wire Support Bot resolve SD-NN: <comment>` adds a closing comment to it first");
    expect(prompt).toContain('For resolve, add "comment" only when the requester asks to close or resolve the request with a note or comment');
    expect(prompt).toContain("only the text the requester wants added, in their own words");
    expect(prompt).toContain('Never invent a comment; otherwise leave "comment" out.');
  });

  it("lists the support request commands as their own group that needs a mention, without channel commands", () => {
    const prompt = integrationsPrompt({ jiraProjectKey: "SD" });
    expect(prompt).toContain("show these as their own group, the support request commands, and say that they need the bot to be mentioned");
    expect(prompt).toContain("the timezone channel setting is a separate group and does not belong to this one");
  });

  it("describes the support bot's purpose and its channel setting, without commands it does not have", async () => {
    const { llm, adapter } = setup("I connect this channel with the service desk.");
    await adapter.answer("what can you do", [], []);
    const system = llm.chatCompletion.mock.calls[0][1][0].content as string;
    expect(system).toContain("service-desk assistant");
    expect(system).toContain("you help the team raise problems, questions and part orders with the service desk");
    expect(system).toContain("Channel setting: `@Wire Support Bot timezone <name>` sets the channel's timezone for reply times");
    expect(system).toContain("describe the timezone setting only as this prompt describes it, in your own words");
    expect(system).not.toContain("Explain it only from this description");
    expect(system).not.toContain("written as complete mentioned commands from");
    expect(system).not.toMatch(/decision|reminder|pause|secure mode|resume|catch me up|status: shows/i);
  });

  it("presents the support request commands and the channel setting as two groups, never as the only command", async () => {
    const { llm, adapter } = setup("I connect this channel with the service desk.");
    await adapter.answer("what can you do", [], []);
    const system = llm.chatCompletion.mock.calls[0][1][0].content as string;
    expect(system).toContain("present two clearly separate groups, each under its own short heading, and say that every command needs the bot to be mentioned");
    expect(system).toContain("When someone asks to change it, give them that command: sending it changes the timezone at once. Never say that you cannot change the timezone.");
    expect(system).not.toContain("you cannot change it yourself");
    expect(system).toContain("1. Support request commands: `@Wire Support Bot support: <problem>`, `@Wire Support Bot support requests`, `@Wire Support Bot my support requests`, `@Wire Support Bot status of <key>`, `@Wire Support Bot reply to <key>: <text>` and `@Wire Support Bot resolve <key>`.");
    expect(system).toContain("2. Channel setting: `@Wire Support Bot timezone <name>`");
    expect(system).toContain("Never call either group, or any single command, your only command or the only thing you can do");
    expect(system).not.toContain("The only channel command");
    expect(system).not.toMatch(/only (?:channel )?command is/i);
    expect(system.indexOf("1. Support request commands")).toBeLessThan(system.indexOf("2. Channel setting"));
  });

  it("has no commands or offer kinds the bot does not have", () => {
    for (const prompt of [integrationsPrompt({ jiraProjectKey: "SD" }), integrationsPrompt({ jiraProjectKey: "SD", jiraShareWithModel: true })]) {
      expect(prompt).not.toContain("ACT-NNNN");
      expect(prompt).not.toContain("to jira`");
      expect(prompt).not.toContain('"kind":"raise"');
      expect(prompt).not.toContain('"kind":"close"');
      expect(prompt).not.toContain("actionId");
      expect(prompt).not.toContain("Linked Jira tickets");
    }
  });

  it("describes the live section instead of the no-content line when sharing is on", () => {
    const prompt = integrationsPrompt({ jiraProjectKey: "SD", jiraShareWithModel: true });
    expect(prompt).not.toContain("you have no ticket content");
    expect(prompt).toContain('A "## Live support request tickets" section, when present, holds the live status, SLAs and latest service-desk replies');
    expect(prompt).toContain("cite the ticket key");
    expect(prompt).toContain("Say nothing about a ticket beyond what that section states");
    expect(prompt).toContain("give the status command");
    expect(prompt).toContain("never guess a ticket's status");
    expect(prompt).toContain('A "## Support requests" section');
    expect(prompt).toContain('OFFER: {"kind":"resolve","issueKey":"SD-NN","comment":"<optional closing comment>"}');
  });

  it("explains the three request kinds and the part essentials, which are never invented", () => {
    const prompt = integrationsPrompt({ jiraProjectKey: "SD" });
    expect(prompt).toContain('"question" for a question to the service desk, "part" for an order of a replacement part, and "fault" for a fault, breakdown, damage, or a service or maintenance need. When unsure, use "fault".');
    expect(prompt).toContain('"part":{"asset":"<the item the part is for>","part":"<part name or number>","quantity":"<how many>","deliverTo":"<delivery location>"}');
    expect(prompt).toContain('"asset" (the item the part is for; this service desk asks for the item the part is for (for example a machine, vehicle or device) and labels it "Asset". Take the item as the requester names it (for example "truck 12" or "the printer on floor 2"): it counts as given even without a serial, fleet or other number), "part" (part name or number)');
    expect(prompt).toContain("Take each value only from the requester's own messages, in their words; never invent, guess or infer one.");
    expect(prompt).toContain("Leave out every essential the requester has not given; the system asks for the missing ones, so do not ask for them yourself.");
    expect(prompt).toContain("For a part order, keep the essentials already given and add those the message supplies.");
    expect(prompt).toContain("to ask the service desk a question, to order a replacement part,");
    expect(prompt).toContain("key, summary, kind, requester and last known status");
  });

  it("describes the asset essential with the configured label and question", () => {
    const prompt = integrationsPrompt({ jiraProjectKey: "SD", partAsset: { label: "Device", question: "the device (asset tag or room number)" } });
    expect(prompt).toContain('"asset" (the item the part is for; this service desk asks for the device (asset tag or room number) and labels it "Device". Take the item as the requester names it (for example "truck 12" or "the printer on floor 2"): it counts as given even without a serial, fleet or other number)');
    expect(prompt).not.toContain("serial number");
  });

  it("never lets an earlier similar request, open or Done, stand in for a requested new one", () => {
    const prompt = integrationsPrompt({ jiraProjectKey: "SD" });
    expect(prompt).toContain("An earlier support request about a similar problem, open or Done, never stands in for a new one.");
    expect(prompt).toContain("never decide that the new problem is the same as an earlier request, and never refuse or ask for more details because of one.");
  });

  it("offers instead of giving the command when asked to act, also again after a no", () => {
    const prompt = integrationsPrompt({ jiraProjectKey: "SD" });
    expect(prompt).toContain("When asked how to raise, follow, reply to or resolve a support request, give the exact supported command");
    expect(prompt).toContain("When the requester asks you to raise a problem, send a reply or resolve a request, do not answer with the command instead: make the offer");
    expect(prompt).toContain("When the requester asks again to raise a problem after a no, that is a new request: make a new offer.");
  });

  it("describes the desk with the configured service scope, and keeps the generic wording without it", () => {
    const scope = "questions about the office equipment, faults, damage, service and maintenance, and replacement part orders";
    const prompt = integrationsPrompt({ jiraProjectKey: "SD", jiraServiceScope: `  ${scope}.\n` });
    expect(prompt).toContain(`Never say that it has no Jira integration or cannot work with Jira.\n- The service desk handles ${scope}.\n`);
    expect(integrationsPrompt({ jiraProjectKey: "SD" })).not.toContain("The service desk handles");
  });

  it("uses the configured project key in the commands and offer format", () => {
    const prompt = integrationsPrompt({ jiraProjectKey: "OPS" });
    expect(prompt).toContain('"issueKey":"OPS-NN"');
    expect(prompt).toContain("`@Wire Support Bot resolve OPS-NN`");
  });
});

describe("OpenAIGeneralAnswerAdapter with support requests and offers", () => {
  it("renders stored requests, live tickets and knowledge articles under their own sections and not under Related Context", async () => {
    const { llm, adapter } = setup("SD-4 is in progress.", { jiraProjectKey: "SD", jiraShareWithModel: true });
    await adapter.answer("Latest on SD-4?", [], [
      { ...result("KB-1", "knowledge_article", "Restart the VPN client first."), source: "VPN guide" },
      result("SD-4", "support_request", "SD-4 | Summary: VPN drops | Requested by: Alice | Last known status: To do"),
      result("SD-4", "live_ticket", "SD-4: VPN drops\nStatus: In progress"),
      result("tz", "context", "Proposal relates to Acme"),
    ], []);
    const system = llm.chatCompletion.mock.calls[0][1][0].content as string;
    const user = llm.chatCompletion.mock.calls[0][1][1].content as string;
    expect(system).toContain("## Live support request tickets");
    expect(user).toContain("## Support requests\n- SD-4 | Summary: VPN drops | Requested by: Alice | Last known status: To do _(2026-09-25)_\n\n");
    expect(user).toContain("## Live support request tickets\n- SD-4: VPN drops\nStatus: In progress\n\n");
    const related = user.slice(user.indexOf("## Related Context"));
    expect(related).toContain("- Proposal relates to Acme");
    expect(related).not.toContain("VPN drops");
    expect(user).toContain(`## Knowledge articles\n- Restart the VPN client first. _(source: VPN guide)_\n${KNOWLEDGE_FIRST_RULE}\n\n`);
    expect(related).not.toContain("Restart the VPN client");
    expect(user.indexOf("## Support requests")).toBeLessThan(user.indexOf("## Live support request tickets"));
    expect(user.indexOf("## Live support request tickets")).toBeLessThan(user.indexOf("## Knowledge articles"));
    expect(user).not.toMatch(/## (?:Relevant Decisions|Relevant Actions|Data summary)/);
  });

  it("tells the model to answer from the articles before offering only when knowledge articles are provided", async () => {
    const { llm, adapter } = setup("Refill the tank.");
    await adapter.answer("My truck has lost power", [], [{ ...result("KB-1", "knowledge_article", "Refill the tank."), source: "DEF warnings" }], []);
    await adapter.answer("My truck has lost power", [], [result("SD-4", "support_request", "SD-4 | Summary: VPN drops")], []);
    const withArticles = llm.chatCompletion.mock.calls[0][1].map((m: { content: string }) => m.content).join("\n");
    const without = llm.chatCompletion.mock.calls[1][1].map((m: { content: string }) => m.content).join("\n");
    expect(withArticles).toContain(KNOWLEDGE_FIRST_RULE);
    expect(KNOWLEDGE_FIRST_RULE).toContain("add no OFFER: line");
    expect(without).not.toContain(KNOWLEDGE_FIRST_RULE);
    expect(without).not.toContain("Answer from these articles");
  });

  it("tells the model to revise a pending offer it is given, which appears under Related Context", async () => {
    const { llm, adapter } = setup("Updated.");
    const pending = 'Pending offer being amended (not confirmed, nothing was sent; the requester\'s message changes it): {"kind":"support","summary":"VPN drops","description":"My VPN drops."}';
    await adapter.answer("It started on Monday", [], [result("pending-offer", "context", pending)], []);
    const system = llm.chatCompletion.mock.calls[0][1][0].content as string;
    const user = llm.chatCompletion.mock.calls[0][1][1].content as string;
    expect(system).toContain('A "Pending offer being amended" line under "## Related Context" is the requester\'s unconfirmed offer');
    expect(system).toContain("end with a revised marker of the same kind (for reply or resolve, the same issueKey)");
    expect(user).toContain(`## Related Context\n- ${pending}\n\n`);
  });

  it("omits both sections when there are no support request results", async () => {
    const { llm, adapter } = setup("Nothing yet.");
    await adapter.answer("Anything?", [], [result("E1", "context", "Something")], []);
    const user = llm.chatCompletion.mock.calls[0][1][1].content as string;
    expect(user).not.toContain("## Support requests");
    expect(user).not.toContain("## Live support request tickets");
  });

  it("keeps a bold marker line and strips the offer question before it", async () => {
    const { adapter } = setup(`Shall I raise this with the service desk?\n**OFFER**: ${support.slice("OFFER: ".length)}`);
    const returned = await adapter.answer("My VPN drops every ten minutes, can you raise it?", [], [], []);
    expect(returned).toBe(`**OFFER**: ${support.slice("OFFER: ".length)}`);
    expect(parseOfferMarker(returned).command).toEqual({ kind: "support", requestKind: "fault", summary: "VPN drops", description: "My VPN drops every ten minutes." });
  });

  it("keeps a final marker line intact after text", async () => {
    const answer = `I can raise that with the service desk.\n${support}`;
    const { llm, adapter } = setup(answer);
    const returned = await adapter.answer("My VPN drops every ten minutes, can you raise it?", [], [], []);
    expect(returned).toBe(answer);
    expect(llm.chatCompletion).toHaveBeenCalledTimes(1);
    expect(parseOfferMarker(returned).command).toEqual({ kind: "support", requestKind: "fault", summary: "VPN drops", description: "My VPN drops every ten minutes." });
  });

  it("keeps a reply marker whose body contains sentences and a question", async () => {
    const answer = 'Here is the reply.\nOFFER: {"kind":"reply","issueKey":"SD-4","body":"Thanks. Can you send the draft?"}';
    const { adapter } = setup(answer);
    const returned = await adapter.answer("Reply to SD-4", [], [], []);
    expect(parseOfferMarker(returned)).toEqual({ text: "Here is the reply.", command: { kind: "reply", issueKey: "SD-4", body: "Thanks. Can you send the draft?" }, hadMarker: true });
  });

  it("strips a model-written offer question before the marker without losing the marker", async () => {
    const { llm, adapter } = setup(`That sounds like one for the service desk. Shall I raise it for you?\n${support}`);
    const returned = await adapter.answer("My VPN drops, please raise it", [], [], []);
    expect(returned).toBe(`That sounds like one for the service desk.\n${support}`);
    expect(llm.chatCompletion).toHaveBeenCalledTimes(1);
  });

  it("returns the marker alone instead of retrying when the only text is an offer question", async () => {
    const { llm, adapter } = setup(`Shall I raise it with the service desk?\n${support}`);
    const returned = await adapter.answer("My VPN drops, please raise it", [], [], []);
    expect(returned).toBe(support);
    expect(llm.chatCompletion).toHaveBeenCalledTimes(1);
  });

  it("keeps the marker from the retry answer", async () => {
    const { llm, adapter } = setup(["Shall I check?", 'Here it is.\nOFFER: {"kind":"resolve","issueKey":"SD-6"}']);
    const returned = await adapter.answer("The VPN works again, close SD-6", [], [], []);
    expect(llm.chatCompletion).toHaveBeenCalledTimes(2);
    expect(parseOfferMarker(returned).command).toEqual({ kind: "resolve", issueKey: "SD-6" });
  });
});
