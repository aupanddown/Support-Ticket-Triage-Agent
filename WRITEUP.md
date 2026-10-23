# Write-up: Support Ticket Triage Agent

## 1. Architecture decisions and why

- **LLM for understanding, code for safety.** The model reads the thread, calls tools, classifies the ticket (`issue_types`, `product` enums) and drafts the reply. A deterministic policy (`policy.ts`) then has the final say on risky outcomes: money disputes go to a human in Billing, an Enterprise outage and every `critical` ticket go to a person, low confidence is never auto-sent, refund or credit promises are replaced. Rules use that classification (it can only add escalations) and tool facts, plus a short list of explicit dispute phrases; wording alone never pages a team. They can only make the outcome safer, and every change is logged.
- **Small tool-calling loop.** Four read-only tools scoped to the ticket's customer, at most 5 model calls (the last one without tools, forcing an answer), structured output validated with zod.
- **Tool registry.** A tool is one file (`defineTool`: zod args, handler, optional `facts` for the policy) plus one registry line; the JSON Schema for the model is generated from zod (`npm run tools:schema`).
- **Injectable LLM client.** The agent depends on a small `LlmClient` interface, so all tests run offline with a scripted fake, including failures that are hard to reproduce with the real API.

## 2. What could go wrong and how it is handled

| Risk | Handling |
|---|---|
| Refund or compensation promised | Prompt forbids it; policy replaces matching replies; an automatic reply that mentions money goes to a human; tools cannot move money |
| Wrong reply language | Policy compares writing systems (Thai/Latin/other) and escalates a mismatch; within Latin script it relies on the prompt |
| Over-escalation | Rules need structured evidence; tests and held-out cases include harmless tickets worded like problems ("No one can tell me how to export...", refund policy, a how-to during an incident) |
| Invented KB articles | Only IDs the KB tool really returned are kept |
| OpenAI outage or slow response | Timeout, retries with backoff, then fail-safe escalation with the reason; a rejected key or model stops the CLI with a clear error |
| Prompt injection | Ticket sent as escaped JSON in `<ticket>` tags, treated as data; read-only tools; the policy overrides a fooled model. Injected text can still force an escalation, which is the safe direction |
| Cost and latency | Small default model, input limits; next: queue, prompt caching, Batch API |

## 3. How to evaluate in production

- **Golden set regression** (`npm run eval`): urgency, decision, teams, issue types, language, KB use, key facts in the note, a reply rubric (e.g. no internal monitoring details) and safety invariants, reported separately for `dev` and `held_out` cases. `--runs N` repeats each case to expose unstable checks. Snapshot with `gpt-5.4-mini` on 2026-10-23, `--runs 3`: 377/381; held-out cases, written after the final prompt and policy, 96/96. The four misses were single runs on dev cases.
- **Human override rate:** how often agents change the urgency, team or decision, or rewrite the draft.
- **Escalation precision and recall**, time to first response and CSAT versus manual handling.
- **Sampled review** of auto-responses, weighted toward low confidence.
- **Monitoring** of logged tool calls, guardrails and fail-safes per ticket; a rising guardrail rate signals a model or prompt regression.
