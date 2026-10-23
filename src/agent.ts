import { z } from "zod";
import { type ChatMessage, type LlmClient, LlmConfigError, type LlmToolCall } from "./llm/client.js";
import { applyPolicy, normalizeQuotes, type PolicyFacts, safeReply, safeReplyLanguage } from "./policy/index.js";
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
 * 1. Run the lookups the policy relies on (tools marked `prefetch`: customer history, billing) in code,
 *    so their facts never depend on the model choosing to call them. The model sees them as results.
 * 2. Send the system prompt, the ticket and those results to the LLM, with the tool definitions.
 * 3. While the LLM asks for tools: run them (scoped to this ticket's customer), collect their facts,
 *    and send the results back (max `maxIterations` LLM calls).
 * 4. Validate the final answer with zod, then apply the deterministic policy using the facts.
 *
 * Never throws: on any failure (API error, timeout, invalid output, too many iterations)
 * it returns a fail-safe result that escalates to a human and explains why.
 */
export async function triageTicket(ticket: Ticket, options: AgentOptions): Promise<TriageResult> {
  const { llm, tools = TOOLS, maxIterations = DEFAULT_MAX_ITERATIONS, onEvent } = options;
  let facts: PolicyFacts = {};

  /** Runs tool calls, records their facts, and returns the messages that report them to the model. */
  const runTools = async (calls: LlmToolCall[]): Promise<ChatMessage[]> => {
    const reported: ChatMessage[] = [{ role: "assistant", content: null, toolCalls: calls }];
    for (const call of calls) {
      const result = await executeTool(call, tools, { customerId: ticket.customer.id });
      onEvent?.({ type: "tool_call", call, result });
      const tool = tools.find((t) => t.name === call.name);
      if (result.ok && tool?.facts) facts = mergeFacts(facts, tool.facts(result.data));
      reported.push({ role: "tool", toolCallId: call.id, content: JSON.stringify(result) });
    }
    return reported;
  };

  try {
    const messages: ChatMessage[] = [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: buildUserMessage(ticket) },
    ];
    const prefetch = prefetchCalls(ticket, tools);
    if (prefetch.length > 0) messages.push(...(await runTools(prefetch)));
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

      messages.push(...(await runTools(response.calls)));
    }

    throw new Error(`No final answer after ${maxIterations} LLM calls (max iterations reached)`);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    onEvent?.({ type: "fail_safe", reason, configError: error instanceof LlmConfigError });
    return failSafeResult(ticket, reason, facts);
  }
}

/** Calls for the tools marked `prefetch`, with the ticket's own customer ID. */
function prefetchCalls(ticket: Ticket, tools: readonly Tool[]): LlmToolCall[] {
  return tools
    .filter((tool) => tool.prefetch && tool.customerIdArg)
    .map((tool) => ({
      id: `prefetch_${tool.name}`,
      name: tool.name,
      arguments: JSON.stringify({ [tool.customerIdArg!]: ticket.customer.id }),
    }));
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
 * When automation fails, a human takes over: escalate_to_human to Support, urgency "high" so the
 * ticket is looked at soon, and a safe reply in the customer's language. There is no classification,
 * so the person triaging decides the right team.
 */
export function failSafeResult(ticket: Ticket, reason: string, facts: PolicyFacts = {}): TriageResult {
  const language = safeReplyLanguage(ticket);
  const result: TriageResult = {
    ticket_id: ticket.id,
    urgency: "high",
    extracted: { product: "other", product_detail: "unknown", issue_types: ["other"], sentiment: "neutral", language },
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
