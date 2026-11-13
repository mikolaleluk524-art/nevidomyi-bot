import { DatabaseSync } from "node:sqlite";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const BOT_TOKEN = "9198483171:AAGiByJqyY9mS6y1arfObdkWMOdBSHBuhRw";
export const BOT_USERNAME = "nevidomyi_chat_bot";
export const CLAIM_CODE = "secret123";
export const DB_PATH = join(process.env.DATA_DIR || dirname(fileURLToPath(import.meta.url)), "nevidomyi.sqlite");

const BTN = {
  search: "🔍 Знайти співрозмовника",
  next: "⏭ Наступний",
  stop: "⛔ Завершити діалог",
  profile: "👤 Мій профіль",
  form: "📝 Заповнити анкету",
  photo: "📷 Завантажити фото",
  premium: "💎 Premium",
  invite: "🎁 Запросити друзів",
  report: "⚠️ Поскаржитись",
  rules: "📜 Правила",
  help: "❓ Допомога",
};

const ACTIONS = Object.fromEntries(Object.entries(BTN).map(([k, v]) => [v, k]));

const PLANS = {
  search: { stars: 1, searches: 1, title: "Пошук за анкетою", label: "1 пошук" },
  day: { stars: 20, seconds: 86400, title: "Premium 1 день", label: "1 день" },
  week: { stars: 100, seconds: 604800, title: "Premium 1 тиждень", label: "1 тиждень" },
  month: { stars: 1000, seconds: 2592000, title: "Premium 1 місяць", label: "1 місяць" },
  sub: { stars: 1000, seconds: 2592000, subscribe: true, title: "Підписка", label: "30 днів" },
};

const db = new DatabaseSync(DB_PATH);
db.exec(`
  pragma journal_mode = wal;
  create table if not exists users (
    id text primary key, adult int default 0, banned int default 0,
    premium_until int default 0, status text default 'new', partner_id text,
    last_partner_id text, gender text, profile_age int, city text,
    look_gender text, age_min int, age_max int, look_city text,
    search_mode text, pending text, search_credits int default 0,
    invite_code text, invited_by text, display_name text, aim text,
    interests text, created_at int, last_seen int
  );
  create table if not exists photos (id text primary key, user_id text, bytes blob, created_at int);
  create table if not exists payments (charge_id text primary key, user_id text, payload text, stars int);
  create table if not exists updates (id int primary key);
`);

const q = (sql, ...p) => db.prepare(sql).all(...p);
const one = (sql, ...p) => db.prepare(sql).get(...p);
const run = (sql, ...p) => db.prepare(sql).run(...p);

function now() { return Math.floor(Date.now() / 1000); }
function code(n = 8) { return Math.random().toString(36).slice(2, 2 + n); }

function menuKb() {
  return { keyboard: [
    [{ text: BTN.search }],
    [{ text: BTN.next }, { text: BTN.stop }],
    [{ text: BTN.form }],
    [{ text: BTN.photo }],
    [{ text: BTN.profile }, { text: BTN.premium }],
    [{ text: BTN.invite }, { text: BTN.report }],
    [{ text: BTN.rules }, { text: BTN.help }],
  ], resize_keyboard: true };
}

function choiceKb(items) {
  return { keyboard: [items.map(t => ({ text: t })), ...menuKb().keyboard], resize_keyboard: true };
}

export async function tg(method, body) {
  const res = await fetch(`https://api.telegram.org/bot\( {BOT_TOKEN}/ \){method}`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });
  const data = await res.json();
  if (!data.ok) throw new Error(data.description || method);
  return data.result;
}

async function send(chatId, text, markup) {
  try {
    await tg("sendMessage", { chat_id: chatId, text, reply_markup: markup || menuKb() });
  } catch {}
}

function ensure(id) {
  if (!one("select id from users where id = ?", id)) {
    run("insert into users (id, invite_code, created_at, last_seen) values (?, ?, ?, ?)", id, code(), now(), now());
  }
  run("update users set last_seen = ? where id = ?", now(), id);
  return one("select * from users where id = ?", id);
}

function premium(until) { return Number(until) > now(); }

