import { parseArgs } from "node:util";
import { type AgentEvent, triageTicket } from "./agent.js";
import { loadConfig } from "./config.js";
import { createOpenAiLlmClient } from "./llm/client.js";
import type { Ticket, TriageResult } from "./schemas.js";
import { loadSampleTickets, loadTickets } from "./tickets.js";

const USAGE = `Usage:
  npm run triage -- --ticket T1        triage one sample ticket from data/tickets.json
  npm run triage -- --file path.json   triage a ticket (or an array of tickets) from a JSON file
  npm run triage -- --all              triage every sample ticket

Options:
  --verbose   also print each tool call (to stderr)
  --help      show this message

Results are printed to stdout as JSON; progress goes to stderr.`;

/** Wrong command line: print the error together with the usage text. */
class UsageError extends Error {}

function parseCliArgs() {
  try {
    return parseArgs({
      options: {
        ticket: { type: "string" },
        file: { type: "string" },
        all: { type: "boolean" },
        verbose: { type: "boolean" },
        help: { type: "boolean" },
      },
    }).values;
  } catch (error) {
    throw new UsageError(error instanceof Error ? error.message : String(error));
  }
}

async function selectTickets(args: ReturnType<typeof parseCliArgs>): Promise<Ticket[]> {
  const sources = [args.ticket, args.file, args.all].filter(Boolean).length;
  if (sources !== 1) throw new UsageError("Choose exactly one of --ticket, --file or --all.");

  if (args.file) return loadTickets(args.file);

  const samples = await loadSampleTickets();
  if (args.all) return samples;

  const ticket = samples.find((t) => t.id === args.ticket);
  if (!ticket) {
    throw new UsageError(`Unknown ticket "${args.ticket}". Sample tickets: ${samples.map((t) => t.id).join(", ")}`);
  }
  return [ticket];
}

function logEvent(ticketId: string, event: AgentEvent): void {
  if (event.type === "tool_call") {
    const outcome = event.result.ok ? "ok" : `error: ${event.result.error}`;
    console.error(`  [${ticketId}] ${event.call.name}(${event.call.arguments}) -> ${outcome}`);
  } else {
    console.error(`  [${ticketId}] WARNING: automatic triage failed, escalated to a human. Reason: ${event.reason}`);
  }
}

async function main(): Promise<void> {
  const args = parseCliArgs();
  if (args.help) {
    console.log(USAGE);
    return;
  }

  const tickets = await selectTickets(args);
  const config = loadConfig();
  const llm = createOpenAiLlmClient(config.openai);

  // One ticket at a time: simple, readable logs, and gentle on API rate limits.
  const results: TriageResult[] = [];
  for (const ticket of tickets) {
    console.error(`Triaging ${ticket.id} with ${config.openai.model}...`);
    // Tool calls only with --verbose; a fail-safe is always shown so a failing API key or model is obvious.
    const onEvent = (event: AgentEvent) => {
      if (args.verbose || event.type === "fail_safe") logEvent(ticket.id, event);
    };
    results.push(await triageTicket(ticket, { llm, onEvent }));
  }

  console.log(JSON.stringify(results.length === 1 ? results[0] : results, null, 2));
}

main().catch((error: unknown) => {
  console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
  if (error instanceof UsageError) console.error(`\n${USAGE}`);
  process.exitCode = 1;
});
