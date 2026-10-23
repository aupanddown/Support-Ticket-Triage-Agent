import { describe, expect, it } from "vitest";
import { detectScript } from "../src/language.js";
import {
  applyPolicy,
  atLeast,
  mentionsMoneyInReply,
  type PolicyFacts,
  promisesRefund,
} from "../src/policy.js";
import { Decision, type IssueType, Urgency, type Ticket, type TriageResult } from "../src/schemas.js";
import { makeResult, makeTicket, sampleTicket } from "./fixtures.js";

const ALL_KB_IDS = ["KB-101", "KB-102", "KB-201", "KB-202", "KB-203", "KB-301", "KB-302", "KB-401"];

/** Runs the policy as if the KB search returned every article, plus any extra tool facts. */
function run(
  result: TriageResult,
  ticket: Ticket = makeTicket(["How do I change the theme?"]),
  facts: PolicyFacts = {},
): TriageResult {
  return applyPolicy(result, { ticket, facts: { retrievedKbIds: ALL_KB_IDS, ...facts } });
}

function ruleIds(result: TriageResult): string[] {
  return result.guardrails_applied.map((entry) => entry.split(":")[0]!);
}

describe("applyPolicy", () => {
  it("leaves a safe result unchanged and records nothing", () => {
    const input = makeResult();
    expect(run(input)).toEqual(input);
  });

  it("does not mutate its input", () => {
    const input = makeResult({ decision: "auto_respond", urgency: "critical" });
    const copy = structuredClone(input);
    run(input, sampleTicket("T1"));
    expect(input).toEqual(copy);
  });

  const dispute = (overrides = {}) =>
    makeResult({ extracted: { ...makeResult().extracted, issue_types: ["billing_dispute"] }, ...overrides });

  it("records what each rule changed", () => {
    const result = run(dispute({ urgency: "medium" }), sampleTicket("T1"));
    expect(result.guardrails_applied[0]).toBe(
      "R1_money_to_billing: urgency medium -> high; decision auto_respond -> escalate_to_human; route_team null -> Billing",
    );
  });

  it("adds every change to the internal note, so the note matches the final routing", () => {
    const result = run(dispute({ internal_note: "Route to Support." }), sampleTicket("T1"));
    expect(result.internal_note).toMatch(/^Route to Support\.\n\[Policy\] R1_money_to_billing: .*route_team null -> Billing/);
  });

  it("can only make the outcome safer (never lowers urgency, never creates an auto_respond)", () => {
    const rank = { low: 0, medium: 1, high: 2, critical: 3 };
    for (const urgency of Urgency.options) {
      for (const decision of Decision.options) {
        for (const ticket of [sampleTicket("T1"), sampleTicket("T2"), sampleTicket("T3")]) {
          const out = run(makeResult({ urgency, decision }), ticket);
          expect(rank[out.urgency]).toBeGreaterThanOrEqual(rank[urgency]);
          if (decision !== "auto_respond") expect(out.decision).not.toBe("auto_respond");
          if (decision === "escalate_to_human") expect(out.decision).toBe("escalate_to_human");
        }
      }
    }
  });
});

describe("verified_kb_articles", () => {
  it("drops KB IDs the tools never returned", () => {
    const ctx = { ticket: makeTicket(["dark mode?"]), facts: { retrievedKbIds: ["KB-101"] } };
    const result = applyPolicy(makeResult({ kb_articles_used: ["KB-101", "KB-999"] }), ctx);
    expect(result.kb_articles_used).toEqual(["KB-101"]);
    expect(ruleIds(result)).toContain("verified_kb_articles");
  });
});

