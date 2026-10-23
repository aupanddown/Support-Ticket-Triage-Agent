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

Then open `.env` and set `OPENAI_API_KEY`. `OPENAI_MODEL` is optional; the default is `gpt-5.4-mini` (see `src/config.ts`). Any other model must support function calling together with structured outputs (`json_schema`), for example `gpt-4.1-mini`. Other optional settings (timeout, retries, port, host) are listed in `.env.example`.

If OpenAI rejects the API key or the model (401, 403 or 404), the CLI, eval and chat stop with exit code 1 and say what to check. Other failures (timeouts, invalid model output) do not stop the run: that ticket is escalated to a human with the reason, and a warning is printed.

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
| R1 money | A refund request, a dispute with the bank, duplicate or failed charges (specific phrases in the ticket, a billing problem found by the billing tool, or the model's own classification): `escalate_to_human`, `Billing`, urgency at least `high`. Questions that only mention money ("refund policy", pricing, invoices) are not matched |
| R1 no refund promise | A reply that promises a refund, reversal or credit is replaced with a safe reply |
| R2 enterprise outage | Enterprise customer (from the ticket or customer history) with outage evidence (a degraded component in the customer's region, 5xx errors, several people unable to work, or the model classified an outage); one user who cannot log in is not an outage: `critical`, `escalate_to_human`, `Engineering_Incident` |
| R3 low confidence | Confidence below 0.7 is never auto-responded |
| R4 auto-respond requirements | `auto_respond` only for `low`/`medium` urgency with at least one KB article |
| R5 reply language | A reply in a different writing system than the ticket (Thai vs Latin vs other) goes to a human; it is replaced when a safe reply exists in that language (English, Thai) |
| team assigned | A routed or escalated ticket without a team goes to `Support`; an auto-responded bug report or feature request goes to `Product` as a follow-up |

The evidence comes from the tools: each tool can turn its result into facts for the policy (`facts()` in the tool file), such as the plan, the region, a billing problem or degraded regions. Tools that take a `customer_id` can only look up the ticket's own customer, so a manipulated model can neither read other customers' data nor use a different customer to avoid a rule.

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

The JSON Schema for the model is generated from the zod schema, arguments are validated before the handler runs, and errors are returned to the model instead of crashing the agent. If the result should count as evidence for a guardrail, add an optional `facts: (data) => ({ ... })` to the same `defineTool` call. Then mention the tool in `src/prompts/system_prompt.md`; a test fails if a tool is not mentioned there.

## Sample output

Real results for the three sample tickets from the latest `npm run eval` run with `gpt-5.4-mini` (the same agent and policy as `npm run triage`). Model output varies a little between runs.

### T1: triple charge, presentation in 2 hours

```json
{
  "ticket_id": "T1",
  "urgency": "critical",
  "extracted": {
    "product": "Billing / Pro upgrade",
    "issue_type": "duplicate_charge_activation_failed",
    "sentiment": "angry",
    "language": "en"
  },
  "decision": "escalate_to_human",
  "route_team": "Billing",
  "kb_articles_used": [
    "KB-202",
    "KB-201",
    "KB-203"
  ],
  "customer_reply_draft": "I’m sorry, Jordan, I can see why you’re frustrated, especially with your presentation in 2 hours.\n\nI found 3 captured Pro upgrade charges on your account and your plan is still showing Free, so this needs Billing review. The Pro plan is not active yet, which is why the export features are still unavailable.\n\nPlease do not open a bank dispute yet if you can avoid it, because disputes can lock the account while they are being investigated. Our Billing team needs to review all three transactions and the failed activation first.\n\nThe charges I found are:\n1. TX-9001, $29.99, captured\n2. TX-9002, $29.99, captured\n3. TX-9003, $29.99, captured\n\nYour case has been handed to the right team now, and they’ll review the charges and activation status as soon as possible.",
  "internal_note": "Customer on Free plan attempted Pro upgrade 3 times today. Billing lookup shows pending_upgrade target Pro with status activation_failed, detail: payment captured but plan activation did not complete. Transactions captured: TX-9001 ($29.99, 3 hours ago, card 4242), TX-9002 ($29.99, 2 hours ago, card 5511), TX-9003 ($29.99, 1 hour ago, card 5511). Customer is angry, says they need Pro export features for a presentation in 2 hours, and threatened to dispute all charges by end of day if not reversed. KB says do not retry many times, captured charges need Billing review, and disputes can lock the account. Escalate to Billing urgently.",
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
    "product": "Web App / Platform",
    "issue_type": "outage",
    "sentiment": "angry",
    "language": "th"
  },
  "decision": "escalate_to_human",
  "route_team": "Engineering_Incident",
  "kb_articles_used": [
    "KB-302",
    "KB-301"
  ],
  "customer_reply_draft": "ขอบคุณที่แจ้งครับ ตอนนี้เราพบว่ามีปัญหาใน region Asia จริงจากการตรวจสอบภายใน โดย Web App และ API มีอาการ degraded และมี HTTP 500 error rate สูงอยู่ แม้หน้า status.company.com จะยังแสดงว่า all systems operational ก็ตาม\n\nอาการที่คุณแจ้งสอดคล้องกับปัญหาระบบฝั่งเรา เพราะลองหลายเบราว์เซอร์ หลายเครื่อง และมีหลายคนในทีมเข้าไม่ได้เหมือนกันครับ\n\nผมได้ส่งเรื่องให้ทีมที่เกี่ยวข้องตรวจสอบแล้ว และกำลังเฝ้าดูสถานการณ์อยู่ สำหรับ demo บ่ายวันนี้ เราเข้าใจว่ามีผลกระทบเร่งด่วนมาก หากมีข้อมูลเพิ่มจากฝั่งคุณ เช่น เวลาเริ่มมีปัญหา หรือข้อความ error ที่เห็นชัดเจน ส่งมาได้เลยครับ",
  "internal_note": "Enterprise customer in Thailand, 45 seats, first critical issue. All users in team cannot access the product, HTTP 500 on multiple browsers/devices. Customer has a demo with a large prospect this afternoon and says the deal may be lost if service is not restored. Customer also noted public status page says all systems operational, but internal monitoring shows Asia Web App and API degraded with HTTP 500 error rate 42% from ap-southeast load balancer since about 2 hours ago. Escalate to Engineering_Incident immediately; note discrepancy between public status and internal monitoring.",
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
  "route_team": "Product",
  "kb_articles_used": [
    "KB-101",
    "KB-102"
  ],
  "customer_reply_draft": "Hey Taylor, yes, we do support dark mode via Settings > Appearance.\n\nOn Pro, the available options are Light and System Default. There isn’t a separate Dark toggle yet, so what you’re seeing is expected.\n\nIf System Default is set but the app still stays light on your Mac, try this:\n1. Fully quit and reopen the app after changing your Mac theme.\n2. Make sure the app is updated to the latest version.\n3. If you’re using the browser version, check whether an extension is forcing a light theme.\n\nFor scheduling, we don’t have an in-app dark mode schedule yet. The workaround is to keep the app on System Default and let macOS switch automatically. On Mac, you can use System Settings > Appearance > Auto so it changes between light and dark by time of day.\n\nHelp article: https://help.company.com/articles/appearance-settings\nSchedule info: https://help.company.com/articles/schedule-theme\n\nIf you want, you can also share the feature request with us through support, and I’ll pass it along.",
  "internal_note": "Customer on Pro, 5 months active, US region, daily logins, no prior tickets. Asked about dark mode, then reported that System Default did not switch to dark on macOS and asked whether this is a bug. KB says only Light and System Default are available, no separate Dark toggle, and System Default should follow OS theme after quitting/reopening and updating. Also asked for scheduled dark mode, which is not available; workaround is macOS Auto theme switching. This is a low-urgency how-to plus feature request. Possible bug only if System Default still stays light after following the documented steps, but thread does not show those troubleshooting steps were tried yet.\n[Policy] team_assigned: route_team null -> Product",
  "confidence": 0.89,
  "guardrails_applied": [
    "team_assigned: route_team null -> Product"
  ]
}
```

## Assumptions

- **Mock data instead of real systems.** Customers, billing, service status and the knowledge base are JSON files in `data/`, consistent with the sample tickets. The tools have the same shape a real integration would have.
- **Teams:** `Billing`, `Engineering_Incident`, `Product`, `Support`.
- **All tools are read-only.** No tool can issue refunds, change plans or send messages. Anything involving money is decided by a human.
- **The customer's plan** comes from both the ticket's customer info and `get_customer_history`; the customer counts as Enterprise if either says so.
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
