/** Catalog bill the agent can offer to pay (URL-mode checkout). */
export type Bill = {
  billId: string;
  title: string;
  amountCents: number;
  currency: string;
  dueDate: string;
  description: string;
};

/** Checkout session opened for one `pay_bill` elicitation flow. */
export type BillIntent = Bill & {
  createdAt: number;
};

/**
 * Receipt after the hosted payment page succeeds.
 * Card PAN never leaves that page — only last4 is retained for confirmation text.
 */
export type PaymentReceipt = {
  confirmationId: string;
  methodLast4: string;
  paidAt: number;
  amountCents: number;
  currency: string;
  billId: string;
  title: string;
};
