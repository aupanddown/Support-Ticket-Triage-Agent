import OpenAI from "openai";
import { zodResponseFormat } from "openai/helpers/zod";
import type {
  ChatCompletion,
  ChatCompletionMessageParam,
  ChatCompletionTool,
} from "openai/resources/chat/completions";
import type { z } from "zod";
import type { AppConfig } from "../config.js";
import type { ToolCall, ToolSpec } from "../tools/index.js";

// ---------- Provider-neutral types used by the agent ----------

export interface LlmToolCall extends ToolCall {
  id: string;
}

export type ChatMessage =
  | { role: "system"; content: string }
  | { role: "user"; content: string }
  | { role: "assistant"; content: string | null; toolCalls?: LlmToolCall[] }
  | { role: "tool"; toolCallId: string; content: string };

export interface LlmRequest {
  messages: ChatMessage[];
  tools: ToolSpec[];
  /** Schema the final answer must follow (structured output). */
  output: { name: string; schema: z.ZodType };
}

/** Either the model wants to call tools, or it gives its final answer as a JSON string. */
export type LlmResponse =
  | { type: "tool_calls"; calls: LlmToolCall[] }
  | { type: "final"; content: string };

/**
 * The only thing the agent knows about the model.
 * Production uses OpenAiLlmClient; tests inject a scripted fake, so they run without an API key.
 */
export interface LlmClient {
  complete(request: LlmRequest): Promise<LlmResponse>;
}

// ---------- OpenAI implementation ----------

export class OpenAiLlmClient implements LlmClient {
  constructor(
    private readonly openai: OpenAI,
    private readonly model: string,
  ) {}

  async complete(request: LlmRequest): Promise<LlmResponse> {
    const completion = await this.openai.chat.completions.create({
      model: this.model,
      messages: request.messages.map(toOpenAiMessage),
      tools: request.tools.map(toOpenAiTool),
      // Used only when the model answers instead of calling a tool.
      response_format: zodResponseFormat(request.output.schema, request.output.name),
    });
    return fromOpenAiCompletion(completion);
  }
}

/** Creates the real client. Fails with a clear message if no API key is configured. */
export function createOpenAiLlmClient(config: AppConfig["openai"]): OpenAiLlmClient {
  if (!config.apiKey) {
    throw new Error("OPENAI_API_KEY is not set. Copy .env.example to .env and add your key.");
  }
  const openai = new OpenAI({
    apiKey: config.apiKey,
    timeout: config.timeoutMs,
    maxRetries: config.maxRetries, // SDK retries with exponential backoff
  });
  return new OpenAiLlmClient(openai, config.model);
}

// ---------- Mapping between our types and OpenAI's (pure, unit tested) ----------

export function toOpenAiMessage(message: ChatMessage): ChatCompletionMessageParam {
  switch (message.role) {
    case "system":
    case "user":
      return { role: message.role, content: message.content };
    case "assistant":
      return {
        role: "assistant",
        content: message.content,
        ...(message.toolCalls?.length && {
          tool_calls: message.toolCalls.map((call) => ({
            id: call.id,
            type: "function" as const,
            function: { name: call.name, arguments: call.arguments },
          })),
        }),
      };
    case "tool":
      return { role: "tool", tool_call_id: message.toolCallId, content: message.content };
  }
}

export function toOpenAiTool(spec: ToolSpec): ChatCompletionTool {
  return {
    type: "function",
    function: { name: spec.name, description: spec.description, parameters: spec.parameters },
  };
}

export function fromOpenAiCompletion(completion: ChatCompletion): LlmResponse {
  const message = completion.choices[0]?.message;
  if (!message) throw new Error("OpenAI returned no choices");
  if (message.refusal) throw new Error(`Model refused: ${message.refusal}`);

  const calls = (message.tool_calls ?? [])
    .filter((call) => call.type === "function")
    .map((call) => ({ id: call.id, name: call.function.name, arguments: call.function.arguments }));
  if (calls.length > 0) return { type: "tool_calls", calls };

  if (!message.content) throw new Error("OpenAI returned neither tool calls nor content");
  return { type: "final", content: message.content };
}
