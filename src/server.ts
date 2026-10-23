import Fastify, { type FastifyInstance } from "fastify";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import { triageTicket } from "./agent.js";
import { loadConfig } from "./config.js";
import { createOpenAiLlmClient, type LlmClient } from "./llm/client.js";
import { Ticket } from "./schemas.js";

export interface ServerOptions {
  llm: LlmClient;
  logger?: boolean;
}

/** Builds the HTTP API. Takes the LLM client as a parameter so tests can use a fake one. */
export function buildServer({ llm, logger = false }: ServerOptions): FastifyInstance {
  const app = Fastify({ logger });

  app.get("/health", async () => ({ status: "ok" }));

  app.post("/triage", async (request, reply) => {
    const parsed = Ticket.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "Invalid ticket", details: z.prettifyError(parsed.error) });
    }

    const ticket = parsed.data;
    // triageTicket never throws: failures come back as an escalate_to_human result.
    const result = await triageTicket(ticket, {
      llm,
      // Logs what happened, not the tool results themselves: those contain customer data.
      onEvent: (event) => {
        if (event.type === "tool_call") {
          request.log.info({ ticketId: ticket.id, tool: event.call.name, ok: event.result.ok }, "agent tool_call");
        } else {
          const log = event.configError ? request.log.error : request.log.warn;
          log.call(request.log, { ticketId: ticket.id, reason: event.reason }, "agent fail_safe");
        }
      },
    });
    if (result.guardrails_applied.length > 0) {
      request.log.info({ ticketId: ticket.id, guardrails: result.guardrails_applied }, "policy guardrails applied");
    }
    return result;
  });

  return app;
}

async function start(): Promise<void> {
  const config = loadConfig();
  const app = buildServer({ llm: createOpenAiLlmClient(config.openai), logger: true });

  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, () => void app.close());
  }

  await app.listen({ port: config.port, host: config.host });
}

// Start only when run directly (npm run serve), not when imported by tests.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  start().catch((error: unknown) => {
    console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
