# Write-up: Support Ticket Triage Agent

## 1. Architecture decisions and why

- **LLM for understanding, code for safety.** The model reads the whole thread, uses tools and drafts the reply, which is what it is good at. A deterministic policy (`policy.ts`) runs after it and has the final say on the risky parts: refunds, disputes and failed or duplicate charges go to a human in Billing, an Enterprise outage is critical, low confidence is never auto-sent, refund promises are replaced, every ticket that needs a person gets a team. Rules use evidence, not single words: specific phrases, facts from the tools (plan, billing problem, degraded region) and the model's own classification, which can only add escalations. The policy can only make the outcome safer, and every change is recorded in `guardrails_applied` and in the internal note.
- **Tool calling with a small loop.** Read-only tools (customer history, KB, billing, service status), results fed back, at most 5 model calls; on the last one tools are switched off so the model must answer. The answer uses structured output and is validated with zod.
- **Tool registry for extensibility.** A tool is one file (`defineTool`: name, description, zod args, handler, optional `facts` for the policy) plus one registry line. The JSON Schema for the model is generated from zod, so definition and validation cannot drift apart. Tools can only look up the ticket's own customer.
- **Injectable LLM client for testing.** The agent depends on a small `LlmClient` interface. Tests use a scripted fake, so all 159 tests run without an API key and cover failures that are hard to reproduce with the real API.

## 2. What could go wrong and how it is handled

| Risk | Handling |
|---|---|
| Refund or compensation promised | Prompt forbids it; the policy replaces replies that match promise patterns, including typographic quotes and passive voice (best effort); money tickets are escalated, so a human reviews the draft; tools cannot move money |
| Reply in the wrong language | The policy compares the writing system of ticket and reply (Thai vs Latin vs other) and escalates a mismatch. It cannot tell English from Spanish, so for Latin-script languages it relies on the prompt |
| Over-escalation | Rules need evidence; tests include harmless tickets that must stay automatic ("refund policy", invoice and pricing questions, one user who cannot log in) |
| Invented KB articles | Only IDs actually returned by the KB tool are kept |
| Tool failure or bad arguments | Errors are returned to the model as data so it can retry, never thrown |
| OpenAI outage or slow response | 30 s timeout, 2 retries with backoff, then fail-safe: `escalate_to_human` with the reason; the policy still routes it. A rejected key or model stops the CLI with a clear error instead |
| Prompt injection in the ticket | Ticket sent as escaped JSON in `<ticket>` tags, prompt says it is data, read-only tools scoped to the ticket's customer, and the policy overrides a fooled model (seen in a real run) |
| Loops, cost and latency | Hard limit of 5 model calls; small default model and input size limits; next: queue, prompt caching, Batch API |

## 3. How to evaluate in production

- **Golden set regression:** `npm run eval` runs the real agent on labeled cases and checks urgency, decision, team, reply language, KB use, key facts in the note and safety invariants. Cases are split into `dev` (looked at while writing the prompt) and `held_out` (never used for tuning), reported separately. Latest run: 61/61. Earlier runs showed one borderline dev miss that moved between T1 and T3, so in production I would run each case several times and track the pass rate per check.
- **Human agent override rate:** how often agents change urgency, team or decision, or rewrite the draft. The main quality signal.
- **Escalation precision and recall:** did escalated tickets need a human, and were auto-responded tickets later escalated?
- **Time to first response and CSAT**, compared with tickets handled without the agent.
- **Sampled human review** of auto-responses, weighted toward low confidence.
- **Logging:** the API server logs every tool call (name and outcome, not customer data), fail-safe and applied guardrail per ticket, so mistakes can be traced and guardrail rates monitored.
