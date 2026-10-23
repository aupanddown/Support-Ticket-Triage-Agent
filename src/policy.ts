import { detectLanguage, type Language } from "./language.js";
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
}

interface Rule {
  id: string;
  apply(result: TriageResult, ctx: PolicyContext): TriageResult;
}

// ---------- Signals detected from the ticket text (English and Thai) ----------

const MONEY_PATTERN =
  /\b(refunds?|refunded|charges?|charged|chargebacks?|disputes?|disputing|billing|billed|payments?|reimburse\w*|money back)\b|\$\s?\d|คืนเงิน|เงิน|ชำระ|เรียกเก็บ/i;

const OUTAGE_PATTERN =
  /\b(outage|down|error\s*5\d\d|5\d\d\s*error|can'?t access|cannot access|unable to access|coworkers|colleagues|everyone|whole team|all users)\b|เข้าไม่ได้|ใช้งานไม่ได้|ล่ม|เพื่อนร่วมงาน|ทุกคน/i;

const OUTAGE_ISSUE_TYPE = /outage|incident|downtime/i;

const ENTERPRISE_PATTERN = /\benterprise\b/i;

// Phrases that promise or confirm a refund/reversal. Only a human in Billing may decide that.
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

export function mentionsMoney(ticket: Ticket): boolean {
  return MONEY_PATTERN.test(customerText(ticket));
}

export function promisesRefund(reply: string): boolean {
  return REFUND_PROMISE_PATTERNS.some((pattern) => pattern.test(reply));
}

// ---------- Safe fallback replies (never promise refunds or compensation) ----------

const SAFE_REPLIES: Record<Language, { billing: string; general: string }> = {
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
      "สวัสดีครับ ขออภัยในความไม่สะดวกเรื่องการชำระเงินครับ เราได้ส่งเรื่องของคุณให้ทีม Billing ตรวจสอบเป็นกรณีเร่งด่วนแล้ว " +
      "ทีมจะตรวจสอบทุกรายการที่เรียกเก็บและสถานะแพ็กเกจของคุณ และจะติดต่อกลับโดยตรงครับ",
    general:
      "สวัสดีครับ ขอบคุณที่ติดต่อเรา เราได้ส่งเรื่องของคุณให้ทีมที่เกี่ยวข้องแล้ว และเจ้าหน้าที่จะติดต่อกลับโดยเร็วที่สุดครับ",
  },
};

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

function addNote(result: TriageResult, note: string): TriageResult {
  return { ...result, internal_note: `${result.internal_note}\n[Policy] ${note}`.trim() };
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
    // Rule 1: money, refunds, duplicate charges or disputes always go to a human in Billing.
    id: "R1_money_to_billing",
    apply: (result, ctx) => {
      if (!mentionsMoney(ctx.ticket)) return result;
      const escalated = escalate(result, "Billing");
      return { ...escalated, urgency: atLeast(result.urgency, "high") };
    },
  },
  {
    // Rule 1 (reply part): never promise a refund, whatever the ticket says.
    id: "R1_no_refund_promise",
    apply: (result, ctx) => {
      if (!promisesRefund(result.customer_reply_draft)) return result;
      const language = detectLanguage(customerText(ctx.ticket));
      const safe = { ...result, customer_reply_draft: SAFE_REPLIES[language].billing };
      return addNote(escalate(safe, "Billing"), "Draft reply promised a refund and was replaced with a safe reply.");
    },
  },
  {
    // Rule 2: an Enterprise customer with an outage or many affected users is a critical incident.
    id: "R2_enterprise_outage",
    apply: (result, ctx) => {
      const isEnterprise = ENTERPRISE_PATTERN.test(ctx.ticket.customer.info);
      const isOutage =
        OUTAGE_PATTERN.test(customerText(ctx.ticket)) ||
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
    // Rule 5: the reply must be in the customer's language.
    id: "R5_reply_language",
    apply: (result, ctx) => {
      const ticketLanguage = detectLanguage(customerText(ctx.ticket));
      let checked: TriageResult = { ...result, extracted: { ...result.extracted, language: ticketLanguage } };

      if (detectLanguage(result.customer_reply_draft) !== ticketLanguage) {
        // We cannot translate safely here, so use a safe reply and let a human write the real answer.
        const template = result.route_team === "Billing" ? "billing" : "general";
        checked = { ...checked, customer_reply_draft: SAFE_REPLIES[ticketLanguage][template] };
        checked = addNote(escalate(checked), `Draft reply was not in the customer's language (${ticketLanguage}).`);
      }
      return checked;
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
 * Runs every rule in order and records each rule that changed something in `guardrails_applied`,
 * e.g. "R1_money_to_billing: decision auto_respond -> escalate_to_human; route_team null -> Billing".
 */
export function applyPolicy(result: TriageResult, ctx: PolicyContext, rules: readonly Rule[] = RULES): TriageResult {
  let current = result;
  const applied = [...result.guardrails_applied];

  for (const rule of rules) {
    const next = rule.apply(current, ctx);
    const changes = describeChanges(current, next);
    if (changes.length > 0) applied.push(`${rule.id}: ${changes.join("; ")}`);
    current = next;
  }

  return { ...current, guardrails_applied: applied };
}
