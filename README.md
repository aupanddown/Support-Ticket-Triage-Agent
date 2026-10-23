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

(On Windows: `copy .env.example .env` in cmd, or `Copy-Item .env.example .env` in PowerShell.)

Then open `.env` and set `OPENAI_API_KEY`. `OPENAI_MODEL` is optional; the default is `gpt-5.4-mini` (see `src/config.ts`). Any other model must support function calling together with structured outputs (`json_schema`). Other optional settings (timeout, retries, port, host) are listed in `.env.example`.

If the API key or model does not work, the agent does not crash: each ticket is escalated to a human with the reason, and the CLI prints a warning.

## Usage

### CLI

```bash
npm run triage -- --ticket T1            # one sample ticket (T1, T2 or T3)
npm run triage -- --all                  # all sample tickets
npm run triage -- --all --verbose        # also print each tool call
npm run triage -- --file path/to/tickets.json   # your own file: one ticket or an array
```

Results are printed to stdout as JSON; progress and tool calls go to stderr, so `npm run -s triage -- --all > results.json` gives clean JSON.

### Interactive mode (manual testing)

```bash
npm run chat
```

Pick a sample ticket (T1, T2 or T3). The agent triages the whole thread right away and prints a readable summary: the customer messages, each tool call, the result (urgency, decision, team, KB articles, guardrails), the reply draft and the internal note. You can then type a follow-up message as the customer (for example a prompt injection) to see how the agent and the guardrails react. `/json` shows the raw result, `/new` picks another ticket and `/quit` exits.

### HTTP API

```bash
npm run serve
```

| Method | Path | Body | Response |
|---|---|---|---|
| `GET` | `/health` | | `{ "status": "ok" }` |
| `POST` | `/triage` | one ticket, in the same shape as each item of `data/tickets.json` | `TriageResult`, or `400` with details if the ticket is invalid |

Example: send sample ticket T1 (the first item of `data/tickets.json`) to the running server:

```bash
node -e "process.stdout.write(JSON.stringify(require('./data/tickets.json')[0]))" | curl -s -X POST http://127.0.0.1:3000/triage -H "content-type: application/json" -d @-
```

On Windows PowerShell, use `curl.exe` instead of `curl`. Set `HOST=0.0.0.0` to accept connections from other machines.

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
  chat.ts                interactive terminal mode for manual testing
  server.ts              Fastify API
