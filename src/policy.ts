import { detectScript, fallbackLanguage, type ReplyLanguage } from "./language.js";
import type { RouteTeam, Ticket, TriageResult, Urgency } from "./schemas.js";

/**
 * Deterministic guardrails applied AFTER the LLM.
 *
 * The LLM is good at understanding tickets but can be wrong or manipulated (prompt injection),
 * so these rules have the final say. Every rule can only make the outcome safer: raise urgency,
 * hand the ticket to a human, or replace an unsafe reply. None of them can undo an escalation.
 * All functions here are pure: no I/O, no mutation of the input.
 */

export interface PolicyContext {
  ticket: Ticket;
  /** IDs of KB articles the knowledge base tool actually returned during this run. */
  retrievedKbIds: readonly string[];
  /** Plan from get_customer_history, if it was called. More reliable than the free-text customer info. */
  customerPlan?: string;
}

interface Rule {
  id: string;
  apply(result: TriageResult, ctx: PolicyContext): TriageResult;
}

// ---------- Signals (English and Thai) ----------
// Each signal is matched on the ticket text OR on the model's own classification. Using the model's
// classification only ever adds escalations, so a fooled model cannot use it to avoid one.

// Money matters only a human may decide: refunds, disputes, duplicate, unexpected or failed charges.
// Plain pricing or invoice questions are deliberately NOT matched, so the KB can answer them.
const MONEY_RISK_TEXT =
  /\b(refunds?|refunded|chargebacks?|disputes?|disputing|reversed|reversal|money back|unauthori[sz]ed|charged (twice|again|\w+ times)|(double|duplicate|multiple|two|three|\d+) (pending )?charges|payments? (failed|declined)|failed payments?)\b|คืนเงิน|เงินคืน|ตัดเงินซ้ำ|หักเงินซ้ำ|ถูกตัดเงิน|ถูกหักเงิน|ชำระเงินไม่สำเร็จ|จ่ายเงินไม่ผ่าน/i;
const MONEY_RISK_ISSUE_TYPE = /refund|duplicate_charge|chargeback|dispute|payment_fail|overcharg/i;

