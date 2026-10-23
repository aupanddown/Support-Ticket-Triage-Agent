import { z } from "zod";
import { type ChatMessage, type LlmClient, LlmConfigError } from "./llm/client.js";
import { applyPolicy, normalizeQuotes, type PolicyFacts, safeReply, safeReplyLanguage } from "./policy.js";
import { buildUserMessage, SYSTEM_PROMPT } from "./prompts/system.js";
import { LlmTriageOutput, type Ticket, TriageResult } from "./schemas.js";
import { executeTool, getToolSpecs, TOOLS, type ToolCall, type ToolResult } from "./tools/index.js";
import type { Tool } from "./tools/tool.js";

export const DEFAULT_MAX_ITERATIONS = 5;

/** Emitted while the agent runs; used for logging and evaluation. */
export type AgentEvent =
  | { type: "tool_call"; call: ToolCall; result: ToolResult }
  /** `configError`: the API key or model was rejected, so every other ticket will fail the same way. */
  | { type: "fail_safe"; reason: string; configError: boolean };

export interface AgentOptions {
  llm: LlmClient;
  tools?: readonly Tool[];
  maxIterations?: number;
  onEvent?: (event: AgentEvent) => void;
}

/**
 * Triages one ticket.
 *
 * 1. Send the system prompt and the ticket to the LLM, with the tool definitions.
 * 2. While the LLM asks for tools: run them (scoped to this ticket's customer), collect their facts,
 *    and send the results back (max `maxIterations` LLM calls).
 * 3. Validate the final answer with zod, then apply the deterministic policy using the facts.
 *
 * Never throws: on any failure (API error, timeout, invalid output, too many iterations)
 * it returns a fail-safe result that escalates to a human and explains why.
 */
export async function triageTicket(ticket: Ticket, options: AgentOptions): Promise<TriageResult> {
  const { llm, tools = TOOLS, maxIterations = DEFAULT_MAX_ITERATIONS, onEvent } = options;
  let facts: PolicyFacts = {};

  try {
    const messages: ChatMessage[] = [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: buildUserMessage(ticket) },
    ];
    const toolSpecs = getToolSpecs(tools);

    for (let iteration = 1; iteration <= maxIterations; iteration++) {
      const response = await llm.complete({
        messages,
        tools: toolSpecs,
        // On the last allowed call, tools are switched off so the model must give its answer.
        toolChoice: iteration === maxIterations ? "none" : "auto",
        output: { name: "triage_result", schema: LlmTriageOutput },
      });

      if (response.type === "final") {
        const output = parseLlmOutput(response.content);
        const reply = tidyReply(output.customer_reply_draft);
        const result: TriageResult = { ticket_id: ticket.id, ...output, customer_reply_draft: reply, guardrails_applied: [] };
        return finalize(result, ticket, facts);
      }

      messages.push({ role: "assistant", content: null, toolCalls: response.calls });
      for (const call of response.calls) {
        const result = await executeTool(call, tools, { customerId: ticket.customer.id });
        onEvent?.({ type: "tool_call", call, result });
        const tool = tools.find((t) => t.name === call.name);
        if (result.ok && tool?.facts) facts = mergeFacts(facts, tool.facts(result.data));
        messages.push({ role: "tool", toolCallId: call.id, content: JSON.stringify(result) });
      }
    }

    throw new Error(`No final answer after ${maxIterations} LLM calls (max iterations reached)`);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    onEvent?.({ type: "fail_safe", reason, configError: error instanceof LlmConfigError });
    return failSafeResult(ticket, reason, facts);
  }
}

function parseLlmOutput(content: string): LlmTriageOutput {
  let json: unknown;
  try {
    json = JSON.parse(content);
  } catch {
    throw new Error("Model output is not valid JSON");
  }
  const parsed = LlmTriageOutput.safeParse(json);
  if (!parsed.success) throw new Error(`Model output does not match the schema: ${z.prettifyError(parsed.error)}`);
  return parsed.data;
}

/** Applies the guardrails, then validates the final shape once more. */
function finalize(result: TriageResult, ticket: Ticket, facts: PolicyFacts): TriageResult {
  return TriageResult.parse(applyPolicy(result, { ticket, facts }));
}

/** Combines facts from several tool calls: lists are merged, other values are replaced by the latest. */
function mergeFacts(current: PolicyFacts, next: PolicyFacts): PolicyFacts {
  const merged: Record<string, unknown> = { ...current };
  for (const [key, value] of Object.entries(next)) {
    const previous = merged[key];
    merged[key] = Array.isArray(previous) && Array.isArray(value) ? [...new Set([...previous, ...value])] : value;
  }
  return merged as PolicyFacts;
}

/**
 * Formatting only, before the policy: plain quotes, which display the same in every client
 * (email, SMS, apps), and no internal team ID in front of the customer.
 */
function tidyReply(reply: string): string {
  return normalizeQuotes(reply).replace(/\bEngineering_Incident(\s+team)?\b/g, "engineering team");
}

/**
 * When automation fails, a human takes over. Urgency starts at "high" so the ticket is looked at soon;
 * the policy still runs with the facts gathered so far, so e.g. a billing ticket goes to Billing and
 * an Enterprise outage becomes critical.
 */
export function failSafeResult(ticket: Ticket, reason: string, facts: PolicyFacts = {}): TriageResult {
  const language = safeReplyLanguage(ticket);
  const result: TriageResult = {
    ticket_id: ticket.id,
    urgency: "high",
    extracted: { product: "other", issue_types: ["other"], sentiment: "neutral", language },
    decision: "escalate_to_human",
    route_team: "Support",
    follow_up_teams: [],
    kb_articles_used: [],
    customer_reply_draft: safeReply(language, "general"),
    internal_note: `Automatic triage failed: ${reason}. Please triage this ticket manually.`,
    confidence: 0,
    guardrails_applied: [`fail_safe: ${reason}`],
  };
  return finalize(result, ticket, facts);
}
