import { detectScript, fallbackLanguage, type ReplyLanguage } from "./language.js";
import type { IssueType, RouteTeam, Ticket, TriageResult, Urgency } from "./schemas.js";

/**
 * Deterministic guardrails applied AFTER the LLM.
 *
 * The LLM is good at understanding tickets but can be wrong or manipulated (prompt injection),
 * so these rules have the final say. Every rule can only make the outcome safer: raise urgency,
 * hand the ticket to a human, add a team, or replace an unsafe reply. None of them can undo an
 * escalation. All functions here are pure: no I/O, no mutation of the input.
 *
 * Signals, strongest first:
 * 1. the model's structured classification (`issue_types`), which can only ADD escalations,
 *    so a fooled model cannot use it to avoid one;
 * 2. facts from tool results, counted only when the ticket is about that topic;
 * 3. a short list of explicit phrases, as a backup in case the model misses the obvious.
 */

/** Evidence from tool results (see `Tool.facts`). Every field is optional: a tool may not have been called. */
export interface PolicyFacts {
  /** get_customer_history */
  customerPlan?: string;
  customerRegion?: string;
  /** get_billing_transactions: a failed activation, or the same thing charged more than once. */
  billingProblem?: boolean;
  /** check_service_status: regions with a component that is not operational. */
  degradedRegions?: string[];
  /** search_knowledge_base: IDs of the articles actually returned. */
  retrievedKbIds?: string[];
}

export interface PolicyContext {
  ticket: Ticket;
  facts: PolicyFacts;
}

export interface Rule {
  id: string;
  apply(result: TriageResult, ctx: PolicyContext): TriageResult;
}

// ---------- Backup phrase lists (English and Thai) ----------

// A money matter only a human may decide: refund requests, disputes, duplicate, failed or
// unauthorized charges. "What is your refund policy?" is not one.
const MONEY_RISK_TEXT = new RegExp(
  [
    String.raw`\b(refund me|money back|chargebacks?)\b`,
    String.raw`\b(want|need|get|request|requesting|asking for|issue|give me|process)\s+(me\s+)?(a\s+|my\s+)?(full\s+)?refund`,
    String.raw`\bdisput\w*\b.{0,40}\b(bank|card|charges?|payments?|transactions?)\b`,
    String.raw`\b(charged|billed)\s+(me\s+)?(twice|again|two times|three times|multiple times|\d+ times)\b`,
    String.raw`\b(double|duplicate)[- ]charg\w*`,
    String.raw`\b(double|duplicate|unauthori[sz]ed)\s+(payments?|transactions?)\b`,
    String.raw`\b(see|have|got|there are|now)\s+(double|multiple|two|three|\d+)\s+(pending\s+)?charges\b`,
    String.raw`\breverse\s+(the\s+|this\s+|these\s+|my\s+|all\s+)?(charges?|payments?|transactions?)\b`,
    String.raw`\bcharges?\s+(\w+\s+){0,2}reversed\b`,
    String.raw`\b(payments?\s+(failed|declined|did not go through|didn't go through)|failed payments?)\b`,
    "ขอคืนเงิน|ขอเงินคืน|คืนเงินให้|ตัดเงินซ้ำ|หักเงินซ้ำ|เรียกเก็บซ้ำ|จ่ายเงินไม่ผ่าน|ชำระเงินไม่สำเร็จ",
    "(โดน|ถูก)(ตัด|หัก)เงิน.{0,10}(ครั้ง|รอบ|ซ้ำ)",
  ].join("|"),
  "i",
);

// The product is down for many people. One user who cannot log in, or one error on one file, is not an outage.
const OUTAGE_TEXT = new RegExp(
  [
    String.raw`\b(outage|(app|site|system|service|platform|website)\s+(is|went)\s+down)\b`,
    String.raw`\b(error|5\d\d|down|can'?t|cannot|unable|not working)\b.{0,40}\bfor\s+(everyone|all\s+(of\s+)?(our|my)\s+users|the\s+whole\s+team|our\s+whole\s+team)\b`,
    String.raw`\b(nobody|no one)\b.{0,30}\bcan\b`,
    String.raw`\b(coworkers|colleagues|everyone|whole team|all (of )?(our|my) users)\b.{0,30}\b(can'?t|cannot|unable to)\b`,
    "ระบบล่ม|ระบบเข้าไม่ได้|ระบบใช้งานไม่ได้|(เพื่อนร่วมงาน|ทุกคน).{0,15}(เข้าไม่ได้|ใช้งานไม่ได้|ใช้ไม่ได้)",
  ].join("|"),
  "i",
);

