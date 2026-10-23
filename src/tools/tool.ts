import type { z } from "zod";

/**
 * A capability the agent can call.
 *
 * Least privilege: every tool is READ-ONLY. A handler may look things up but must never
 * change state (no refunds, no plan changes, no outgoing messages). Anything that moves
 * money or changes an account is done by a human after escalation.
 */
export interface Tool<Args extends z.ZodObject = z.ZodObject> {
  /** Name the model uses to call the tool, in snake_case. */
  name: string;
  /** Tells the model what the tool does and when to call it. */
  description: string;
  /** Validates the model's arguments; also converted to JSON Schema for the model. */
  args: Args;
  /** Receives validated arguments. Throw an Error to report a problem back to the model. */
  handler(args: z.infer<Args>): Promise<unknown>;
}

/** Identity helper so TypeScript infers the handler's argument type from `args`. */
export function defineTool<Args extends z.ZodObject>(tool: Tool<Args>): Tool<Args> {
  return tool;
}
