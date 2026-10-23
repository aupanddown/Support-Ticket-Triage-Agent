import { describe, expect, it } from "vitest";
import { type AgentEvent, DEFAULT_MAX_ITERATIONS, triageTicket } from "../src/agent.js";
import { LlmConfigError } from "../src/llm/client.js";
import type { LlmTriageOutput } from "../src/schemas.js";
import { FakeLlmClient, finalAnswer, toolCalls } from "./fakeLlmClient.js";
import { sampleTicket } from "./fixtures.js";

/** A good model answer for T3 (dark mode question). */
const T3_OUTPUT: LlmTriageOutput = {
  urgency: "low",
  extracted: {
    product: "appearance",
    product_detail: "Dark mode",
    issue_types: ["how_to", "bug", "feature_request"],
    sentiment: "positive",
    language: "en",
  },
  decision: "auto_respond",
  route_team: null,
  follow_up_teams: ["Product"],
  kb_articles_used: ["KB-101"],
  customer_reply_draft: "Hi! Thanks for the details. Settings > Appearance has Light and System Default...",
  internal_note: "Possible bug: System Default does not follow macOS dark mode. Feature request: scheduled dark mode.",
  confidence: 0.9,
};

/** A modest model answer for T2, before the policy: high urgency, routed to Support, Thai reply. */
const T2_LIKE_OUTPUT: LlmTriageOutput = {
  ...T3_OUTPUT,
  urgency: "high",
  decision: "route_to_specialist",
  route_team: "Support",
  follow_up_teams: [],
  kb_articles_used: [],
  customer_reply_draft: "ขออภัยครับ ทีมงานกำลังตรวจสอบให้ครับ",
  extracted: { product: "platform", product_detail: "Web App", issue_types: ["access_problem"], sentiment: "negative", language: "th" },
};

