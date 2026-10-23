# Support Ticket Triage Agent

An AI agent that triages customer support tickets with an OpenAI GPT model. For each ticket it:

1. classifies urgency: `critical`, `high`, `medium` or `low`
2. extracts key information: product, issue types, customer sentiment, language
3. searches a knowledge base for articles that help answer it
4. decides the next action: `auto_respond`, `route_to_specialist` or `escalate_to_human`, with the team that owns it
5. drafts a reply in the customer's language and an internal note for the support team

It runs as a terminal command and processes the three sample tickets in `data/tickets.json` (T1, T2, T3).

## Setup

You need **Node.js 22.12 or newer** and **your own OpenAI API key**. No key is included in this repository.

**1. Install the dependencies**

```bash
npm ci
```

**2. Add your API key**

Copy the example settings file:

```bash
cp .env.example .env
```

On Windows use `copy .env.example .env` (cmd) or `Copy-Item .env.example .env` (PowerShell).

Then open `.env` and put your key after `OPENAI_API_KEY=`:

```
OPENAI_API_KEY=sk-...your key...
```

That is all. The model defaults to `gpt-5.4-mini`; to use another one, set `OPENAI_MODEL` in `.env` (it must support function calling with structured outputs, for example `gpt-4.1-mini`).

You can also skip the `.env` file and pass the key on the command line: `OPENAI_API_KEY=sk-... npm run triage -- --all` (PowerShell: `$env:OPENAI_API_KEY="sk-..."; npm run triage -- --all`).

## Run

Run these from the project folder.

**Triage all three sample tickets:**

```bash
npm run triage -- --all
```

**Triage one ticket** (`T1`, `T2` or `T3`):

```bash
npm run triage -- --ticket T1
```

**See each tool the agent calls** while it works:

```bash
npm run triage -- --ticket T2 --verbose
```

The result is printed as JSON, one object per ticket. Real results for T1, T2 and T3 are in [SAMPLE_OUTPUT.md](SAMPLE_OUTPUT.md).

If the key, the model or the account's credit is rejected, the command stops and says what to check. Other problems (a timeout, an invalid answer from the model) do not crash it: that ticket is handed to a human with the reason.

## Check that it works

```bash
npm test             # 193 tests, offline: they use a scripted fake model, no API key needed
npm run typecheck
```

## Other commands

| Command | What it does |
|---|---|
| `npm run triage -- --file path.json` | Triage your own file (one ticket or a list, same format as `data/tickets.json`) |
| `npm run tools:schema` | Print every tool definition exactly as the model receives it |
| `npm run eval` | Run the real agent on T1-T3 and compare with the expected results in `data/golden.json` (add `-- --runs 3` to repeat each ticket) |
| `npm run serve` | Start an HTTP API: `POST /triage` with one ticket, `GET /health` |
| `npm run chat` | Interactive mode: pick T1, T2 or T3 and add follow-up messages as the customer |

## How it works

```
ticket ──> lookups (customer history, billing) ──> LLM <──> tools (read-only, mocked data)
                                                    │
                                                    v
                          zod validation ──> guardrail policy ──> result (JSON)
```

- **Agent** (`src/agent.ts`): looks up the customer's history and billing, then lets the model call tools (at most 5 model calls), validates the answer with zod and applies the policy. Any failure ends in a safe hand-over to a human with the reason.
- **System prompt** (`src/prompts/system_prompt.md`): the instructions driving the agent.
- **Tools** (`src/tools/`): customer history, knowledge base search, billing, service status. All read-only, mocked with JSON files in `data/`, and only allowed to read the ticket's own customer.
- **Guardrail policy** (`src/policy/`): deterministic rules applied after the model. They can only make the outcome safer, and every change is logged in `guardrails_applied` and the internal note.

| Rule | What it guarantees |
|---|---|
| `verified_kb_articles` | Only knowledge base articles the tool really returned are cited |
| `money_to_billing` | A billing dispute, or a payment taken without the plan being activated, goes to a person in Billing at high urgency or more |
| `no_refund_promise` | A reply that promises a refund, credit or compensation is replaced with a safe reply |
| `money_reply_reviewed` | An automatic reply that mentions money is checked by a person first |
| `enterprise_outage_critical` | An Enterprise outage is critical and goes to the incident team |
| `outage_to_engineering` | Any outage goes to the incident team, at high urgency or more |
| `no_auto_reply_during_incident` | No automatic reply to an Enterprise customer while their region has an incident |
| `critical_to_human` | A critical ticket always goes to a person |
| `low_confidence` | Confidence below 0.7 is never answered automatically |
| `auto_respond_requirements` | Automatic replies only for low or medium urgency, backed by a knowledge base article |
| `reply_language` | The reply is in the customer's writing system (e.g. Thai), otherwise a person takes over |
| `team_assigned` | Every ticket that needs a person has an owning team; bug reports and feature requests reach Product |

## Project structure

```
src/
  agent.ts               the agent loop
  prompts/               system prompt (system_prompt.md) and the user message
  tools/                 the four tools and the tool registry
  policy/                guardrail rules, reply checks, safe replies
  schemas.ts             ticket and result formats (zod)
  config.ts              settings from .env
  llm/client.ts          OpenAI client behind a small interface (tests use a fake)
  cli.ts                 the npm run triage command
data/                    sample tickets and mock data (customers, billing, status, knowledge base)
tests/                   offline tests
WRITEUP.md               architecture, risks and evaluation
```

**Adding a tool:** create a file in `src/tools/` with `defineTool({ name, description, args, handler })` and add it to `TOOLS` in `src/tools/index.ts`. The JSON Schema for the model is generated from the zod `args`.

## Assumptions

- Customers, billing, service status and the knowledge base are mock JSON files consistent with the sample tickets.
- Teams are `Billing`, `Engineering_Incident`, `Product` and `Support`.
- No tool can issue refunds, change plans or send messages: decisions about money are made by people.
- Knowledge base search uses English keywords (the model translates Thai queries).
