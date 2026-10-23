import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadSampleTickets, loadTickets } from "../src/tickets.js";
import { makeTicket } from "./fixtures.js";

async function tempFile(content: string): Promise<string> {
  const path = join(await mkdtemp(join(tmpdir(), "tickets-")), "tickets.json");
  await writeFile(path, content, "utf8");
  return path;
}

describe("loadTickets", () => {
  it("loads the three sample tickets", async () => {
    expect((await loadSampleTickets()).map((t) => t.id)).toEqual(["T1", "T2", "T3"]);
  });

  it("accepts a file with a single ticket", async () => {
    const path = await tempFile(JSON.stringify(makeTicket(["Hello"])));
    expect(await loadTickets(path)).toHaveLength(1);
  });

  it("rejects invalid JSON with a clear message", async () => {
    await expect(loadTickets(await tempFile("{oops"))).rejects.toThrow(/Cannot read tickets/);
  });

  it("rejects a ticket without messages", async () => {
    const path = await tempFile(JSON.stringify({ ...makeTicket(["x"]), messages: [] }));
    await expect(loadTickets(path)).rejects.toThrow(/Invalid ticket file/);
  });

  it("rejects a missing file", async () => {
    await expect(loadTickets("does-not-exist.json")).rejects.toThrow(/Cannot read tickets/);
  });
});
