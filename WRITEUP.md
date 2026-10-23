# Write-up: Support Ticket Triage Agent

## 1. Architecture decisions, and why

**I let the model understand, and let code decide anything risky.** The GPT model is good at reading a messy thread and replying in the customer's tone, but I don't trust it with the last word on money or outages. So after the model answers, fixed rules in code check the result, and they can only make it safer: a payment problem goes to a person in Billing, an outage goes to the engineering team, and nothing is sent automatically when the model is unsure. Every change a rule makes is logged in the result.

**The rules trust data, not the model's words.** In my first version, some rules only worked if the model chose to call the billing tool. I moved those lookups into code: the agent reads the customer's account and billing before the model starts, so "paid, but the upgrade failed" is a fact the rules can rely on.

**I kept the loop small on purpose.** Four tools (customer history, help articles, billing, service status) that only read data, and only for the ticket's own customer. The model gets at most 5 turns, and its answer must follow a schema: OpenAI structured outputs enforce it, and Zod checks it again before use. I didn't use an agent framework: for one ticket and four tools, a short loop of my own is easier to read, debug and test.

**Built to change.** A new tool is one file plus one line in the tool list. The OpenAI client sits behind a small interface, so all 193 tests run without a key using a fake model. That let me test timeouts, broken output and prompt injection offline.

## 2. What could go wrong, and how it is handled

These are the failures I worried about most:

| What could go wrong | What the agent does |
|---|---|
| The reply promises a refund | The prompt forbids it and no tool can move money. Money tickets go to a person, who reads the draft first. If an automatic reply mentions money, a rule replaces it or hands it to a person. |
| Wrong reply language | A rule checks the reply uses the customer's alphabet (e.g. Thai); if not, a person takes over. |
| Too many escalations | Rules use the classification and account data, not alarming words, so "no one can tell me how to export" is not an emergency. |
| Invented help articles | Only articles the search tool really returned are kept. |
| OpenAI down or slow | Limited wait and retries, then the ticket goes to a person with the reason. A wrong key or model stops with a clear message. |
| "Ignore your instructions" in a ticket | The ticket is passed as data, tools only read, and account facts (an unpaid upgrade, an Enterprise outage) block automatic replies whatever the model was told. |

The weak spot I still see is wording: the same ticket can get a slightly different reply or internal note on each run (for example, the note sometimes leaves out the 1-hour SLA). Decisions and teams have been stable in my runs; wording needs the measurement below.

## 3. How I would measure it in production

- **Test set with known answers** (`npm run eval`): urgency, decision, team, language, help articles, key facts in the note and reply wording, with policy rules checked separately. I run each ticket several times, because a check that passes only sometimes needs attention. It runs on every prompt or model change, and real tickets are added over time. Real results are in SAMPLE_OUTPUT.md.
- **Override rate:** how often staff change the urgency, team or decision, or rewrite the draft. This is the number I would watch first.
- **Escalation accuracy:** how many escalated tickets needed a person, and how many that needed one were missed; plus response time and customer satisfaction versus manual triage.
- **Spot checks** of automatic replies, more often when confidence is low.
- **Monitoring:** tool calls, rule changes and fallbacks are logged per ticket. If rules start correcting the model more often, the model or prompt has got worse.
