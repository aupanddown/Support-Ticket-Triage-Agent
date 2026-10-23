# Write-up: Support Ticket Triage Agent

## 1. Architecture decisions and why

- **LLM for understanding, code for safety.** The model reads the whole thread, uses tools and drafts the reply, which is what it is good at. A deterministic policy (`policy.ts`) runs after it and has the final say on the risky parts: money always goes to a human in Billing, an Enterprise outage is always critical, low confidence is never auto-sent, and refund promises are replaced. The policy can only make the outcome safer, and it records every change in `guardrails_applied`.
- **Tool calling with a small loop.** The agent calls read-only tools (customer history, KB, billing, service status), feeds the results back, and stops after at most 5 model calls. The final answer uses structured output and is validated with zod.
- **Tool registry for extensibility.** A tool is one file (`defineTool` with name, description, zod args, handler) plus one line in the registry. The JSON Schema for the model is generated from zod, so the definition and the validation cannot drift apart.
- **Injectable LLM client for testing.** The agent depends on a small `LlmClient` interface, not on OpenAI. Tests use a scripted fake, so all tests run without an API key and cover failures that are hard to reproduce with the real API.
- **API ready for any client.** Fastify exposes `POST /triage` with plain JSON, so a web or Flutter app can call it. The CLI and the server share the same agent.

## 2. What could go wrong and how it is handled

| Risk | Handling |
|---|---|
| Hallucinated refunds or promises | Prompt forbids it; the policy detects refund or credit promises and replaces the reply; tools cannot move money |
| Wrong language | The policy detects the ticket and reply language by script and replaces a mismatched reply |
| Invented KB articles | Only IDs actually returned by the KB tool are kept |
| Tool failure or bad arguments | Errors are returned to the model as data so it can retry, never thrown |
| OpenAI outage or slow response | 30 s timeout and 2 retries with exponential backoff; then fail-safe: `escalate_to_human` with the reason, and the policy still routes it (e.g. Billing) |
| Prompt injection in the ticket | The ticket is sent as escaped JSON in `<ticket>` tags, the prompt says it is data, tools are read-only, and the policy overrides a fooled model (tested end to end) |
| Loops | Hard limit of 5 model calls, then fail-safe |
| Cost and latency at scale | Small default model, input size limits; next steps: queue, prompt caching, Batch API for non-urgent tickets |

## 3. How to evaluate in production

- **Golden set regression:** `npm run eval` runs the real agent on labeled cases (including a prompt injection case) and checks urgency, decision, team, reply language, KB use, key facts in the note, and safety invariants. Run it on every prompt or model change; add real tickets that went wrong.
- **Human agent override rate:** how often agents change urgency, team or decision, or rewrite the draft. This is the main quality signal.
- **Escalation precision and recall:** were escalated tickets really needing a human, and were any auto-responded tickets later escalated?
- **Time to first response** and **CSAT**, compared with tickets handled without the agent.
- **Sampled human review** of auto-responses, weighted toward low confidence.
- **Logging:** every tool call, guardrail and fail-safe is logged per ticket, so mistakes can be traced and guardrail rates monitored (a rising rate means the model or prompt got worse).