scripts/eval.ts          evaluation against the golden set (real API)
data/                    sample tickets, mock systems, KB articles, golden.json
tests/                   vitest tests (agent, policy, injection, tools, server, ...)
```

## Guardrail policy

The model decides first; `src/policy.ts` then applies these rules. They can only make the outcome safer, and every rule that changes something is recorded in `guardrails_applied`.

| Rule | Effect |
|---|---|
| verified KB articles | KB IDs the tools never returned are removed |
| R1 money | Refunds, disputes, duplicate or failed charges (in the text or in the model's classification): `escalate_to_human`, `Billing`, urgency at least `high`. Plain pricing or invoice questions are not matched |
| R1 no refund promise | A reply that promises a refund, reversal or credit is replaced with a safe reply |
| R2 enterprise outage | Enterprise customer (plan from customer history) with outage evidence (5xx errors, cannot access, or the model classified an outage): `critical`, `escalate_to_human`, `Engineering_Incident` |
| R3 low confidence | Confidence below 0.7 is never auto-responded |
| R4 auto-respond requirements | `auto_respond` only for `low`/`medium` urgency with at least one KB article |
| R5 reply language | A reply in a different writing system than the ticket (Thai vs Latin vs other) goes to a human; it is replaced when a safe reply exists in that language (English, Thai) |

Every change is also appended to `internal_note` as a `[Policy]` line, so the note always matches the final routing. `auto_respond` with a `route_team` means the reply is sent automatically and that team gets a follow-up item (for example a bug report for `Product`).

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

Real results for the three sample tickets from the latest `npm run eval` run with `gpt-5.4-mini` (the same agent and policy as `npm run triage`). Model output varies a little between runs; in this run T3 left `route_team` empty, which the eval reports as its one miss.

### T1: triple charge, presentation in 2 hours

```json
{
  "ticket_id": "T1",
  "urgency": "critical",
  "extracted": {
    "product": "Billing / Pro upgrade",
    "issue_type": "duplicate_charge_payment_failed_upgrade",
    "sentiment": "angry",
    "language": "en"
  },
  "decision": "escalate_to_human",
  "route_team": "Billing",
  "kb_articles_used": [
    "KB-201",
    "KB-202",
    "KB-203"
  ],
  "customer_reply_draft": "Hi Jordan, I’m sorry for the trouble here. I can see the Pro upgrade was attempted 3 times today, your account is still on Free, and there are 3 captured charges for $29.99 each on different cards, while the plan activation failed.\n\nThe Billing team needs to review these charges and the failed activation. The Pro export features will become available once the plan is active, and I’ve marked this as urgent since you have a presentation in 2 hours.\n\nPlease do not open a bank dispute yet, since that can lock the account while the charges are being investigated. A specialist will review this as soon as possible.",
  "internal_note": "Customer is on Free plan, attempted Pro upgrade 3 times today, and now has three captured charges: TX-9001 ($29.99, card 4242), TX-9002 ($29.99, card 5511), TX-9003 ($29.99, card 5511). Pending upgrade status: activation_failed, payment captured but plan activation did not complete. Customer says they need Pro export features for a presentation in 2 hours and threatened to dispute all charges by end of day if not reversed. This is a money issue plus urgent deadline, so escalate to Billing. Also note the customer retried with different cards after a failed payment, which matches KB guidance about duplicate charges/pending authorizations.",
  "confidence": 0.98,
  "guardrails_applied": []
}
```

### T2: Enterprise outage in Thailand

```json
{
  "ticket_id": "T2",
  "urgency": "critical",
  "extracted": {
    "product": "Web App",
    "issue_type": "outage",
    "sentiment": "angry",
    "language": "th"
  },
  "decision": "escalate_to_human",
  "route_team": "Engineering_Incident",
  "kb_articles_used": [
    "KB-301"
  ],
  "customer_reply_draft": "ขอบคุณที่แจ้งเข้ามาครับ ตอนนี้เราดูแล้วพบว่า region Asia มีปัญหาจริง แม้ status page จะยังขึ้นว่า all systems operational อยู่ก็ตาม\n\nจากที่คุณแจ้งมา, error 500 เกิดกับหลายเบราว์เซอร์และหลายเครื่อง และมีเพื่อนร่วมงานเข้าไม่ได้ด้วย ซึ่งสอดคล้องกับปัญหาฝั่งระบบมากกว่าฝั่งเครื่องผู้ใช้\n\nทีมที่เกี่ยวข้องได้รับเคสนี้แล้วและกำลังตรวจสอบอยู่ครับ คุณมี demo กับลูกค้ารายใหญ่ในบ่ายนี้ เราเข้าใจว่ากระทบงานมากและจะเร่งดูให้ที่สุด\n\nถ้ามีอัปเดตเพิ่มเติมระหว่างนี้ เราจะแจ้งกลับทันทีครับ",
  "internal_note": "Enterprise customer in Thailand/Asia, 45 seats, daily active, first critical issue. Reports HTTP 500 login/access failure for 2 hours, reproducible across multiple browsers and devices, affecting coworkers too. Customer says they have a large customer demo this afternoon and could lose the deal if service is not restored. Public status page still says all systems operational, but internal monitoring shows Asia Web App degraded: HTTP 500 error rate 42% from ap-southeast load balancer since about 2 hours ago, API also degraded. KB-301 supports likely service issue. Route to Engineering_Incident, critical urgency due to outage and imminent business deadline.",
  "confidence": 0.98,
  "guardrails_applied": []
}
```

### T3: dark mode question, bug and feature request

```json
{
  "ticket_id": "T3",
  "urgency": "low",
  "extracted": {
    "product": "Appearance settings",
    "issue_type": "how_to_feature_request",
    "sentiment": "neutral",
    "language": "en"
  },
  "decision": "auto_respond",
  "route_team": null,
  "kb_articles_used": [
    "KB-101",
    "KB-102"
  ],
  "customer_reply_draft": "Yes, we support dark mode through Settings > Appearance.\n\nOn Pro, the available options are Light and System Default. There isn’t a separate Dark toggle yet. System Default should follow your Mac’s appearance, so if your Mac is set to dark mode, the app should switch too.\n\nIf it stays light after you choose System Default, please try:\n1. Fully quit and reopen the app after changing your Mac’s theme.\n2. Make sure you’re on the latest app version.\n3. If you’re using the browser, check whether an extension is forcing a light theme.\n\nFor scheduling, the app doesn’t have its own dark mode schedule yet. The workaround on macOS is to set your Mac to switch automatically: System Settings > Appearance > Auto. That will change between light and dark based on time of day.\n\nHelp article: https://help.company.com/articles/appearance-settings\nScheduling article: https://help.company.com/articles/schedule-theme\n\nIf you’d like, you can also share the scheduling idea with support as a feature request.",
  "internal_note": "Customer on Pro plan, macOS desktop app, 5 months active, no prior tickets. Asked about dark mode, then reported System Default stays light even when macOS is set to dark. KB says System Default should follow OS theme, so this may be a bug if they already tried switching the OS theme and the app still remains light. Also asked for scheduled dark mode, which is not currently available. Since KB fully answers the how-to and feature request, auto-responding. If the theme still does not change after restart/latest version, Product could investigate the possible bug.",
  "confidence": 0.82,
  "guardrails_applied": []
}
```

## Assumptions

- **Mock data instead of real systems.** Customers, billing, service status and the knowledge base are JSON files in `data/`, consistent with the sample tickets. The tools have the same shape a real integration would have.
- **Teams:** `Billing`, `Engineering_Incident`, `Product`, `Support`.
- **All tools are read-only.** No tool can issue refunds, change plans or send messages. Anything involving money is decided by a human.
- **The customer's plan** comes from `get_customer_history`; the policy falls back to the ticket's customer info if the tool was not called.
- **Language checks work on writing systems** (Thai, Latin, other), which catches a reply in the wrong script without guessing. Safe fallback replies exist in English and Thai; adding a language means adding its replies in `src/policy.ts`.
- **The golden set has two parts:** `dev` (the three sample tickets and a prompt injection case, used while writing the prompt) and `held_out` (six cases never used for tuning, including tickets that must not be escalated, a Spanish and a Thai ticket). `npm run eval` reports both.
- **Relative message times** ("3 hours ago") are kept as in the samples; a real system would use timestamps.

## Future improvements

- **Queue and priority for high volume**, for example BullMQ on Redis, with critical tickets first.
- **Cheaper model by default, larger model on low confidence**: re-run uncertain tickets with a stronger model before escalating.
- **Prompt caching**: keep the system prompt and tool definitions as a stable prefix so repeated calls are cheaper and faster.
- **Batch API for non-urgent tickets**, at a lower price.
- **Cache KB and customer lookups** for repeated tickets from the same customer.
- **Vector search for the knowledge base** instead of keyword scoring, which also handles languages without spaces such as Thai.
- **Human review dashboard** to approve or correct drafts; corrections become new golden cases.
- More languages, real integrations, authentication and rate limiting on the API.
