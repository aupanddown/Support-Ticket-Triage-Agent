# Support Ticket Triage Agent

An AI agent that triages customer support tickets. For each ticket it:

1. classifies urgency (`critical` / `high` / `medium` / `low`)
2. extracts key information (product, issue type, customer sentiment, language)
3. searches a knowledge base for relevant articles
4. decides the next action: `auto_respond`, `route_to_specialist` or `escalate_to_human`
5. drafts a reply in the customer's language and writes an internal note for the support team

It uses an OpenAI GPT model with function calling and four read-only tools (customer history, knowledge base, billing, service status). A deterministic guardrail policy checks every result after the model. It runs as a CLI or as an HTTP API.

```
ticket ──> LLM <──> tools (read-only, mocked data)
            │
            v
      zod validation ──> guardrail policy ──> TriageResult (JSON)
            │
   any failure (API error, timeout, invalid output, too many steps)
            └──> fail-safe: escalate_to_human, with the reason
```

## Setup

Requirements: Node.js 22 or newer, and an OpenAI API key.

```bash
npm install
cp .env.example .env
```

Then open `.env` and set `OPENAI_API_KEY`. `OPENAI_MODEL` is optional; the default is `gpt-5.4-mini` (see `src/config.ts`). Other optional settings (timeout, retries, port, host) are listed in `.env.example`.

## Usage

### CLI

```bash
npm run triage -- --ticket T1            # one sample ticket (T1, T2 or T3)
npm run triage -- --all                  # all sample tickets
npm run triage -- --file examples/ticket.json
npm run triage -- --all --verbose        # also print each tool call
```

Results are printed to stdout as JSON; progress and tool calls go to stderr, so `npm run -s triage -- --all > results.json` gives clean JSON.

### HTTP API

```bash
npm run serve
```

| Method | Path | Body | Response |
|---|---|---|---|
| `GET` | `/health` | | `{ "status": "ok" }` |
| `POST` | `/triage` | a ticket (see `examples/ticket.json`) | `TriageResult`, or `400` with details if the ticket is invalid |

```bash
curl -s -X POST http://127.0.0.1:3000/triage \
  -H "content-type: application/json" \
  -d @examples/ticket.json
```

The API is plain JSON, so a web or Flutter client can call it directly. Set `HOST=0.0.0.0` to reach it from a phone or emulator on the local network.

### Tests, type check and evaluation

```bash
npm test             # all tests, no API key needed (uses a scripted fake LLM)
npm run typecheck
npm run eval         # runs the REAL agent on data/golden.json and prints a score table
```

## Project structure

```
src/
  config.ts              env validation (zod): model, timeout, retries, port
  schemas.ts             Ticket, TriageResult and enums (zod)
  agent.ts               agent loop: LLM <-> tools, max 5 LLM calls, validation, policy, fail-safe
  policy.ts              deterministic guardrails applied after the LLM (pure functions)
  language.ts            script-based language detection used by the policy
  llm/client.ts          LlmClient interface + OpenAI implementation
  prompts/
    system_prompt.md     the system prompt (exactly what the model receives)
    system.ts            loads the prompt, builds the user message
  tools/
    tool.ts              Tool interface + defineTool helper
    index.ts             tool registry, JSON Schema generation, safe tool execution
    customerHistory.ts   get_customer_history
    knowledgeBase.ts     search_knowledge_base (weighted keyword search, top 3)
    billing.ts           get_billing_transactions
    serviceStatus.ts     check_service_status
  tickets.ts             load and validate ticket files
  evaluation.ts          golden set checks and scoring
  cli.ts                 command line entry point
  server.ts              Fastify API
scripts/eval.ts          evaluation against the golden set (real API)
data/                    sample tickets, mock systems, KB articles, golden.json
examples/ticket.json     an extra ticket for --file and curl
tests/                   vitest tests (agent, policy, injection, tools, server, ...)
```

## Guardrail policy

The model decides first; `src/policy.ts` then applies these rules. They can only make the outcome safer, and every rule that changes something is recorded in `guardrails_applied`.

| Rule | Effect |
|---|---|
| verified KB articles | KB IDs the tools never returned are removed |
| R1 money | Refunds, charges, payments or disputes mentioned: `escalate_to_human`, `Billing`, urgency at least `high` |
| R1 no refund promise | A reply that promises a refund, reversal or credit is replaced with a safe reply |
| R2 enterprise outage | Enterprise customer with an outage or many affected users: `critical`, `escalate_to_human`, `Engineering_Incident` |
| R3 low confidence | Confidence below 0.7 is never auto-responded |
| R4 auto-respond requirements | `auto_respond` only for `low`/`medium` urgency with at least one KB article |
| R5 reply language | A reply in the wrong language is replaced and the ticket goes to a human |

## How to add a new tool

Two files: a new file in `src/tools/` and one line in `src/tools/index.ts`.

```ts
// src/tools/orderStatus.ts
import { z } from "zod";
import { defineTool } from "./tool.js";

export const orderStatusTool = defineTool({
  name: "get_order_status",
  description: "Look up the shipping status of an order. Call when the customer asks where an order is.",
  args: z.object({ order_id: z.string().min(1) }),
  async handler({ order_id }) {
    return { order_id, status: "shipped" }; // read-only lookup
  },
});
```

```ts
// src/tools/index.ts
export const TOOLS: readonly Tool[] = [customerHistoryTool, knowledgeBaseTool, billingTool, serviceStatusTool, orderStatusTool];
```

The JSON Schema for the model is generated from the zod schema, arguments are validated before the handler runs, and errors are returned to the model instead of crashing the agent. Then mention the tool in `src/prompts/system_prompt.md`; a test fails if a tool is not mentioned there.

## Sample output

Real results from `npm run triage -- --all` with `gpt-5.4-mini`:

> _Pending: to be pasted from a real run._

## Assumptions

- **Mock data instead of real systems.** Customers, billing, service status and the knowledge base are JSON files in `data/`, consistent with the sample tickets. The tools have the same shape a real integration would have.
- **Teams:** `Billing`, `Engineering_Incident`, `Product`, `Support`.
- **All tools are read-only.** No tool can issue refunds, change plans or send messages. Anything involving money is decided by a human.
- **The customer's plan comes from the ticket's customer info** for the policy (R2), and from `get_customer_history` for the model.
- **Language detection supports English and Thai**, the two languages in the samples. Adding a language means adding a code in `src/language.ts` and its safe replies in `src/policy.ts`.
- **Relative message times** ("3 hours ago") are kept as in the samples; a real system would use timestamps.

## Time spent

About _X_ hours.

## Future improvements

- **Queue and priority for high volume**, for example BullMQ on Redis, with critical tickets first.
- **Cheaper model by default, larger model on low confidence**: re-run uncertain tickets with a stronger model before escalating.
- **Prompt caching**: keep the system prompt and tool definitions as a stable prefix so repeated calls are cheaper and faster.
- **Batch API for non-urgent tickets**, at a lower price.
- **Cache KB and customer lookups** for repeated tickets from the same customer.
- **Vector search for the knowledge base** instead of keyword scoring, which also handles languages without spaces such as Thai.
- **Human review dashboard** to approve or correct drafts; corrections become new golden cases.
- More languages, real integrations, authentication and rate limiting on the API.
