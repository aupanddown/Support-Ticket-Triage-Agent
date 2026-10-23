import type { z } from "zod";
import type { PolicyFacts } from "../policy/index.js";

/**
 * A capability the agent can call.
 *
 * Least privilege: every tool is READ-ONLY. A handler may look things up but must never
 * change state (no refunds, no plan changes, no outgoing messages). Anything that moves
 * money or changes an account is done by a human after escalation. A tool that looks up a
 * customer declares which argument holds the ID (`customerIdArg`), and may then only be called
 * for the ticket's own customer (enforced in tools/index.ts).
 */
export interface Tool<Args extends z.ZodObject = z.ZodObject, Result = unknown> {
  /** Name the model uses to call the tool, in snake_case. */
  name: string;
  /** Tells the model what the tool does and when to call it. */
  description: string;
  /** Validates the model's arguments; also converted to JSON Schema for the model. */
  args: Args;
  /** Name of the argument holding a customer ID, if any. Calls for any other customer are refused. */
  customerIdArg?: keyof z.infer<Args> & string;
  /**
   * Run by the agent itself before the first model call, for the ticket's customer (needs
   * `customerIdArg`). For lookups the policy relies on, so their facts never depend on the model.
   */
  prefetch?: boolean;
  /** Receives validated arguments. Throw an Error to report a problem back to the model. */
  handler(args: z.infer<Args>): Promise<Result>;
  /**
   * Optional: evidence for the guardrail policy taken from this tool's result
   * (e.g. the customer's plan). Lets the policy rely on data instead of the model's words.
   */
  facts?(data: Result): PolicyFacts;
}

/** Identity helper so TypeScript infers the argument and result types from `args` and `handler`. */
export function defineTool<Args extends z.ZodObject, Result>(tool: Tool<Args, Result>): Tool<Args, Result> {
  return tool;
}
