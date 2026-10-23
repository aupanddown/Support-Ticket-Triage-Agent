import { z } from "zod";
import customers from "../../data/customers.json" with { type: "json" };
import { defineTool } from "./tool.js";

export const customerHistoryTool = defineTool({
  name: "get_customer_history",
  description:
    "Look up a customer's account: plan, seats, region, tenure, activity and past support tickets. " +
    "Call this first for every ticket.",
  customerIdArg: "customer_id",
  args: z.object({
    customer_id: z.string().min(1).describe("Customer ID from the ticket, e.g. C-1001"),
  }),
  async handler({ customer_id }) {
    const customer = customers.find((c) => c.customer_id === customer_id);
    if (!customer) throw new Error(`No customer found with id "${customer_id}"`);
    return customer;
  },
  facts: ({ plan, region }) => ({ customerPlan: plan, customerRegion: region }),
});
