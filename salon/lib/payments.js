// Передоплата. Підтримуються два провайдери — обирається тим, які ключі задані:
//   LiqPay (ПриватБанк): LIQPAY_PUBLIC_KEY + LIQPAY_PRIVATE_KEY
//   monobank «Плата by mono»: MONO_TOKEN
// Без ключів — тестовий режим (гроші не списуються).
import { createHash } from "node:crypto";

const env = (k) => process.env[k]?.trim();

export function provider() {
  if (env("LIQPAY_PUBLIC_KEY") && env("LIQPAY_PRIVATE_KEY")) return "liqpay";
  if (env("MONO_TOKEN")) return "mono";
  return "demo";
}
export const paymentsLive = () => provider() !== "demo";

// ---------- LiqPay ----------
const lpSign = (data) => createHash("sha1").update(env("LIQPAY_PRIVATE_KEY") + data + env("LIQPAY_PRIVATE_KEY")).digest("base64");
const lpEncode = (obj) => Buffer.from(JSON.stringify({ version: 3, public_key: env("LIQPAY_PUBLIC_KEY"), ...obj })).toString("base64");

async function lpRequest(params) {
  const data = lpEncode(params);
  const res = await fetch("https://www.liqpay.ua/api/request", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ data, signature: lpSign(data) }),
  });
  const json = await res.json().catch(() => ({}));
  if (json.result === "error" && json.err_code !== "payment_not_found") throw new Error(`liqpay: ${json.err_description || json.err_code}`);
  return json;
}

/** Перевірка й розбір колбеку LiqPay (form: data, signature). Повертає розкодовані дані або null. */
export function liqpayCallback(form) {
  const data = String(form.data || "");
  const sig = String(form.signature || "");
  if (!data || provider() !== "liqpay" || lpSign(data) !== sig) return null;
  try {
    return JSON.parse(Buffer.from(data, "base64").toString("utf8"));
  } catch {
    return null;
  }
}

// ---------- monobank ----------
async function mono(path, init = {}) {
  const res = await fetch("https://api.monobank.ua/api/merchant" + path, {
    ...init,
    headers: { "X-Token": env("MONO_TOKEN"), "content-type": "application/json", ...(init.headers || {}) },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`mono ${res.status}: ${data.errText || data.errCode || "error"}`);
  return data;
}

// ---------- спільний інтерфейс ----------
/**
 * Створює платіж. ref — унікальний ідентифікатор (для LiqPay це order_id, для mono — invoiceId).
 * Повертає { ref, pageUrl }.
 */
export async function createPayment({ amount, orderId, description, resultUrl, serverUrl }) {
  if (provider() === "liqpay") {
    const data = lpEncode({
      action: "pay",
      amount,
      currency: "UAH",
      description,
      order_id: orderId,
      result_url: resultUrl,
      server_url: serverUrl,
      language: "uk",
      expired_date: new Date(Date.now() + 20 * 60_000).toISOString().replace("T", " ").slice(0, 19),
    });
    const pageUrl = `https://www.liqpay.ua/api/3/checkout?${new URLSearchParams({ data, signature: lpSign(data) })}`;
    return { ref: orderId, pageUrl };
  }
  const inv = await mono("/invoice/create", {
    method: "POST",
    body: JSON.stringify({
      amount: Math.round(amount * 100),
      ccy: 980,
      merchantPaymInfo: { reference: orderId, destination: description },
      redirectUrl: resultUrl,
      webHookUrl: serverUrl,
      validity: 15 * 60,
    }),
  });
  return { ref: inv.invoiceId, pageUrl: inv.pageUrl };
}

/** Повертає { paid: boolean, amount } — сума в гривнях. */
export async function paymentStatus(ref) {
  if (provider() === "liqpay") {
    const st = await lpRequest({ action: "status", order_id: ref });
    return { paid: st.status === "success" || st.status === "sandbox", amount: Math.round(Number(st.amount) || 0) };
  }
  const st = await mono(`/invoice/status?invoiceId=${encodeURIComponent(ref)}`);
  return { paid: st.status === "success", amount: Math.round((st.finalAmount ?? st.amount) / 100) };
}

export async function refundPayment(ref, amount) {
  if (provider() === "liqpay") return lpRequest({ action: "refund", order_id: ref, amount });
  return mono("/invoice/cancel", { method: "POST", body: JSON.stringify({ invoiceId: ref }) });
}
