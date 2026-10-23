import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { TriageResult } from "../src/schemas.js";
import { buildServer } from "../src/server.js";
import { FakeLlmClient, finalAnswer, toolCalls } from "./fakeLlmClient.js";
import { makeResult, sampleTicket } from "./fixtures.js";

// inject() sends a request straight to Fastify: no open port, no network, no API key.
let app: FastifyInstance;
afterEach(() => app?.close());

describe("GET /health", () => {
  it("returns ok", async () => {
    app = buildServer({ llm: new FakeLlmClient([]) });
    const res = await app.inject({ method: "GET", url: "/health" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: "ok" });
  });
});

describe("POST /triage", () => {
  it("triages a valid ticket and returns a TriageResult", async () => {
    const llm = new FakeLlmClient([
      toolCalls({ name: "search_knowledge_base", args: { query: "dark mode system default" } }),
      finalAnswer(makeResult({ route_team: "Product" })),
    ]);
    app = buildServer({ llm });

    const res = await app.inject({ method: "POST", url: "/triage", payload: sampleTicket("T3") });

    expect(res.statusCode).toBe(200);
    const body = TriageResult.parse(res.json());
    expect(body).toMatchObject({ ticket_id: "T3", decision: "auto_respond", kb_articles_used: ["KB-101"] });
  });

  it("returns 400 with details for an invalid ticket", async () => {
    app = buildServer({ llm: new FakeLlmClient([]) });
    const res = await app.inject({ method: "POST", url: "/triage", payload: { id: "X", messages: [] } });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: "Invalid ticket", details: expect.stringContaining("customer") });
  });

  it("returns 400 for a body that is not JSON", async () => {
    app = buildServer({ llm: new FakeLlmClient([]) });
    const res = await app.inject({
      method: "POST",
      url: "/triage",
      headers: { "content-type": "application/json" },
      payload: "{not json",
    });
    expect(res.statusCode).toBe(400);
  });

  it("returns a fail-safe escalation (not a 500) when the model fails", async () => {
    app = buildServer({ llm: new FakeLlmClient([new Error("Request timed out.")]) });
    const res = await app.inject({ method: "POST", url: "/triage", payload: sampleTicket("T2") });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ decision: "escalate_to_human", route_team: "Engineering_Incident" });
  });
});
