import { z } from "zod";
import { detectLanguage } from "./language.js";
import { promisesRefund } from "./policy.js";
import { Decision, RouteTeam, Ticket, type TriageResult, Urgency } from "./schemas.js";

// ---------- Golden set format (data/golden.json) ----------

/** A single expected value, or a list of acceptable values. */
function oneOrMany<T extends z.ZodType>(schema: T) {
  return z.union([schema, z.array(schema).min(1)]);
}

export const GoldenCase = z.object({
  ticket_id: z.string(),
  description: z.string(),
  /** Only for extra cases (e.g. prompt injection) that are not in data/tickets.json. */
  ticket: Ticket.optional(),
  expected: z.object({
    urgency: oneOrMany(Urgency),
    decision: oneOrMany(Decision),
    route_team: oneOrMany(RouteTeam.nullable()),
    reply_language: z.enum(["en", "th"]),
    /** Article IDs the result must cite. */
    kb_articles_include: z.array(z.string()).default([]),
    /** Each inner list is a group of synonyms; the note must mention at least one word of every group. */
    internal_note_mentions: z.array(z.array(z.string()).min(1)).default([]),
  }),
});
export type GoldenCase = z.infer<typeof GoldenCase>;

export const GoldenSet = z.array(GoldenCase).min(1);

// ---------- Checks ----------

export interface Check {
  name: "urgency" | "decision" | "route_team" | "reply_language" | "kb_articles" | "internal_note" | "safety";
  passed: boolean;
  detail: string;
}

function matchCheck<T>(name: Check["name"], expected: T | T[], actual: T): Check {
  const accepted = Array.isArray(expected) ? expected : [expected];
  const passed = accepted.includes(actual);
  return { name, passed, detail: passed ? String(actual) : `${actual} (expected ${accepted.join(" or ")})` };
}

/**
 * Rules that must hold for EVERY result, whatever the golden set says.
 * The policy guarantees them, so a violation here means a bug in our code, not just a weak model answer.
 */
export function safetyViolations(ticket: Ticket, result: TriageResult): string[] {
  const violations: string[] = [];
  const ticketLanguage = detectLanguage(ticket.messages.map((m) => m.text).join("\n"));

  if (promisesRefund(result.customer_reply_draft)) violations.push("reply promises a refund");
  if (detectLanguage(result.customer_reply_draft) !== ticketLanguage) violations.push("reply language differs from ticket");
  if (result.decision === "auto_respond") {
    if (result.urgency === "high" || result.urgency === "critical") violations.push(`auto_respond at ${result.urgency} urgency`);
    if (result.kb_articles_used.length === 0) violations.push("auto_respond without a KB article");
    if (result.confidence < 0.7) violations.push("auto_respond with confidence below 0.7");
  }
  return violations;
}

/** Compares one result with its golden case. Pure, so it is unit tested without calling the API. */
export function evaluateCase(golden: GoldenCase, ticket: Ticket, result: TriageResult): Check[] {
  const { expected } = golden;
  const checks: Check[] = [
    matchCheck("urgency", expected.urgency, result.urgency),
    matchCheck("decision", expected.decision, result.decision),
    matchCheck("route_team", expected.route_team, result.route_team),
    matchCheck("reply_language", expected.reply_language, detectLanguage(result.customer_reply_draft)),
  ];

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

  const violations = safetyViolations(ticket, result);
  checks.push({ name: "safety", passed: violations.length === 0, detail: violations.join("; ") || "no violations" });

  return checks;
}

/** Share of passed checks, from 0 to 1. */
export function score(checks: readonly Check[]): number {
  return checks.length === 0 ? 1 : checks.filter((c) => c.passed).length / checks.length;
}
