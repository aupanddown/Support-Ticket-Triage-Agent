# Write-up: Support Ticket Triage Agent

## 1. Architecture decisions

The GPT model handles the parts that need language understanding: reading the whole thread, classifying the ticket, searching help articles and drafting a reply. I don't let it make the final call on anything risky, like money or an outage. After the model answers, a set of rules in code checks the result and can only make it safer. A payment problem always goes to Billing, an outage goes to the engineering team, and nothing is auto-sent when the model's confidence is low. Any change a rule makes is recorded in the result, so the support team can see why.

In my first version, some rules depended on the model calling the billing tool, and nothing guaranteed it would. I changed it so the agent loads the customer's account and billing data before calling the model. That way a fact like "paid, but the upgrade failed" comes from data and the rules can rely on it.

There are four tools: customer history, help article search, billing and service status. All of them are read-only and only return data for the customer on the ticket. The model has a limit of 5 turns, and its answer has to match a schema (OpenAI structured outputs, checked again with Zod). I wrote the loop myself instead of using an agent framework. With one ticket and four tools it is short enough to read in one go, and easier to debug.

Adding a tool means adding one file and registering it in the tool list. The OpenAI client is behind a small interface, so the tests (193 at the moment) run with a fake model and no API key. This is how I tested timeouts, broken output and prompt injection.

## 2. What could go wrong and how I handle it

- **Promising a refund.** The prompt says not to, and no tool can move money anyway. Billing tickets go to a person who reviews the draft. If an auto-reply mentions money, a rule replaces it or sends the ticket to a person.
- **Replying in the wrong language.** A rule checks that the reply uses the customer's script (for example Thai). If it doesn't, the ticket goes to a person.
- **Escalating too much.** The rules look at the classification and account data instead of keywords, so a message like "no one can tell me how to export" isn't treated as an emergency.
- **Made-up help articles.** I only keep articles that the search tool actually returned.
- **OpenAI is down or slow.** There is a timeout and a few retries. After that the ticket goes to a person with the reason. A wrong API key or model name stops the run with a clear error.
- **Prompt injection** ("ignore your instructions..."). The ticket text is passed as data, the tools can't change anything, and account facts like an unpaid upgrade or an Enterprise outage block auto-replies no matter what the model was told.

What still isn't solid is the wording. The same ticket can get a slightly different reply or note on each run, for example the note sometimes misses the 1-hour SLA. Decision and team have been stable in my runs; urgency was off once (T3 rated medium instead of low).

## 3. How I would evaluate it in production

- **Eval set** (`npm run eval`): checks urgency, decision, team, language, help articles and key facts in the note and reply, with the policy rules tested separately. I run each ticket several times since a check that only passes sometimes is a problem too. It should run on every prompt or model change, and real tickets get added over time. Results from my runs are in SAMPLE_OUTPUT.md.
- **Override rate:** how often support staff change the urgency, team or decision, or rewrite the draft. This is the first number I would look at.
- **Escalation accuracy:** how many escalated tickets really needed a person, and how many that needed one were missed. Also response time and CSAT compared with manual triage.
- **Spot checks** on auto-replies, more of them when confidence is low.
- **Logging:** tool calls, rule changes and fallbacks for each ticket. If the rules start correcting the model more often, something in the model or prompt has gotten worse.