async function enqueue(id, mode = "random") {
  const me = ensure(id);
  if (!me.adult) return send(id, "Спочатку підтверди вік.");
  if (me.status === "chat") return send(id, "Спочатку заверши діалог.");

  if (mode === "dating") {
    if (!me.gender || !me.profile_age || !me.city) return startForm(id);
    if (!premium(me.premium_until) && me.search_credits < 1) {
      await send(id, "Пошук за анкетою лише з Premium.");
      return showPremium(id);
    }
    if (!premium(me.premium_until)) run("update users set search_credits = search_credits - 1 where id = ?", id);
  }

  run("update users set status = 'search', search_mode = ?, partner_id = null where id = ?", mode, id);

  const cand = one(
    mode === "dating"
      ? "select id from users where status = 'search' and search_mode = 'dating' and id != ? and adult = 1 and gender = ? and profile_age between ? and ? and lower(city) = lower(?) limit 1"
      : "select id from users where status = 'search' and coalesce(search_mode, 'random') = 'random' and id != ? and adult = 1 limit 1",
    id, me.look_gender || me.gender, me.age_min || 18, me.age_max || 99, me.look_city || me.city
  );

  if (!cand) return send(id, mode === "dating" ? "Шукаю за анкетою..." : "Шукаю випадково...");

  run("update users set status = 'chat', partner_id = ? where id = ?", cand.id, id);
  run("update users set status = 'chat', partner_id = ? where id = ?", id, cand.id);

  await send(id, "Співрозмовника знайдено. Пиши.");
  try { await send(cand.id, "Співрозмовника знайдено. Пиши."); } catch {}
}

async function disconnect(id) {
  const me = one("select * from users where id = ?", id);
  if (!me) return;
  if (me.status === "search") {
    run("update users set status = 'lobby' where id = ?", id);
    return send(id, "Пошук скасовано.");
  }
  if (me.status === "chat" && me.partner_id) {
    const p = me.partner_id;
    run("update users set status = 'lobby', partner_id = null where id = ?", id);
    run("update users set status = 'lobby', partner_id = null where id = ? and partner_id = ?", p, id);
    await send(id, "Діалог завершено.");
    try { await send(p, "Співрозмовник завершив діалог."); } catch {}
  }
}

async function showPremium(id) {
  const p = one("select * from users where id = ?", id);
  await send(id, `Premium: ${premium(p?.premium_until) ? "активний" : "немає"}\nПошуків: ${p?.search_credits || 0}\n\n1 пошук — 1⭐\n1 день — 20⭐\n1 тиждень — 100⭐\n1 місяць — 1000⭐`, {
    inline_keyboard: [
      [{ text: "1 пошук · 1⭐", callback_data: "buy:search" }],
      [{ text: "1 день · 20⭐", callback_data: "buy:day" }],
      [{ text: "1 тиждень · 100⭐", callback_data: "buy:week" }],
      [{ text: "1 місяць · 1000⭐", callback_data: "buy:month" }],
    ]
  });
}

async function startForm(id) {
  run("update users set pending = 'gender' where id = ?", id);
  await send(id, "Твоя стать?", choiceKb(["Чоловік", "Жінка"]));
}

async function savePending(id, pending, text) {
  if (pending === "gender") {
    const g = text === "Чоловік" || text === "Жінка" ? text : null;
    if (!g) return startForm(id);
    run("update users set gender = ?, pending = 'age' where id = ?", g, id);
    return send(id, "Скільки тобі років? (18-99)");
  }
  if (pending === "age") {
    const n = Number(text);
    if (!Number.isInteger(n) || n < 18 || n > 99) return send(id, "Напиши число від 18 до 99.");
    run("update users set profile_age = ?, pending = 'city' where id = ?", n, id);
    return send(id, "Твоє місто?");
  }
  if (pending === "city") {
    run("update users set city = ?, pending = null where id = ?", text.slice(0, 40), id);
    await send(id, "Анкета збережена.");
    return enqueue(id, "dating");
  }
}

