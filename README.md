# Support Ticket Triage Agent

This is my take on the support ticket triage assignment: an agent that reads a customer's ticket and works out what should happen next, using an OpenAI GPT model. For each ticket it:

1. decides how urgent it is: `critical`, `high`, `medium` or `low`
2. pulls out the key information: product, issue types, how the customer feels, and their language
3. searches the help center for articles that answer it
4. picks the next step: `auto_respond`, `route_to_specialist` or `escalate_to_human`, and the team that should own it
5. drafts a reply in the customer's language, plus an internal note for whoever picks it up

You run it from the terminal on the three sample tickets from the assignment (T1, T2 and T3, in `data/tickets.json`).

## Setup

You'll need **Node.js 22.12 or newer** and **your own OpenAI API key**. I haven't included a key in the repo.

**1. Install the dependencies**

```bash
npm ci
```

**2. Add your API key**

Copy the example settings file:

```bash
cp .env.example .env
```

On Windows it's `copy .env.example .env` (cmd) or `Copy-Item .env.example .env` (PowerShell).

Then open `.env` and paste your key after `OPENAI_API_KEY=`:

```
OPENAI_API_KEY=sk-...your key...
```

That's it. I used `gpt-5.4-mini` by default. If you want a different model, set `OPENAI_MODEL` in `.env`; it needs to support function calling with structured outputs (`gpt-4.1-mini` works, for example).

If you'd rather not create a `.env` file, you can pass the key on the command line instead: `OPENAI_API_KEY=sk-... npm run triage all` (in PowerShell: `$env:OPENAI_API_KEY="sk-..."; npm run triage all`).

## Run

From the project folder:

**All three sample tickets:**

```bash
npm run triage all
```

**Just one ticket** (`T1`, `T2` or `T3`):

```bash
npm run triage T1
```

**Watch the tools it calls** as it works:

```bash
npm run triage T2 verbose
```

You get JSON back, one object per ticket. If you want to see what that looks like before spending any credit, my own results for T1, T2 and T3 are in [SAMPLE_OUTPUT.md](SAMPLE_OUTPUT.md).

If OpenAI rejects the key, the model name or the account's credit, the command stops and tells you what to check. Anything else that goes wrong (a timeout, an answer that doesn't fit the format) doesn't crash it: that ticket gets handed to a person, with the reason.

## Check that it works

```bash
npm test             # 193 tests that run offline with a scripted fake model, so no API key needed
npm run typecheck
```

## Other commands

| Command | What it does |
|---|---|
| `npm run triage file path.json` | Triage your own file (one ticket or a list, in the same format as `data/tickets.json`) |
| `npm run tools:schema` | Print every tool definition exactly as the model sees it |
| `npm run eval` | Run the real agent on T1-T3 and compare it with the answers I expect in `data/golden.json`. `npm run eval 3` runs each ticket 3 times, since results vary between runs |
| `npm run serve` | Start an HTTP API: `POST /triage` with one ticket, `GET /health` |
| `npm run chat` | Interactive mode: pick T1, T2 or T3, then add follow-up messages as the customer and see how the triage changes |

## How it works

```
ticket ──> lookups (customer history, billing) ──> LLM <──> tools (read-only, mocked data)
                                                    │
                                                    v
                          zod validation ──> guardrail policy ──> result (JSON)
```

The model does the reading and writing; plain code makes the risky calls. In more detail:

- **Agent** (`src/agent.ts`): looks up the customer's history and billing first, then lets the model call tools (5 model calls at most), checks its answer with zod and applies the policy. If anything fails, the ticket goes to a person with the reason.
- **System prompt** (`src/prompts/system_prompt.md`): the instructions the model works from.
- **Tools** (`src/tools/`): customer history, help article search, billing and service status. They only read data (mocked as JSON files in `data/`) and can only see the customer on the ticket.
- **Guardrail policy** (`src/policy/`): rules that run after the model. They can only make the result safer, never riskier, and each change is logged in `guardrails_applied` and in the internal note.

These are the rules, in the order they run:

| Rule | What it makes sure of |
|---|---|
| `verified_kb_articles` | Only help articles the search tool really returned are cited |
| `money_to_billing` | A billing dispute, or a payment taken without the plan being activated, goes to a person in Billing at high urgency or above |
| `no_refund_promise` | A reply that promises a refund, credit or compensation is swapped for a safe one |
| `money_reply_reviewed` | An automatic reply that mentions money is checked by a person first |
| `enterprise_outage_critical` | An Enterprise outage is critical and goes to the incident team |
| `outage_to_engineering` | Any outage goes to the incident team, at high urgency or above |
| `no_auto_reply_during_incident` | No automatic reply to an Enterprise customer while their region has an incident |
| `critical_to_human` | A critical ticket always goes to a person |
| `low_confidence` | Below 0.7 confidence, nothing is answered automatically |
| `auto_respond_requirements` | Automatic replies only for low or medium urgency, and only when a help article backs them up |
| `reply_language` | The reply is in the customer's alphabet (e.g. Thai); if not, a person takes over |
| `team_assigned` | Every ticket that needs a person has a team, and bug reports and feature requests reach Product |

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
data/                    sample tickets and mock data (customers, billing, status, help articles)
tests/                   offline tests
WRITEUP.md               my architecture decisions, risks and how I'd evaluate it
```

**Adding a tool:** create a file in `src/tools/` with `defineTool({ name, description, args, handler })` and add it to `TOOLS` in `src/tools/index.ts`. The JSON Schema the model sees is generated from the zod `args`, so there's nothing else to keep in sync.

## Assumptions I made

- The assignment didn't come with customer, billing, status or help center data, so I made mock JSON files that are consistent with the sample tickets.
- I assumed four teams: `Billing`, `Engineering_Incident`, `Product` and `Support`.
- No tool can refund, change a plan or send a message. Decisions about money stay with people.
- Help article search works on English keywords; for a Thai ticket, the model translates its search terms.