describe("R1: money matters go to a human in Billing", () => {
  const dispute = makeResult({ extracted: { ...makeResult().extracted, issue_types: ["billing_dispute"] } });

  it("escalates a billing dispute to Billing with at least high urgency", () => {
    const result = run({ ...dispute, urgency: "medium" }, sampleTicket("T1"));
    expect(result).toMatchObject({ decision: "escalate_to_human", route_team: "Billing", urgency: "high" });
  });

  it("keeps critical urgency when the LLM already chose it", () => {
    expect(run({ ...dispute, urgency: "critical" }, sampleTicket("T1")).urgency).toBe("critical");
  });

  it.each([
    "I want my money back",
    "What is your chargeback policy?",
    "Will I be double charged if I switch to annual billing?",
    "I was not charged twice, just checking how billing works",
    "ขอคืนเงินด้วยครับ",
  ])("follows the classification, never the wording of the ticket: %s", (text) => {
    expect(ruleIds(run(makeResult(), makeTicket([text])))).not.toContain("R1_money_to_billing");
    expect(run(dispute, makeTicket([text])).route_team).toBe("Billing");
  });

  it.each([
    "We will refund all three charges today.",
    "I'll make sure the charges are reversed by end of day.",
    "Your refund has been issued.",
    "Refunds will be processed within 24 hours.",
    "You will receive a full refund.",
    "Our billing team will refund you.",
    "We guarantee a refund.",
    "We'll credit your account with one free month.",
    // Typographic apostrophes, as models often write them.
    "We’ll refund all three charges today.",
    "You’ll receive a full refund.",
    "I’ve issued a refund for the duplicate charges.",
    // Passive voice.
    "The duplicate charges will be refunded by end of day.",
    "Your payment has been fully reversed.",
    // Credits and compensation.
    "We're issuing you a credit for the downtime.",
    "We are refunding the extra charges today.",
    "We'll give you a month free as compensation.",
    "As an apology we are crediting your account.",
    "เราจะคืนเงินให้ภายในวันนี้ครับ",
    "เราจะดำเนินการคืนเงินให้ครับ",
  ])("flags a refund promise: %s", (reply) => {
    expect(promisesRefund(reply)).toBe(true);
  });

  it("does not mistake a credit card for a credit", () => {
    expect(promisesRefund("We'll check your credit card details.")).toBe(false);
    expect(mentionsMoneyInReply("Pay with any credit card in Settings > Billing.")).toBe(false);
    expect(mentionsMoneyInReply("ชำระผ่านบัตรเครดิตได้ครับ")).toBe(false);
  });

  it("sends an automatic reply that talks about money to a human, even without a clear promise", () => {
    const reply = "Our refund policy allows a partial amount back in some cases.";
    const result = run(makeResult({ customer_reply_draft: reply }));
    expect(result).toMatchObject({ decision: "escalate_to_human", route_team: "Billing", customer_reply_draft: reply });
    expect(ruleIds(result)).toContain("R1_money_reply_reviewed");
  });

  it.each([
    "Our Billing team will review every charge on your account.",
    "I can't confirm a refund myself, but Billing is looking at it now.",
    "Pending authorizations usually drop off within 3 to 5 business days.",
    "I will escalate this reversal request to Billing right away.",
    "I will pass your refund request to our billing team.",
  ])("does not flag a safe reply: %s", (reply) => {
    expect(promisesRefund(reply)).toBe(false);
  });

  it("replaces a reply that promises a refund", () => {
    const result = run(
      makeResult({ customer_reply_draft: "So sorry! We will refund all three charges right away." }),
      sampleTicket("T1"),
    );
    expect(promisesRefund(result.customer_reply_draft)).toBe(false);
    expect(result.customer_reply_draft).toMatch(/Billing team/);
    expect(result.internal_note).toMatch(/\[Policy\] R1_no_refund_promise/);
  });
});

