// Передоплата через monobank (еквайринг «Плата by mono»).
// Потрібна змінна MONO_TOKEN (токен з кабінету web.monobank.ua). Без неї — тестовий режим.
const API = "https://api.monobank.ua/api/merchant";
const token = () => process.env.MONO_TOKEN?.trim();

export const paymentsLive = () => Boolean(token());

async function call(path, init = {}) {
  const res = await fetch(API + path, {
    ...init,
    headers: { "X-Token": token(), "content-type": "application/json", ...(init.headers || {}) },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`mono ${res.status}: ${data.errText || data.errCode || "error"}`);
  return data;
}

/** Повертає { invoiceId, pageUrl } */
export function createInvoice({ amount, reference, destination, redirectUrl, webHookUrl }) {
  return call("/invoice/create", {
    method: "POST",
    body: JSON.stringify({
      amount: Math.round(amount * 100),
      ccy: 980,
      merchantPaymInfo: { reference, destination },
      redirectUrl,
      webHookUrl,
      validity: 15 * 60,
    }),
  });
}

/** status: created | processing | hold | success | failure | reversed | expired */
export const invoiceStatus = (invoiceId) => call(`/invoice/status?invoiceId=${encodeURIComponent(invoiceId)}`);

export const refundInvoice = (invoiceId) => call("/invoice/cancel", { method: "POST", body: JSON.stringify({ invoiceId }) });
