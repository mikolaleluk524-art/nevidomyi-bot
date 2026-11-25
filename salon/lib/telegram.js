// Telegram-бот «Зошит записів»: сторінка записів на день, нові записи, щоденна копія бази.
// Потрібна лише змінна TG_BOT_TOKEN. Власниця підключає свій Telegram кнопкою в кабінеті
// (одноразове посилання t.me/<бот>?start=<код>) — chat_id вводити не треба.
import { randomBytes } from "node:crypto";
import { all, getSecret, one, setSecret } from "./db.js";
import { addDays, hm, humanDate, kyivNow } from "./time.js";

const token = () => process.env.TG_BOT_TOKEN?.trim();
export const telegramOn = () => Boolean(token());

async function tg(method, body, isForm = false) {
  const res = await fetch(`https://api.telegram.org/bot${token()}/${method}`, {
    method: "POST",
    ...(isForm ? { body } : { headers: { "content-type": "application/json" }, body: JSON.stringify(body || {}) }),
  });
  const data = await res.json().catch(() => ({}));
  if (!data.ok) throw new Error(`tg ${method}: ${data.description || res.status}`);
  return data.result;
}

// ---------- кому писати ----------
export function ownerChats() {
  const list = JSON.parse(getSecret("tg_chats") || "[]");
  const env = process.env.TG_CHAT_ID?.trim();
  if (env && !list.some((c) => String(c.id) === env)) list.push({ id: env, name: "TG_CHAT_ID" });
  return list;
}
function addChat(id, name) {
  const list = JSON.parse(getSecret("tg_chats") || "[]").filter((c) => String(c.id) !== String(id));
  list.push({ id, name });
  setSecret("tg_chats", JSON.stringify(list));
}
export function removeChat(id) {
  setSecret("tg_chats", JSON.stringify(JSON.parse(getSecret("tg_chats") || "[]").filter((c) => String(c.id) !== String(id))));
}
const isOwner = (id) => ownerChats().some((c) => String(c.id) === String(id));

export function linkCode() {
  let c = getSecret("tg_link_code");
  if (!c) {
    c = randomBytes(9).toString("base64url");
    setSecret("tg_link_code", c);
  }
  return c;
}

let me = null;
export async function botInfo() {
  if (!telegramOn()) return null;
  if (!me) me = await tg("getMe").catch(() => null);
  return me;
}

// ---------- відправка ----------
const esc = (s) => String(s ?? "").replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]);
const KEYBOARD = {
  keyboard: [[{ text: "📒 Сьогодні" }, { text: "📅 Завтра" }], [{ text: "🗓 Тиждень" }, { text: "🗄 Копія бази" }]],
  resize_keyboard: true,
  is_persistent: true,
};

export async function sendTo(chatId, html, extra = {}) {
  return tg("sendMessage", { chat_id: chatId, text: html, parse_mode: "HTML", disable_web_page_preview: true, reply_markup: KEYBOARD, ...extra });
}

/** Повідомлення всім підключеним (власниці). title — жирним, body — звичайним текстом. */
export async function sendToOwners(title, body = "") {
  if (!telegramOn()) return;
  const text = `<b>${esc(title)}</b>${body ? "\n" + esc(body) : ""}`;
  for (const c of ownerChats()) await sendTo(c.id, text).catch((e) => console.error("[tg]", e.message));
}

export async function sendDocumentToOwners(buf, filename, caption, silent = false) {
  if (!telegramOn()) return false;
  let sent = false;
  for (const c of ownerChats()) {
    const form = new FormData();
    form.append("chat_id", String(c.id));
    form.append("caption", caption);
    if (silent) form.append("disable_notification", "true");
    form.append("document", new Blob([buf]), filename);
    await tg("sendDocument", form, true)
      .then(() => (sent = true))
      .catch((e) => console.error("[tg doc]", e.message));
  }
  return sent;
}

// ---------- сторінка зошита ----------
const STATUS_MARK = { request: "📩", pending: "💳", confirmed: "•", done: "✓", no_show: "✗" };
const LINE = "┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈";

