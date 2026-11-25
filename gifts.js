/**
 * Подарунки за Telegram Stars: у діалозі з бота (/gift) і за столом у грі «Бутилочка».
 * Усі зірки йдуть на баланс бота, тобто власнику. Окремий відсоток рахувати не потрібно.
 *
 * payload рахунку: gift:<подарунок>:<отримувач>:<c|t>
 *   c — діалог у боті, t — стіл у грі.
 */

import { DatabaseSync } from "node:sqlite";
import { DB_PATH, langOf, tg } from "./src/bot.js";
import { L, LANGS, localizeMarkup } from "./src/i18n.js";

export const GIFTS = {
  rose: { emoji: "🌹", name: "Троянда", stars: 10 },
  choco: { emoji: "🍫", name: "Шоколадка", stars: 25 },
  bear: { emoji: "🧸", name: "Ведмедик", stars: 50 },
  ring: { emoji: "💍", name: "Каблучка", stars: 100 },
  diamond: { emoji: "💎", name: "Діамант", stars: 250 },
};

const hasGift = (id) => Object.hasOwn(GIFTS, id);
export const giftList = () => Object.entries(GIFTS).map(([id, g]) => ({ id, ...g }));

// game-server.js підключає сюди перевірку «сидять за одним столом» і показ подарунка за столом.
let hooks = { sameTable: () => false, tableGift: () => false };
export function setGiftHooks(next) {
  hooks = { ...hooks, ...next };
}

// Нове підключення на кожну дію: так нас не ламає відновлення бази з копії.
function withDb(fn) {
  const db = new DatabaseSync(DB_PATH);
  try {
    db.exec("pragma busy_timeout = 5000");
    db.exec("create table if not exists gifts (id integer primary key autoincrement, from_id text not null, to_id text not null, gift text not null, stars integer not null, charge_id text unique, created_at integer not null)");
    return fn(db);
  } finally {
    db.close();
  }
}

// З ким користувач зараз у діалозі (з обох боків), інакше null.
function partnerOf(userId) {
  return withDb((db) => {
    const me = db.prepare("select status, partner_id, adult, banned from users where id = ?").get(String(userId));
    if (!me || me.status !== "chat" || !me.partner_id || !me.adult || me.banned) return null;
    const other = db.prepare("select status, partner_id, banned from users where id = ?").get(me.partner_id);
    if (!other || other.status !== "chat" || other.partner_id !== String(userId) || other.banned) return null;
    return String(me.partner_id);
  });
}

function nameOf(userId) {
  return withDb((db) => db.prepare("select display_name from users where id = ?").get(String(userId))?.display_name) || "Гравець";
}

function allowed(kind, from, to) {
  if (!to || to === from) return false;
  if (kind === "c") return partnerOf(from) === to;
  if (kind === "t") return hooks.sameTable(from, to);
  return false;
}

function parse(payload) {
  const [tag, giftId, to, kind] = String(payload).split(":");
  if (tag !== "gift" || !hasGift(giftId) || (kind !== "c" && kind !== "t") || !to) return null;
  return { giftId, gift: GIFTS[giftId], to, kind };
}

function isGone(err) {
  const msg = err instanceof Error ? err.message.toLowerCase() : "";
  return err?.code === 403 || /blocked|deactivated|chat not found/.test(msg);
}

async function say(chatId, text, reply_markup) {
  const lang = langOf(chatId);
  try {
    await tg("sendMessage", { chat_id: chatId, text: L(lang, text), ...(reply_markup ? { reply_markup: localizeMarkup(lang, reply_markup) } : {}) });
  } catch (err) {
    if (!isGone(err)) console.error("[gift] send", err.message);
  }
}

// Рахунок мовою того, хто платить.
const invoiceFields = (g, lang = "uk") => ({
  title: L(lang, `Подарунок: ${g.name}`),
  description: L(lang, "Подарунок гравцю. Оплата зірками Telegram."),
  currency: "XTR",
  prices: [{ label: L(lang, g.name), amount: g.stars }],
});
const giftLabel = (g, lang) => `${g.emoji} ${L(lang, g.name)}`;

// Посилання на оплату для міні-застосунку. Кидає помилку, якщо дарувати не можна.
export async function createGiftInvoice(from, to, giftId, kind) {
  if (!hasGift(giftId)) throw new Error("bad_gift");
  if (!allowed(kind, String(from), String(to))) throw new Error("not_allowed");
  return tg("createInvoiceLink", { ...invoiceFields(GIFTS[giftId], langOf(from)), payload: `gift:${giftId}:${to}:${kind}` });
}

async function showGifts(userId) {
  if (!partnerOf(userId)) {
    await say(userId, "Подарунки в діалозі можна дарувати лише під час розмови. Натисни «Знайти співрозмовника». А за столом у грі можна дарувати гравцям, відкрий «🍾 Гра в бутилочку».");
    return;
  }
  const lang = langOf(userId);
  const rows = giftList().map((g) => [{ text: `${giftLabel(g, lang)} · ${g.stars}⭐`, callback_data: `gift:${g.id}` }]);
  await say(userId, "🎁 Обери подарунок для співрозмовника. Він отримає його анонімно.", { inline_keyboard: rows });
}