describe("R2: Enterprise outage is a critical incident", () => {
  const issues = (...issue_types: IssueType[]) => ({ ...makeResult().extracted, issue_types });
  const llmT2 = makeResult({
    urgency: "high",
    decision: "route_to_specialist",
    route_team: "Support",
    customer_reply_draft: "ขออภัยในความไม่สะดวกครับ ทีมงานกำลังตรวจสอบให้ครับ",
    extracted: { product: "platform", issue_types: ["outage"], sentiment: "negative", language: "th" },
  });

  it("makes T2 critical and escalates it to Engineering_Incident", () => {
    const result = run(llmT2, sampleTicket("T2"));
    expect(result).toMatchObject({ urgency: "critical", decision: "escalate_to_human", route_team: "Engineering_Incident" });
    expect(ruleIds(result)).toEqual(["R2_enterprise_outage"]);
  });

  it("fires on the model's outage classification even when the text gives no hint", () => {
    const result = run(makeResult({ extracted: issues("outage") }), makeTicket(["Help!"], "Enterprise plan"));
    expect(result.urgency).toBe("critical");
  });

  it.each([
    "How do I share a project with my coworkers?",
    "No one can tell me how to export a project to PDF",
    "My coworkers can't see the project I shared, how do I give them access?",
    "Nobody can find the dark mode toggle",
    "The site is down for everyone",
  ])("follows the model's classification, not the wording: %s", (text) => {
    // The model classified these as how-to questions; words like "nobody" or "down" do not page the incident team.
    expect(ruleIds(run(makeResult(), makeTicket([text], "Enterprise plan, 45 seats")))).not.toContain(
      "R2_enterprise_outage",
    );
  });

  it("does not apply to a non-Enterprise customer", () => {
    const ticket = makeTicket(["The site is down for everyone"], "Pro plan, 5 months customer");
    const result = run(makeResult({ extracted: issues("outage"), decision: "route_to_specialist", route_team: "Support" }), ticket);
    expect(ruleIds(result)).not.toContain("R2_enterprise_outage");
  });

  it("reads the plan name, not any mention of Enterprise", () => {
    const outageResult = makeResult({ extracted: { ...makeResult().extracted, issue_types: ["outage"] } });
    const ticket = makeTicket(["It is slow"], "Pro plan, evaluating an Enterprise upgrade");
    expect(ruleIds(run(outageResult, ticket))).not.toContain("R2_enterprise_outage");
  });

  it("treats the customer as Enterprise if either the ticket or customer history says so", () => {
    const ticket = makeTicket(["Nothing loads"], "Long-time customer");
    expect(run(makeResult({ extracted: issues("outage") }), ticket, { customerPlan: "Enterprise" }).urgency).toBe("critical");
    // A lookup that says "Pro" cannot switch the rule off for a ticket that says Enterprise.
    expect(run(llmT2, sampleTicket("T2"), { customerPlan: "Pro" }).route_team).toBe("Engineering_Incident");
  });

  it("counts a degraded region only when the ticket reports a problem", () => {
    const vague = makeTicket(["Something feels off with the app today."], "Enterprise plan");
    const degraded = { customerRegion: "asia", degradedRegions: ["asia"] };
    expect(run(makeResult({ extracted: issues("access_problem") }), vague, degraded).urgency).toBe("critical");
    expect(run(makeResult({ extracted: issues("access_problem") }), vague, { ...degraded, customerRegion: "us" }).urgency).toBe("low");
    // A how-to question during a regional incident is still a how-to question.
    expect(run(makeResult({ extracted: issues("how_to") }), vague, degraded).urgency).toBe("low");
  });

  it("keeps Billing as a follow-up when an outage ticket also has a billing dispute", () => {
    const result = run(makeResult({ extracted: issues("outage", "billing_dispute") }), makeTicket(["Help"], "Enterprise plan"));
    expect(result).toMatchObject({ route_team: "Engineering_Incident", follow_up_teams: ["Billing"] });
  });
});

describe("critical_to_human: critical tickets always go to a person now", () => {
  it.each(["auto_respond", "route_to_specialist"] as const)("escalates a critical %s", (decision) => {
    const result = run(makeResult({ urgency: "critical", decision, route_team: "Product" }));
    expect(result).toMatchObject({ decision: "escalate_to_human", route_team: "Product" });
    expect(ruleIds(result)).toContain("critical_to_human");
  });
});

describe("R3: low confidence is never auto-responded", () => {
  it("escalates an auto_respond with confidence below 0.7", () => {
    const result = run(makeResult({ confidence: 0.6 }));
    expect(result).toMatchObject({ decision: "escalate_to_human", route_team: "Support" });
  });

  it("allows auto_respond at exactly 0.7", () => {
    expect(run(makeResult({ confidence: 0.7 })).decision).toBe("auto_respond");
  });
});

describe("R4: auto_respond needs low/medium urgency and a KB article", () => {
  it("sends a high urgency auto_respond to a person", () => {
    expect(run(makeResult({ urgency: "high" }))).toMatchObject({ decision: "escalate_to_human", route_team: "Support" });
  });

  it("routes an auto_respond without KB articles to a specialist", () => {
    expect(run(makeResult({ kb_articles_used: [] })).decision).toBe("route_to_specialist");
  });

  it("keeps the team the LLM chose", () => {
    expect(run(makeResult({ kb_articles_used: [], route_team: "Product" })).route_team).toBe("Product");
  });
});

