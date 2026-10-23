import tickets from "../data/tickets.json" with { type: "json" };
import { Ticket, type TriageResult } from "../src/schemas.js";

/** One of the sample tickets from data/tickets.json (T1, T2 or T3). */
export function sampleTicket(id: "T1" | "T2" | "T3"): Ticket {
  const raw = tickets.find((t) => t.id === id);
  if (!raw) throw new Error(`Sample ticket ${id} not found`);
  return Ticket.parse(raw);
}

/** A small ticket built from message texts, for edge cases. */
export function makeTicket(texts: string[], info = "Pro plan, 5 months customer"): Ticket {
  return {
    id: "TEST",
    customer: { id: "C-3001", info },
    messages: texts.map((text, i) => ({ sent: `${texts.length - i} hours ago`, text })),
  };
}

/** A harmless, valid result that passes every guardrail. Override what a test needs. */
export function makeResult(overrides: Partial<TriageResult> = {}): TriageResult {
  return {
    ticket_id: "TEST",
    urgency: "low",
    extracted: { product: "appearance", product_detail: "Theme settings", issue_types: ["how_to"], sentiment: "neutral", language: "en" },
    decision: "auto_respond",
    route_team: null,
    follow_up_teams: [],
    kb_articles_used: ["KB-101"],
    customer_reply_draft: "Hi! You can change the theme in Settings > Appearance.",
    internal_note: "Simple how-to question.",
    confidence: 0.9,
    guardrails_applied: [],
    ...overrides,
  };
}
