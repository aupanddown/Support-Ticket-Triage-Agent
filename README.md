# Support Ticket Triage Agent

An AI agent that triages customer support tickets. For each ticket it:

1. classifies urgency (`critical` / `high` / `medium` / `low`)
2. extracts key information (product area, issue types, customer sentiment, language) as structured values
3. searches a knowledge base for relevant articles
4. decides the next action (`auto_respond`, `route_to_specialist` or `escalate_to_human`), the owning team and any follow-up teams
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

## Where to start reading

The core path is four files: `src/agent.ts` (the loop), `src/prompts/system_prompt.md` (the instructions), `src/tools/` (the tools) and `src/policy.ts` (the guardrails). Everything else is an entry point around the same `triageTicket()` function: the CLI (the main way to run it), an HTTP API, an interactive terminal mode for manual testing, and the evaluation script.

## Setup

Requirements: Node.js 22 or newer, and an OpenAI API key.

```bash
npm ci
cp .env.example .env
```

`npm ci` installs the exact versions from `package-lock.json`. (On Windows: `copy .env.example .env` in cmd, or `Copy-Item .env.example .env` in PowerShell.)

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

Results are printed to stdout as JSON; progress and tool calls go to stderr, so `npm run -s triage -- --all > results.json` gives clean JSON (in Windows PowerShell 5.1, `>` writes UTF-16; use `| Out-File -Encoding utf8` instead). Run all commands from the repository root, where `.env` is read.

### Interactive mode (manual testing)

```bash
npm run chat
```

