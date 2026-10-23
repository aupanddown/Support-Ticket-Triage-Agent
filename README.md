# Support Ticket Triage Agent

An AI agent that triages customer support tickets. For each ticket it:

1. classifies urgency (`critical` / `high` / `medium` / `low`)
2. extracts key information as structured values: product area, issue types, sentiment, language
3. searches a knowledge base for relevant articles
4. decides the next action (`auto_respond`, `route_to_specialist` or `escalate_to_human`), the owning team and any follow-up teams
5. drafts a reply in the customer's language and an internal note for the support team

It uses an OpenAI GPT model with function calling and four read-only tools (customer history, knowledge base, billing, service status). A deterministic guardrail policy checks every result after the model.

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

`src/agent.ts` (the loop), `src/prompts/system_prompt.md` (the instructions), `src/tools/` (the tools) and `src/policy.ts` (the guardrails). The CLI (`src/cli.ts`) is the main way to run it; an HTTP API, an interactive terminal mode and the evaluation script are thin wrappers around the same `triageTicket()` function.

## Setup

Requirements: Node.js 22.12 or newer, and an OpenAI API key.

```bash
npm ci
cp .env.example .env
```

(Windows: `copy .env.example .env` in cmd, `Copy-Item .env.example .env` in PowerShell.) Then set your own `OPENAI_API_KEY` in `.env`; no key is included in the repository. Alternatively, skip `.env` and set the key in your shell, which takes precedence:

```bash
OPENAI_API_KEY=your-key npm run triage -- --all
```

(PowerShell: `$env:OPENAI_API_KEY="your-key"; npm run triage -- --all`.) `OPENAI_MODEL` is optional; the default is `gpt-5.4-mini`. Any other model must support function calling together with structured outputs (`json_schema`), for example `gpt-4.1-mini`. Run all commands from the repository root.

If OpenAI rejects the key, the model, or the account's quota, the commands stop with exit code 1 and say what to check. Other failures (a timeout, invalid model output) escalate that ticket to a human with the reason and print a warning.

## Usage

```bash
npm run triage -- --ticket T1          # one sample ticket (T1, T2 or T3), printed as JSON
npm run triage -- --all --verbose      # all sample tickets, also printing each tool call
npm run triage -- --file data/tickets.json   # any file with one ticket or an array, in this shape
```

Results go to stdout as JSON; progress and tool calls go to stderr.

```bash
npm test                   # all tests, offline (a scripted fake LLM, no API key needed)
npm run typecheck
npm run tools:schema       # every tool definition exactly as the model receives it (JSON Schema)
npm run eval               # real agent on T1-T3, compared with data/golden.json
npm run eval -- --runs 3   # each ticket 3 times, listing checks that did not pass every run
```

Also available: `npm run serve` starts an HTTP API (`POST /triage` with one ticket, `GET /health`), and `npm run chat` is an interactive terminal mode that triages T1, T2 or T3 and lets you add follow-up messages as the customer.

## Guardrail policy

`src/policy.ts` runs after the model and can only make the outcome safer. Rules use structured evidence: the model's classification (`issue_types`, which can only add escalations) and facts from the tools, which act on their own where the data is unambiguous, so a model that mislabels a ticket still cannot auto-respond to an unresolved payment or during an Enterprise incident. The ticket text is never pattern-matched. Every change is recorded in `guardrails_applied` and appended to `internal_note`.

| Rule | Effect |
|---|---|
| verified KB articles | KB IDs the tools never returned are removed |
| R1 money | `billing_dispute` (refund request, dispute, duplicate or failed charge), or an unresolved payment found by the billing tool (charged but the plan was not activated): `escalate_to_human`, owner `Billing`, urgency at least `high` |
| R1 no refund promise | A reply that promises a refund, credit or compensation is replaced with a safe reply and escalated; Billing owns it or follows up |
| R1 money reply reviewed | An automatic reply that mentions refunds, credits or compensation goes to a person first |
| R2 enterprise outage | Enterprise plan (from the ticket or customer history) and an `outage`, or an access problem or bug while a component in the customer's region is degraded: `critical`, `escalate_to_human`, `Engineering_Incident` |
| R2 no auto-reply during incident | Enterprise customer whose region is degraded: no automatic reply, a person checks it (not paged as an incident) |
| critical to human | A `critical` ticket is always `escalate_to_human` |
| R3 low confidence | Confidence below 0.7 is never auto-responded |
| R4 auto-respond requirements | Only `low`/`medium` urgency with at least one KB article; otherwise a person or a specialist |
| R5 reply language | A reply in another writing system than the ticket (Thai, Latin, other) goes to a person and is replaced by a safe reply when one exists (English, Thai) |
| team assigned | Every ticket that needs a person has an owner; an automatic reply has none, and bug reports or feature requests add `Product` as a follow-up |

The reply checks are a backstop for replies sent automatically; on an escalated ticket the reply is a draft that a person reads before sending. Tools that look up a customer declare the ID argument (`customerIdArg`) and can only read the ticket's own customer.

## Tools

| Tool | Returns | Facts for the policy |
|---|---|---|
| `get_customer_history` | plan, seats, region, tenure, past tickets, notes | plan, region |
| `search_knowledge_base` | up to 3 articles: id, title, url, snippet, score | IDs actually returned |
| `get_billing_transactions` | current plan, pending upgrade, charges with status | unresolved payment |
| `check_service_status` | public status page message, component status per region | degraded regions |

To add a tool: create a file in `src/tools/` with `defineTool({ name, description, args, handler })` and add it to `TOOLS` in `src/tools/index.ts`. The JSON Schema for the model is generated from the zod `args`, arguments are validated before the handler runs, and errors are returned to the model instead of crashing the agent. Optionally set `customerIdArg` (customer lookups) and `facts` (evidence for a rule, declared in `PolicyFacts`). A test fails until the tool is mentioned in `src/prompts/system_prompt.md`.

## Sample output

Real results for T1, T2 and T3 are in [SAMPLE_OUTPUT.md](SAMPLE_OUTPUT.md).

## Assumptions

- **Mock data instead of real systems.** Customers, billing, service status and the knowledge base are JSON files in `data/`, consistent with the sample tickets.
- **Teams:** `Billing`, `Engineering_Incident`, `Product`, `Support`.
- **All tools are read-only.** No tool can issue refunds, change plans or send messages; money is decided by a human.
- **Language checks work on writing systems** (Thai, Latin, other); they cannot tell English from Spanish. Safe fallback replies exist in English and Thai.
- **Knowledge base search uses English keywords**; the prompt asks the model to translate the query, because keyword search cannot split Thai text.
- **The golden set covers the three sample tickets.** Besides urgency, decision and teams it checks issue types, KB use, key facts in the note and a small reply rubric. Policy invariants are reported separately from the score.

## Future improvements

- Queue with priorities for high volume (e.g. BullMQ on Redis), critical tickets first.
- Cheaper model by default, a larger one when confidence is low.
- Prompt caching for the stable system prompt and tool definitions; Batch API for non-urgent tickets.
- Vector search for the knowledge base, which also handles Thai.
- A larger golden set from real tickets, an LLM judge with a rubric for reply quality, and a review dashboard whose corrections become new cases.
