import { randomUUID } from "node:crypto";
import {
  inputRequired,
  inputResponse,
  type CallToolResult,
  type InputRequiredResult,
  type McpRequestContext,
  type McpServer,
} from "@modelcontextprotocol/server";
import * as z from "zod/v4";

import { findBill, formatMoney, UNPAID_BILLS } from "./catalog.js";
import {
  getBillIntent,
  openBillIntent,
  peekPaymentReceipt,
  takePaymentReceipt,
} from "./store.js";

export type BillToolDeps = {
  publicUrl: (path: string) => string;
  mintState: (data: { flowId: string }) => Promise<string>;
  /** Legacy-era: stash completion notifier keyed by elicitation / flow id. */
  stashCompletionNotifier: (
    elicitationId: string,
    notify: () => Promise<void>
  ) => void;
};

function receiptResult(flowId: string): CallToolResult | null {
  const receipt = takePaymentReceipt(flowId);
  if (!receipt) return null;
  const money = formatMoney(receipt.amountCents, receipt.currency);
  return {
    content: [
      {
        type: "text",
        text: `Paid ${money} for ${receipt.title} (${receipt.billId}). Confirmation ${receipt.confirmationId}; card •••• ${receipt.methodLast4}. Card details never traversed the MCP client.`,
      },
    ],
  };
}

/**
 * Registers:
 * - `list_unpaid_bills` — catalog read (no elicitation)
 * - `pay_bill` — URL-mode checkout on `/ui/pay_bill`
 */
export function registerBillTools(
  server: McpServer,
  reqCtx: McpRequestContext,
  deps: BillToolDeps
): void {
  server.registerTool(
    "list_unpaid_bills",
    {
      title: "List unpaid bills",
      description:
        "Returns demo unpaid bills the user can pay with `pay_bill` (billId + amount).",
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (): Promise<CallToolResult> => ({
      content: [
        {
          type: "text",
          text: JSON.stringify(
            UNPAID_BILLS.map((b) => ({
              ...b,
              amountDisplay: formatMoney(b.amountCents, b.currency),
            })),
            null,
            2
          ),
        },
      ],
    })
  );

  server.registerTool(
    "pay_bill",
    {
      title: "Pay bill (URL elicitation)",
      description:
        "URL-mode elicitation that opens a hosted payment page for an unpaid bill. Card data never returns through the MCP client — only a confirmation + last4 after Continue.",
      inputSchema: z.object({
        billId: z
          .string()
          .optional()
          .meta({
            description:
              "Bill id from list_unpaid_bills (defaults to the first unpaid bill)",
          }),
      }),
    },
    async (
      { billId },
      ctx
    ): Promise<CallToolResult | InputRequiredResult> => {
      const bill = findBill(billId);
      if (!bill) {
        return {
          content: [
            {
              type: "text",
              text: `Unknown billId ${String(billId)}. Call list_unpaid_bills first.`,
            },
          ],
          isError: true,
        };
      }

      const existingState = ctx.mcpReq.requestState<{ flowId: string }>();
      const flowId = existingState?.flowId ?? randomUUID();
      const payUrl = deps.publicUrl(
        `/ui/pay_bill?flow=${encodeURIComponent(flowId)}`
      );
      const money = formatMoney(bill.amountCents, bill.currency);
      const openMessage = `Pay ${money} for ${bill.title} on the secure checkout page. Card details must not pass through the MCP client.`;

      if (reqCtx.era === "legacy") {
        openBillIntent(flowId, { ...bill, createdAt: Date.now() });
        const elicitationId = flowId;
        const notifyComplete = server.server.createElicitationCompletionNotifier(
          elicitationId,
          { relatedRequestId: ctx.mcpReq.id }
        );
        deps.stashCompletionNotifier(elicitationId, notifyComplete);

        const result = await ctx.mcpReq.elicitInput(
          {
            mode: "url",
            message: openMessage,
            url: payUrl,
            elicitationId,
          },
          { timeout: 10 * 60_000, signal: ctx.mcpReq.signal }
        );

        if (result.action !== "accept") {
          return {
            content: [{ type: "text", text: `Bill payment ${result.action}` }],
          };
        }
        const done = receiptResult(flowId);
        if (done) return done;
        await new Promise((r) => setTimeout(r, 400));
        return (
          receiptResult(flowId) ?? {
            content: [
              {
                type: "text",
                text: "Checkout was opened but no receipt was recorded. Complete payment on the page, then run pay_bill again.",
              },
            ],
            isError: true,
          }
        );
      }

      // ---- 2026-07-28: input_required + requestState ------------------------
      if (peekPaymentReceipt(flowId)) {
        return receiptResult(flowId)!;
      }

      const payment = inputResponse(ctx.mcpReq.inputResponses, "payment");
      if (payment.kind === "elicit" && payment.action !== "accept") {
        return {
          content: [{ type: "text", text: `Bill payment ${payment.action}` }],
        };
      }

      if (payment.kind === "elicit" && payment.action === "accept") {
        // Continue without a receipt — re-prompt instead of blocking the HTTP call.
        if (peekPaymentReceipt(flowId)) {
          return receiptResult(flowId)!;
        }
        if (!getBillIntent(flowId)) {
          openBillIntent(flowId, { ...bill, createdAt: Date.now() });
        }
        return inputRequired({
          requestState: await deps.mintState({ flowId }),
          inputRequests: {
            payment: inputRequired.elicitUrl({
              message: `Payment not received yet for ${bill.title}. Finish checkout on the secure page, then choose Continue again.`,
              url: payUrl,
            }),
          },
        });
      }

      openBillIntent(flowId, { ...bill, createdAt: Date.now() });
      return inputRequired({
        requestState: await deps.mintState({ flowId }),
        inputRequests: {
          payment: inputRequired.elicitUrl({
            message: openMessage,
            url: payUrl,
          }),
        },
      });
    }
  );
}
