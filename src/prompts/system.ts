import { readFileSync } from "node:fs";
import type { Ticket } from "../schemas.js";

/**
 * The system prompt lives in system_prompt.md, so reviewers read exactly what the model receives
 * and the prompt can be edited without touching code.
 */
export const SYSTEM_PROMPT = readFileSync(new URL("./system_prompt.md", import.meta.url), "utf8").trim();

/**
 * Wraps the ticket as JSON inside <ticket> tags, so the model can tell our instructions
 * from customer-written text. "<" is escaped so a ticket cannot close the tag early
 * (a simple prompt injection trick); the JSON stays valid and readable for the model.
 */
export function buildUserMessage(ticket: Ticket): string {
  const json = JSON.stringify(ticket, null, 2).replaceAll("<", "\\u003c");
  return `Triage this support ticket. Messages are oldest first.\n\n<ticket>\n${json}\n</ticket>`;
}