describe("agent loop", () => {
  it("runs the requested tools, sends results back, and returns a validated result", async () => {
    const llm = new FakeLlmClient([
      toolCalls(
        { name: "get_customer_history", args: { customer_id: "C-3001" } },
        { name: "search_knowledge_base", args: { query: "dark mode system default" } },
      ),
      finalAnswer(T3_OUTPUT),
    ]);

    const result = await triageTicket(sampleTicket("T3"), { llm });

    expect(result).toMatchObject({
      ticket_id: "T3",
      decision: "auto_respond",
      kb_articles_used: ["KB-101"],
      guardrails_applied: [],
    });

    // First request: system prompt, the whole ticket thread, and every tool definition.
    const [first, second] = llm.requests;
    // System prompt, the ticket, then the lookups the agent made itself (customer history and billing).
    expect(first!.messages.map((m) => m.role)).toEqual(["system", "user", "assistant", "tool", "tool"]);
    expect(first!.messages[1]!.content).toContain("schedule dark mode");
    expect(first!.tools.map((t) => t.name)).toContain("search_knowledge_base");

    // Second request: the assistant's tool calls followed by one tool message per call.
    const toolMessages = second!.messages.filter((m) => m.role === "tool");
    expect(toolMessages).toHaveLength(4); // 2 prefetched + 2 requested by the model
    const kbReply = JSON.parse(toolMessages[3]!.content);
    expect(kbReply.ok).toBe(true);
    expect(kbReply.data[0].id).toBe("KB-101");
  });

  it("catches a mislabeled ticket with the prefetched billing facts, even if the model calls no tool", async () => {
    // The fooled model calls T1 a how-to and answers right away; the agent had already looked up billing.
    const llm = new FakeLlmClient([finalAnswer({ ...T3_OUTPUT, follow_up_teams: [], extracted: { ...T3_OUTPUT.extracted, issue_types: ["how_to"] } })]);

    const result = await triageTicket(sampleTicket("T1"), { llm });

    expect(result).toMatchObject({ decision: "escalate_to_human", route_team: "Billing", urgency: "high" });
  });

  it("tidies the reply: plain quotes and no internal team IDs", async () => {
    const reply = "I’m sorry. Our Engineering_Incident team is looking into it.";
    const llm = new FakeLlmClient([finalAnswer({ ...T2_LIKE_OUTPUT, customer_reply_draft: reply, extracted: { ...T2_LIKE_OUTPUT.extracted, language: "en" } })]);

    const result = await triageTicket(sampleTicket("T3"), { llm });

    expect(result.customer_reply_draft).toBe("I'm sorry. Our engineering team is looking into it.");
  });

  it("reports each tool call through onEvent", async () => {
    const events: AgentEvent[] = [];
    const llm = new FakeLlmClient([
      toolCalls({ name: "get_customer_history", args: { customer_id: "C-3001" } }),
      finalAnswer({ ...T3_OUTPUT, kb_articles_used: [] }),
    ]);

    await triageTicket(sampleTicket("T3"), { llm, onEvent: (e) => events.push(e) });

    expect(events.map((e) => (e.type === "tool_call" ? e.call.name : e.type))).toEqual([
      "get_customer_history", // prefetched
      "get_billing_transactions", // prefetched
      "get_customer_history", // requested by the model
    ]);
  });

  it("applies the policy: a KB ID that was never retrieved does not count", async () => {
    // The model claims KB-101 without ever searching, so auto_respond is not allowed (rule 4).
    const llm = new FakeLlmClient([finalAnswer(T3_OUTPUT)]);

    const result = await triageTicket(sampleTicket("T3"), { llm });

    expect(result.kb_articles_used).toEqual([]);
    expect(result.decision).toBe("route_to_specialist");
  });

  it("switches tools off on the last allowed call so the model must answer", async () => {
    const llm = new FakeLlmClient([
      ...Array.from({ length: DEFAULT_MAX_ITERATIONS - 1 }, () =>
        toolCalls({ name: "get_customer_history", args: { customer_id: "C-3001" } }),
      ),
      finalAnswer({ ...T3_OUTPUT, kb_articles_used: [], decision: "route_to_specialist" }),
    ]);

    const result = await triageTicket(sampleTicket("T3"), { llm });

    expect(llm.requests.map((r) => r.toolChoice)).toEqual(["auto", "auto", "auto", "auto", "none"]);
    expect(result.guardrails_applied.some((g) => g.startsWith("fail_safe"))).toBe(false);
  });

  it("gives the policy the plan from customer history, not only the free-text info", async () => {
    // The ticket text does not say "Enterprise", but the customer history tool does.
    const ticket = { ...sampleTicket("T2"), customer: { id: "C-2001", info: "Customer in Thailand" } };
    const llm = new FakeLlmClient([
      toolCalls({ name: "get_customer_history", args: { customer_id: "C-2001" } }),
      finalAnswer({ ...T2_LIKE_OUTPUT, extracted: { ...T2_LIKE_OUTPUT.extracted, issue_types: ["outage"] } }),
    ]);

    const result = await triageTicket(ticket, { llm });

    expect(result).toMatchObject({ urgency: "critical", route_team: "Engineering_Incident" });
  });

  it("confirms an access problem as an outage when the customer's region is degraded", async () => {
    const llm = new FakeLlmClient([
      toolCalls(
        { name: "get_customer_history", args: { customer_id: "C-2001" } },
        { name: "check_service_status", args: { region: "asia" } },
      ),
      finalAnswer({ ...T2_LIKE_OUTPUT, extracted: { ...T2_LIKE_OUTPUT.extracted, issue_types: ["access_problem"] } }),
    ]);

    const result = await triageTicket(sampleTicket("T2"), { llm });

    expect(result).toMatchObject({ urgency: "critical", route_team: "Engineering_Incident" });
  });

  it("cannot read another customer, and the refused lookup changes nothing", async () => {
    // A fooled model looks up a Pro customer for the Enterprise outage ticket T2.
    const llm = new FakeLlmClient([
      toolCalls({ name: "get_customer_history", args: { customer_id: "C-3001" } }),
      finalAnswer({ ...T2_LIKE_OUTPUT, extracted: { ...T2_LIKE_OUTPUT.extracted, issue_types: ["outage"] } }),
    ]);

    const result = await triageTicket(sampleTicket("T2"), { llm });

    const toolReply = JSON.parse(llm.requests[1]!.messages.at(-1)!.content!);
    expect(toolReply).toEqual({ ok: false, error: "Only the ticket's customer (C-2001) can be looked up" });
    expect(result).toMatchObject({ urgency: "critical", route_team: "Engineering_Incident" });
  });

  it("feeds tool errors back to the model so it can recover", async () => {
    const llm = new FakeLlmClient([
      toolCalls({ name: "get_customer_history", args: { customer_id: "WRONG" } }),
      toolCalls({ name: "get_customer_history", args: { customer_id: "C-3001" } }),
      finalAnswer({ ...T3_OUTPUT, kb_articles_used: [], decision: "route_to_specialist" }),
    ]);

    const result = await triageTicket(sampleTicket("T3"), { llm });

    const firstToolReply = llm.requests[1]!.messages.at(-1)!;
    expect(JSON.parse(firstToolReply.content!)).toMatchObject({ ok: false });
    expect(result.decision).toBe("route_to_specialist");
  });
});