Pick a sample ticket (`T1`, `T2` or `T3`) to triage that thread right away, or `N1`, `N2` or `N3` to start an empty ticket as one of the sample customers (Free, Enterprise, Pro) and type the messages yourself. Every message you type is added to the thread as the customer, and the agent triages the whole thread again. It prints a readable summary: the messages, each tool call, the result (urgency, decision, teams, issue types, KB articles, guardrails), the reply draft and the internal note. `/json` shows the raw result, `/new` goes back to the menu and `/quit` exits.

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
npm run eval -- --runs 3   # each case 3 times, and lists checks that did not pass every run (about 60 triages, a few minutes)
npm run tools:schema      # prints every tool definition exactly as the model receives it
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
scripts/tool-schemas.ts  prints the tool definitions (name, description, JSON Schema)
data/                    sample tickets, mock systems, KB articles, golden.json
tests/                   vitest tests (agent, policy, injection, tools, server, ...)
```

## Guardrail policy

The model decides first; `src/policy.ts` then applies these rules. They can only make the outcome safer, and every rule that changes something is recorded in `guardrails_applied` and appended to `internal_note` as a `[Policy]` line, so the note always matches the final routing.

Rules rely on structured evidence: the model's classification (`issue_types`, which can only add escalations, so a fooled model cannot use it to avoid one) and facts from the tools. The only text matching on the ticket is a short list of explicit money disputes ("refund me", chargeback, double-charged, a dispute with the bank, and their Thai equivalents); the reply itself is checked for refund promises and money talk.

| Rule | Effect |
|---|---|
| verified KB articles | KB IDs the tools never returned are removed |
| R1 money | `billing_dispute` (refund request, dispute, duplicate or failed charge) or an explicit dispute phrase: `escalate_to_human`, `Billing`, urgency at least `high`. Questions about prices, invoices or the refund policy are left to the model |
| R1 no refund promise | A reply that promises a refund, reversal, credit or compensation is replaced with a safe reply and escalated |
| R1 money reply reviewed | An automatic reply that talks about refunds, credits or compensation goes to a human in Billing first, even without a clear promise |
| R2 enterprise outage | Enterprise customer (from the ticket or customer history) with an `outage`, or with an access problem or bug while a component in the customer's region is degraded: `critical`, `escalate_to_human`, `Engineering_Incident`. Wording alone ("nobody can...") never pages the incident team |
| critical to human | A `critical` ticket is always `escalate_to_human` |
| R3 low confidence | Confidence below 0.7 is never auto-responded |
| R4 auto-respond requirements | `auto_respond` only for `low`/`medium` urgency with at least one KB article; a higher urgency goes to a person, a missing article to a specialist |
| R5 reply language | A reply in a different writing system than the ticket (Thai vs Latin vs other) goes to a human; it is replaced when a safe reply exists in that language (English, Thai) |
| team assigned | A routed or escalated ticket without a team goes to `Support`; an auto-responded bug report or feature request adds `Product` to `follow_up_teams` |

`route_team` is the team that owns the ticket (`null` when the reply is sent automatically). `follow_up_teams` lists other teams that must also act; when a rule changes the owner, the previous team becomes a follow-up, so an outage ticket that also has a duplicate charge still reaches Billing.

Tools that look up a customer declare which argument holds the ID (`customerIdArg`), and may only be called for the ticket's own customer, so a manipulated model can neither read other customers' data nor use a different customer to avoid a rule.

## Tool definitions

| Tool | Returns | Policy facts |
|---|---|---|
| `get_customer_history` | plan, seats, region, tenure, past tickets, notes | plan, region |
| `search_knowledge_base` | up to 3 articles: id, title, url, snippet | IDs actually returned |
| `get_billing_transactions` | current plan, pending upgrade, charges with status | none (read by the model) |
| `check_service_status` | public status page message, component status per region | degraded regions |

Each schema is written once in zod and converted to JSON Schema for the model. `npm run tools:schema` prints all of them; for example `search_knowledge_base`:

```json
{
  "name": "search_knowledge_base",
  "description": "Search help center articles (FAQ and docs) by keywords. Returns up to 3 matches with id, title, url and snippet. Use English keywords even if the ticket is in another language.",
  "parameters": {
    "type": "object",
    "properties": {
      "query": { "type": "string", "minLength": 1, "description": "English keywords, e.g. \"dark mode system default\"" },
      "product": {
        "type": "string",
        "enum": ["billing", "platform", "appearance", "account", "other"],
        "description": "Prefer articles for this product area. If none match, all articles are searched."
      }
    },
    "required": ["query"],
    "additionalProperties": false
  }
}
```

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

The JSON Schema for the model is generated from the zod schema, arguments are validated before the handler runs, and errors are returned to the model instead of crashing the agent. If the tool looks up a customer, set `customerIdArg` to the argument that holds the ID, so it can only read the ticket's own customer. If the result should count as evidence for a guardrail, add an optional `facts: (data) => ({ ... })` to the same `defineTool` call. Then mention the tool in `src/prompts/system_prompt.md`; a test fails if a tool is not mentioned there.

## Sample output

Real results for the three sample tickets from the first run of the latest `npm run eval -- --runs 3` with `gpt-5.4-mini` on 2026-10-23 (the same agent and policy as `npm run triage`). Model output varies a little between runs.

### T1: triple charge, presentation in 2 hours

```json
{
  "ticket_id": "T1",
  "urgency": "critical",
  "extracted": {
    "product": "billing",
    "issue_types": [
      "billing_dispute",
      "billing_question"
    ],
    "sentiment": "angry",
    "language": "en"
  },
  "decision": "escalate_to_human",
  "route_team": "Billing",
  "follow_up_teams": [],
  "kb_articles_used": [
    "KB-201",
    "KB-202",
    "KB-203"
  ],
  "customer_reply_draft": "I'm sorry this has become urgent, especially with your presentation in 2 hours. I can see that your Pro upgrade attempts were captured, but your account is still on Free because activation did not complete. I've passed this to our billing team, and they'll review all three charges and the failed activation. If you also contact your bank about the charges, please let us know so the billing team can review that at the same time.\n\nThe Pro plan includes the export features you need, and those features become available as soon as the plan is active. Our billing team is the only team that can review the charges and fix the plan activation issue. They will contact you as soon as possible.",
  "internal_note": "Customer on Free plan attempted Pro upgrade 3 times today. Billing data shows payment captured on TX-9001 ($29.99, card 4242), TX-9002 ($29.99, card 5511), and TX-9003 ($29.99, card 5511); current plan remains Free and pending_upgrade status is activation_failed: payment captured but plan activation did not complete. Customer reports two then three charges, no refunds, no Pro access, and threatens to dispute all charges with bank by end of day; also has a presentation in 2 hours and needs Pro export features. Severity is critical due to immediate business impact plus chargeback threat. Billing owns; they can review charges and manually activate plan per KB. Use KB-201, KB-202, KB-203.",
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
    "product": "platform",
    "issue_types": [
      "outage",
      "access_problem"
    ],
    "sentiment": "negative",
    "language": "th"
  },
  "decision": "escalate_to_human",
  "route_team": "Engineering_Incident",
  "follow_up_teams": [],
  "kb_articles_used": [
    "KB-301",
    "KB-302",
    "KB-401"
  ],
  "customer_reply_draft": "ขอบคุณที่แจ้งครับ ตอนนี้เราจะส่งเรื่องนี้ให้ทีมวิศวกรรมของเราเพื่อตรวจสอบปัญหาที่อาจกระทบ region Asia โดยตรงครับ\n\nจากที่คุณแจ้งว่า error 500 เกิดขึ้นทั้ง Chrome, Safari และ Firefox และมีหลายคนในทีมเข้าไม่ได้ พร้อมทั้งมี demo กับลูกค้ารายใหญ่ในวันนี้ ผมได้ระบุความเร่งด่วนไว้แล้วว่าร้ายแรงมาก ทีมของเราจะติดต่อกลับโดยเร็วที่สุด\n\nหมายเหตุ: หน้า status อาจยังแสดงว่า all systems operational ได้ในบางช่วง แม้จะมีปัญหาในภูมิภาคที่กำลังตรวจสอบอยู่\n\nถ้ามีอัปเดตเพิ่มเติมเกี่ยวกับเวลาที่เริ่มเกิดปัญหาหรือข้อความ error ที่เปลี่ยนไป ส่งมาได้เลยครับ จะช่วยทีมตรวจสอบได้เร็วขึ้น",
  "internal_note": "Enterprise customer in Thailand/asia, 45 seats, daily active, first critical issue. Reports HTTP 500 login/access failure affecting multiple browsers and multiple coworkers; demo with a large customer this afternoon and says the deal may be lost if service is not restored. Public status page says all systems operational, but internal monitoring shows asia Web App and API degraded with HTTP 500 rate 42% from ap-southeast LB since about 2 hours ago. KB confirms status page may lag regional incidents and Enterprise critical issues have 1 hour response target. Route to Engineering_Incident for suspected regional outage; customer should be told the team is investigating a possible issue affecting them and to acknowledge the deadline.",
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
    "product": "appearance",
    "issue_types": [
      "how_to",
      "feature_request",
      "bug"
    ],
    "sentiment": "neutral",
    "language": "en"
  },
  "decision": "auto_respond",
  "route_team": null,
  "follow_up_teams": [
    "Product"
  ],
  "kb_articles_used": [
    "KB-101",
    "KB-102"
  ],
  "customer_reply_draft": "Hi Taylor, thanks for checking and for the extra detail.\n\nYes, dark mode is supported through Settings > Appearance, but on all plans the options available are Light and System Default. There is not a separate Dark toggle yet.\n\nIf you set System Default and your Mac is in dark mode, the app should follow it. If it stays light, please try:\n1. Fully quit and reopen the app after changing your Mac theme\n2. Make sure you are on the latest app version\n\nIf you are using the desktop app and it still does not switch after that, it may be a bug. If you can, please reply with your app version and we will pass that along.\n\nFor scheduling, we do not have a built-in dark mode schedule yet. The workaround is to set the app to System Default and use macOS Appearance > Auto, which can switch light/dark automatically by time of day.\n\nHelp article: https://help.company.com/articles/appearance-settings\nSchedule info: https://help.company.com/articles/schedule-theme\n\nI have also passed your feature request for scheduled dark mode to our product team.",
  "internal_note": "Customer on Pro plan, macOS desktop app, daily active, no prior tickets. Asked whether dark mode is supported, then reported that System Default stays light despite macOS being in dark mode, which is a possible bug. Also asked for scheduled dark mode, which is a feature request. No billing or access issues. Suggest auto-response using KB-101 and KB-102; route Product follow-up for feature request and possible bug if issue persists.",
  "confidence": 0.91,
  "guardrails_applied": []
}
```

## Assumptions

- **Mock data instead of real systems.** Customers, billing, service status and the knowledge base are JSON files in `data/`, consistent with the sample tickets. The tools have the same shape a real integration would have.
- **Teams:** `Billing`, `Engineering_Incident`, `Product`, `Support`.
- **All tools are read-only.** No tool can issue refunds, change plans or send messages. Anything involving money is decided by a human.
- **The customer's plan** comes from both the ticket's customer info and `get_customer_history`; the customer counts as Enterprise if either says so.
- **Language checks work on writing systems** (Thai, Latin, other), which catches a reply in the wrong script without guessing. Safe fallback replies exist in English and Thai; adding a language means adding its replies in `src/policy.ts`.
- **The golden set has two parts:** `dev` (the sample tickets, a prompt injection case and regression cases, all seen while the prompt and policy were developed) and `held_out` (written after the final prompt and policy, commit `5e16034`, and never used to change them; one wrong expectation was corrected afterwards, see commit `92598d2`). `npm run eval` reports both. Besides urgency, decision and team, cases can check issue types, follow-up teams and a small reply rubric (phrases the reply must or must not contain).
- **Knowledge base search uses English keywords.** The prompt asks the model to translate the query; keyword search cannot split Thai text, which has no spaces between words.
- **Relative message times** ("3 hours ago") are kept as in the samples; a real system would use timestamps.

## Future improvements

- **Queue and priority for high volume**, for example BullMQ on Redis, with critical tickets first.
- **Cheaper model by default, larger model on low confidence**: re-run uncertain tickets with a stronger model before escalating.
- **Prompt caching**: keep the system prompt and tool definitions as a stable prefix so repeated calls are cheaper and faster.
- **Batch API for non-urgent tickets**, at a lower price.
- **Cache KB and customer lookups** for repeated tickets from the same customer.
- **Vector search for the knowledge base** instead of keyword scoring, which also handles languages without spaces such as Thai.
- **Human review dashboard** to approve or correct drafts; corrections become new golden cases.
- **LLM-as-judge for reply quality**, with a rubric, on top of the phrase checks in the golden set.
- More languages, real integrations, authentication and rate limiting on the API.
