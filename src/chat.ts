import { stdin as input, stdout as output } from "node:process";
import { createInterface } from "node:readline/promises";
import { styleText } from "node:util";
import articles from "../data/kb_articles.json" with { type: "json" };
import { type AgentEvent, triageTicket } from "./agent.js";
import { loadConfig } from "./config.js";
import { createOpenAiLlmClient, type LlmClient } from "./llm/client.js";
import type { Decision, Ticket, TriageResult, Urgency } from "./schemas.js";
import { loadSampleTickets } from "./tickets.js";

/**
 * Interactive manual testing in the terminal.
 *
 * Pick T1, T2 or T3: the agent triages that sample thread right away. Or pick N1, N2 or N3 to
 * start an empty ticket as one of the sample customers and type the messages yourself.
 * Every message you type is added to the thread as the customer, and the agent triages again.
 *
 * Usage: npm run chat
 */

const WIDTH = Math.min(output.columns || 100, 100);

const HELP = "Type a follow-up message as the customer, or: /json  /new  /quit";

const DECISION_LABEL: Record<Decision, string> = {
  auto_respond: "Auto-respond",
  route_to_specialist: "Route to specialist",
  escalate_to_human: "Escalate to human",
};

// Single-format styleText calls (nested for two formats) work on every Node 22 release.
const URGENCY_STYLE: Record<Urgency, (text: string) => string> = {
  critical: (text) => styleText("red", styleText("bold", text)),
  high: (text) => styleText("red", text),
  medium: (text) => styleText("yellow", text),
  low: (text) => styleText("green", text),
};

const KB_TITLES = new Map(articles.map((a) => [a.id, a.title]));

// ---------- Formatting helpers ----------

const heading = (text: string) => console.log(`\n${styleText("cyan", styleText("bold", text))}`);
const dim = (text: string) => styleText("dim", text);

/** Word-wraps text to the terminal width, keeping the original line breaks. */
function wrap(text: string, indent = "  "): string {
  const max = WIDTH - indent.length;
  return text
    .split("\n")
    .map((paragraph) => {
      const lines: string[] = [];
      let line = "";
      for (const word of paragraph.split(" ")) {
        if (line && line.length + word.length + 1 > max) {
          lines.push(line);
          line = word;
        } else {
          line = line ? `${line} ${word}` : word;
        }
      }
      lines.push(line);
      return lines.map((l) => indent + l).join("\n");
    })
    .join("\n");
}

/** A "label   value" row; extra lines of the value are aligned under the first. */
function row(label: string, value: string): void {
  const pad = "  " + " ".repeat(13);
  console.log(`  ${label.padEnd(13)}${value.split("\n").join(`\n${pad}`)}`);
}

/** Shows tool arguments as key=value instead of raw JSON. */
function formatArgs(json: string): string {
  try {
    return Object.entries(JSON.parse(json) as Record<string, unknown>)
      .map(([key, value]) => `${key}=${typeof value === "string" ? `"${value}"` : String(value)}`)
      .join("  ");
  } catch {
    return json;
  }
}

// ---------- Screens ----------

function printTicket(ticket: Ticket): void {
  console.log(`\n${"=".repeat(WIDTH)}`);
  console.log(styleText("bold", ` ${ticket.id}  `) + ticket.customer.info);
  console.log("=".repeat(WIDTH));

  heading("CUSTOMER MESSAGES");
  ticket.messages.forEach((m, i) => {
    if (i > 0) console.log();
    console.log(dim(`  [${m.sent}]`));
    console.log(wrap(m.text));
  });
}

function printEvent(event: AgentEvent): void {
  if (event.type === "tool_call") {
    const mark = event.result.ok ? styleText("green", "ok ") : styleText("red", "err");
    console.log(`  ${mark} ${event.call.name.padEnd(26)}${dim(formatArgs(event.call.arguments))}`);
  } else {
    console.log(styleText("yellow", `  Automatic triage failed, escalated to a human: ${event.reason}`));
  }
}

