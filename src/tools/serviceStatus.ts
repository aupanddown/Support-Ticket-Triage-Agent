import { z } from "zod";
import status from "../../data/service_status.json" with { type: "json" };
import { defineTool } from "./tool.js";

export const Region = z.enum(["us", "eu", "asia"]);

export const serviceStatusTool = defineTool({
  name: "check_service_status",
  description:
    "Check internal monitoring for each component per region, plus what the public status page currently says. " +
    "Internal monitoring can show problems before they are posted publicly. " +
    "Call when the customer reports errors, downtime or cannot access the product.",
  args: z.object({
    region: Region.optional().describe("asia covers Thailand and the rest of Asia Pacific. Omit to get all regions."),
  }),
  async handler({ region }) {
    return {
      public_status_page: status.public_status_page,
      regions: status.regions.filter((r) => !region || r.region === region),
    };
  },
  facts: ({ regions }) => ({
    degradedRegions: regions.filter((r) => r.components.some((c) => c.status !== "operational")).map((r) => r.region),
  }),
});
