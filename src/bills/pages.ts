import { formatMoney } from "./catalog.js";
import type { BillIntent, PaymentReceipt } from "./types.js";

function esc(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

const chrome = `
  :root { color-scheme: light dark; font-family: ui-sans-serif, system-ui, sans-serif; }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #0b1220; color: #e2e8f0; }
  main { width: min(440px, 92vw); background: #111827; border: 1px solid #1f2a44; border-radius: 14px; padding: 28px; box-shadow: 0 18px 50px rgba(0,0,0,.35); }
  h1 { margin: 0 0 6px; font-size: 1.35rem; letter-spacing: -0.02em; }
  .eyebrow { margin: 0 0 14px; font-size: 0.75rem; font-weight: 600; letter-spacing: 0.08em; text-transform: uppercase; color: #64748b; }
  .amount { margin: 0 0 18px; font-size: 1.85rem; font-weight: 700; color: #f8fafc; }
  .meta { margin: 0 0 20px; padding: 12px 14px; border-radius: 10px; background: #0f172a; border: 1px solid #1e293b; color: #94a3b8; font-size: 0.92rem; line-height: 1.5; }
  .meta strong { color: #cbd5e1; font-weight: 600; }
  label { display: block; font-size: 0.82rem; margin: 0 0 6px; color: #cbd5e1; }
  input { width: 100%; box-sizing: border-box; padding: 10px 12px; border-radius: 8px; border: 1px solid #334155; background: #0b1220; color: inherit; margin-bottom: 12px; }
  .row { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
  button { margin-top: 8px; width: 100%; padding: 12px 14px; border: 0; border-radius: 9px; background: #22c55e; color: #052e16; font-weight: 700; cursor: pointer; font-size: 0.95rem; }
  button:hover { background: #16a34a; }
  .hint { margin: 14px 0 0; font-size: 0.8rem; color: #64748b; line-height: 1.4; }
  .ok { color: #86efac; }
  .err { color: #fca5a5; }
`;

export function paymentPageHtml(flowId: string, intent: BillIntent): string {
  const money = formatMoney(intent.amountCents, intent.currency);
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Pay ${esc(intent.title)}</title>
  <style>${chrome}</style>
</head>
<body>
  <main>
    <p class="eyebrow">Secure checkout · URL elicitation</p>
    <h1>${esc(intent.title)}</h1>
    <p class="amount">${esc(money)}</p>
    <div class="meta">
      <div><strong>Bill</strong> ${esc(intent.billId)}</div>
      <div><strong>Due</strong> ${esc(intent.dueDate)}</div>
      <div style="margin-top:8px">${esc(intent.description)}</div>
    </div>
    <form method="post" action="/ui/pay_bill" autocomplete="off">
      <input type="hidden" name="flow" value="${esc(flowId)}" />
      <label for="cardName">Name on card</label>
      <input id="cardName" name="cardName" required minlength="2" placeholder="Jordan Lee" />
      <label for="cardNumber">Card number</label>
      <input id="cardNumber" name="cardNumber" type="password" inputmode="numeric" autocomplete="off" required minlength="12" maxlength="19" pattern="[0-9 ]{12,19}" title="12–19 digits" placeholder="4242 4242 4242 4242" />
      <div class="row">
        <div>
          <label for="expiry">Expiry</label>
          <input id="expiry" name="expiry" required pattern="(0[1-9]|1[0-2])/[0-9]{2}" title="MM/YY" placeholder="12/28" />
        </div>
        <div>
          <label for="cvc">CVC</label>
          <input id="cvc" name="cvc" type="password" inputmode="numeric" autocomplete="off" required minlength="3" maxlength="4" pattern="[0-9]{3,4}" title="3 or 4 digits" placeholder="123" />
        </div>
      </div>
      <button type="submit">Pay ${esc(money)}</button>
    </form>
    <p class="hint">Demo only — card details stay on this page and are never returned through the MCP client. Use any 12–19 digit number; last 4 appear on the receipt.</p>
  </main>
</body>
</html>`;
}

export function paymentSuccessHtml(receipt: PaymentReceipt): string {
  const money = formatMoney(receipt.amountCents, receipt.currency);
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Payment confirmed</title>
  <style>${chrome}</style>
</head>
<body>
  <main>
    <p class="eyebrow ok">Payment confirmed</p>
    <h1 class="ok">Paid ${esc(money)}</h1>
    <div class="meta">
      <div><strong>Confirmation</strong> ${esc(receipt.confirmationId)}</div>
      <div><strong>Bill</strong> ${esc(receipt.billId)} · ${esc(receipt.title)}</div>
      <div><strong>Method</strong> •••• ${esc(receipt.methodLast4)}</div>
    </div>
    <p class="hint">You can close this tab and choose <strong>Continue</strong> in the MCP client so the tool can finish.</p>
  </main>
</body>
</html>`;
}

export function paymentErrorHtml(message: string): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Payment error</title>
  <style>${chrome}</style>
</head>
<body>
  <main>
    <h1 class="err">Could not complete payment</h1>
    <p class="meta">${esc(message)}</p>
  </main>
</body>
</html>`;
}
