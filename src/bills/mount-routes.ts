import { randomUUID } from "node:crypto";
import type { Express, Request, Response } from "express";
import express from "express";

import {
  paymentErrorHtml,
  paymentPageHtml,
  paymentSuccessHtml,
} from "./pages.js";
import { getBillIntent, recordPayment } from "./store.js";

export type BillRouteDeps = {
  /** Fired after a successful checkout POST (wakes legacy waiters / notifiers). */
  onPaymentPosted: (flowId: string) => void;
};

/** Hosted checkout UI for `pay_bill` URL elicitation. */
export function mountBillRoutes(app: Express, deps: BillRouteDeps): void {
  app.get("/ui/pay_bill", (req: Request, res: Response) => {
    const flow = String(req.query.flow ?? "");
    if (!flow) {
      res.status(400).type("html").send(paymentErrorHtml("Missing flow id"));
      return;
    }
    const intent = getBillIntent(flow);
    if (!intent) {
      res
        .status(404)
        .type("html")
        .send(
          paymentErrorHtml(
            "No open checkout for this link. Ask the assistant to run pay_bill again."
          )
        );
      return;
    }
    res.type("html").send(paymentPageHtml(flow, intent));
  });

  app.post(
    "/ui/pay_bill",
    express.urlencoded({ extended: false }),
    (req: Request, res: Response) => {
      const flow = String(req.body?.flow ?? "");
      const cardNumber = String(req.body?.cardNumber ?? "").replace(/\s+/g, "");
      const cardName = String(req.body?.cardName ?? "").trim();
      const expiry = String(req.body?.expiry ?? "").trim();
      const cvc = String(req.body?.cvc ?? "").trim();

      const intent = flow ? getBillIntent(flow) : undefined;
      if (!intent) {
        res
          .status(404)
          .type("html")
          .send(paymentErrorHtml("Checkout session expired or unknown."));
        return;
      }
      if (
        cardName.length < 2 ||
        cardNumber.length < 12 ||
        cardNumber.length > 19 ||
        !/^\d+$/.test(cardNumber) ||
        !/^(0[1-9]|1[0-2])\/\d{2}$/.test(expiry) ||
        !/^\d{3,4}$/.test(cvc)
      ) {
        res
          .status(400)
          .type("html")
          .send(paymentErrorHtml("Invalid payment details. Go back and try again."));
        return;
      }

      const last4 = cardNumber.slice(-4);
      const confirmationId = `pay_${randomUUID().slice(0, 8)}`;
      recordPayment(flow, {
        confirmationId,
        methodLast4: last4,
        paidAt: Date.now(),
        amountCents: intent.amountCents,
        currency: intent.currency,
        billId: intent.billId,
        title: intent.title,
      });
      deps.onPaymentPosted(flow);

      res.type("html").send(
        paymentSuccessHtml({
          confirmationId,
          methodLast4: last4,
          paidAt: Date.now(),
          amountCents: intent.amountCents,
          currency: intent.currency,
          billId: intent.billId,
          title: intent.title,
        })
      );
    }
  );
}
