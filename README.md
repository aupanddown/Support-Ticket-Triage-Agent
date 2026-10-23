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
npm run eval -- --runs 3   # each case 3 times, and lists checks that did not pass every run
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

Each rule looks at three kinds of evidence, strongest first: the model's structured classification (`issue_types`, which can only add escalations, so a fooled model cannot use it to avoid one), facts from the tools (counted only when the ticket is about that topic), and a short list of explicit English and Thai phrases as a backup.

| Rule | Effect |
|---|---|
| verified KB articles | KB IDs the tools never returned are removed |
| R1 money | `billing_dispute` (refund request, dispute, duplicate or failed charge), a matching phrase, or a billing question on an account where the billing tool shows a failed activation or a repeated charge: `escalate_to_human`, `Billing`, urgency at least `high` |
| R1 no refund promise | A reply that promises a refund, reversal, credit or compensation is replaced with a safe reply and escalated |
| R1 money reply reviewed | An automatic reply that talks about refunds, credits or compensation goes to a human in Billing first, even without a clear promise |
| R2 enterprise outage | Enterprise customer (from the ticket or customer history) with an `outage`, an outage phrase (site down, nobody can log in), or an access problem or bug while the customer's region is degraded: `critical`, `escalate_to_human`, `Engineering_Incident`. One user who cannot log in is not an outage |
| critical to human | A `critical` ticket is always `escalate_to_human` |
| R3 low confidence | Confidence below 0.7 is never auto-responded |
| R4 auto-respond requirements | `auto_respond` only for `low`/`medium` urgency with at least one KB article |
| R5 reply language | A reply in a different writing system than the ticket (Thai vs Latin vs other) goes to a human; it is replaced when a safe reply exists in that language (English, Thai) |
| team assigned | A routed or escalated ticket without a team goes to `Support`; an auto-responded bug report or feature request adds `Product` to `follow_up_teams` |

`route_team` is the team that owns the ticket (`null` when the reply is sent automatically). `follow_up_teams` lists other teams that must also act; when a rule changes the owner, the previous team becomes a follow-up, so an outage ticket that also has a duplicate charge still reaches Billing.

Tools that look up a customer declare which argument holds the ID (`customerIdArg`), and may only be called for the ticket's own customer, so a manipulated model can neither read other customers' data nor use a different customer to avoid a rule.

## Tool definitions

| Tool | Returns | Policy facts |
|---|---|---|
| `get_customer_history` | plan, seats, region, tenure, past tickets, notes | plan, region |
| `search_knowledge_base` | up to 3 articles: id, title, url, snippet | IDs actually returned |
| `get_billing_transactions` | current plan, pending upgrade, charges with status | failed activation or repeated charge |
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

Real results for the three sample tickets from the first run of the latest `npm run eval -- --runs 3` with `gpt-5.4-mini` (the same agent and policy as `npm run triage`). Model output varies a little between runs.

### T1: triple charge, presentation in 2 hours