export async function handleUpdate(update) {
  const seen = run("insert into updates (id) values (?) on conflict do nothing", update.update_id);
  if (!seen.changes) return;

  const from = update.callback_query?.from || update.message?.from;
  if (!from) return;
  const id = String(from.id);

  if (update.callback_query) {
    const data = update.callback_query.data || "";
    const qid = update.callback_query.id;
    try {
      if (data === "age:yes") {
        run("update users set adult = 1, status = 'lobby' where id = ?", id);
        await tg("answerCallbackQuery", { callback_query_id: qid, text: "Вік підтверджено" });
        await send(id, "Вік підтверджено.");
      } else if (data.startsWith("buy:")) {
        await tg("answerCallbackQuery", { callback_query_id: qid });
        const plan = PLANS[data.slice(4)];
        if (plan) await tg("sendInvoice", {
          chat_id: id, title: plan.title, description: plan.label,
          payload: `prem:${data.slice(4)}`, currency: "XTR", provider_token: "",
          prices: [{ label: plan.label, amount: plan.stars }]
        });
      } else if (data === "find:random") {
        await tg("answerCallbackQuery", { callback_query_id: qid });
        await enqueue(id, "random");
      } else if (data === "find:dating") {
        await tg("answerCallbackQuery", { callback_query_id: qid });
        await enqueue(id, "dating");
      } else {
        await tg("answerCallbackQuery", { callback_query_id: qid });
      }
    } catch {}
    return;
  }

  const msg = update.message;
  if (!msg || msg.chat.type !== "private") return;

  const text = msg.text || "";
  const me = ensure(id);

  if (msg.successful_payment) {
    const payload = msg.successful_payment.invoice_payload;
    const plan = PLANS[payload?.replace("prem:", "")];
    if (plan) {
      if (plan.searches) run("update users set search_credits = search_credits + 1 where id = ?", id);
      else run("update users set premium_until = max(premium_until, ?) + ? where id = ?", now(), plan.seconds, id);
      await send(id, "Оплачено.");
    }
    return;
  }

  if (!me.adult) {
    return send(id, "Невідомий — анонімний чат.\n\nПідтверди, що тобі є 18.", {
      inline_keyboard: [[{ text: "Мені є 18", callback_data: "age:yes" }, { text: "Мені немає 18", callback_data: "age:no" }]]
    });
  }

  const action = ACTIONS[text];
  if (action === "search") {
    return send(id, "Обери.", { inline_keyboard: [[{ text: "Випадково", callback_data: "find:random" }], [{ text: "За анкетою", callback_data: "find:dating" }]] });
  }
  if (action === "next") return me.status === "chat" ? disconnect(id).then(() => enqueue(id)) : enqueue(id);
  if (action === "stop") return disconnect(id);
  if (action === "profile") {
    const p = one("select * from users where id = ?", id);
    return send(id, `Профіль\nСтать: ${p?.gender || "—"}\nВік: ${p?.profile_age || "—"}\nМісто: ${p?.city || "—"}\nPremium: ${premium(p?.premium_until) ? "так" : "ні"}\nПошуків: ${p?.search_credits || 0}`);
  }
  if (action === "form") return startForm(id);
  if (action === "premium") return showPremium(id);
  if (action === "invite") {
    const p = one("select invite_code from users where id = ?", id);
    return send(id, `https://t.me/\( {BOT_USERNAME}?start= \){p?.invite_code || code()}\n\nЗа друга — 3 години Premium.`);
  }
  if (action === "rules") return send(id, "Правила:\n• 18+\n• Без образ\n• Без контактів");
  if (action === "help") return send(id, "Кнопки внизу. «Знайти» — почати пошук.");

  const pending = one("select pending from users where id = ?", id)?.pending;
  if (pending) return savePending(id, pending, text);

  if (me.status === "chat" && me.partner_id) {
    try { await tg("copyMessage", { chat_id: me.partner_id, from_chat_id: msg.chat.id, message_id: msg.message_id }); }
    catch { await disconnect(id); }
    return;
  }

  if (me.status === "search") return send(id, "Пошук триває...");
  await send(id, "Ти в лобі.");
}

export async function publishCommands() {
  await tg("setMyCommands", { commands: [
    { command: "start", description: "Почати" },
    { command: "search", description: "Знайти" },
    { command: "stop", description: "Завершити" },
  ]});
}

export function checkpoint() { try { db.exec("pragma wal_checkpoint(TRUNCATE)"); } catch {} }