import { describe, expect, it } from "vitest";
import customers from "../data/customers.json" with { type: "json" };
import tickets from "../data/tickets.json" with { type: "json" };
import { Ticket } from "../src/schemas.js";
import { executeTool, getToolSpecs, TOOLS, type ToolResult } from "../src/tools/index.js";
import { billingTool } from "../src/tools/billing.js";
import { customerHistoryTool } from "../src/tools/customerHistory.js";
import { knowledgeBaseTool, scoreArticle, tokenize } from "../src/tools/knowledgeBase.js";
import { serviceStatusTool } from "../src/tools/serviceStatus.js";

/** Calls a tool the way the agent does (arguments as a JSON string). */
function call(name: string, args: unknown): Promise<ToolResult> {
  return executeTool({ name, arguments: JSON.stringify(args) });
}

/** Asserts success and returns the data, typed loosely for convenience in tests. */
function dataOf(result: ToolResult): any {
  if (!result.ok) throw new Error(`Expected ok result, got error: ${result.error}`);
  return result.data;
}

describe("get_customer_history", () => {
  it("returns the enterprise account for T2", async () => {
    const customer = dataOf(await call("get_customer_history", { customer_id: "C-2001" }));
    expect(customer).toMatchObject({ plan: "Enterprise", seats: 45, region: "asia", tenure_months: 8 });
  });

  it("returns an error for an unknown customer", async () => {
    const result = await call("get_customer_history", { customer_id: "C-404" });
    expect(result).toEqual({ ok: false, error: expect.stringContaining("C-404") });
  });
});

describe("search_knowledge_base", () => {
  it("finds the Appearance / System Default article for the dark mode question", async () => {
    const results = dataOf(await call("search_knowledge_base", { query: "dark mode system default" }));
    expect(results[0].id).toBe("KB-101");
    expect(results[0]).toEqual(
      expect.objectContaining({ title: expect.any(String), url: expect.any(String), snippet: expect.any(String) }),
    );
  });

  it("returns at most 3 results, best first", async () => {
    const results = dataOf(await call("search_knowledge_base", { query: "pro plan payment charge upgrade billing" }));
    expect(results.length).toBeLessThanOrEqual(3);
    const scores = results.map((r: { score: number }) => r.score);
    expect(scores).toEqual([...scores].sort((a, b) => b - a));
  });

  it("filters by product", async () => {
    const results = dataOf(await call("search_knowledge_base", { query: "pro plan", product: "billing" }));
    expect(results.length).toBeGreaterThan(0);
    expect(results.every((r: { id: string }) => r.id.startsWith("KB-2"))).toBe(true);
  });

  it("falls back to the whole KB when the product filter finds nothing", async () => {
    // KB-203 (Pro features, export) is filed under billing, not platform.
    const results = dataOf(await call("search_knowledge_base", { query: "export formats", product: "platform" }));
    expect(results.map((r: { id: string }) => r.id)).toContain("KB-203");
  });

  it("returns an empty list when nothing matches", async () => {
    expect(dataOf(await call("search_knowledge_base", { query: "zzzz qqqq" }))).toEqual([]);
  });

  it("rejects an unknown product", async () => {
    const result = await call("search_knowledge_base", { query: "refund", product: "crypto" });
    expect(result.ok).toBe(false);
  });

  it("tokenizes case-insensitively and drops stop words", () => {
    expect(tokenize("Is the Dark-Mode on?")).toEqual(["dark", "mode"]);
  });

  it("weights title matches above body matches", () => {
    const article = { id: "X", title: "Refund", url: "", product: "billing", tags: [], body: "export" };
    expect(scoreArticle(article, ["refund"])).toBeGreaterThan(scoreArticle(article, ["export"]));
  });
});

describe("get_billing_transactions", () => {
  it("shows 3 captured $29.99 charges and a plan that is still Free for T1", async () => {
    const account = dataOf(await call("get_billing_transactions", { customer_id: "C-1001" }));
    expect(account.current_plan).toBe("Free");
    expect(account.transactions).toHaveLength(3);
    expect(account.transactions.every((t: { amount: number }) => t.amount === 29.99)).toBe(true);
  });

  it("returns an error for an unknown customer", async () => {
    expect((await call("get_billing_transactions", { customer_id: "nobody" })).ok).toBe(false);
  });
});