// Evidence that the product is down, not just words like "coworkers" or "down".
const OUTAGE_TEXT =
  /\b(outage|error\s*5\d\d|5\d\d\s*error|http\s*5\d\d|(can'?t|cannot|unable to) (access|log ?in|sign in)|is down|went down)\b|เข้าไม่ได้|ใช้งานไม่ได้|ล่ม/i;
const OUTAGE_ISSUE_TYPE = /outage|incident|downtime/i;

const ENTERPRISE = /\benterprise\b/i;

// Phrases that promise or confirm a refund or compensation. Best effort: replies on money
// tickets are escalated anyway, so a human reviews them before anything is sent.
const REFUND_PROMISE_PATTERNS: readonly RegExp[] = [
  /\b(we|i)('ll|'ve| will| have| am going to| are going to)\s+(\w+\s+){0,5}(refund|reverse|reimburse|credit)/i,
  /\b(team|billing)\s+will\s+(\w+\s+){0,2}(refund|reverse|reimburse)/i,
  /\b(refunds?|reversals?|reimbursements?)\s+(has|have|will|is|are)\s+(been\s+)?(be\s+)?(issued|processed|approved|initiated|sent)/i,
  /\byou('ll| will)\s+(\w+\s+){0,3}(get|receive|see)\s+(\w+\s+){0,3}(refund|money back)/i,
  /\bguarantee\w*\b.*\brefund/i,
  /จะคืนเงิน|คืนเงินให้/,
];

function customerText(ticket: Ticket): string {
  return ticket.messages.map((m) => m.text).join("\n");
}

/** True when the ticket raises a money matter that only a human in Billing may decide. */
export function mentionsMoneyRisk(ticket: Ticket): boolean {
  return MONEY_RISK_TEXT.test(customerText(ticket));
}

export function promisesRefund(reply: string): boolean {
  return REFUND_PROMISE_PATTERNS.some((pattern) => pattern.test(reply));
}

// ---------- Safe fallback replies (never promise refunds or compensation) ----------

const SAFE_REPLIES: Record<ReplyLanguage, { billing: string; general: string }> = {
  en: {
    billing:
      "Hi, thank you for your patience, and I'm sorry for the trouble with your payment. " +
      "I have passed your case to our Billing team as a priority so they can review every charge on your account " +
      "and your plan status. A team member will contact you directly with an update.",
    general:
      "Hi, thank you for contacting us. Your request has been passed to the right team, " +
      "and a team member will get back to you as soon as possible.",
  },
  th: {
    billing:
      "สวัสดีครับ ขออภัยในความไม่สะดวกเรื่องการชำระเงินครับ เราได้ส่งเรื่องของคุณให้ทีมการเงินตรวจสอบเป็นกรณีเร่งด่วนแล้ว " +
      "ทีมจะตรวจสอบทุกรายการที่เรียกเก็บและสถานะแพ็กเกจของคุณ และจะติดต่อกลับโดยตรงครับ",
    general:
      "สวัสดีครับ ขอบคุณที่ติดต่อเรา เราได้ส่งเรื่องของคุณให้ทีมที่เกี่ยวข้องแล้ว และเจ้าหน้าที่จะติดต่อกลับโดยเร็วที่สุดครับ",
  },
};

export type SafeReplyKind = keyof (typeof SAFE_REPLIES)[ReplyLanguage];

/** A pre-approved reply, used whenever the model's draft cannot be trusted. */
export function safeReply(language: ReplyLanguage, kind: SafeReplyKind): string {
  return SAFE_REPLIES[language][kind];
}

/** The language for a safe reply to this ticket: Thai for Thai tickets, English otherwise. */
export function safeReplyLanguage(ticket: Ticket): ReplyLanguage {
  return fallbackLanguage(detectScript(customerText(ticket))) ?? "en";
}

// ---------- Small helpers ----------

const URGENCY_RANK: Record<Urgency, number> = { low: 0, medium: 1, high: 2, critical: 3 };

/** Returns the higher of two urgency levels. */
export function atLeast(current: Urgency, minimum: Urgency): Urgency {
  return URGENCY_RANK[current] >= URGENCY_RANK[minimum] ? current : minimum;
}

/** Hands the ticket to a human, keeping the team the LLM chose if there is one. */
function escalate(result: TriageResult, team?: RouteTeam): TriageResult {
  return { ...result, decision: "escalate_to_human", route_team: team ?? result.route_team ?? "Support" };
}

// ---------- Rules, applied in this order ----------

export const RULES: readonly Rule[] = [
  {
    // The model may cite article IDs it never retrieved (hallucination). Keep only real ones.
    id: "verified_kb_articles",
    apply: (result, ctx) => ({
      ...result,
      kb_articles_used: result.kb_articles_used.filter((id) => ctx.retrievedKbIds.includes(id)),
    }),
  },
  {
    // Rule 1: refunds, disputes, duplicate or failed charges always go to a human in Billing.
    id: "R1_money_to_billing",
    apply: (result, ctx) => {
      const moneyRisk = mentionsMoneyRisk(ctx.ticket) || MONEY_RISK_ISSUE_TYPE.test(result.extracted.issue_type);
      if (!moneyRisk) return result;
      return { ...escalate(result, "Billing"), urgency: atLeast(result.urgency, "high") };
    },
  },
  {
    // Rule 1 (reply part): never promise a refund, whatever the ticket says.
    id: "R1_no_refund_promise",
    apply: (result, ctx) => {
      if (!promisesRefund(result.customer_reply_draft)) return result;
      const safe = { ...result, customer_reply_draft: safeReply(safeReplyLanguage(ctx.ticket), "billing") };
      return escalate(safe, "Billing");
    },
  },
  {
    // Rule 2: an Enterprise customer with an outage is a critical incident.
    id: "R2_enterprise_outage",
    apply: (result, ctx) => {
      const isEnterprise = ENTERPRISE.test(ctx.customerPlan ?? ctx.ticket.customer.info);
      const isOutage =
        OUTAGE_TEXT.test(customerText(ctx.ticket)) ||
        OUTAGE_ISSUE_TYPE.test(result.extracted.issue_type) ||
        result.route_team === "Engineering_Incident";
      if (!isEnterprise || !isOutage) return result;
      return { ...escalate(result, "Engineering_Incident"), urgency: "critical" };
    },
  },
  {
    // Rule 3: a low-confidence answer must not be sent automatically.
    id: "R3_low_confidence",
    apply: (result) =>
      result.decision === "auto_respond" && result.confidence < 0.7 ? escalate(result) : result,
  },
  {
    // Rule 4: auto-respond only for low/medium urgency backed by at least one KB article.
    id: "R4_auto_respond_requirements",
    apply: (result) => {
      if (result.decision !== "auto_respond") return result;
      const urgencyOk = result.urgency === "low" || result.urgency === "medium";
      const hasKb = result.kb_articles_used.length > 0;
      if (urgencyOk && hasKb) return result;
      return { ...result, decision: "route_to_specialist", route_team: result.route_team ?? "Support" };
    },
  },
  {
    // Rule 5: the reply must be written in the same script as the ticket (e.g. Thai for a Thai ticket).
    id: "R5_reply_language",
    apply: (result, ctx) => {
      const ticketScript = detectScript(customerText(ctx.ticket));
      const replyScript = detectScript(result.customer_reply_draft);

      // Thai is detected reliably, so correct an obviously wrong label. Other labels are left to the model.
      const labeled: TriageResult =
        ticketScript === "thai" && result.extracted.language !== "th"
          ? { ...result, extracted: { ...result.extracted, language: "th" } }
          : result;

      if (!ticketScript || ticketScript === replyScript) return labeled;

      // Wrong script: a human writes the real answer. Replace the draft if we have a safe reply in that language.
      const language = fallbackLanguage(ticketScript);
      const template = result.route_team === "Billing" ? "billing" : "general";
      const replaced = language ? { ...labeled, customer_reply_draft: safeReply(language, template) } : labeled;
      return escalate(replaced);
    },
  },
];

// ---------- Applying the policy ----------

/** Describes what a rule changed, e.g. "decision auto_respond -> escalate_to_human". */
function describeChanges(before: TriageResult, after: TriageResult): string[] {
  const changes: string[] = [];
  if (before.urgency !== after.urgency) changes.push(`urgency ${before.urgency} -> ${after.urgency}`);
  if (before.decision !== after.decision) changes.push(`decision ${before.decision} -> ${after.decision}`);
  if (before.route_team !== after.route_team) changes.push(`route_team ${before.route_team} -> ${after.route_team}`);
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
