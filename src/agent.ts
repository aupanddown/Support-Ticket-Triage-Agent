import { z } from "zod";
import { detectLanguage } from "./language.js";
import type { ChatMessage, LlmClient } from "./llm/client.js";
import { applyPolicy, safeReply } from "./policy.js";
import { buildUserMessage, SYSTEM_PROMPT } from "./prompts/system.js";
import { LlmTriageOutput, type Ticket, TriageResult } from "./schemas.js";
import { executeTool, getToolSpecs, TOOLS, type ToolCall, type ToolResult } from "./tools/index.js";
import { knowledgeBaseTool } from "./tools/knowledgeBase.js";
import type { Tool } from "./tools/tool.js";

export const DEFAULT_MAX_ITERATIONS = 5;

/** Emitted while the agent runs; used for logging and evaluation. */
export type AgentEvent =
  | { type: "tool_call"; call: ToolCall; result: ToolResult }
  | { type: "fail_safe"; reason: string };

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
 * 2. While the LLM asks for tools: run them and send the results back (max `maxIterations` LLM calls).
 * 3. Validate the final answer with zod, then apply the deterministic policy.
 *
 * Never throws: on any failure (API error, timeout, invalid output, too many iterations)
 * it returns a fail-safe result that escalates to a human and explains why.
 */
export async function triageTicket(ticket: Ticket, options: AgentOptions): Promise<TriageResult> {
  const { llm, tools = TOOLS, maxIterations = DEFAULT_MAX_ITERATIONS, onEvent } = options;
  const retrievedKbIds = new Set<string>();

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
        output: { name: "triage_result", schema: LlmTriageOutput },
      });

      if (response.type === "final") {
        const output = parseLlmOutput(response.content);
        const result: TriageResult = { ticket_id: ticket.id, ...output, guardrails_applied: [] };
        return finalize(result, ticket, [...retrievedKbIds]);
      }

      messages.push({ role: "assistant", content: null, toolCalls: response.calls });
      for (const call of response.calls) {
        const result = await executeTool(call, tools);
        onEvent?.({ type: "tool_call", call, result });
        for (const id of kbIdsFrom(call, result)) retrievedKbIds.add(id);
        messages.push({ role: "tool", toolCallId: call.id, content: JSON.stringify(result) });
      }
    }

    throw new Error(`No final answer after ${maxIterations} LLM calls (max iterations reached)`);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    onEvent?.({ type: "fail_safe", reason });
    return failSafeResult(ticket, reason);
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
function finalize(result: TriageResult, ticket: Ticket, retrievedKbIds: string[]): TriageResult {
  return TriageResult.parse(applyPolicy(result, { ticket, retrievedKbIds }));
}

/** Remembers which KB articles were really retrieved, so the policy can reject invented IDs. */
function kbIdsFrom(call: ToolCall, result: ToolResult): string[] {
  if (call.name !== knowledgeBaseTool.name || !result.ok || !Array.isArray(result.data)) return [];
  return result.data.map((article: { id: string }) => article.id);
}

/**
 * When automation fails, a human takes over. Urgency starts at "high" so the ticket is looked at soon;
 * the policy still runs, so e.g. a billing ticket goes to Billing and an Enterprise outage becomes critical.
 */
export function failSafeResult(ticket: Ticket, reason: string): TriageResult {
  const language = detectLanguage(ticket.messages.map((m) => m.text).join("\n"));
  const result: TriageResult = {
    ticket_id: ticket.id,
    urgency: "high",
    extracted: { product: "unknown", issue_type: "unknown", sentiment: "neutral", language },
    decision: "escalate_to_human",
    route_team: "Support",
    kb_articles_used: [],
    customer_reply_draft: safeReply(language, "general"),
    internal_note: `Automatic triage failed: ${reason}. Please triage this ticket manually.`,
    confidence: 0,
    guardrails_applied: [`fail_safe: ${reason}`],
  };
  return finalize(result, ticket, []);
}