describe("R5: reply written in the ticket's script", () => {
  it("replaces an English reply to a Thai ticket and escalates", () => {
    const llm = makeResult({
      urgency: "critical",
      decision: "escalate_to_human",
      route_team: "Engineering_Incident",
      customer_reply_draft: "We are looking into the error 500 in the Asia region.",
      extracted: { product: "platform", issue_types: ["outage"], sentiment: "negative", language: "en" },
    });
    const result = run(llm, sampleTicket("T2"));
    expect(detectScript(result.customer_reply_draft)).toBe("thai");
    expect(result.extracted.language).toBe("th");
    expect(ruleIds(result)).toContain("R5_reply_language");
  });

  it("keeps the model's label for languages it cannot check (e.g. Japanese or Spanish)", () => {
    const japanese = makeResult({
      customer_reply_draft: "はい、設定から変更できます。",
      extracted: { ...makeResult().extracted, language: "ja" },
    });
    expect(run(japanese, makeTicket(["ダークモードはありますか"]))).toEqual(japanese);

    const spanish = makeResult({
      customer_reply_draft: "Hola, puedes cambiarlo en Ajustes > Apariencia.",
      extracted: { ...makeResult().extracted, language: "es" },
    });
    expect(run(spanish, makeTicket(["Hola, ¿tienen modo oscuro?"])).extracted.language).toBe("es");
  });

  it("escalates a reply in the wrong script even without a fallback reply for that language", () => {
    const result = run(makeResult({ customer_reply_draft: "Yes, go to Settings." }), makeTicket(["ダークモードはありますか"]));
    expect(result.decision).toBe("escalate_to_human");
    expect(result.customer_reply_draft).toBe("Yes, go to Settings."); // kept as a draft for the human
  });
});

describe("refund promise on a ticket that is not about billing", () => {
  const outage = makeResult({
    urgency: "critical",
    decision: "escalate_to_human",
    route_team: "Engineering_Incident",
    extracted: { ...makeResult().extracted, product: "platform", issue_types: ["outage"] },
    customer_reply_draft: "We will offer an SLA service credit as compensation for the downtime.",
  });

  it("keeps the incident team as owner, adds Billing as a follow-up, and uses a neutral safe reply", () => {
    const result = run(outage, makeTicket(["Everything is down"], "Enterprise plan"));
    expect(result).toMatchObject({ route_team: "Engineering_Incident", follow_up_teams: ["Billing"] });
    expect(result.customer_reply_draft).not.toMatch(/payment/i);
  });

  it("never lists the owner team as a follow-up too", () => {
    const result = run({ ...outage, follow_up_teams: ["Billing"], customer_reply_draft: "We will refund you." });
    expect(result.follow_up_teams).not.toContain(result.route_team);
  });
});

describe("team_assigned: every ticket that needs a person has an owner", () => {
  const issues = (...issue_types: IssueType[]) => ({ ...makeResult().extracted, issue_types });

  it("sends a routed ticket without a team to Support", () => {
    expect(run(makeResult({ decision: "route_to_specialist", route_team: null })).route_team).toBe("Support");
  });

  it("adds Product as a follow-up for an auto-responded bug report or feature request", () => {
    const result = run(makeResult({ extracted: issues("how_to", "bug", "feature_request") }));
    expect(result).toMatchObject({ decision: "auto_respond", route_team: null, follow_up_teams: ["Product"] });
    expect(ruleIds(result)).toEqual(["team_assigned"]);
  });

  it("turns a team named on an auto-response into a follow-up", () => {
    const result = run(makeResult({ route_team: "Support" }));
    expect(result).toMatchObject({ decision: "auto_respond", route_team: null, follow_up_teams: ["Support"] });
  });

  it("leaves a plain how-to auto-response without a team", () => {
    expect(run(makeResult({ extracted: issues("how_to") }))).toMatchObject({ route_team: null, follow_up_teams: [] });
  });
});

describe("helpers", () => {
  it("detects the main script of a text", () => {
    expect(detectScript("Hello there")).toBe("latin");
    expect(detectScript(sampleTicket("T2").messages.map((m) => m.text).join(" "))).toBe("thai");
    expect(detectScript("ขออภัยครับ ทีม Engineering กำลังตรวจสอบ error 500 ใน region Asia อยู่ครับ")).toBe("thai");
    expect(detectScript("ダークモードはありますか")).toBe("other");
    expect(detectScript("123 !!!")).toBeUndefined();
  });

  it("atLeast never lowers urgency", () => {
    expect(atLeast("low", "high")).toBe("high");
    expect(atLeast("critical", "high")).toBe("critical");
  });
});
