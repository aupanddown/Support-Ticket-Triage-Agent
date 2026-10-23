import { readFile, writeFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { triageTicket } from "../src/agent.js";
import { loadConfig } from "../src/config.js";
import { type Check, evaluateCase, GoldenSet, policyViolations, score } from "../src/evaluation.js";
import { createOpenAiLlmClient } from "../src/llm/client.js";
import type { TriageResult } from "../src/schemas.js";
import { loadSampleTickets } from "../src/tickets.js";

/**
 * Runs the REAL agent (OpenAI API) on the sample tickets and compares the results with data/golden.json.
 * Usage: npm run eval       (each ticket once)
 *        npm run eval 3     (each ticket 3 times, to measure run-to-run stability; same as -- --runs 3)
 * Exit code 1 if a policy invariant is broken: that is a bug in our code, whatever the model does.
 */

const GOLDEN_FILE = new URL("../data/golden.json", import.meta.url);
const RESULTS_FILE = "eval-results.json"; // results of the first run, for inspection (gitignored)

interface CaseReport {
  ticketId: string;
  run: number;
  checks: Check[];
  violations: string[];
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
    "Ticket", "Urgency", "Decision", "Team", "Follow", "Issues", "Lang", "KB", "Note", "Reply", "Tools", "Time", "Score",
  ];
  const rows = reports.map((r) => [
    label(r, runs),
    cell(find(r.checks, "urgency"), true),
    cell(find(r.checks, "decision"), true),
    cell(find(r.checks, "route_team"), true),
    cell(find(r.checks, "follow_up_teams"), false),
    cell(find(r.checks, "issue_types"), false),
    cell(find(r.checks, "reply_language"), true),
    cell(find(r.checks, "kb_articles"), false),
    cell(find(r.checks, "internal_note"), false),
    cell(find(r.checks, "reply"), false),
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
    if (failed.length === 0 && guardrails.length === 0 && !r.failSafe && r.violations.length === 0) continue;

    console.log(`\n${label(r, runs)}`);
    if (r.failSafe) console.log(`  fail-safe: ${r.failSafe}`);
    for (const check of failed) console.log(`  ✗ ${check.name}: ${check.detail}`);
    for (const violation of r.violations) console.log(`  POLICY VIOLATION: ${violation}`);
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
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: { runs: { type: "string", default: "1" } },
  });
  const runs = Number(positionals[0] ?? values.runs);
  if (!Number.isInteger(runs) || runs < 1) throw new Error("The number of runs must be a positive integer, e.g. npm run eval 3");
  return runs;
}

async function main(): Promise<void> {
  const runs = parseRuns();
  const golden = GoldenSet.parse(JSON.parse(await readFile(GOLDEN_FILE, "utf8")));
  const samples = await loadSampleTickets();
  const config = loadConfig();
  const llm = createOpenAiLlmClient(config.openai);

  console.log(`Evaluating ${golden.length} tickets with ${config.openai.model}${runs > 1 ? `, ${runs} runs each` : ""}\n`);

  const reports: CaseReport[] = [];
  for (const goldenCase of golden) {
    const ticket = samples.find((t) => t.id === goldenCase.ticket_id);
    if (!ticket) throw new Error(`Golden case ${goldenCase.ticket_id} has no matching sample ticket`);

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

      reports.push({
        ticketId: ticket.id,
        run,
        checks: evaluateCase(goldenCase, result),
        violations: policyViolations(ticket, result),
        toolCalls,
        seconds,
        failSafe,
        result,
      });
    }
  }

  printTable(reports, runs);
  printDetails(reports, runs);
  if (runs > 1) printStability(reports, runs);

  const allChecks = reports.flatMap((r) => r.checks);
  const passed = allChecks.filter((c) => c.passed).length;
  console.log(`\nScore: ${passed}/${allChecks.length} checks passed (${Math.round(score(allChecks) * 100)}%)`);

  const violations = reports.flatMap((r) => r.violations);
  console.log(`Policy invariants: ${violations.length === 0 ? "all hold" : `${violations.length} violated`}`);

  const firstRun = reports.filter((r) => r.run === 1).map((r) => r.result);
  await writeFile(RESULTS_FILE, `${JSON.stringify(firstRun, null, 2)}\n`, "utf8");
  console.log(`Results of run 1 written to ${RESULTS_FILE}`);

  if (violations.length > 0) {
    console.error("\nPOLICY INVARIANT VIOLATED: this is a bug in the guardrail wiring, not only a model mistake.");
    process.exitCode = 1;
  }
}

main().catch((error: unknown) => {
  console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
