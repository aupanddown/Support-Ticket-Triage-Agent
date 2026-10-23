import type { LlmClient, LlmRequest, LlmResponse, LlmToolCall } from "../src/llm/client.js";
import type { LlmTriageOutput } from "../src/schemas.js";

/** One scripted step: a response to return, or an error to throw (e.g. a timeout). */
export type ScriptStep = LlmResponse | Error;

/**
 * A scripted stand-in for the real model. Returns the steps in order and records every
 * request, so tests can check what the agent sent. No network, no API key, same result every run.
 */
export class FakeLlmClient implements LlmClient {
  readonly requests: LlmRequest[] = [];
  private readonly script: ScriptStep[];

  constructor(script: ScriptStep[]) {
    this.script = [...script];
  }

  async complete(request: LlmRequest): Promise<LlmResponse> {
    // Copy the messages: the agent keeps appending to the same array.
    this.requests.push({ ...request, messages: [...request.messages] });

    const step = this.script.shift();
    if (!step) throw new Error("FakeLlmClient: no scripted response left");
    if (step instanceof Error) throw step;
    return step;
  }
}

// ---------- Helpers to write scripts briefly ----------

let nextCallId = 1;

export function toolCalls(...calls: Array<{ name: string; args: unknown }>): LlmResponse {
  return {
    type: "tool_calls",
    calls: calls.map(({ name, args }): LlmToolCall => ({
      id: `call_${nextCallId++}`,
      name,
      arguments: JSON.stringify(args),
    })),
  };
}

export function finalAnswer(output: LlmTriageOutput | Record<string, unknown>): LlmResponse {
  return { type: "final", content: JSON.stringify(output) };
}
