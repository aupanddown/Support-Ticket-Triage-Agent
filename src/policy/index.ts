import type { TriageResult } from "../schemas.js";
import { RULES } from "./rules.js";
import type { PolicyContext, Rule } from "./types.js";

/**
 * Deterministic guardrails applied AFTER the LLM.
 *
 * The LLM is good at understanding tickets but can be wrong or manipulated (prompt injection),
 * so these rules have the final say. Every rule can only make the outcome safer: raise urgency,
 * hand the ticket to a human, add a team, or replace an unsafe reply. None of them can undo an
 * escalation. All functions here are pure: no I/O, no mutation of the input.
 *
 * Rules rely on structured evidence: the model's classification (`issue_types`), which can only
 * ADD escalations, and facts from tool results, which act on their own where the data is
 * unambiguous (an unresolved payment, a degraded region for an Enterprise customer). The customer's
 * messages are never pattern-matched for intent; only the reply draft is checked (replyChecks.ts).
 *
 * Files: types.ts (context and facts), rules.ts (the rules, in order), replyChecks.ts (reply
 * patterns), safeReplies.ts (pre-approved replies).
 */

export { AUTO_RESPOND_MIN_CONFIDENCE, atLeast, RULES } from "./rules.js";
export { mentionsMoneyInReply, normalizeQuotes, promisesRefund } from "./replyChecks.js";
export { safeReply, safeReplyLanguage } from "./safeReplies.js";
export type { PolicyContext, PolicyFacts, Rule } from "./types.js";

/** Describes what a rule changed, e.g. "decision auto_respond -> escalate_to_human". */
function describeChanges(before: TriageResult, after: TriageResult): string[] {
  const changes: string[] = [];
  if (before.urgency !== after.urgency) changes.push(`urgency ${before.urgency} -> ${after.urgency}`);
  if (before.decision !== after.decision) changes.push(`decision ${before.decision} -> ${after.decision}`);
  if (before.route_team !== after.route_team) changes.push(`route_team ${before.route_team} -> ${after.route_team}`);
  if (before.follow_up_teams.join() !== after.follow_up_teams.join()) {
    changes.push(`follow_up_teams [${before.follow_up_teams}] -> [${after.follow_up_teams}]`);
  }
  if (before.extracted.language !== after.extracted.language) {
    changes.push(`language ${before.extracted.language} -> ${after.extracted.language}`);
  }
  if (before.kb_articles_used.join() !== after.kb_articles_used.join()) {
    changes.push(`kb_articles_used [${before.kb_articles_used}] -> [${after.kb_articles_used}]`);
  }
  if (before.customer_reply_draft !== after.customer_reply_draft) changes.push("customer_reply_draft replaced");
  return changes;
}

/**
 * Runs every rule in order. Each rule that changed something is recorded in `guardrails_applied`
 * and also appended to `internal_note`, so the human who picks up the ticket sees why the final
 * routing may differ from what the note above it says.
 */
export function applyPolicy(result: TriageResult, ctx: PolicyContext, rules: readonly Rule[] = RULES): TriageResult {
  let current = result;
  const applied = [...result.guardrails_applied];
  const notes: string[] = [];

  for (const rule of rules) {
    const next = rule.apply(current, ctx);
    const changes = describeChanges(current, next);
    if (changes.length > 0) {
      const entry = `${rule.id}: ${changes.join("; ")}`;
      applied.push(entry);
      notes.push(`[Policy] ${entry}`);
    }
    current = next;
  }

  const internal_note = [current.internal_note, ...notes].filter(Boolean).join("\n");
  return { ...current, internal_note, guardrails_applied: applied };
}
