import { describe, expect, it } from "vitest";
import { detectLanguage } from "../src/language.js";
import { applyPolicy, atLeast, mentionsMoney, promisesRefund, type PolicyContext } from "../src/policy.js";
import { Decision, Urgency, type Ticket, type TriageResult } from "../src/schemas.js";
import { makeResult, makeTicket, sampleTicket } from "./fixtures.js";

const ALL_KB_IDS = ["KB-101", "KB-102", "KB-201", "KB-202", "KB-203", "KB-301", "KB-302", "KB-401"];

function run(result: TriageResult, ticket: Ticket = makeTicket(["How do I change the theme?"])): TriageResult {
  const ctx: PolicyContext = { ticket, retrievedKbIds: ALL_KB_IDS };
  return applyPolicy(result, ctx);
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

  it("records what each rule changed", () => {
    const result = run(makeResult({ urgency: "medium" }), sampleTicket("T1"));
    expect(result.guardrails_applied[0]).toBe(
      "R1_money_to_billing: urgency medium -> high; decision auto_respond -> escalate_to_human; route_team null -> Billing",
    );
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
    const ctx = { ticket: makeTicket(["dark mode?"]), retrievedKbIds: ["KB-101"] };
    const result = applyPolicy(makeResult({ kb_articles_used: ["KB-101", "KB-999"] }), ctx);
    expect(result.kb_articles_used).toEqual(["KB-101"]);
    expect(ruleIds(result)).toContain("verified_kb_articles");
  });
});

describe("R1: money goes to a human in Billing", () => {
  it("escalates T1 to Billing with at least high urgency", () => {
    const result = run(makeResult({ urgency: "medium", decision: "auto_respond" }), sampleTicket("T1"));
    expect(result).toMatchObject({ decision: "escalate_to_human", route_team: "Billing", urgency: "high" });
  });

  it("keeps critical urgency when the LLM already chose it", () => {
    const result = run(makeResult({ urgency: "critical" }), sampleTicket("T1"));
    expect(result.urgency).toBe("critical");
  });

  it("detects money topics in English and Thai, but not in unrelated tickets", () => {
    expect(mentionsMoney(sampleTicket("T1"))).toBe(true);
    expect(mentionsMoney(makeTicket(["I want my money back"]))).toBe(true);
    expect(mentionsMoney(makeTicket(["ขอคืนเงินด้วยครับ"]))).toBe(true);
    expect(mentionsMoney(sampleTicket("T2"))).toBe(false);
    expect(mentionsMoney(sampleTicket("T3"))).toBe(false);
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
    "เราจะคืนเงินให้ภายในวันนี้ครับ",
  ])("flags a refund promise: %s", (reply) => {
    expect(promisesRefund(reply)).toBe(true);
  });

  it.each([
    "Our Billing team will review every charge on your account.",
    "I can't confirm a refund myself, but Billing is looking at it now.",
    "Pending authorizations usually drop off within 3 to 5 business days.",
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
    expect(result.internal_note).toMatch(/\[Policy\].*refund/);
    expect(ruleIds(result)).toContain("R1_no_refund_promise");
  });
});

describe("R2: Enterprise outage is a critical incident", () => {
  it("makes T2 critical and escalates it to Engineering_Incident", () => {
    const llm = makeResult({
      urgency: "high",
      decision: "route_to_specialist",
      route_team: "Support",
      customer_reply_draft: "ขออภัยในความไม่สะดวกครับ ทีมงานกำลังตรวจสอบให้ครับ",
      extracted: { product: "Web App", issue_type: "outage", sentiment: "negative", language: "th" },
    });
    const result = run(llm, sampleTicket("T2"));
    expect(result).toMatchObject({ urgency: "critical", decision: "escalate_to_human", route_team: "Engineering_Incident" });
    expect(ruleIds(result)).toEqual(["R2_enterprise_outage"]);
  });

  it("does not apply to a non-Enterprise customer", () => {
    const ticket = makeTicket(["I get error 500 and cannot access the app"], "Pro plan, 5 months customer");
    const result = run(makeResult({ urgency: "high", decision: "route_to_specialist", route_team: "Support" }), ticket);
    expect(ruleIds(result)).not.toContain("R2_enterprise_outage");
  });
});

describe("R3: low confidence is never auto-responded", () => {
  it("escalates an auto_respond with confidence below 0.7", () => {
    const result = run(makeResult({ confidence: 0.6 }));
    expect(result.decision).toBe("escalate_to_human");
    expect(result.route_team).toBe("Support");
  });

  it("allows auto_respond at exactly 0.7", () => {
    expect(run(makeResult({ confidence: 0.7 })).decision).toBe("auto_respond");
  });
});

describe("R4: auto_respond needs low/medium urgency and a KB article", () => {
  it("routes a high urgency auto_respond to a specialist", () => {
    const result = run(makeResult({ urgency: "high" }));
    expect(result).toMatchObject({ decision: "route_to_specialist", route_team: "Support" });
  });

  it("routes an auto_respond without KB articles to a specialist", () => {
    expect(run(makeResult({ kb_articles_used: [] })).decision).toBe("route_to_specialist");
  });

  it("keeps the team the LLM chose", () => {
    expect(run(makeResult({ urgency: "high", route_team: "Product" })).route_team).toBe("Product");
  });
});

describe("R5: reply language matches the ticket", () => {
  it("replaces an English reply to a Thai ticket and escalates", () => {
    const llm = makeResult({
      urgency: "critical",
      decision: "escalate_to_human",
      route_team: "Engineering_Incident",
      customer_reply_draft: "We are looking into the error 500 in the Asia region.",
      extracted: { product: "Web App", issue_type: "outage", sentiment: "negative", language: "en" },
    });
    const result = run(llm, sampleTicket("T2"));
    expect(detectLanguage(result.customer_reply_draft)).toBe("th");
    expect(result.extracted.language).toBe("th");
    expect(ruleIds(result)).toContain("R5_reply_language");
  });

  it("accepts a Thai reply that contains English terms", () => {
    const reply = "ขออภัยครับ ทีม Engineering กำลังตรวจสอบ error 500 ใน region Asia อยู่ครับ";
    expect(detectLanguage(reply)).toBe("th");
  });
});

describe("helpers", () => {
  it("detects English, Thai, and defaults to English for no letters", () => {
    expect(detectLanguage("Hello there")).toBe("en");
    expect(detectLanguage(sampleTicket("T2").messages.map((m) => m.text).join(" "))).toBe("th");
    expect(detectLanguage("123 !!!")).toBe("en");
  });

  it("atLeast never lowers urgency", () => {
    expect(atLeast("low", "high")).toBe("high");
    expect(atLeast("critical", "high")).toBe("critical");
  });
});
