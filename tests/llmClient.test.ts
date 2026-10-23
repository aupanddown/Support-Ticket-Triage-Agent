import type { ChatCompletion } from "openai/resources/chat/completions";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { createOpenAiLlmClient, fromOpenAiCompletion, toOpenAiMessage } from "../src/llm/client.js";

/** Builds a minimal ChatCompletion with one choice. */
function completion(message: Record<string, unknown>): ChatCompletion {
  return {
    id: "x",
    object: "chat.completion",
    created: 0,
    model: "test",
    choices: [{ index: 0, finish_reason: "stop", logprobs: null, message: { role: "assistant", refusal: null, ...message } }],
  } as ChatCompletion;
}

describe("OpenAI mapping", () => {
  it("maps an assistant message with tool calls and a tool result", () => {
    expect(
      toOpenAiMessage({ role: "assistant", content: null, toolCalls: [{ id: "c1", name: "t", arguments: "{}" }] }),
    ).toEqual({
      role: "assistant",
      content: null,
      tool_calls: [{ id: "c1", type: "function", function: { name: "t", arguments: "{}" } }],
    });
    expect(toOpenAiMessage({ role: "tool", toolCallId: "c1", content: "{}" })).toEqual({
      role: "tool",
      tool_call_id: "c1",
      content: "{}",
    });
  });

  it("reads tool calls from a completion", () => {
    const response = fromOpenAiCompletion(
      completion({
        content: null,
        tool_calls: [{ id: "c1", type: "function", function: { name: "check_service_status", arguments: "{}" } }],
      }),
    );
    expect(response).toEqual({ type: "tool_calls", calls: [{ id: "c1", name: "check_service_status", arguments: "{}" }] });
  });

  it("reads a final answer from a completion", () => {
    expect(fromOpenAiCompletion(completion({ content: '{"urgency":"low"}' }))).toEqual({
      type: "final",
      content: '{"urgency":"low"}',
    });
  });

  it("throws on a refusal or an empty message (the agent turns this into a fail-safe)", () => {
    expect(() => fromOpenAiCompletion(completion({ content: null, refusal: "I can't help" }))).toThrow(/refused/);
    expect(() => fromOpenAiCompletion(completion({ content: null }))).toThrow(/neither/);
  });

  it("explains a missing API key", () => {
    expect(() => createOpenAiLlmClient(loadConfig({}).openai)).toThrow(/OPENAI_API_KEY is not set/);
  });
});
