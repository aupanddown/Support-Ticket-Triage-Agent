import { readFile, writeFile } from "node:fs/promises";
import { triageTicket } from "../src/agent.js";
import { loadConfig } from "../src/config.js";
import { type Check, evaluateCase, GoldenSet, score } from "../src/evaluation.js";
import { createOpenAiLlmClient } from "../src/llm/client.js";
import type { TriageResult } from "../src/schemas.js";
import { loadSampleTickets } from "../src/tickets.js";

/**
 * Runs the REAL agent (OpenAI API) on every golden case and prints a score table.
 * Usage: npm run eval
 * Exit code 1 if any safety check fails (those must never fail, whatever the model does).
 */

const GOLDEN_FILE = new URL("../data/golden.json", import.meta.url);
const RESULTS_FILE = "eval-results.json"; // full results for inspection (gitignored)

interface CaseReport {
  ticketId: string;
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

function printTable(reports: CaseReport[]): void {
  const header = ["Ticket", "Urgency", "Decision", "Team", "Lang", "KB", "Note", "Safety", "Tools", "Time", "Score"];
  const rows = reports.map((r) => [
    r.ticketId,
    cell(find(r.checks, "urgency"), true),
    cell(find(r.checks, "decision"), true),
    cell(find(r.checks, "route_team"), true),
    cell(find(r.checks, "reply_language"), true),
    cell(find(r.checks, "kb_articles"), false),
    cell(find(r.checks, "internal_note"), false),
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

function printDetails(reports: CaseReport[]): void {
  for (const r of reports) {
    const failed = r.checks.filter((c) => !c.passed);
    const guardrails = r.result.guardrails_applied;
    if (failed.length === 0 && guardrails.length === 0 && !r.failSafe) continue;

    console.log(`\n${r.ticketId}`);
    if (r.failSafe) console.log(`  fail-safe: ${r.failSafe}`);
    for (const check of failed) console.log(`  ✗ ${check.name}: ${check.detail}`);
    // Guardrails that fired show where the model needed correcting.
    for (const entry of guardrails) console.log(`  guardrail ${entry}`);
  }
}

// ---------- Main ----------

async function main(): Promise<void> {
  const golden = GoldenSet.parse(JSON.parse(await readFile(GOLDEN_FILE, "utf8")));
  const samples = await loadSampleTickets();
  const config = loadConfig();
  const llm = createOpenAiLlmClient(config.openai);

  console.log(`Evaluating ${golden.length} cases with ${config.openai.model}\n`);

  const reports: CaseReport[] = [];
  for (const goldenCase of golden) {
    const ticket = goldenCase.ticket ?? samples.find((t) => t.id === goldenCase.ticket_id);
    if (!ticket) throw new Error(`Golden case ${goldenCase.ticket_id} has no matching ticket`);

    let toolCalls = 0;
    let failSafe: string | undefined;
    const started = performance.now();
    const result = await triageTicket(ticket, {
      llm,
      onEvent: (event) => {
        if (event.type === "tool_call") toolCalls++;
        else failSafe = event.reason;
      },
    });
    const seconds = (performance.now() - started) / 1000;

    reports.push({ ticketId: ticket.id, checks: evaluateCase(goldenCase, ticket, result), toolCalls, seconds, failSafe, result });
  }

  printTable(reports);
  printDetails(reports);

  const allChecks = reports.flatMap((r) => r.checks);
  const passed = allChecks.filter((c) => c.passed).length;
  console.log(`\nOverall: ${passed}/${allChecks.length} checks passed (${Math.round(score(allChecks) * 100)}%)`);

  await writeFile(RESULTS_FILE, `${JSON.stringify(reports.map((r) => r.result), null, 2)}\n`, "utf8");
  console.log(`Full results written to ${RESULTS_FILE}`);

  if (allChecks.some((c) => c.name === "safety" && !c.passed)) {
    console.error("\nSAFETY CHECK FAILED: this is a bug in the guardrails, not only a model mistake.");
    process.exitCode = 1;
  }
}

main().catch((error: unknown) => {
  console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