describe("fail safe: always escalate to a human, never throw", () => {
  it(`stops after ${DEFAULT_MAX_ITERATIONS} LLM calls when the model keeps calling tools`, async () => {
    const endless = Array.from({ length: 10 }, () =>
      toolCalls({ name: "get_customer_history", args: { customer_id: "C-3001" } }),
    );
    const llm = new FakeLlmClient(endless);

    const result = await triageTicket(sampleTicket("T3"), { llm });

    expect(llm.requests).toHaveLength(DEFAULT_MAX_ITERATIONS);
    expect(result.decision).toBe("escalate_to_human");
    expect(result.internal_note).toMatch(/max iterations/);
    expect(result.guardrails_applied[0]).toMatch(/^fail_safe:/);
  });

  it("escalates when the output is not JSON", async () => {
    const llm = new FakeLlmClient([{ type: "final", content: "Sure! This ticket looks urgent." }]);
    const result = await triageTicket(sampleTicket("T3"), { llm });
    expect(result.decision).toBe("escalate_to_human");
    expect(result.internal_note).toMatch(/not valid JSON/);
  });

  it("escalates when the output does not match the schema", async () => {
    const llm = new FakeLlmClient([finalAnswer({ ...T3_OUTPUT, urgency: "super urgent" })]);
    const result = await triageTicket(sampleTicket("T3"), { llm });
    expect(result.decision).toBe("escalate_to_human");
    expect(result.internal_note).toMatch(/does not match the schema/);
  });

  it("escalates on an API error or timeout", async () => {
    const llm = new FakeLlmClient([new Error("Request timed out.")]);
    const result = await triageTicket(sampleTicket("T3"), { llm });
    expect(result).toMatchObject({ decision: "escalate_to_human", confidence: 0, route_team: "Support" });
    expect(result.internal_note).toContain("Request timed out.");
  });

  it("marks a rejected API key or model as a configuration error", async () => {
    const events: AgentEvent[] = [];
    const llm = new FakeLlmClient([new LlmConfigError("OpenAI rejected the request (401)")]);

    const result = await triageTicket(sampleTicket("T3"), { llm, onEvent: (e) => events.push(e) });

    expect(result.decision).toBe("escalate_to_human");
    expect(events.filter((e) => e.type === "fail_safe")).toEqual([
      { type: "fail_safe", reason: "OpenAI rejected the request (401)", configError: true },
    ]);
  });

  it("hands a failed ticket to a person, still using the prefetched facts", async () => {
    // Without the model's classification there is nothing to route on: a person triages it.
    // The prefetched billing lookup still found T1's unresolved payment, so it goes to Billing.
    const t1 = await triageTicket(sampleTicket("T1"), { llm: new FakeLlmClient([new Error("API down")]) });
    expect(t1).toMatchObject({ decision: "escalate_to_human", route_team: "Billing", urgency: "high" });

    const t2 = await triageTicket(sampleTicket("T2"), { llm: new FakeLlmClient([new Error("API down")]) });
    expect(t2).toMatchObject({ decision: "escalate_to_human", route_team: "Support", urgency: "high" });
    expect(t2.extracted.language).toBe("th");
  });
});
