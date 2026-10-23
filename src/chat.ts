import { stdin as input, stdout as output } from "node:process";
import { createInterface } from "node:readline/promises";
import { styleText } from "node:util";
import { type AgentEvent, triageTicket } from "./agent.js";
import { loadConfig } from "./config.js";
import { createOpenAiLlmClient, type LlmClient } from "./llm/client.js";
import type { Ticket, TicketMessage, TriageResult } from "./schemas.js";
import { loadSampleTickets } from "./tickets.js";

/**
 * Interactive manual testing in the terminal, based on the sample tickets.
 *
 * Pick T1, T2 or T3, then press Enter to reveal the customer's messages one by one.
 * After each message the agent triages the thread so far, so you can see urgency and
 * decision change as the thread develops. You can also type your own message as the
 * customer (for example a prompt injection) to see how the agent and the policy react.
 *
 * Usage: npm run chat
 */

interface Session {
  sample: Ticket;
  /** How many sample messages are revealed so far. */
  revealed: number;
  /** Messages you typed yourself, added after the revealed sample messages. */
  extra: TicketMessage[];
  lastResult?: TriageResult;
}

const HELP = `Commands:
  Enter       reveal the next sample message and triage the thread so far
  /all        reveal all remaining sample messages and triage once (fewest API calls)
  (any text)  add your own message as the customer and triage
  /thread     show the messages so far
  /json       show the full JSON of the last result
  /new        pick another sample ticket
  /quit       exit`;

const dim = (text: string) => styleText("dim", text);
const bold = (text: string) => styleText("bold", text);

function currentTicket(session: Session): Ticket {
  return { ...session.sample, messages: [...session.sample.messages.slice(0, session.revealed), ...session.extra] };
}

function printStartMenu(samples: Ticket[]): void {
  console.log(`\n${bold("Pick a sample ticket")}`);
  for (const t of samples) console.log(`  ${t.id}  ${t.customer.info} (${t.messages.length} messages)`);
}

function startSession(choice: string, samples: Ticket[]): Session | undefined {
  const sample = samples.find((t) => t.id === choice.toUpperCase());
  if (!sample) {
    console.log(`Please type one of: ${samples.map((t) => t.id).join(", ")}`);
    return undefined;
  }
  console.log(dim(`${sample.id} loaded. Press Enter for the first message, or type /all.`));
  return { sample, revealed: 0, extra: [] };
}

function printEvent(event: AgentEvent): void {
  if (event.type === "tool_call") {
    const outcome = event.result.ok ? "ok" : `error: ${event.result.error}`;
    console.log(dim(`  tool ${event.call.name}(${event.call.arguments}) -> ${outcome}`));
  } else {
    console.log(styleText("yellow", `  fail-safe: ${event.reason}`));
  }
}

function printResult(r: TriageResult): void {
  const urgencyColor = r.urgency === "critical" || r.urgency === "high" ? "red" : "green";
  console.log();
  console.log(`  ${bold("urgency")}    ${styleText(urgencyColor, r.urgency)}`);
  console.log(`  ${bold("decision")}   ${r.decision}${r.route_team ? ` -> ${r.route_team}` : ""}`);
  console.log(`  ${bold("extracted")}  ${r.extracted.product} | ${r.extracted.issue_type} | ${r.extracted.sentiment} | ${r.extracted.language}`);
  console.log(`  ${bold("confidence")} ${r.confidence}`);
  console.log(`  ${bold("KB used")}    ${r.kb_articles_used.join(", ") || "-"}`);
  for (const entry of r.guardrails_applied) console.log(styleText("yellow", `  guardrail  ${entry}`));
  console.log(`\n${bold("Reply to customer:")}\n${r.customer_reply_draft}`);
  console.log(`\n${bold("Internal note:")}\n${dim(r.internal_note)}\n`);
}

/** Handles one input line while a ticket is open. Returns what the main loop should do next. */
async function handleLine(line: string, session: Session, llm: LlmClient): Promise<"continue" | "new" | "quit"> {
  const remaining = session.sample.messages.length - session.revealed;

  switch (line) {
    case "/quit":
      return "quit";
    case "/new":
      return "new";
    case "/thread": {
      const { messages } = currentTicket(session);
      if (messages.length === 0) console.log(dim("No messages yet. Press Enter to reveal the first one."));
      for (const m of messages) console.log(`  ${dim(`(${m.sent})`)} ${m.text}`);
      return "continue";
    }
    case "/json":
      console.log(session.lastResult ? JSON.stringify(session.lastResult, null, 2) : "No result yet.");
      return "continue";
    case "":
      if (remaining === 0) {
        console.log(dim("No more sample messages. Type your own message, /new or /quit."));
        return "continue";
      }
      session.revealed++;
      break;
    case "/all":
      session.revealed = session.sample.messages.length;
      break;
    default:
      if (line.startsWith("/")) {
        console.log(HELP);
        return "continue";
      }
      session.extra.push({ sent: "just now", text: line });
  }

  const ticket = currentTicket(session);
  const newest = ticket.messages.at(-1)!;
  console.log(`\n${styleText("cyan", `customer (${newest.sent}):`)} ${newest.text}`);
  console.log(dim(`Triaging ${ticket.messages.length} message(s)...`));
  session.lastResult = await triageTicket(ticket, { llm, onEvent: printEvent });
  printResult(session.lastResult);
  return "continue";
}

async function main(): Promise<void> {
  const config = loadConfig();
  const llm = createOpenAiLlmClient(config.openai);
  const samples = await loadSampleTickets();
  const rl = createInterface({ input, output });
  let closed = false;
  rl.on("close", () => (closed = true));
  rl.on("SIGINT", () => rl.close()); // Ctrl+C exits cleanly

  console.log(bold(`Support triage agent (${config.openai.model})`));
  console.log(dim("Each triage sends the thread to the API (about 3 to 4 requests)."));
  console.log(HELP);

  let session: Session | undefined;
  printStartMenu(samples);
  rl.setPrompt("ticket> ");
  rl.prompt();

  // `for await` buffers lines typed while the agent is busy, so nothing is lost.
  for await (const raw of rl) {
    const line = raw.trim();
    if (!session) {
      if (line) session = startSession(line, samples);
    } else {
      const next = await handleLine(line, session, llm);
      if (next === "quit") break;
      if (next === "new") {
        session = undefined;
        printStartMenu(samples);
      }
    }
    if (closed) break; // input closed (Ctrl+C) while the agent was working
    rl.setPrompt(session ? styleText("cyan", "> ") : "ticket> ");
    rl.prompt();
  }

  rl.close();
}

main().catch((error: unknown) => {
  console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
