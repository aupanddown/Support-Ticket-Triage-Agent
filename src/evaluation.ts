import { z } from "zod";
import { detectScript } from "./language.js";
import { promisesRefund } from "./policy.js";
import { Decision, IssueType, RouteTeam, Ticket, type TriageResult, Urgency } from "./schemas.js";

// ---------- Golden set format (data/golden.json) ----------

/** A single expected value, or a list of acceptable values. */
function oneOrMany<T extends z.ZodType>(schema: T) {
  return z.union([schema, z.array(schema).min(1)]);
}

/** Expected outcome for one sample ticket of data/tickets.json. */
export const GoldenCase = z.object({
  ticket_id: z.string(),
  description: z.string(),
  expected: z.object({
    urgency: oneOrMany(Urgency),
    decision: oneOrMany(Decision),
    route_team: oneOrMany(RouteTeam.nullable()),
    /** Teams that must be among the follow-up teams. */
    follow_up_teams_include: z.array(RouteTeam).default([]),
    /** Issue types the model must have recognized. */
    issue_types_include: z.array(IssueType).default([]),
    /** ISO 639-1 code, e.g. "en", "th", "es". */
    reply_language: z.string().min(2),
    /** Article IDs the result must cite. */
    kb_articles_include: z.array(z.string()).default([]),
    /** Each inner list is a group of synonyms; the note must mention at least one word of every group. */
    internal_note_mentions: z.array(z.array(z.string()).min(1)).default([]),
    /** Reply quality: case-insensitive regexes the reply must match, and must not match. */
    reply_must_match: z.array(z.string()).default([]),
    reply_must_not_match: z.array(z.string()).default([]),
  }),
});
export type GoldenCase = z.infer<typeof GoldenCase>;

export const GoldenSet = z.array(GoldenCase).min(1);

// ---------- Checks ----------

export interface Check {
  name:
    | "urgency"
    | "decision"
    | "route_team"
    | "follow_up_teams"
    | "issue_types"
    | "reply_language"
    | "kb_articles"
    | "internal_note"
    | "reply";
  passed: boolean;
  detail: string;
}

/**
 * Thai must be written in Thai script. Other languages must be in Latin script, and the model's
 * own language label must match (script detection cannot tell English from Spanish).
 */
function replyLanguageCheck(expected: string, result: TriageResult): Check {
  const script = detectScript(result.customer_reply_draft);
  const passed = script === (expected === "th" ? "thai" : "latin") && result.extracted.language === expected;
  const actual = `${result.extracted.language}, ${script ?? "no"} script`;
  return { name: "reply_language", passed, detail: passed ? expected : `${actual} (expected ${expected})` };
}

function matchCheck<T>(name: Check["name"], expected: T | T[], actual: T): Check {
  const accepted = Array.isArray(expected) ? expected : [expected];
  const passed = accepted.includes(actual);
  return { name, passed, detail: passed ? String(actual) : `${actual} (expected ${accepted.join(" or ")})` };
}

/** Passes when every expected item is present, e.g. issue types or follow-up teams. */
function includesCheck(name: Check["name"], expected: readonly string[], actual: readonly string[]): Check {
  const missing = expected.filter((item) => !actual.includes(item));
  return { name, passed: missing.length === 0, detail: missing.length === 0 ? actual.join(", ") : `missing ${missing.join(", ")}` };
}

/**
 * Invariants that must hold for EVERY result. The policy enforces them, partly with the same
 * functions, so they hold by construction: they check that the policy is wired in correctly
 * (a violation is a bug in our code), not the quality of the model's answer. That is why they
 * are reported separately and are not part of the score.
 */
export function policyViolations(ticket: Ticket, result: TriageResult): string[] {
  const violations: string[] = [];
  const ticketScript = detectScript(ticket.messages.map((m) => m.text).join("\n"));
  const replyScript = detectScript(result.customer_reply_draft);

  if (promisesRefund(result.customer_reply_draft)) violations.push("reply promises a refund");
  if (ticketScript && replyScript !== ticketScript) violations.push("reply script differs from ticket");
  if (result.decision === "auto_respond") {
    if (result.urgency === "high" || result.urgency === "critical") violations.push(`auto_respond at ${result.urgency} urgency`);
    if (result.kb_articles_used.length === 0) violations.push("auto_respond without a KB article");
    if (result.confidence < 0.7) violations.push("auto_respond with confidence below 0.7");
  }
  if (result.urgency === "critical" && result.decision !== "escalate_to_human") violations.push("critical not escalated");
  if (result.decision !== "auto_respond" && result.route_team === null) violations.push("needs a person but has no team");
  return violations;
}

/** Compares one result with its golden case. Pure, so it is unit tested without calling the API. */
export function evaluateCase(golden: GoldenCase, result: TriageResult): Check[] {
  const { expected } = golden;
  const checks: Check[] = [
    matchCheck("urgency", expected.urgency, result.urgency),
    matchCheck("decision", expected.decision, result.decision),
    matchCheck("route_team", expected.route_team, result.route_team),
  ];
  if (expected.follow_up_teams_include.length > 0) {
    checks.push(includesCheck("follow_up_teams", expected.follow_up_teams_include, result.follow_up_teams));
  }
  if (expected.issue_types_include.length > 0) {
    checks.push(includesCheck("issue_types", expected.issue_types_include, result.extracted.issue_types));
  }
  checks.push(replyLanguageCheck(expected.reply_language, result));

  if (expected.kb_articles_include.length > 0) {
    const missing = expected.kb_articles_include.filter((id) => !result.kb_articles_used.includes(id));
    checks.push({
      name: "kb_articles",
      passed: missing.length === 0,
      detail: missing.length === 0 ? result.kb_articles_used.join(", ") : `missing ${missing.join(", ")}`,
    });
  }

  if (expected.internal_note_mentions.length > 0) {
    const note = result.internal_note.toLowerCase();
    const missing = expected.internal_note_mentions.filter((group) => !group.some((word) => note.includes(word.toLowerCase())));
    checks.push({
      name: "internal_note",
      passed: missing.length === 0,
      detail: missing.length === 0 ? "mentions all key facts" : `missing: ${missing.map((g) => g.join(" / ")).join("; ")}`,
    });
  }

  if (expected.reply_must_match.length > 0 || expected.reply_must_not_match.length > 0) {
    const reply = result.customer_reply_draft;
    const problems = [
      ...expected.reply_must_match.filter((p) => !new RegExp(p, "i").test(reply)).map((p) => `lacks /${p}/`),
      ...expected.reply_must_not_match.filter((p) => new RegExp(p, "i").test(reply)).map((p) => `contains /${p}/`),
    ];
    checks.push({ name: "reply", passed: problems.length === 0, detail: problems.join("; ") || "meets the rubric" });
  }

  return checks;
}

/** Share of passed checks, from 0 to 1. */
export function score(checks: readonly Check[]): number {
  return checks.length === 0 ? 1 : checks.filter((c) => c.passed).length / checks.length;
}
