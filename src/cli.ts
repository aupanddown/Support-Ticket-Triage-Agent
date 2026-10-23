import { parseArgs } from "node:util";
import { type AgentEvent, triageTicket } from "./agent.js";
import { loadConfig } from "./config.js";
import { createOpenAiLlmClient } from "./llm/client.js";
import type { Ticket, TriageResult } from "./schemas.js";
import { loadSampleTickets, loadTickets } from "./tickets.js";

const USAGE = `Usage:
  npm run triage T1               triage one sample ticket from data/tickets.json
  npm run triage file path.json   triage a ticket (or an array of tickets) from a JSON file
  npm run triage all              triage every sample ticket

Options (add after the command):
  verbose   also print each tool call (to stderr), e.g. npm run triage T2 verbose
  help      show this message

The flag forms also work: npm run triage -- --ticket T1 | --file path.json | --all [--verbose].
Results are printed to stdout as JSON; progress goes to stderr.`;

/** Wrong command line: print the error together with the usage text. */
class UsageError extends Error {}

/**
 * Reads the command line. Plain words (`all`, `T1`, `file path.json`, `verbose`, `help`) mean the same
 * as the flags, so no `--` is needed after `npm run triage` and nothing depends on the shell.
 */
function parseCliArgs() {
  let parsed;
  try {
    parsed = parseArgs({
      allowPositionals: true,
      options: {
        ticket: { type: "string" },
        file: { type: "string" },
        all: { type: "boolean" },
        verbose: { type: "boolean" },
        help: { type: "boolean" },
      },
    });
  } catch (error) {
    throw new UsageError(error instanceof Error ? error.message : String(error));
  }

  const args = { ...parsed.values };
  const words = [...parsed.positionals];
  for (let word = words.shift(); word !== undefined; word = words.shift()) {
    const keyword = word.toLowerCase();
    if (keyword === "all") args.all = true;
    else if (keyword === "verbose") args.verbose = true;
    else if (keyword === "help") args.help = true;
    else if (keyword === "file") {
      args.file = words.shift();
      if (!args.file) throw new UsageError('"file" needs a path, e.g. npm run triage file my-tickets.json');
    } else args.ticket = word.toUpperCase();
  }
  return args;
}

async function selectTickets(args: ReturnType<typeof parseCliArgs>): Promise<Ticket[]> {
  const sources = [args.ticket, args.file, args.all].filter(Boolean).length;
  if (sources !== 1) throw new UsageError("Choose exactly one: a ticket ID (T1), file <path>, or all.");

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
    let configError: string | undefined;
    // Tool calls only with verbose; a fail-safe is always shown so a failing API key or model is obvious.
    const onEvent = (event: AgentEvent) => {
      if (event.type === "fail_safe" && event.configError) configError = event.reason;
      else if (args.verbose || event.type === "fail_safe") logEvent(ticket.id, event);
    };
    const result = await triageTicket(ticket, { llm, onEvent });
    // A rejected key or model would fail every ticket the same way: stop instead of printing fake
    // escalations, but keep the results of the tickets that were already triaged.
    if (configError) {
      if (results.length > 0) printResults(results);
      throw new Error(configError);
    }
    results.push(result);
  }

  printResults(results);
}

function printResults(results: TriageResult[]): void {
  console.log(JSON.stringify(results.length === 1 ? results[0] : results, null, 2));
}

main().catch((error: unknown) => {
  console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
  if (error instanceof UsageError) console.error(`\n${USAGE}`);
  process.exitCode = 1;
});
