import { readFile, writeFile } from "node:fs/promises";
import { triageTicket } from "../src/agent.js";
import { loadConfig } from "../src/config.js";
import { type Check, evaluateCase, type GoldenCase, GoldenSet, score } from "../src/evaluation.js";
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
  set: GoldenCase["set"];
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
  const header = ["Ticket", "Set", "Urgency", "Decision", "Team", "Lang", "KB", "Note", "Safety", "Tools", "Time", "Score"];
  const rows = reports.map((r) => [
    r.ticketId,
    r.set,
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
    reports.push({ ticketId: ticket.id, set: goldenCase.set, checks, toolCalls, seconds, failSafe, result });
  }

  printTable(reports);
  printDetails(reports);

  const summary = (checks: Check[]) =>
    `${checks.filter((c) => c.passed).length}/${checks.length} checks passed (${Math.round(score(checks) * 100)}%)`;
  const allChecks = reports.flatMap((r) => r.checks);
  console.log(`\nOverall:   ${summary(allChecks)}`);
  // Held-out cases were never used while writing the prompt, so they show how well it generalizes.
  for (const set of ["dev", "held_out"] as const) {
    const checks = reports.filter((r) => r.set === set).flatMap((r) => r.checks);
    if (checks.length > 0) console.log(`  ${set.padEnd(9)} ${summary(checks)}`);
  }

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
