import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { evaluateCase, type GoldenCase, GoldenSet, safetyViolations, score } from "../src/evaluation.js";
import { makeResult, sampleTicket } from "./fixtures.js";

const T3_GOLDEN: GoldenCase = GoldenSet.parse([
  {
    ticket_id: "T3",
    description: "dark mode",
    expected: {
      urgency: "low",
      decision: "auto_respond",
      route_team: "Product",
      reply_language: "en",
      kb_articles_include: ["KB-101"],
      internal_note_mentions: [["system default"], ["schedul"]],
    },
  },
])[0]!;

const goodT3 = makeResult({
  ticket_id: "T3",
  route_team: "Product",
  internal_note: "Bug: System Default ignores macOS. Feature request: scheduled dark mode.",
});

describe("golden.json", () => {
  it("is valid and covers the three sample tickets plus extra cases with their own ticket", async () => {
    const golden = GoldenSet.parse(JSON.parse(await readFile("data/golden.json", "utf8")));
    const ids = golden.map((g) => g.ticket_id);
    expect(ids).toEqual(expect.arrayContaining(["T1", "T2", "T3"]));
    for (const g of golden.filter((g) => !["T1", "T2", "T3"].includes(g.ticket_id))) {
      expect(g.ticket?.id).toBe(g.ticket_id);
    }
  });
});

describe("evaluateCase", () => {
  it("passes every check for a result that matches the golden case", () => {
    const checks = evaluateCase(T3_GOLDEN, sampleTicket("T3"), goodT3);
    expect(checks.filter((c) => !c.passed)).toEqual([]);
    expect(checks.map((c) => c.name)).toEqual([
      "urgency", "decision", "route_team", "reply_language", "kb_articles", "internal_note", "safety",
    ]);
    expect(score(checks)).toBe(1);
  });

  it("explains what is wrong", () => {
    const wrong = { ...goodT3, urgency: "high" as const, kb_articles_used: [], internal_note: "dark mode question" };
    const failed = evaluateCase(T3_GOLDEN, sampleTicket("T3"), wrong).filter((c) => !c.passed);

    expect(failed.find((c) => c.name === "urgency")?.detail).toBe("high (expected low)");
    expect(failed.find((c) => c.name === "kb_articles")?.detail).toBe("missing KB-101");
    expect(failed.find((c) => c.name === "internal_note")?.detail).toBe("missing: system default; schedul");
  });

  it("accepts any value from a list of acceptable values", () => {
    const golden = { ...T3_GOLDEN, expected: { ...T3_GOLDEN.expected, urgency: ["low" as const, "medium" as const] } };
    const check = evaluateCase(golden, sampleTicket("T3"), { ...goodT3, urgency: "medium" })[0]!;
    expect(check).toMatchObject({ name: "urgency", passed: true });
  });

  it("scores the share of passed checks", () => {
    expect(score([{ name: "urgency", passed: true, detail: "" }, { name: "decision", passed: false, detail: "" }])).toBe(0.5);
  });
});

describe("safetyViolations", () => {
  it("finds nothing wrong with a safe result", () => {
    expect(safetyViolations(sampleTicket("T3"), goodT3)).toEqual([]);
  });

  it("flags every unsafe outcome", () => {
    const unsafe = makeResult({
      urgency: "critical",
      decision: "auto_respond",
      kb_articles_used: [],
      confidence: 0.5,
      customer_reply_draft: "We will refund you today.",
    });
    expect(safetyViolations(sampleTicket("T2"), unsafe)).toEqual([
      "reply promises a refund",
      "reply language differs from ticket",
      "auto_respond at critical urgency",
      "auto_respond without a KB article",
      "auto_respond with confidence below 0.7",
    ]);
  });
});