async function onCallback(cb) {
  await tg("answerCallbackQuery", { callback_query_id: cb.id }).catch(() => {});
  const from = String(cb.from.id);
  const giftId = cb.data.slice("gift:".length);
  if (!hasGift(giftId)) return;
  const partner = partnerOf(from);
  if (!partner) {
    await say(from, "Діалог уже завершено, подарунок надіслати нікому.");
    return;
  }
  await tg("sendInvoice", {
    chat_id: Number(from),
    ...invoiceFields(GIFTS[giftId], langOf(from)),
    payload: `gift:${giftId}:${partner}:c`,
    provider_token: "",
  });
}

async function onPreCheckout(query) {
  const p = parse(query.invoice_payload);
  let error = null;
  if (!p || query.currency !== "XTR" || query.total_amount !== p.gift.stars) error = "Ціна змінилась. Відкрий подарунки ще раз.";
  else if (!allowed(p.kind, String(query.from.id), p.to)) {
    error = p.kind === "t" ? "Гравець уже вийшов зі столу. Подарунок не надіслано." : "Діалог уже завершено, подарунок надіслати нікому.";
  }
  await tg("answerPreCheckoutQuery", { pre_checkout_query_id: query.id, ok: !error, ...(error ? { error_message: L(langOf(query.from.id), error) } : {}) });
}

async function onPaid(from, pay) {
  const p = parse(pay.invoice_payload);
  const chargeId = pay.telegram_payment_charge_id;

  const refund = async (why) => {
    try {
      await tg("refundStarPayment", { user_id: Number(from), telegram_payment_charge_id: chargeId });
    } catch (err) {
      console.error("[gift] refund", err.message);
    }
    withDb((db) => db.prepare("delete from payments where charge_id = ?").run(chargeId));
    await say(from, why);
  };

  // Спершу запис платежу: повтор того самого оплачування не доставить подарунок вдруге.
  const fresh = withDb((db) =>
    db.prepare("insert into payments (charge_id, user_id, payload, stars) values (?, ?, ?, ?) on conflict (charge_id) do nothing")
      .run(chargeId, from, pay.invoice_payload, pay.total_amount).changes
  );
  if (!fresh) return;

  if (!p || pay.currency !== "XTR" || pay.total_amount !== p.gift.stars) {
    await refund("Оплату отримано, але подарунок не збігся. Зірки повернено.");
    return;
  }
  // У діалозі співрозмовник має лишатись на місці. За столом подарунок уже оплачено, тож доставляємо особисто.
  if (p.kind === "c" && partnerOf(from) !== p.to) {
    await refund("Діалог уже завершено, тому подарунок не надіслано. Зірки повернено.");
    return;
  }
  const { emoji, name } = p.gift;
  const toLang = langOf(p.to);
  const label = giftLabel(p.gift, toLang);
  const text = p.kind === "t" ? `🎁 ${nameOf(from)} подарував(ла) тобі: ${label}!` : `🎁 Співрозмовник подарував тобі: ${label}!`;
  try {
    await tg("sendMessage", { chat_id: p.to, text: L(toLang, text) });
  } catch {
    await refund("Не вдалося доставити подарунок. Зірки повернено.");
    return;
  }
  if (p.kind === "t") {
    try { hooks.tableGift(from, p.to, { id: p.giftId, emoji, name }); } catch (err) { console.error("[gift] table", err.message); }
  }
  withDb((db) =>
    db.prepare("insert into gifts (from_id, to_id, gift, stars, charge_id, created_at) values (?, ?, ?, ?, ?, ?) on conflict (charge_id) do nothing")
      .run(from, p.to, p.giftId, p.gift.stars, chargeId, Math.floor(Date.now() / 1000))
  );
  await say(from, `🎁 Подарунок «${giftLabel(p.gift, langOf(from))}» надіслано. Дякую!`);
}

// true — оновлення наше, bot.js його вже не обробляє.
export async function handleGiftUpdate(update) {
  try {
    if (update.pre_checkout_query?.invoice_payload?.startsWith("gift:")) {
      await onPreCheckout(update.pre_checkout_query);
      return true;
    }
    const msg = update.message;
    if (msg?.successful_payment?.invoice_payload?.startsWith("gift:")) {
      await onPaid(String(msg.from.id), msg.successful_payment);
      return true;
    }
    if (update.callback_query?.data?.startsWith("gift:")) {
      await onCallback(update.callback_query);
      return true;
    }
    if (msg?.chat?.type === "private" && typeof msg.text === "string" && /^\/gift(@\w+)?(\s|$)/i.test(msg.text.trim())) {
      await showGifts(String(msg.from.id));
      return true;
    }
  } catch (err) {
    console.error("[gift]", err.message);
    return true;
  }
  return false;
}

// Додає /gift до списку команд, не стираючи наявні.
export async function publishGiftCommand() {
  for (const lang of LANGS) {
    const scope = lang === "uk" ? {} : { language_code: lang };
    const current = await tg("getMyCommands", scope);
    const list = current.filter((c) => c.command !== "gift");
    list.push({ command: "gift", description: L(lang, "Подарувати подарунок") });
    await tg("setMyCommands", { commands: list, ...scope });
  }
}