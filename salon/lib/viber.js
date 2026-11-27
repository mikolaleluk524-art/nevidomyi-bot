// Viber-бот «Магія краси»: безкоштовні нагадування клієнткам, які підписалися.
// Потрібна змінна VIBER_TOKEN (токен бота з partners.viber.com).
// Клієнтка підписується за посиланням viber://pa?chatURI=<бот>&context=<її ref_code>.
import { createHmac, timingSafeEqual } from "node:crypto";
import { getSecret, one, run, setSecret } from "./db.js";

const token = () => process.env.VIBER_TOKEN?.trim();
export const viberOn = () => Boolean(token());
const NAME = "Магія краси";

async function call(path, body) {
  const res = await fetch(`https://chatapi.viber.com/pa/${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", "X-Viber-Auth-Token": token() },
    body: JSON.stringify(body || {}),
  });
  const data = await res.json().catch(() => ({}));
  if (data.status !== 0) throw new Error(`viber ${path}: ${data.status_message || data.status || res.status}`);
  return data;
}

export function verifySignature(raw, sig) {
  if (!token() || !sig) return false;
  const good = createHmac("sha256", token()).update(raw).digest("hex");
  return good.length === String(sig).length && timingSafeEqual(Buffer.from(good), Buffer.from(String(sig)));
}

export async function viberInfo() {
  if (!viberOn()) return null;
  try {
    const info = await call("get_account_info");
    if (info.uri) setSecret("viber_uri", info.uri);
    return { name: info.name, uri: info.uri, subscribers: info.subscribers_count };
  } catch (e) {
    return { error: e.message };
  }
}

/** Посилання для підписки конкретної клієнтки (за її кодом). */
export function viberLink(refCode) {
  const uri = getSecret("viber_uri");
  return uri ? `viber://pa?chatURI=${encodeURIComponent(uri)}&context=${encodeURIComponent(refCode)}` : null;
}

export async function sendViber(viberId, text) {
  await call("send_message", { receiver: viberId, type: "text", sender: { name: NAME }, text });
  return true;
}

const KEYBOARD = {
  Type: "keyboard",
  DefaultHeight: false,
  Buttons: [{ ActionType: "reply", ActionBody: "Підписатись", Text: "💅 Отримувати нагадування", BgColor: "#c9a46a", TextSize: "regular" }],
};

/** Обробка подій від Viber. Повертає тіло відповіді (для conversation_started — привітання). */
export async function handleViber(ev) {
  const user = ev.user || ev.sender;
  if (ev.event === "conversation_started") {
    // Запамʼятовуємо, хто прийшов за посиланням, — привʼяжемо після першого повідомлення
    if (ev.context && user?.id) setSecret("viber_ctx_" + user.id, String(ev.context).slice(0, 40));
    return {
      sender: { name: NAME },
      type: "text",
      text: "Вітаємо в «Магії краси» 💛\n\nНатисніть кнопку нижче — і ми нагадаємо вам про запис напередодні візиту.",
      keyboard: KEYBOARD,
    };
  }
  if (ev.event === "message" && user?.id) {
    const ctx = getSecret("viber_ctx_" + user.id);
    const c = ctx ? one("SELECT id, name FROM clients WHERE ref_code = ?", ctx.toUpperCase()) : one("SELECT id, name FROM clients WHERE viber_id = ?", user.id);
    if (c) {
      run("UPDATE clients SET viber_id = NULL WHERE viber_id = ? AND id != ?", user.id, c.id);
      run("UPDATE clients SET viber_id = ? WHERE id = ?", user.id, c.id);
      await sendViber(user.id, `Готово, ${c.name.split(" ")[0]}! ✨ Тепер нагадування про ваші записи приходитимуть сюди, у Viber.`).catch(() => {});
    } else {
      await sendViber(
        user.id,
        "Щоб отримувати нагадування, відкрийте посилання з сайту салону (розділ «Мої») або попросіть його в майстра 💅"
      ).catch(() => {});
    }
  }
  if (ev.event === "unsubscribed" && ev.user_id) run("UPDATE clients SET viber_id = NULL WHERE viber_id = ?", ev.user_id);
  return { ok: true };
}

export async function setViberWebhook(base) {
  if (!viberOn()) return;
  try {
    await call("set_webhook", { url: `${base}/api/viber/webhook`, event_types: ["subscribed", "unsubscribed", "conversation_started", "message"], send_name: true });
    const info = await viberInfo();
    console.log(`[viber] бот підключено: ${info?.name || "?"} (${info?.uri || "?"}), підписників: ${info?.subscribers ?? "?"}`);
  } catch (e) {
    console.error("[viber] webhook:", e.message);
  }
}
