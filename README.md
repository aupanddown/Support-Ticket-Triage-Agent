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

### Interactive mode (manual testing)

```bash
npm run chat
```

Pick a sample ticket (T1, T2 or T3), then press Enter to reveal the customer's messages one by one. After each message the agent triages the thread so far, so you can watch urgency and decision change as the thread develops. Type `/all` to triage the whole thread at once, or type your own message as the customer (for example a prompt injection) to see how the agent and the guardrails react. `/thread`, `/json`, `/new` and `/quit` are also available.

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
  chat.ts                interactive terminal mode for manual testing
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

Real results for the three sample tickets, produced with `gpt-5.4-mini` by `npm run eval` (the same agent and policy as `npm run triage`). Model output varies a little between runs.

### T1: triple charge, presentation in 2 hours

```json
{
  "ticket_id": "T1",
  "urgency": "critical",
  "extracted": {
    "product": "Billing / Pro upgrade",
    "issue_type": "duplicate_charge_plan_activation_failed",
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
  "customer_reply_draft": "I’m sorry for the trouble here, especially with your presentation in 2 hours. I can see the upgrade attempt did not complete, and your account is still on Free even though the payment was captured.\n\nThere are 3 captured Pro upgrade charges on the account right now: TX-9001 ($29.99, card ending 4242), TX-9002 ($29.99, card ending 5511), and TX-9003 ($29.99, card ending 5511).\n\nThe right team has this now and will review the charges and the failed activation. They’ll also check why Pro was not enabled after payment.\n\nPlease don’t open a bank dispute yet, because that can make the investigation harder. The Billing team will review this as soon as possible.",
  "internal_note": "Customer on Free plan attempted Pro upgrade 3 times today. Billing data shows pending_upgrade target Pro with status activation_failed, payment captured but plan activation did not complete. Transactions captured: TX-9001 29.99 USD card 4242, TX-9002 29.99 USD card 5511, TX-9003 29.99 USD card 5511. Customer is angry, says they need Pro export features for a presentation in 2 hours and threatened to dispute all charges by end of day if not reversed. This involves multiple captured charges and account activation failure, so Billing should review urgently. Also relevant KB says pending authorizations can drop off in 3-5 business days, but these are captured charges, not just pending auths.",
  "confidence": 0.97,
  "guardrails_applied": []
}
```

### T2: Enterprise outage in Thailand

```json
{
  "ticket_id": "T2",
  "urgency": "critical",
  "extracted": {
    "product": "Web App / Login",
    "issue_type": "outage",
    "sentiment": "angry",
    "language": "th"
  },
  "decision": "escalate_to_human",
  "route_team": "Engineering_Incident",
  "kb_articles_used": [
    "KB-301",
    "KB-302",
    "KB-401"
  ],
  "customer_reply_draft": "ขอบคุณที่แจ้งครับ ตอนนี้ผมตรวจพบว่าฝั่ง region Asia มีปัญหาจริง แม้ status.company.com จะยังแสดงว่า all systems operational อยู่ก็ตาม\n\nจากการตรวจสอบภายใน พบว่า Web App และ API ใน Asia อยู่ในสถานะ degraded และมี HTTP 500 error rate สูงตั้งแต่ประมาณ 2 ชั่วโมงที่แล้ว ซึ่งสอดคล้องกับอาการที่คุณเจอ, รวมถึงคนในทีมของคุณที่เข้าไม่ได้จากหลายเบราว์เซอร์และหลายเครื่อง\n\nเคสนี้ถูกส่งต่อให้ทีมที่เกี่ยวข้องแล้ว และกำลังตรวจสอบอยู่ เนื่องจากเป็น Enterprise account และกระทบผู้ใช้งานหลายคนกับเดโมบ่ายนี้ ทีมจะให้ความสำคัญสูงสุดครับ\n\nขออภัยในความไม่สะดวกอย่างมาก หากมีข้อมูลเพิ่ม เช่น เวลาที่เริ่มเกิดปัญหา หรือหน้าที่ขึ้น error 500 เป็นหน้าหลัก/บางฟีเจอร์เท่านั้น ส่งมาได้เลยครับ เราจะใช้ประกอบการตรวจสอบต่อ",
  "internal_note": "Enterprise customer in Thailand/Asia, 45 seats, first critical issue. Thread shows multi-user access failure with HTTP 500 for 2 hours, multiple browsers/devices affected, and a hard business deadline: customer has a demo this afternoon and says the deal may be lost. Public status page still says all systems operational, but internal monitoring shows Asia Web App and API degraded since about 2 hours ago, HTTP 500 error rate 42% from ap-southeast load balancer. Route to Engineering_Incident. KB articles used support that this is likely a service issue and that public status may lag internal incidents. No billing aspect.",
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
  "customer_reply_draft": "Hi Taylor, thanks for checking and for the extra details.\n\nYes, on Pro you should see Light and System Default only, there is no separate Dark toggle yet. System Default follows your operating system theme, so if your Mac is set to dark mode the app should switch too.\n\nIf it is still showing light after you choose System Default, please try:\n1. Fully quit and reopen the app after changing your Mac theme\n2. Make sure you are on the latest app version\n3. If you are using the browser version, check whether any extension is forcing a light theme\n\nFor scheduling dark mode, we do not have an in-app schedule yet. The current workaround on macOS is to set Appearance to System Default and use macOS automatic switching: System Settings > Appearance > Auto.\n\nHelp article: https://help.company.com/articles/appearance-settings\nScheduling info: https://help.company.com/articles/schedule-theme\n\nIf you want, we can also pass the scheduling idea along as product feedback.",
  "internal_note": "Customer on Pro plan, macOS desktop app, daily user, no prior tickets. Issue is twofold: how System Default works and a feature request for scheduled dark mode. KB says there is no separate Dark toggle, System Default should follow OS theme, and macOS Auto can schedule it. If System Default still stays light after quitting/reopening and updating, this could be a bug, but thread does not show they tried the troubleshooting yet. Route Product for feature request feedback if needed; no urgency, no money involved.",
  "confidence": 0.95,
  "guardrails_applied": []
}
```

## Assumptions

- **Mock data instead of real systems.** Customers, billing, service status and the knowledge base are JSON files in `data/`, consistent with the sample tickets. The tools have the same shape a real integration would have.
- **Teams:** `Billing`, `Engineering_Incident`, `Product`, `Support`.
- **All tools are read-only.** No tool can issue refunds, change plans or send messages. Anything involving money is decided by a human.
- **The customer's plan comes from the ticket's customer info** for the policy (R2), and from `get_customer_history` for the model.
- **Language detection supports English and Thai**, the two languages in the samples. Adding a language means adding a code in `src/language.ts` and its safe replies in `src/policy.ts`.
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
