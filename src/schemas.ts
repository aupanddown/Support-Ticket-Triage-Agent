import { z } from "zod";

// Enums are declared once here and reused by the agent, the policy, the tools and the tests.

export const Urgency = z.enum(["critical", "high", "medium", "low"]);
export type Urgency = z.infer<typeof Urgency>;

export const Sentiment = z.enum(["positive", "neutral", "negative", "angry"]);
export type Sentiment = z.infer<typeof Sentiment>;

export const Decision = z.enum(["auto_respond", "route_to_specialist", "escalate_to_human"]);
export type Decision = z.infer<typeof Decision>;

export const RouteTeam = z.enum(["Billing", "Engineering_Incident", "Product", "Support"]);
export type RouteTeam = z.infer<typeof RouteTeam>;

// Structured labels, so the guardrails and analytics do not depend on free text.
export const IssueType = z.enum([
  "billing_dispute", // refund request, duplicate, failed or unauthorized charge, chargeback threat
  "billing_question", // prices, plans, invoices
  "outage", // the product is down or erroring for many users
  "access_problem", // one person cannot log in or reach a page
  "bug", // the product does not behave as documented
  "feature_request",
  "how_to",
  "other",
]);
export type IssueType = z.infer<typeof IssueType>;

export const ProductArea = z.enum(["billing", "platform", "appearance", "account", "other"]);
export type ProductArea = z.infer<typeof ProductArea>;

// ---------- Input: an incoming ticket ----------

// Limits keep one request (e.g. through the API) from becoming very large, which costs tokens and time.
const MAX_MESSAGE_LENGTH = 10_000;
const MAX_MESSAGES = 50;

export const TicketMessage = z.object({
  sent: z.string().min(1).max(100).describe('Relative time the message was sent, e.g. "3 hours ago" or "just now"'),
  text: z.string().min(1).max(MAX_MESSAGE_LENGTH),
});
export type TicketMessage = z.infer<typeof TicketMessage>;

export const Ticket = z.object({
  id: z.string().min(1),
  customer: z.object({
    id: z.string().min(1).describe("Used by tools to look up history, billing, etc."),
    info: z.string().min(1).describe("Free-text customer context as shown to the support agent"),
  }),
  // Oldest first. The whole thread matters: frustration and deadlines build up over time.
  messages: z.array(TicketMessage).min(1).max(MAX_MESSAGES),
});
export type Ticket = z.infer<typeof Ticket>;

// ---------- Output: the triage result ----------

export const ExtractedInfo = z.object({
  product: ProductArea.describe("Product area the ticket is mainly about"),
  product_detail: z.string().describe('The specific product or feature, e.g. "Pro plan upgrade", "Web App (Asia region)"'),
  issue_types: z.array(IssueType).min(1).describe("Every issue in the thread, the most important first"),
  sentiment: Sentiment,
  language: z.string().describe('ISO 639-1 code of the language the customer writes in, e.g. "en" or "th"'),
});
export type ExtractedInfo = z.infer<typeof ExtractedInfo>;

export const TriageResult = z.object({
  ticket_id: z.string(),
  urgency: Urgency,
  extracted: ExtractedInfo,
  decision: Decision,
  route_team: RouteTeam.nullable().describe("The team that owns the ticket; null when the reply is sent automatically"),
  follow_up_teams: z
    .array(RouteTeam)
    .describe("Other teams that should also act, e.g. Product for a bug report on an auto-responded ticket"),
  kb_articles_used: z.array(z.string()).describe("IDs of knowledge base articles the reply relies on"),
  customer_reply_draft: z.string().describe("Reply to the customer, written in the customer's language"),
  internal_note: z.string().describe("Reasoning summary for the human agent, including any deadlines the customer mentioned"),
  confidence: z.number().min(0).max(1),
  guardrails_applied: z.array(z.string()).describe("Policy rules that changed the outcome (filled by policy.ts, not the LLM)"),
});
export type TriageResult = z.infer<typeof TriageResult>;

// What the LLM must return. ticket_id is set by our code and guardrails_applied by the policy,
// so the model is never asked to produce (or able to fake) either of them.
export const LlmTriageOutput = TriageResult.omit({ ticket_id: true, guardrails_applied: true });
export type LlmTriageOutput = z.infer<typeof LlmTriageOutput>;
