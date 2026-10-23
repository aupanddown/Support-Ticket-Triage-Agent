import { detectScript, fallbackLanguage } from "../language.js";
import type { IssueType, RouteTeam, Ticket, TriageResult, Urgency } from "../schemas.js";
import { customerText, mentionsMoneyInReply, promisesRefund } from "./replyChecks.js";
import { safeReply, safeReplyLanguage } from "./safeReplies.js";
import type { PolicyFacts, Rule } from "./types.js";

/** Below this confidence a ticket is never answered automatically (also stated in the system prompt). */
export const AUTO_RESPOND_MIN_CONFIDENCE = 0.7;

// The plan name at the start of the customer info ("Enterprise plan, Thailand region, ..."),
// so a mention such as "evaluating an Enterprise upgrade" does not count.
const ENTERPRISE_PLAN = /^\s*enterprise\b/i;

// ---------- Helpers ----------

const URGENCY_RANK: Record<Urgency, number> = { low: 0, medium: 1, high: 2, critical: 3 };

/** Returns the higher of two urgency levels. */
export function atLeast(current: Urgency, minimum: Urgency): Urgency {
  return URGENCY_RANK[current] >= URGENCY_RANK[minimum] ? current : minimum;
}

function hasIssue(result: TriageResult, ...types: IssueType[]): boolean {
  return types.some((type) => result.extracted.issue_types.includes(type));
}

/** Enterprise if EITHER the ticket or customer history says so, so a lookup can never make the outcome less safe. */
function isEnterprise(ticket: Ticket, facts: PolicyFacts): boolean {
  return ENTERPRISE_PLAN.test(ticket.customer.info) || facts.customerPlan === "Enterprise";
}

/** A component is not operational in the customer's own region. */
function regionDegraded(facts: PolicyFacts): boolean {
  return facts.customerRegion !== undefined && (facts.degradedRegions ?? []).includes(facts.customerRegion);
}

/** Adds a follow-up team, unless it already owns the ticket or is listed. */
function addFollowUp(result: TriageResult, team: RouteTeam): TriageResult {
  if (result.route_team === team || result.follow_up_teams.includes(team)) return result;
  return { ...result, follow_up_teams: [...result.follow_up_teams, team] };
}

/**
 * Hands the ticket to a human. A new owner team keeps the previous team as a follow-up,
 * so e.g. an outage ticket that also has a duplicate charge still reaches Billing.
 * The owner is never also listed as a follow-up.
 */
function escalate(result: TriageResult, team?: RouteTeam): TriageResult {
  const owner = team ?? result.route_team ?? "Support";
  const previous = result.route_team;
  const escalated: TriageResult = {
    ...result,
    decision: "escalate_to_human",
    route_team: owner,
    follow_up_teams: result.follow_up_teams.filter((t) => t !== owner),
  };
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
    // Refunds, disputes, duplicate or failed charges always go to a human in Billing. An unresolved
    // payment found by the billing lookup counts too, whatever the model's labels say.
    id: "money_to_billing",
    apply: (result, { facts }) => {
      if (!hasIssue(result, "billing_dispute") && facts.unresolvedPayment !== true) return result;
      return { ...escalate(result, "Billing"), urgency: atLeast(result.urgency, "high") };
    },
  },
  {
    // Never promise a refund or compensation, whatever the ticket says. Billing decides on money, so it
    // owns the ticket, unless an incident team already does (e.g. a service credit during an outage).
    id: "no_refund_promise",
    apply: (result, { ticket }) => {
      if (!promisesRefund(result.customer_reply_draft)) return result;
      const owner = result.route_team === "Engineering_Incident" ? "Engineering_Incident" : "Billing";
      const template = owner === "Billing" ? "billing" : "general";
      const safe = { ...result, customer_reply_draft: safeReply(safeReplyLanguage(ticket), template) };
      return { ...addFollowUp(escalate(safe, owner), "Billing"), urgency: atLeast(result.urgency, "high") };
    },
  },
  {
    // Backstop: an automatic reply that talks about money is checked by a human first.
    id: "money_reply_reviewed",
    apply: (result) =>
      result.decision === "auto_respond" && mentionsMoneyInReply(result.customer_reply_draft)
        ? escalate(result, "Billing")
        : result,
  },
  {
    // An Enterprise customer with an outage is a critical incident. A degraded component in the
    // customer's region confirms an access problem or bug as an outage; a how-to stays a how-to.
    id: "enterprise_outage_critical",
    apply: (result, { ticket, facts }) => {
      const isOutage = hasIssue(result, "outage") || (regionDegraded(facts) && hasIssue(result, "access_problem", "bug"));
      if (!isEnterprise(ticket, facts) || !isOutage) return result;
      return { ...escalate(result, "Engineering_Incident"), urgency: "critical" };
    },
  },
  {
    // Any outage, whatever the plan, goes to the incident team as a person's job, at least high.
    id: "outage_to_engineering",
    apply: (result) => {
      if (!hasIssue(result, "outage")) return result;
      if (result.decision === "escalate_to_human" && result.route_team === "Engineering_Incident") return result;
      return { ...escalate(result, "Engineering_Incident"), urgency: atLeast(result.urgency, "high") };
    },
  },
  {
    // During an incident in an Enterprise customer's region, a person checks the ticket before any
    // reply goes out, even if the model calls it a how-to. It is not paged as an incident.
    id: "no_auto_reply_during_incident",
    apply: (result, { ticket, facts }) => {
      if (!isEnterprise(ticket, facts) || !regionDegraded(facts) || result.decision !== "auto_respond") return result;
      return { ...result, decision: "route_to_specialist", route_team: result.route_team ?? "Support" };
    },
  },
  {
    // Critical means a person acts now: it is never auto-answered or left in a queue.
    id: "critical_to_human",
    apply: (result) =>
      result.urgency === "critical" && result.decision !== "escalate_to_human" ? escalate(result) : result,
  },
  {
    // A low-confidence answer is never sent automatically.
    id: "low_confidence",
    apply: (result) =>
      result.decision === "auto_respond" && result.confidence < AUTO_RESPOND_MIN_CONFIDENCE ? escalate(result) : result,
  },
  {
    // Auto-respond only for low/medium urgency backed by at least one KB article.
    // A high urgency ticket goes to a person now; one without a KB answer goes to a specialist.
    id: "auto_respond_requirements",
    apply: (result) => {
      if (result.decision !== "auto_respond") return result;
      if (result.urgency === "high" || result.urgency === "critical") return escalate(result);
      if (result.kb_articles_used.length > 0) return result;
      return { ...result, decision: "route_to_specialist", route_team: result.route_team ?? "Support" };
    },
  },
  {
    // The reply must be written in the same script as the ticket (e.g. Thai for a Thai ticket).
    id: "reply_language",
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
    // Every ticket that needs a person has an owner. An automatically answered ticket has no owner:
    // a team the model named becomes a follow-up, and bug reports or feature requests reach Product.
    id: "team_assigned",
    apply: (result) => {
      if (result.decision !== "auto_respond") {
        return result.route_team === null ? { ...result, route_team: "Support" } : result;
      }
      let followed = result.route_team ? addFollowUp({ ...result, route_team: null }, result.route_team) : result;
      if (hasIssue(followed, "bug", "feature_request")) followed = addFollowUp(followed, "Product");
      return followed;
    },
  },
];
