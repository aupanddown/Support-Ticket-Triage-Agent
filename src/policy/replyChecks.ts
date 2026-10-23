import type { Ticket } from "../schemas.js";

/**
 * Checks on the reply draft. Best effort: they guard replies that are SENT AUTOMATICALLY.
 * An escalated ticket's reply is a draft that a person reads before sending.
 */

// Replies that promise or confirm a refund, credit or compensation. Only a human in Billing may decide that.
// "I will pass your refund request to Billing" is not a promise.
const REFUND_PROMISE_PATTERNS: readonly RegExp[] = [
  /\b(we|i)('ll|'re|'ve| will| are| have| am| am going to| are going to)\s+(\w+\s+){0,5}(?<!\bfor\s+(a\s+)?)(refund|reimburse|reverse)(d|ing)?\b(?!\s+(request|policy|process|team|department))/i,
  /\b(we|i|team|billing)\s+(can|could|is going to|are going to|will be able to)\s+(\w+\s+){0,2}(refund|reimburse|reverse)\b(?!\s+(request|policy|process))/i,
  /\byou('ll| will)\s+be\s+(fully\s+)?(refunded|reimbursed|credited)\b/i,
  /\b(we|i)('ll|'re| will| are| am)\s+(\w+\s+){0,3}(issu\w*|giv\w*|add\w*|appl\w*)\s+(you\s+|your account\s+)?(a\s+|an\s+)?(full\s+|partial\s+)?(refund|credit|discount)\b/i,
  /\bcredit\w*\s+(to\s+)?(your|the)\s+account\b/i,
  /\b(team|billing)\s+will\s+(\w+\s+){0,2}(refund|reimburse|reverse)\b(?!\s+(request|policy|process))/i,
  /\b(refunds?|reversals?|reimbursements?)\s+(has|have|will|is|are)\s+(been\s+)?(be\s+)?(issued|processed|approved|initiated|sent)/i,
  /\b(will|shall)\s+be\s+(fully\s+)?(refunded|reversed|reimbursed|credited|returned)\b/i,
  /\b(has|have)\s+been\s+(fully\s+)?(refunded|reversed|reimbursed|credited)\b/i,
  /\byou('ll| will)\s+(\w+\s+){0,3}(get|receive|see)\s+(\w+\s+){0,3}(refund|money back)/i,
  /\b(as (an apology|compensation)|by way of compensation)\b/i,
  /\b(a\s+)?(month|months|week|weeks)\s+(for\s+)?free\b|\bfree\s+(month|months|week|weeks)\b/i,
  /\bguarantee\w*\b.*\brefund/i,
  // Thai: "will refund", "refund you", "compensate you"; not "your refund request" (คำขอคืนเงิน).
  /จะ.{0,20}(?<!ขอ)คืนเงิน|(?<!ขอ)คืนเงินให้|ชดเชยให้/,
];

// Money words in a reply. An AUTOMATIC reply that talks about money is reviewed by a human,
// even when no promise pattern matched. Broad on purpose: a false positive only adds a review.
// ("credit card" / "บัตรเครดิต" is not counted.)
const MONEY_IN_REPLY =
  /\b(refund\w*|reimburs\w*|compensat\w*|chargebacks?|money back|credit(?![- ]?card)\w*|revers(e|ed|al)\s+(\w+\s+){0,2}(charges?|payments?|transactions?))\b|คืนเงิน|ชดเชย|(?<!บัตร)เครดิต/i;

/**
 * Normalizes quotes before matching: models often write typographic quotes instead of "We'll".
 * (Not NFKC: it would split the Thai vowel "ำ" into two characters and break the Thai patterns.)
 */
export function normalizeQuotes(text: string): string {
  return text.replace(/[‘’ʼ`´]/g, "'").replace(/[“”]/g, '"');
}

export function customerText(ticket: Ticket): string {
  return normalizeQuotes(ticket.messages.map((m) => m.text).join("\n"));
}

export function promisesRefund(reply: string): boolean {
  const text = normalizeQuotes(reply);
  return REFUND_PROMISE_PATTERNS.some((pattern) => pattern.test(text));
}

export function mentionsMoneyInReply(reply: string): boolean {
  return MONEY_IN_REPLY.test(normalizeQuotes(reply));
}
