import type { BillIntent, PaymentReceipt } from "./types.js";

/** flowId → open checkout (card data never stored here). */
export const billIntents = new Map<string, BillIntent>();

/** flowId → completed payment receipt (last4 only). */
export const paymentReceipts = new Map<string, PaymentReceipt>();

export function openBillIntent(flowId: string, intent: BillIntent): void {
  billIntents.set(flowId, intent);
}

export function getBillIntent(flowId: string): BillIntent | undefined {
  return billIntents.get(flowId);
}

export function recordPayment(flowId: string, receipt: PaymentReceipt): void {
  paymentReceipts.set(flowId, receipt);
  billIntents.delete(flowId);
}

export function takePaymentReceipt(flowId: string): PaymentReceipt | undefined {
  const receipt = paymentReceipts.get(flowId);
  if (receipt) paymentReceipts.delete(flowId);
  return receipt;
}

export function peekPaymentReceipt(flowId: string): PaymentReceipt | undefined {
  return paymentReceipts.get(flowId);
}