function dayPage(date) {
  const rows = all(
    `SELECT b.*, c.name, c.phone, c.note FROM bookings b JOIN clients c ON c.id = b.client_id
     WHERE b.date = ? AND b.status IN ('request','pending','confirmed','done','no_show') ORDER BY b.start`,
    date
  );
  const blocks = all("SELECT * FROM blocks WHERE date = ? ORDER BY start", date);
  const head = `📒 <b>${esc(humanDate(date))}</b>`;
  if (!rows.length && !blocks.length) return `${head}\n${LINE}\n<i>Сторінка порожня — записів немає</i> ☕`;
  const items = [
    ...rows.map((b) => ({
      t: b.start,
      text:
        `<code>${hm(b.start)}</code> ${STATUS_MARK[b.status] || "•"} <b>${esc(b.name)}</b>\n` +
        `<code>     </code> ${esc(b.service_name)} · ${b.price - b.discount - b.bonus_used} грн\n` +
        `<code>     </code> ☎ ${esc(b.phone)}` +
        (b.comment ? `\n<code>     </code> 💬 ${esc(b.comment)}` : "") +
        (b.note ? `\n<code>     </code> 📝 ${esc(b.note)}` : ""),
    })),
    ...blocks.map((k) => ({ t: k.start, text: `<code>${hm(k.start)}</code> ⛔ <i>закрито${k.end >= 1440 ? " весь день" : ` до ${hm(k.end)}`}${k.note ? " — " + esc(k.note) : ""}</i>` })),
  ].sort((a, b) => a.t - b.t);
  const active = rows.filter((b) => b.status !== "no_show");
  const sum = active.reduce((s, b) => s + b.price - b.discount - b.bonus_used, 0);
  return `${head}\n${LINE}\n${items.map((i) => i.text).join(`\n${LINE}\n`)}\n${LINE}\nРазом: <b>${active.length}</b> ${plural(active.length)} · <b>${sum} грн</b>`;
}

function weekPage() {
  const today = kyivNow().date;
  const lines = [];
  for (let i = 0; i < 7; i++) {
    const d = addDays(today, i);
    const n = one("SELECT COUNT(*) n, COALESCE(SUM(price - discount - bonus_used),0) s FROM bookings WHERE date = ? AND status IN ('request','pending','confirmed','done')", d);
    lines.push(`${i === 0 ? "▸" : " "} <b>${esc(humanDate(d))}</b>\n<code>   </code>${n.n ? `${n.n} ${plural(n.n)} · ${n.s} грн` : "<i>вільно</i>"}`);
  }
  return `🗓 <b>Тиждень наперед</b>\n${LINE}\n${lines.join("\n")}`;
}

const plural = (n) => (n % 10 === 1 && n % 100 !== 11 ? "запис" : [2, 3, 4].includes(n % 10) && ![12, 13, 14].includes(n % 100) ? "записи" : "записів");

// ---------- обробка повідомлень ----------
async function handle(update) {
  const msg = update.message;
  if (!msg?.text) return;
  const chat = msg.chat.id;
  const text = msg.text.trim();
  const site = process.env.PUBLIC_URL || (process.env.RAILWAY_PUBLIC_DOMAIN ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}` : "");

  if (text.startsWith("/start")) {
    const code = text.split(" ")[1];
    if (code && code === getSecret("tg_link_code")) {
      addChat(chat, [msg.from?.first_name, msg.from?.last_name].filter(Boolean).join(" ") || "Власниця");
      setSecret("tg_link_code", ""); // код одноразовий
      // Журнал починаємо з цього моменту (старі записи є в копії бази)
      setSecret("tg_journal_last", String(one("SELECT COALESCE(MAX(id),0) n FROM booking_log").n));
      await sendTo(chat, `✨ <b>Зошит записів підключено!</b>\n\nСюди приходитимуть:\n• 📝 кожен запис одразу, як тільки його створено чи змінено\n• ☀️ щоранку о 7:00 — записи на сьогодні\n• 🌙 щовечора о 20:00 — записи на завтра\n• 🗄 кожні 2 години — повна копія бази (тихо, без звуку)\n\nКнопки внизу відкривають потрібну сторінку.`);
      const { sendBackupNow } = await import("./backup.js");
      return sendBackupNow().catch(() => {});
    }
    if (isOwner(chat)) return sendTo(chat, dayPage(kyivNow().date));
    return tg("sendMessage", { chat_id: chat, text: `Це службовий зошит салону «Магія краси» 💅\n\nЗаписатися до майстра: ${site}`, reply_markup: { remove_keyboard: true } });
  }
  if (!isOwner(chat)) return; // чужим нічого не показуємо

  if (/сьогодні|^\/today/i.test(text)) return sendTo(chat, dayPage(kyivNow().date));
  if (/завтра|^\/tomorrow/i.test(text)) return sendTo(chat, dayPage(addDays(kyivNow().date, 1)));
  if (/тиждень|^\/week/i.test(text)) return sendTo(chat, weekPage());
  if (/копія|^\/backup/i.test(text)) {
    const { sendBackupNow } = await import("./backup.js");
    return (await sendBackupNow()) ? null : sendTo(chat, "Не вдалося зробити копію. Спробуйте пізніше.");
  }
  const m = text.match(/^\/?(\d{1,2})[./](\d{1,2})$/); // напр. «28.11» — сторінка на дату
  if (m) {
    const y = kyivNow().date.slice(0, 4);
    return sendTo(chat, dayPage(`${y}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}`));
  }
  return sendTo(chat, "Оберіть кнопку внизу або напишіть дату, напр. <code>28.11</code> — покажу сторінку на цей день.");
}

// ---------- журнал: кожен запис і кожна зміна — одразу в Telegram ----------
const STATUS_UA = { request: "заявка", pending: "очікує оплати", confirmed: "підтверджено", done: "прийшла ✓", cancelled: "скасовано", no_show: "не прийшла", expired: "не оплачено / згоріло" };

function journalText(log, b) {
  const d = `${b.date.slice(8, 10)}.${b.date.slice(5, 7)}`;
  const body =
    `<code>${d} ${hm(b.start)}</code> <b>${esc(b.name)}</b> · ${esc(b.phone)}\n` +
    `${esc(b.service_name)} · ${b.price - b.discount - b.bonus_used} грн` +
    (b.comment ? `\n💬 ${esc(b.comment)}` : "");
  if (!log.old_status) {
    const title = b.source === "admin" ? `📝 Записано вами · #${b.id}` : `💅 <b>Новий запис · #${b.id}</b>${b.status === "request" ? " (заявка)" : ""}`;
    return { text: `${title}\n${body}`, loud: b.source !== "admin" };
  }
  const loud = log.new_status === "cancelled";
  const icon = { cancelled: "❌", done: "✅", no_show: "🚫", confirmed: "✔️", expired: "⌛" }[log.new_status] || "✏️";
  return { text: `${icon} #${b.id} · ${STATUS_UA[log.old_status] || log.old_status} → <b>${STATUS_UA[log.new_status] || log.new_status}</b>\n${body}`, loud };
}

