# Write-up: Support Ticket Triage Agent

## 1. Architecture decisions and why

- **LLM for understanding, code for safety.** The model reads the thread, calls tools, classifies the ticket (`issue_types`, `product` enums) and drafts the reply. A deterministic policy (`policy.ts`) has the final say on risky outcomes: money disputes go to a human in Billing, Enterprise outages and every `critical` ticket go to a person, low confidence is never auto-sent, refund promises are replaced. Rules use the classification (which can only add escalations) and tool facts, never the ticket's wording, and every change is logged.
- **Small tool-calling loop.** Four read-only tools scoped to the ticket's customer, at most 5 model calls (the last one without tools, forcing an answer), structured output validated with zod.
- **Tool registry.** A tool is one file (`defineTool`: zod args, handler, optional `facts` for the policy) plus one registry line; the JSON Schema for the model is generated from zod.
- **Injectable LLM client.** The agent depends on a small `LlmClient` interface, so all tests run offline with a scripted fake, including failures that are hard to reproduce with the real API.

## 2. What could go wrong and how it is handled

| Risk | Handling |
|---|---|
| Refund or compensation promised | Prompt forbids it; tools cannot move money; money tickets are escalated, so a person reads the draft; on automatic replies the policy replaces promises and sends any money talk to a person |
| Wrong reply language | Policy compares writing systems (Thai/Latin/other) and escalates a mismatch; within Latin script it relies on the prompt |
| Over-escalation | Rules ignore the ticket's wording; tests include harmless tickets worded like problems ("No one can tell me how to export...") |
| Invented KB articles | Only IDs the KB tool really returned are kept |
| OpenAI outage or slow response | Timeout, retries with backoff, then fail-safe escalation with the reason; a rejected key or model stops the CLI with a clear error |
| Prompt injection | Ticket sent as escaped JSON in `<ticket>` tags, treated as data; read-only tools; the policy overrides a fooled model |
| Cost and latency | Small default model, input limits; next: queue, prompt caching, Batch API |

## 3. How to evaluate in production

- **Golden set regression** (`npm run eval`): urgency, decision, teams, issue types, language, KB use, key facts in the note and a reply rubric, with `--runs N` to expose unstable checks. Snapshot on the sample tickets (`gpt-5.4-mini`, 2026-10-23, 3 runs): 65/69; T1 and T2 passed everything, T3 is borderline (urgency `medium`, a browser step for a desktop user, each in 2 of 3 runs). Policy invariants are reported apart from the score, since they hold by construction. In production the set grows with real tickets.
- **Human override rate:** how often agents change the urgency, team or decision, or rewrite the draft.
- **Escalation precision and recall**, time to first response and CSAT versus manual handling.
- **Sampled review** of auto-responses, weighted toward low confidence.
- **Monitoring** of logged tool calls, guardrails and fail-safes per ticket; a rising guardrail rate signals a model or prompt regression.
