import { z } from "zod";
import accounts from "../../data/billing.json" with { type: "json" };
import { defineTool } from "./tool.js";

type Account = (typeof accounts)[number];

export const billingTool = defineTool({
  name: "get_billing_transactions",
  description:
    "Read-only view of a customer's current plan, pending upgrades and recent charges with their status. " +
    "Call when the ticket mentions payments, charges, refunds or plan upgrades. Cannot issue refunds or change plans.",
  customerIdArg: "customer_id",
  args: z.object({
    customer_id: z.string().min(1).describe("Customer ID from the ticket, e.g. C-1001"),
  }),
  async handler({ customer_id }) {
    const account = accounts.find((a) => a.customer_id === customer_id);
    if (!account) throw new Error(`No billing account found for customer "${customer_id}"`);
    return account;
  },
  facts: (data) => ({ billingProblem: hasBillingProblem(data as Account) }),
});

/** A problem only a human can fix: a failed plan activation, or the same thing charged more than once. */
export function hasBillingProblem(account: Account): boolean {
  if (account.pending_upgrade?.status === "activation_failed") return true;
  const captured = account.transactions.filter((t) => t.status === "captured").map((t) => t.description);
  return new Set(captured).size < captured.length;
}
