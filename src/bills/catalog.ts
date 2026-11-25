import type { Bill } from "./types.js";

/** Demo unpaid bills — pick by `billId` or let `pay_bill` default to the first. */
export const UNPAID_BILLS: readonly Bill[] = [
  {
    billId: "inv-1001",
    title: "Office electricity — November 2026",
    amountCents: 12_850,
    currency: "USD",
    dueDate: "2026-11-30",
    description: "Metro Power Co. account ending 4412. Peak + off-peak usage.",
  },
  {
    billId: "inv-1002",
    title: "Agent Studio seats — SaaS",
    amountCents: 49_900,
    currency: "USD",
    dueDate: "2026-12-01",
    description: "Monthly subscription for 5 builder seats.",
  },
  {
    billId: "inv-1003",
    title: "Cloud egress — October",
    amountCents: 8_420,
    currency: "USD",
    dueDate: "2026-11-28",
    description: "Object storage + CDN transfer overage.",
  },
];

export function findBill(billId: string | undefined): Bill | undefined {
  if (!billId) return UNPAID_BILLS[0];
  return UNPAID_BILLS.find((b) => b.billId === billId);
}

export function formatMoney(amountCents: number, currency: string): string {
  try {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency,
    }).format(amountCents / 100);
  } catch {
    return `${(amountCents / 100).toFixed(2)} ${currency}`;
  }
}
