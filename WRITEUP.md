# Write-up: Support Ticket Triage Agent

## 1. Architecture decisions and why

- **LLM for understanding, code for safety.** The model reads the thread, calls tools and drafts the reply. A deterministic policy (`policy.ts`) then has the final say on risky outcomes: money disputes go to a human in Billing, an Enterprise outage is critical, low confidence is never auto-sent, refund promises are replaced. Rules need evidence (specific phrases, facts from tools, the model's own classification), never single words, and can only make the outcome safer. Every change is logged in `guardrails_applied` and the internal note.
- **Small tool-calling loop.** Four read-only tools, at most 5 model calls (the last one without tools, forcing an answer), structured output validated with zod.
- **Tool registry.** A tool is one file (`defineTool`: zod args, handler, optional `facts` for the policy) plus one registry line; the JSON Schema for the model is generated from zod.
- **Injectable LLM client.** The agent depends on a small `LlmClient` interface, so all tests run offline with a scripted fake, including failures that are hard to reproduce with the real API.

## 2. What could go wrong and how it is handled

| Risk | Handling |
|---|---|
| Refund or compensation promised | Prompt forbids it; policy replaces matching replies (best effort); money tickets always reach a human; tools cannot move money |
| Wrong reply language | Policy compares writing systems (Thai/Latin/other) and escalates a mismatch; within Latin script it relies on the prompt |
| Over-escalation | Tests with harmless tickets ("refund policy", invoices, one user locked out) that must stay automatic |
| Invented KB articles | Only IDs the KB tool really returned are kept |
| Tool errors | Returned to the model as data so it can retry |
| OpenAI outage or slow response | Timeout, retries with backoff, then fail-safe escalation with the reason; a rejected key or model stops the CLI with a clear error |
| Prompt injection | Ticket sent as escaped JSON in `<ticket>` tags, treated as data; tools are read-only and scoped to the ticket's customer; the policy overrides a fooled model |
| Cost and latency | Small default model, input limits; next: queue, prompt caching, Batch API |

## 3. How to evaluate in production

- **Golden set regression** (`npm run eval`): urgency, decision, team, language, KB use, key facts and safety checks, reported separately for `dev` cases (seen while writing the prompt) and `held_out` cases. Model output varies, so `--runs N` repeats each case and reports unstable checks. Latest `--runs 3`: 182/183 (held-out 108/108); the one miss was T3's note not saying "possible bug" in 1 of 3 runs.
- **Human override rate:** how often agents change the urgency, team or decision, or rewrite the draft.
- **Escalation precision and recall**, time to first response and CSAT versus manual handling.
- **Sampled review** of auto-responses, weighted toward low confidence.
- **Monitoring** of logged tool calls, guardrails and fail-safes per ticket; a rising guardrail rate signals a model or prompt regression.
