import { z } from "zod";
import { billingTool } from "./billing.js";
import { customerHistoryTool } from "./customerHistory.js";
import { knowledgeBaseTool } from "./knowledgeBase.js";
import { serviceStatusTool } from "./serviceStatus.js";
import type { Tool } from "./tool.js";

/**
 * Every tool the agent can use.
 * To add a tool: create a new file in this folder with `defineTool(...)`, then add it to this list.
 */
export const TOOLS: readonly Tool[] = [
  customerHistoryTool,
  knowledgeBaseTool,
  billingTool,
  serviceStatusTool,
];

/** Provider-neutral tool description; the LLM client turns it into its own format. */
export interface ToolSpec {
  name: string;
  description: string;
  /** JSON Schema of the arguments, generated from the zod schema. */
  parameters: Record<string, unknown>;
}

/** A tool call exactly as the model produced it: arguments are a JSON string. */
export interface ToolCall {
  name: string;
  arguments: string;
}

export type ToolResult = { ok: true; data: unknown } | { ok: false; error: string };

export function getToolSpecs(tools: readonly Tool[] = TOOLS): ToolSpec[] {
  return tools.map(({ name, description, args }) => {
    const { $schema: _, ...parameters } = z.toJSONSchema(args);
    return { name, description, parameters };
  });
}

/**
 * Runs a tool call from the model.
 * Problems (unknown tool, bad JSON, invalid args, handler error) are returned as
 * `{ ok: false, error }` instead of thrown, so the model can read the error and recover.
 */
export async function executeTool(call: ToolCall, tools: readonly Tool[] = TOOLS): Promise<ToolResult> {
  const tool = tools.find((t) => t.name === call.name);
  if (!tool) return { ok: false, error: `Unknown tool "${call.name}"` };

  let rawArgs: unknown;
  try {
    rawArgs = JSON.parse(call.arguments || "{}");
  } catch {
    return { ok: false, error: "Tool arguments are not valid JSON" };
  }

  const parsed = tool.args.safeParse(rawArgs);
  if (!parsed.success) {
    return { ok: false, error: `Invalid arguments for ${call.name}: ${z.prettifyError(parsed.error)}` };
  }

  try {
    return { ok: true, data: await tool.handler(parsed.data) };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}
