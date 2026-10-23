import type { Ticket, TriageResult } from "../schemas.js";

/**
 * Evidence from tool results (see `Tool.facts`). Every field is optional: a tool may not have been
 * called. To add a fact, add a field here and use it in a rule; list fields are merged automatically.
 */
export interface PolicyFacts {
  /** get_customer_history */
  customerPlan?: string;
  customerRegion?: string;
  /** get_billing_transactions: a plan activation failed after the customer was charged. */
  unresolvedPayment?: boolean;
  /** check_service_status: regions with a component that is not operational. */
  degradedRegions?: string[];
  /** search_knowledge_base: IDs of the articles actually returned. */
  retrievedKbIds?: string[];
}

export interface PolicyContext {
  ticket: Ticket;
  facts: PolicyFacts;
}

export interface Rule {
  /** snake_case name, recorded in `guardrails_applied` when the rule changes something. */
  id: string;
  apply(result: TriageResult, ctx: PolicyContext): TriageResult;
}