describe("check_service_status", () => {
  it("shows Asia degraded while the public status page says operational", async () => {
    const status = dataOf(await call("check_service_status", { region: "asia" }));
    expect(status.public_status_page.message).toMatch(/operational/i);
    expect(status.regions).toHaveLength(1);
    expect(status.regions[0].components.some((c: { status: string }) => c.status === "degraded")).toBe(true);
  });

  it("returns every region when no region is given", async () => {
    const status = dataOf(await call("check_service_status", {}));
    expect(status.regions.map((r: { region: string }) => r.region)).toEqual(["us", "eu", "asia"]);
  });

  it("rejects an unknown region", async () => {
    expect((await call("check_service_status", { region: "mars" })).ok).toBe(false);
  });
});

describe("tool facts (evidence for the policy)", () => {
  const factsOf = async (tool: (typeof TOOLS)[number], args: unknown) => tool.facts!(dataOf(await call(tool.name, args)));

  it("customer history gives the plan and region", async () => {
    expect(await factsOf(customerHistoryTool, { customer_id: "C-2001" })).toEqual({
      customerPlan: "Enterprise",
      customerRegion: "asia",
    });
  });

  it("billing flags T1's failed activation and repeated charges, but not a normal account", async () => {
    expect(await factsOf(billingTool, { customer_id: "C-1001" })).toEqual({ billingProblem: true });
    expect(await factsOf(billingTool, { customer_id: "C-3001" })).toEqual({ billingProblem: false });
  });

  it("service status lists the degraded regions", async () => {
    expect(await factsOf(serviceStatusTool, {})).toEqual({ degradedRegions: ["asia"] });
    expect(await factsOf(serviceStatusTool, { region: "us" })).toEqual({ degradedRegions: [] });
  });

  it("knowledge base lists the retrieved article IDs", async () => {
    const facts = await factsOf(knowledgeBaseTool, { query: "dark mode system default" });
    expect(facts.retrievedKbIds?.[0]).toBe("KB-101");
  });
});

describe("tool registry", () => {
  it("only lets tools look up the ticket's own customer", async () => {
    const scope = { customerId: "C-1001" };
    const other = await executeTool({ name: "get_billing_transactions", arguments: '{"customer_id":"C-2001"}' }, TOOLS, scope);
    expect(other).toEqual({ ok: false, error: "Only the ticket's customer (C-1001) can be looked up" });

    const own = await executeTool({ name: "get_billing_transactions", arguments: '{"customer_id":"C-1001"}' }, TOOLS, scope);
    expect(own.ok).toBe(true);
  });

  it("returns an error for an unknown tool", async () => {
    expect(await call("issue_refund", { amount: 29.99 })).toEqual({ ok: false, error: 'Unknown tool "issue_refund"' });
  });

  it("returns an error for arguments that are not JSON", async () => {
    const result = await executeTool({ name: "get_customer_history", arguments: "{not json" });
    expect(result).toEqual({ ok: false, error: "Tool arguments are not valid JSON" });
  });

  it("returns an error for missing or wrongly typed arguments", async () => {
    expect((await call("get_customer_history", {})).ok).toBe(false);
    expect((await call("get_customer_history", { customer_id: 42 })).ok).toBe(false);
  });

  it("reports handler errors instead of throwing", async () => {
    const failing = { ...TOOLS[0]!, async handler(): Promise<unknown> { throw new Error("database down"); } };
    const result = await executeTool({ name: failing.name, arguments: '{"customer_id":"C-1001"}' }, [failing]);
    expect(result).toEqual({ ok: false, error: "database down" });
  });

  it("exposes unique tool names with an object JSON Schema for each", () => {
    const specs = getToolSpecs();
    expect(new Set(specs.map((s) => s.name)).size).toBe(specs.length);
    for (const spec of specs) {
      expect(spec.description.length).toBeGreaterThan(20);
      expect(spec.parameters).toMatchObject({ type: "object" });
      expect(spec.parameters).not.toHaveProperty("$schema");
    }
  });

  it("has no tool that can change state (names are all lookups)", () => {
    for (const tool of TOOLS) expect(tool.name).toMatch(/^(get|search|check)_/);
  });
});

describe("mock data", () => {
  it("sample tickets match the Ticket schema and reference known customers", () => {
    const knownIds = new Set(customers.map((c) => c.customer_id));
    for (const raw of tickets) {
      const ticket = Ticket.parse(raw);
      expect(knownIds.has(ticket.customer.id)).toBe(true);
    }
  });
});
