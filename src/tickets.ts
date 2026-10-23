import { readFile } from "node:fs/promises";
import { z } from "zod";
import { Ticket } from "./schemas.js";

const SAMPLE_TICKETS = new URL("../data/tickets.json", import.meta.url);

const TicketFile = z.union([Ticket, z.array(Ticket).min(1)]);

/** Reads a JSON file that holds one ticket or an array of tickets, validated with zod. */
export async function loadTickets(path: string | URL): Promise<Ticket[]> {
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    throw new Error(`Cannot read tickets from ${path}: ${error instanceof Error ? error.message : error}`);
  }

  const parsed = TicketFile.safeParse(raw);
  if (!parsed.success) throw new Error(`Invalid ticket file ${path}:\n${z.prettifyError(parsed.error)}`);
  return Array.isArray(parsed.data) ? parsed.data : [parsed.data];
}

/** The sample tickets T1, T2 and T3 from data/tickets.json. */
export function loadSampleTickets(): Promise<Ticket[]> {
  return loadTickets(SAMPLE_TICKETS);
}
