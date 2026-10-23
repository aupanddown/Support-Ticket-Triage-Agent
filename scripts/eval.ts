import { readFile, writeFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { triageTicket } from "../src/agent.js";
import { loadConfig } from "../src/config.js";
import { type Check, evaluateCase, type GoldenCase, GoldenSet, score } from "../src/evaluation.js";
import { createOpenAiLlmClient } from "../src/llm/client.js";
import type { TriageResult } from "../src/schemas.js";
import { loadSampleTickets } from "../src/tickets.js";

/**
 * Runs the REAL agent (OpenAI API) on every golden case and prints a score table.
 * Usage: npm run eval                 (each case once)
 *        npm run eval -- --runs 3     (each case 3 times, to measure run-to-run stability)
 * Exit code 1 if any safety check fails (those must never fail, whatever the model does).
 */

const GOLDEN_FILE = new URL("../data/golden.json", import.meta.url);
const RESULTS_FILE = "eval-results.json"; // results of the first run, for inspection (gitignored)

interface CaseReport {
  ticketId: string;
  set: GoldenCase["set"];
  run: number;
  checks: Check[];
  toolCalls: number;
  seconds: number;
  failSafe?: string;
  result: TriageResult;
}

// ---------- Output ----------

function find(checks: Check[], name: Check["name"]): Check | undefined {
  return checks.find((c) => c.name === name);
}

/** "✓ critical" for value checks; "✓" / "✗" for the others; "-" when the case does not check it. */
function cell(check: Check | undefined, showValue: boolean): string {
  if (!check) return "-";
  const mark = check.passed ? "✓" : "✗";
  return showValue ? `${mark} ${check.detail.split(" (")[0]}` : mark;
}

function label(r: CaseReport, runs: number): string {
  return runs > 1 ? `${r.ticketId} #${r.run}` : r.ticketId;
}

function printTable(reports: CaseReport[], runs: number): void {
  const header = [
    "Ticket", "Set", "Urgency", "Decision", "Team", "Follow", "Issues", "Lang", "KB", "Note", "Reply", "Safety",
    "Tools", "Time", "Score",
  ];
  const rows = reports.map((r) => [
    label(r, runs),
    r.set,
    cell(find(r.checks, "urgency"), true),
    cell(find(r.checks, "decision"), true),
    cell(find(r.checks, "route_team"), true),
    cell(find(r.checks, "follow_up_teams"), false),
    cell(find(r.checks, "issue_types"), false),
    cell(find(r.checks, "reply_language"), true),
    cell(find(r.checks, "kb_articles"), false),
    cell(find(r.checks, "internal_note"), false),
    cell(find(r.checks, "reply"), false),
    cell(find(r.checks, "safety"), false),
    String(r.toolCalls),
    `${r.seconds.toFixed(1)}s`,
    `${Math.round(score(r.checks) * 100)}%`,
  ]);

  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((row) => row[i]!.length)));
  const line = (cells: string[]) => cells.map((c, i) => c.padEnd(widths[i]!)).join(" | ");

  console.log(line(header));
  console.log(widths.map((w) => "-".repeat(w)).join("-|-"));
  for (const row of rows) console.log(line(row));
}

function printDetails(reports: CaseReport[], runs: number): void {
  for (const r of reports) {
    const failed = r.checks.filter((c) => !c.passed);
    const guardrails = r.result.guardrails_applied;
    if (failed.length === 0 && guardrails.length === 0 && !r.failSafe) continue;

    console.log(`\n${label(r, runs)}`);
    if (r.failSafe) console.log(`  fail-safe: ${r.failSafe}`);
    for (const check of failed) console.log(`  ✗ ${check.name}: ${check.detail}`);
    // Guardrails that fired show where the model needed correcting.
    for (const entry of guardrails) console.log(`  guardrail ${entry}`);
  }
}

/** With several runs: the checks that did not pass every time, e.g. "T3 urgency: 2/3 runs". */
function printStability(reports: CaseReport[], runs: number): void {
  const passes = new Map<string, number>();
  for (const r of reports) {
    for (const c of r.checks) {
      const key = `${r.ticketId} ${c.name}`;
      passes.set(key, (passes.get(key) ?? 0) + (c.passed ? 1 : 0));
    }
  }
  const unstable = [...passes].filter(([, passed]) => passed < runs);
  console.log(`\nStability over ${runs} runs: ${unstable.length === 0 ? "every check passed in every run" : ""}`);
  for (const [key, passed] of unstable) console.log(`  ${key}: passed ${passed}/${runs} runs`);
}

// ---------- Main ----------

function parseRuns(): number {
  const { values } = parseArgs({ options: { runs: { type: "string", default: "1" } } });
  const runs = Number(values.runs);
  if (!Number.isInteger(runs) || runs < 1) throw new Error("--runs must be a positive integer");
  return runs;
}

async function main(): Promise<void> {
  const runs = parseRuns();
  const golden = GoldenSet.parse(JSON.parse(await readFile(GOLDEN_FILE, "utf8")));
  const samples = await loadSampleTickets();
  const config = loadConfig();
  const llm = createOpenAiLlmClient(config.openai);

  console.log(`Evaluating ${golden.length} cases with ${config.openai.model}${runs > 1 ? `, ${runs} runs each` : ""}\n`);

  const reports: CaseReport[] = [];
  for (const goldenCase of golden) {
    const ticket = goldenCase.ticket ?? samples.find((t) => t.id === goldenCase.ticket_id);
    if (!ticket) throw new Error(`Golden case ${goldenCase.ticket_id} has no matching ticket`);

    for (let run = 1; run <= runs; run++) {
      let toolCalls = 0;
      let failSafe: string | undefined;
      let configError = false;
      const started = performance.now();
      const result = await triageTicket(ticket, {
        llm,
        onEvent: (event) => {
          if (event.type === "tool_call") {
            toolCalls++;
          } else {
            failSafe = event.reason;
            configError = event.configError;
          }
        },
      });
      const seconds = (performance.now() - started) / 1000;
      // A rejected key or model fails every case the same way: stop instead of scoring fake escalations.
      if (configError && failSafe) throw new Error(failSafe);

      const checks = evaluateCase(goldenCase, ticket, result);
      reports.push({ ticketId: ticket.id, set: goldenCase.set, run, checks, toolCalls, seconds, failSafe, result });
    }
  }

  printTable(reports, runs);
  printDetails(reports, runs);
  if (runs > 1) printStability(reports, runs);

  const summary = (checks: Check[]) =>
    `${checks.filter((c) => c.passed).length}/${checks.length} checks passed (${Math.round(score(checks) * 100)}%)`;
  const allChecks = reports.flatMap((r) => r.checks);
  console.log(`\nOverall:   ${summary(allChecks)}`);
  // Held-out cases were never used while writing the prompt, so they show how well it generalizes.
  for (const set of ["dev", "held_out"] as const) {
    const checks = reports.filter((r) => r.set === set).flatMap((r) => r.checks);
    if (checks.length > 0) console.log(`  ${set.padEnd(9)} ${summary(checks)}`);
  }

  const firstRun = reports.filter((r) => r.run === 1).map((r) => r.result);
  await writeFile(RESULTS_FILE, `${JSON.stringify(firstRun, null, 2)}\n`, "utf8");
  console.log(`Results of run 1 written to ${RESULTS_FILE}`);

  if (allChecks.some((c) => c.name === "safety" && !c.passed)) {
    console.error("\nSAFETY CHECK FAILED: this is a bug in the guardrails, not only a model mistake.");
    process.exitCode = 1;
  }
}

main().catch((error: unknown) => {
  console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