```json
{
  "ticket_id": "T1",
  "urgency": "critical",
  "extracted": {
    "product": "billing",
    "issue_types": [
      "billing_dispute",
      "billing_question",
      "other"
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
  "customer_reply_draft": "I’m sorry for the trouble, especially with your presentation in 2 hours. I’ve escalated this to our Billing team right away. They will review the three Pro charges on your account and the failed plan activation, and they’ll contact you directly as soon as possible.\n\nFrom what I can see, your account is still on Free, and the Pro upgrade did not activate even though the charges were captured. The Pro plan should unlock advanced export features as soon as it becomes active. I’ve also noted your message that you may dispute the charges with your bank if this isn’t resolved by end of day.\n\nIf you do contact your bank, please let us know so Billing can review everything together.",
  "internal_note": "Customer attempted Pro upgrade 3 times today. Billing data shows current plan still Free and pending upgrade status is activation_failed. Three captured charges exist: TX-9001 ($29.99, 3 hours ago, card 4242), TX-9002 ($29.99, 2 hours ago, card 5511), TX-9003 ($29.99, 1 hour ago, card 5511). User reports no Pro access, wants export features for a presentation in 2 hours, and threatened to dispute all charges by end of day if not reversed. This is a billing dispute with chargeback threat and immediate deadline; escalate to Billing. Public status and internal US status are operational, so this is not an outage.",
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
    "KB-302"
  ],
  "customer_reply_draft": "ขอบคุณที่แจ้งมาครับ ตอนนี้มีโอกาสเป็นปัญหาฝั่งระบบใน region Asia ตามอาการที่คุณแจ้งมา ทั้งขึ้น error 500 หลายเบราว์เซอร์และหลายเครื่อง รวมถึงเพื่อนร่วมงานเข้าไม่ได้ด้วย และคุณยังแจ้งว่ามี demo กับลูกค้ารายใหญ่ช่วงบ่ายนี้ด้วย ผมได้ส่งเรื่องให้ทีม Engineering_Incident แล้ว และทีมจะติดต่อกลับโดยเร็วที่สุด\n\nเรื่องที่ status.company.com ยังขึ้นว่า all systems operational นั้นอาจเกิดจากปัญหา regional incident ที่ยังไม่ถูกประกาศบนหน้าสถานะสาธารณะครับ",
  "internal_note": "Enterprise customer in Thailand (Asia region), 45 seats, first critical issue, with 1 hour response SLA for critical issues. Thread shows HTTP 500 access failure for multiple users across browsers/devices, starting ~2 hours ago, worsening impact, and a deadline: demo with a major customer this afternoon, risk of losing deal. Public status page says all systems operational, but internal monitoring shows Asia Web App/API degraded with elevated 5xx from ap-southeast load balancer since about 2 hours ago. Owns Engineering_Incident; no billing issue.",
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
      "bug",
      "feature_request"
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
  "customer_reply_draft": "Yes, we do support appearance settings on all plans, including Pro. In Settings > Appearance, the available options are Light and System Default. There is not a separate Dark toggle yet, so what you are seeing is expected.\n\nIf you choose System Default, the app should follow your operating system theme. On macOS, that means it should switch to dark when your Mac is set to dark mode. If it is still showing light, please try:\n1. Fully quit and reopen the app after changing your Mac theme.\n2. Make sure you are on the latest app version.\n3. If you are using the browser version, check whether an extension is forcing a light theme.\n\nWe do not have a built-in schedule for dark mode yet. As a workaround, you can set your Mac to switch automatically in System Settings > Appearance > Auto, and then keep the app on System Default.\n\nThanks for the suggestion about scheduling dark mode. I have passed that feature request to our Product team as well.\n\nHelp article: https://help.company.com/articles/appearance-settings\nSchedule/theme article: https://help.company.com/articles/schedule-theme",
  "internal_note": "Customer on Pro plan, 5 months tenure, US region, daily active, no prior tickets. Asked about dark mode, then reported that System Default on macOS still shows light theme and asked if it is a bug, plus requested scheduled dark mode at 6pm. KB says only Light and System Default are available on all plans; no separate Dark toggle. If System Default does not switch, recommended steps are fully quit/reopen after OS theme change, update app, and browser extension check. Also no built-in theme schedule yet; workaround is OS-level auto switch on macOS. Treat as a how-to plus possible bug report and feature request. No money/account issues.",
  "confidence": 0.94,
  "guardrails_applied": []
}
```

## Assumptions

- **Mock data instead of real systems.** Customers, billing, service status and the knowledge base are JSON files in `data/`, consistent with the sample tickets. The tools have the same shape a real integration would have.
- **Teams:** `Billing`, `Engineering_Incident`, `Product`, `Support`.
- **All tools are read-only.** No tool can issue refunds, change plans or send messages. Anything involving money is decided by a human.
- **The customer's plan** comes from both the ticket's customer info and `get_customer_history`; the customer counts as Enterprise if either says so.
- **Language checks work on writing systems** (Thai, Latin, other), which catches a reply in the wrong script without guessing. Safe fallback replies exist in English and Thai; adding a language means adding its replies in `src/policy.ts`.
- **The golden set has two parts:** `dev` (the three sample tickets and a prompt injection case, looked at while writing the prompt) and `held_out` (cases the prompt was never adjusted for, including tickets that must not be escalated, Spanish and Thai tickets; the newest ones were written after the last prompt change). `npm run eval` reports both. Besides urgency, decision and team, cases can check issue types, follow-up teams and a small reply rubric (phrases the reply must or must not contain).
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