function printResult(r: TriageResult): void {
  heading("RESULT");
  row("Urgency", URGENCY_STYLE[r.urgency](r.urgency.toUpperCase()));
  row("Decision", `${DECISION_LABEL[r.decision]}${r.route_team ? `  ->  ${r.route_team}` : ""}`);
  row("Follow-up", r.follow_up_teams.join(", ") || "none");
  row("Product", r.extracted.product);
  row("Issue types", r.extracted.issue_types.join(", "));
  row("Sentiment", r.extracted.sentiment);
  row("Language", r.extracted.language);
  row("Confidence", `${Math.round(r.confidence * 100)}%`);
  row("KB articles", r.kb_articles_used.map((id) => `${id}  ${KB_TITLES.get(id) ?? ""}`).join("\n") || "none");
  row("Guardrails", r.guardrails_applied.length ? styleText("yellow", r.guardrails_applied.join("\n")) : "none");

  heading("REPLY TO CUSTOMER");
  console.log(wrap(r.customer_reply_draft));

  heading("INTERNAL NOTE");
  console.log(dim(wrap(r.internal_note)));
  console.log(`\n${"-".repeat(WIDTH)}`);
}

// ---------- Session ----------

interface Session {
  ticket: Ticket;
  lastResult?: TriageResult;
}

async function triage(session: Session, llm: LlmClient, model: string): Promise<void> {
  printTicket(session.ticket);
  heading(`AGENT (${model})`);
  let configError: string | undefined;
  session.lastResult = await triageTicket(session.ticket, {
    llm,
    onEvent: (event) => {
      if (event.type === "fail_safe" && event.configError) configError = event.reason;
      printEvent(event);
    },
  });
  // A rejected key or model fails every ticket the same way, so stop with the reason.
  if (configError) throw new Error(configError);
  printResult(session.lastResult);
  console.log(dim(HELP));
}

function printMenu(samples: Ticket[]): void {
  console.log(`\n${styleText("bold", "Pick a sample ticket, or start a new one and type the messages yourself")}`);
  for (const t of samples) console.log(`  ${styleText("bold", t.id)}  ${t.customer.info}`);
  samples.forEach((t, i) => console.log(`  ${styleText("bold", `N${i + 1}`)}  new ticket as ${t.customer.id} (${t.customer.info})`));
}

/** T1-T3 opens a sample thread; N1-N3 opens an empty ticket for that sample's customer. */
function startSession(choice: string, samples: Ticket[]): Session | undefined {
  const answer = choice.toUpperCase();
  const sample = samples.find((t) => t.id === answer);
  if (sample) return { ticket: sample };

  const customer = /^N(\d)$/.exec(answer) && samples[Number(answer.slice(1)) - 1]?.customer;
  if (customer) {
    console.log(dim(`New ticket for ${customer.id}. Type the customer's first message.`));
    return { ticket: { id: "NEW", customer, messages: [] } };
  }
  return undefined;
}

async function main(): Promise<void> {
  const config = loadConfig();
  const llm = createOpenAiLlmClient(config.openai);
  const samples = await loadSampleTickets();
  const rl = createInterface({ input, output });
  let closed = false;
  rl.on("close", () => (closed = true));
  rl.on("SIGINT", () => rl.close()); // Ctrl+C exits cleanly

  console.log(styleText("bold", "Support ticket triage agent"));

  let session: Session | undefined;
  printMenu(samples);
  rl.setPrompt("ticket> ");
  rl.prompt();

  // `for await` buffers lines typed while the agent is busy, so nothing is lost.
  for await (const raw of rl) {
    const line = raw.trim();

    if (line === "/quit") break;
    if (line === "/new") {
      session = undefined;
      printMenu(samples);
    } else if (!session) {
      session = startSession(line, samples);
      if (session && session.ticket.messages.length > 0) {
        await triage(session, llm, config.openai.model);
      } else if (!session && line) {
        const choices = [...samples.map((t) => t.id), ...samples.map((_, i) => `N${i + 1}`)];
        console.log(`Please type one of: ${choices.join(", ")}`);
      }
    } else if (line === "/json") {
      console.log(session.lastResult ? JSON.stringify(session.lastResult, null, 2) : "No result yet.");
    } else if (line.startsWith("/")) {
      console.log(HELP);
    } else if (line) {
      // A follow-up from the customer: add it to the thread and triage again.
      const messages = [...session.ticket.messages, { sent: "just now", text: line }];
      session = { ticket: { ...session.ticket, messages } };
      await triage(session, llm, config.openai.model);
    }

    if (closed) break; // input closed (Ctrl+C) while the agent was working
    rl.setPrompt(session ? styleText("cyan", "customer> ") : "ticket> ");
    rl.prompt();
  }

  rl.close();
}

main().catch((error: unknown) => {
  console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