let journalBusy = false;
async function journalTick() {
  if (journalBusy || !ownerChats().length) return;
  journalBusy = true;
  try {
    let last = Number(getSecret("tg_journal_last"));
    if (!Number.isFinite(last) || getSecret("tg_journal_last") === null) {
      last = one("SELECT COALESCE(MAX(id),0) n FROM booking_log").n;
      setSecret("tg_journal_last", String(last));
    }
    const logs = all("SELECT * FROM booking_log WHERE id > ? ORDER BY id LIMIT 30", last);
    for (const log of logs) {
      const b = one("SELECT b.*, c.name, c.phone FROM bookings b JOIN clients c ON c.id = b.client_id WHERE b.id = ?", log.booking_id);
      if (b) {
        const { text, loud } = journalText(log, b);
        let ok = true;
        for (const c of ownerChats()) {
          await sendTo(c.id, text, { disable_notification: !loud }).catch((e) => {
            ok = false;
            console.error("[tg journal]", e.message);
          });
        }
        if (!ok) break; // повторимо цей рядок наступного разу — нічого не загубиться
      }
      setSecret("tg_journal_last", String(log.id));
    }
  } finally {
    journalBusy = false;
  }
}

// ---------- щоденні сторінки ----------
async function scheduled() {
  if (!ownerChats().length) return;
  const { telegramBackupTick } = await import("./backup.js");
  await telegramBackupTick().catch((e) => console.error("[tg backup]", e.message));
  const { date, minutes } = kyivNow();
  if (minutes >= 7 * 60 && getSecret("tg_morning") !== date) {
    setSecret("tg_morning", date);
    for (const c of ownerChats()) await sendTo(c.id, `☀️ Доброго ранку!\n\n${dayPage(date)}`).catch(() => {});
  }
  if (minutes >= 20 * 60 && getSecret("tg_evening") !== date) {
    setSecret("tg_evening", date);
    for (const c of ownerChats()) await sendTo(c.id, `🌙 Записи на завтра\n\n${dayPage(addDays(date, 1))}`).catch(() => {});
  }
}

// ---------- запуск ----------
export async function startTelegram() {
  if (!telegramOn()) return;
  try {
    await tg("deleteWebhook", {});
    await tg("setMyCommands", {
      commands: [
        { command: "today", description: "📒 Записи на сьогодні" },
        { command: "tomorrow", description: "📅 Записи на завтра" },
        { command: "week", description: "🗓 Тиждень наперед" },
        { command: "backup", description: "🗄 Резервна копія бази" },
      ],
    });
    await tg("setMyShortDescription", { short_description: "Зошит записів салону «Магія краси» 📒" }).catch(() => {});
    await tg("setMyDescription", {
      description: "📒 Службовий зошит записів салону «Магія краси».\n\nНові записи, сторінка на кожен день і щоденна резервна копія — все тут.",
    }).catch(() => {});
    console.log("[tg] бот:", (await botInfo())?.username);
  } catch (e) {
    console.error("[tg] старт:", e.message);
    return;
  }
  setInterval(() => scheduled().catch((e) => console.error("[tg sched]", e.message)), 60_000).unref();
  setInterval(() => journalTick().catch((e) => console.error("[tg journal]", e.message)), 5_000).unref();
  let offset = Number(getSecret("tg_offset")) || 0;
  (async function poll() {
    for (;;) {
      try {
        const updates = await tg("getUpdates", { offset, timeout: 25, allowed_updates: ["message"] });
        for (const u of updates) {
          offset = u.update_id + 1;
          setSecret("tg_offset", String(offset));
          await handle(u).catch((e) => console.error("[tg handle]", e.message));
        }
      } catch (e) {
        console.error("[tg poll]", e.message);
        await new Promise((r) => setTimeout(r, 5000));
      }
    }
  })();
}