const ENTERPRISE = /\benterprise\b/i;

// Phrases that promise or confirm a refund, credit or compensation. Only a human in Billing may decide that.
const REFUND_PROMISE_PATTERNS: readonly RegExp[] = [
  /\b(we|i)('ll|'re|'ve| will| are| have| am| am going to| are going to)\s+(\w+\s+){0,5}(refund\w*|revers\w*|reimburs\w*)/i,
  /\b(we|i)('ll|'re| will| are| am)\s+(\w+\s+){0,3}(issu\w*|giv\w*|add\w*|appl\w*)\s+(you\s+|your account\s+)?(a\s+|an\s+)?(full\s+|partial\s+)?(refund|credit|discount)\b/i,
  /\bcredit\w*\s+(to\s+)?(your|the)\s+account\b/i,
  /\b(team|billing)\s+will\s+(\w+\s+){0,2}(refund|reverse|reimburse)/i,
  /\b(refunds?|reversals?|reimbursements?)\s+(has|have|will|is|are)\s+(been\s+)?(be\s+)?(issued|processed|approved|initiated|sent)/i,
  /\b(will|shall)\s+be\s+(fully\s+)?(refunded|reversed|reimbursed|credited|returned)\b/i,
  /\b(has|have)\s+been\s+(fully\s+)?(refunded|reversed|reimbursed|credited)\b/i,
  /\byou('ll| will)\s+(\w+\s+){0,3}(get|receive|see)\s+(\w+\s+){0,3}(refund|money back)/i,
  /\b(as (an apology|compensation)|by way of compensation)\b/i,
  /\b(a\s+)?(month|months|week|weeks)\s+(for\s+)?free\b|\bfree\s+(month|months|week|weeks)\b/i,
  /\bguarantee\w*\b.*\brefund/i,
  /จะ.{0,20}คืนเงิน|คืนเงินให้|ชดเชยให้/,
];

// Money words in a reply. An AUTOMATIC reply that talks about money is reviewed by a human,
// even when no promise pattern matched ("credit card" / "บัตรเครดิต" is not counted).
const MONEY_IN_REPLY =
  /\b(refund\w*|reimburs\w*|compensat\w*|chargebacks?|money back|credit(?!\s*card)\w*)\b|คืนเงิน|ชดเชย|(?<!บัตร)เครดิต/i;

/**
 * Normalizes quotes before matching: models often write typographic quotes ("We’ll") instead of "We'll".
 * (Not NFKC: it would split the Thai vowel "ำ" into two characters and break the Thai patterns.)
 */
function normalize(text: string): string {
  return text.replace(/[‘’ʼ`´]/g, "'").replace(/[“”]/g, '"');
}

function customerText(ticket: Ticket): string {
  return normalize(ticket.messages.map((m) => m.text).join("\n"));
}

/** Backup signal: the ticket text raises a money matter that only a human in Billing may decide. */
export function mentionsMoneyRisk(ticket: Ticket): boolean {
  return MONEY_RISK_TEXT.test(customerText(ticket));
}

/** Backup signal: the ticket text describes an outage rather than a single user's problem. */
export function mentionsOutage(ticket: Ticket): boolean {
  return OUTAGE_TEXT.test(customerText(ticket));
}

export function promisesRefund(reply: string): boolean {
  const text = normalize(reply);
  return REFUND_PROMISE_PATTERNS.some((pattern) => pattern.test(text));
}

export function mentionsMoneyInReply(reply: string): boolean {
  return MONEY_IN_REPLY.test(normalize(reply));
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

function hasIssue(result: TriageResult, ...types: IssueType[]): boolean {
  return types.some((type) => result.extracted.issue_types.includes(type));
}

function addFollowUp(result: TriageResult, team: RouteTeam): TriageResult {
  if (result.follow_up_teams.includes(team)) return result;
  return { ...result, follow_up_teams: [...result.follow_up_teams, team] };
}

/**
 * Hands the ticket to a human. A new owner team keeps the previous team as a follow-up,
 * so e.g. an outage ticket that also has a duplicate charge still reaches Billing.
 */
function escalate(result: TriageResult, team?: RouteTeam): TriageResult {
  const owner = team ?? result.route_team ?? "Support";
  const previous = result.route_team;
  const escalated: TriageResult = { ...result, decision: "escalate_to_human", route_team: owner };
  return previous && previous !== owner ? addFollowUp(escalated, previous) : escalated;
}

// ---------- Rules, applied in this order ----------

export const RULES: readonly Rule[] = [
  {
    // The model may cite article IDs it never retrieved (hallucination). Keep only real ones.
    id: "verified_kb_articles",
    apply: (result, { facts }) => ({
      ...result,
      kb_articles_used: result.kb_articles_used.filter((id) => facts.retrievedKbIds?.includes(id)),
    }),
  },
  {
    // Rule 1: refunds, disputes, duplicate or failed charges always go to a human in Billing.
    // A billing problem on the account counts only when the ticket is about billing.
    id: "R1_money_to_billing",
    apply: (result, { ticket, facts }) => {
      const aboutBilling = hasIssue(result, "billing_dispute", "billing_question");
      const moneyRisk =
        hasIssue(result, "billing_dispute") || mentionsMoneyRisk(ticket) || (aboutBilling && facts.billingProblem === true);
      if (!moneyRisk) return result;
      return { ...escalate(result, "Billing"), urgency: atLeast(result.urgency, "high") };
    },
  },
  {
    // Rule 1 (reply part): never promise a refund or compensation, whatever the ticket says.
    id: "R1_no_refund_promise",
    apply: (result, { ticket }) => {
      if (!promisesRefund(result.customer_reply_draft)) return result;
      const safe = { ...result, customer_reply_draft: safeReply(safeReplyLanguage(ticket), "billing") };
      return escalate(safe, "Billing");
    },
  },
  {
    // Backup for rule 1: an automatic reply that talks about money is checked by a human first.
    id: "R1_money_reply_reviewed",
    apply: (result) =>
      result.decision === "auto_respond" && mentionsMoneyInReply(result.customer_reply_draft)
        ? escalate(result, "Billing")
        : result,
  },
  {
    // Rule 2: an Enterprise customer with an outage is a critical incident.
    // A degraded region counts only when the ticket reports a problem, not for a how-to question.
    id: "R2_enterprise_outage",
    apply: (result, { ticket, facts }) => {
      // Enterprise if EITHER source says so, so a lookup can never make the outcome less safe.
      const isEnterprise = ENTERPRISE.test(ticket.customer.info) || ENTERPRISE.test(facts.customerPlan ?? "");
      const regionDegraded =
        facts.customerRegion !== undefined && (facts.degradedRegions ?? []).includes(facts.customerRegion);
      const isOutage =
        hasIssue(result, "outage") ||
        mentionsOutage(ticket) ||
        (regionDegraded && hasIssue(result, "access_problem", "bug"));
      if (!isEnterprise || !isOutage) return result;
      return { ...escalate(result, "Engineering_Incident"), urgency: "critical" };
    },
  },
  {
    // Critical means a person acts now: it is never auto-answered or left in a queue.
    id: "critical_to_human",
    apply: (result) =>
      result.urgency === "critical" && result.decision !== "escalate_to_human" ? escalate(result) : result,
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
    apply: (result, { ticket }) => {
      const ticketScript = detectScript(customerText(ticket));
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
  {
    // Every ticket that needs a person has an owner, and bug reports or feature requests on an
    // automatically answered ticket still reach Product as a follow-up.
    id: "team_assigned",
    apply: (result) => {
      if (result.decision !== "auto_respond" && result.route_team === null) return { ...result, route_team: "Support" };
      if (result.decision === "auto_respond" && hasIssue(result, "bug", "feature_request")) {
        return addFollowUp(result, "Product");
      }
      return result;
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
