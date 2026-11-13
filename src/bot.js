import { DatabaseSync, backup } from "node:sqlite";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomBytes } from "node:crypto";
import { mkdirSync, readdirSync, statSync, unlinkSync, copyFileSync, existsSync } from "node:fs";
import { readFile, writeFile, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:http";

export const BOT_TOKEN = process.env.BOT_TOKEN || "9198483171:AAGiByJqyY9mS6y1arfObdkWMOdBSHBuhRw";
export const BOT_USERNAME = process.env.BOT_USERNAME || "nevidomyi_chat_bot";
export const CLAIM_CODE = process.env.CLAIM_CODE || "secret123";
export const ADMIN_ID = Number(process.env.ADMIN_ID || 0);
export const ADMIN_PASS = "POTT@R1999";
const FRIEND_PREMIUM = 3 * 60 * 60;
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

const ACTIONS = {
  [BTN.search]: "search",
  [BTN.next]: "next",
  [BTN.stop]: "stop",
  [BTN.profile]: "profile",
  [BTN.form]: "form",
  [BTN.photo]: "photo",
  [BTN.premium]: "premium",
  [BTN.invite]: "invite",
  [BTN.report]: "report",
  [BTN.rules]: "rules",
  [BTN.help]: "help",
  "Шукати співрозмовника": "search",
  "Скасувати пошук": "stop",
  Наступний: "next",
  Зупинити: "stop",
};

const PLANS = {
  search: { stars: 1, searches: 1, title: "Пошук за анкетою", label: "1 пошук за анкетою" },
  day: { stars: 20, seconds: 24 * 60 * 60, title: "Premium на 1 день", label: "1 день" },
  week: { stars: 100, seconds: 7 * 24 * 60 * 60, title: "Premium на 1 тиждень", label: "1 тиждень" },
  month: { stars: 1000, seconds: 30 * 24 * 60 * 60, title: "Premium на 1 місяць", label: "1 місяць" },
  sub: { stars: 1000, seconds: 30 * 24 * 60 * 60, subscribe: true, title: "Підписка на чат знайомств", label: "30 днів" },
};

mkdirSync(dirname(DB_PATH), { recursive: true });

const SCHEMA = `
  pragma journal_mode = wal;
  create table if not exists users (
    id text primary key, adult integer not null default 0, banned integer not null default 0,
    premium_until integer not null default 0, status text not null default 'new',
    partner_id text, last_partner_id text, first_name text, username text, language_code text,
    gender text, profile_age integer, interests text, invite_code text unique, invited_by text,
    pending text, last_seen integer, search_credits integer not null default 0,
    priority integer not null default 0, invite_rewarded integer not null default 0,
    city text, look_gender text, age_min integer, age_max integer, look_city text,
    search_mode text, goal text, display_name text, aim text, public_code text unique,
    created_at integer not null
  );
  create table if not exists photos (id text primary key, user_id text not null, bytes blob not null, created_at integer not null);
  create table if not exists payments (charge_id text primary key, user_id text not null, payload text not null, stars integer not null);
  create table if not exists reports (id integer primary key autoincrement, reporter_id text not null, target_id text not null, created_at integer not null);
  create table if not exists optout (id text primary key);
  create table if not exists admin (id text primary key);
  create table if not exists updates (id integer primary key);
  create table if not exists requests (id text primary key, from_id text not null, to_id text not null);
  create table if not exists messages (id integer primary key autoincrement, from_id text, to_id text, text text, created_at integer);
`;

function backupDir() { return join(dirname(DB_PATH), "backups"); }
function dropSidecars() {
  for (const suffix of ["-wal", "-shm"]) try { unlinkSync(DB_PATH + suffix); } catch {}
}
function isHealthy(path, readOnly = true) {
  if (!existsSync(path)) return false;
  let probe;
  try {
    probe = new DatabaseSync(path, { readOnly });
    return probe.prepare("pragma integrity_check").get()?.integrity_check === "ok";
  } catch { return false; }
  finally { try { probe?.close(); } catch {} }
}
function backupFiles() {
  try {
    return readdirSync(backupDir())
      .filter(n => n.startsWith("nevidomyi-") && n.endsWith(".sqlite"))
      .map(n => ({ path: join(backupDir(), n), time: statSync(join(backupDir(), n)).mtimeMs }))
      .sort((a, b) => b.time - a.time);
  } catch { return []; }
}
function newestGoodBackup() { return backupFiles().find(f => isHealthy(f.path))?.path ?? null; }
function openDatabase() { const next = new DatabaseSync(DB_PATH); next.exec(SCHEMA); return next; }
function installCopy(src) { dropSidecars(); copyFileSync(src, DB_PATH); dropSidecars(); }

export let restoredFrom = null;
if (!existsSync(DB_PATH) || !isHealthy(DB_PATH, false)) {
  const src = newestGoodBackup();
  if (src) { installCopy(src); restoredFrom = src; console.info(`[bot] базу відновлено з ${src}`); }
}

let db = openDatabase();
const q = (sql, ...p) => db.prepare(sql).all(...p);
const one = (sql, ...p) => db.prepare(sql).get(...p);
const run = (sql, ...p) => db.prepare(sql).run(...p);

let lock = Promise.resolve();
function withLock(fn) { const job = lock.then(() => fn()); lock = job.then(() => {}, () => {}); return job; }
function nowSec() { return Math.floor(Date.now() / 1000); }
function code(len = 10) { return randomBytes(Math.ceil(len / 2)).toString("hex").slice(0, len); }
function planOf(payload) { const id = String(payload || "").replace(/^prem:/, ""); return id in PLANS ? { id, ...PLANS[id] } : null; }
function premiumActive(until) { return Number(until) > nowSec(); }

const hist = new Map();
function spam(id) {
  const now = Date.now();
  if (hist.size > 5000) for (const [k, v] of hist) if (!v.length || now - v[v.length - 1] > 30_000) hist.delete(k);
  const h = (hist.get(id) ?? []).filter(t => now - t < 5000);
  h.push(now); hist.set(id, h);
  if (h.length > 8) return h.length === 9 ? "warn" : "drop";
  return "ok";
}

function menuKb() {
  return { keyboard: [[{ text: BTN.search }], [{ text: BTN.next }, { text: BTN.stop }], [{ text: BTN.form }], [{ text: BTN.photo }], [{ text: BTN.profile }, { text: BTN.premium }], [{ text: BTN.invite }, { text: BTN.report }], [{ text: BTN.rules }, { text: BTN.help }]], resize_keyboard: true, is_persistent: true };
}
function placeKb() { return { keyboard: [[{ text: "Моє місцезнаходження", request_location: true }], ...menuKb().keyboard], resize_keyboard: true, is_persistent: true }; }
function choiceKb(row) { return { keyboard: [row.map(text => ({ text })), ...menuKb().keyboard], resize_keyboard: true, is_persistent: true }; }
const kbAge = { inline_keyboard: [[{ text: "Мені є 18", callback_data: "age:yes" }, { text: "Мені немає 18", callback_data: "age:no" }]] };

export async function tg(method, body) {
  const res = await fetch(`https://api.telegram.org/bot\( {BOT_TOKEN}/ \){method}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body ?? {}), signal: AbortSignal.timeout(method === "getUpdates" ? 40_000 : 20_000) });
  const data = await res.json();
  if (!data.ok) { const err = new Error(data.description || method); err.code = data.error_code; err.retryAfter = data.parameters?.retry_after; throw err; }
  return data.result;
}
function isGone(err) { const msg = err instanceof Error ? err.message.toLowerCase() : ""; return err?.code === 403 || /blocked|deactivated|chat not found|user is deactivated/.test(msg); }
async function tgRetry(method, body) {
  for (let attempt = 0; attempt < 4; attempt++) {
    try { return await tg(method, body); }
    catch (err) { if (!err.retryAfter || attempt === 3) throw err; await new Promise(r => setTimeout(r, (err.retryAfter + 0.5) * 1000)); }
  }
}
async function send(chatId, text, reply_markup) { await tgRetry("sendMessage", { chat_id: chatId, text, reply_markup: reply_markup ?? menuKb() }); }

function ensure(id, from) {
  if (!one("select * from users where id = ?", id)) run("insert into users (id, invite_code, public_code, created_at, last_seen) values (?, ?, ?, ?, ?)", id, code(10), code(10), nowSec(), nowSec());
  if (from) run("update users set first_name = coalesce(?, first_name), username = ?, language_code = coalesce(?, language_code), last_seen = ? where id = ?", from.first_name ?? null, from.username ?? null, from.language_code ?? null, nowSec(), id);
  else run("update users set last_seen = ? where id = ?", nowSec(), id);
  return one("select * from users where id = ?", id);
}
function isAdmin(id) { if (ADMIN_ID && String(ADMIN_ID) === id) return true; return Boolean(one("select id from admin where id = ?", id)); }

async function showAge(chatId) { await send(chatId, "Невідомий — анонімний чат.\n\nСпіврозмовник не бачить твоє ім’я, юзернейм і номер.\n\nБот лише для людей від 18 років. Підтверди вік.", kbAge); }
async function showLobby(chatId, lead) { await send(chatId, lead ?? "Ти в лобі.", menuKb()); }

async function enqueue(id, mode) {
  const result = await withLock(() => {
    const me = ensure(id);
    if (me.banned || !me.adult) return { kind: "closed" };
    if (me.status === "chat") return { kind: "busy" };
    const row = one("select * from users where id = ?", id);
    const want = mode ?? (row?.search_mode === "dating" ? "dating" : "random");
    const premium = premiumActive(row?.premium_until);
    if (want === "dating") {
      if (!row?.gender || !row.profile_age || !row.city) return { kind: "needprofile" };
      if (!premium && Number(row.search_credits) < 1 && !(row.status === "search" && row.search_mode === "dating")) return { kind: "needpay" };
      if (!(row.status === "search" && row.search_mode === "dating")) {
        if (!premium) run("update users set status = 'search', partner_id = null, search_mode = 'dating', search_credits = search_credits - 1 where id = ?", id);
        else run("update users set status = 'search', partner_id = null, search_mode = 'dating' where id = ?", id);
      }
      const cand = one("select id from users where status = 'search' and search_mode = 'dating' and id != ? and adult = 1 limit 1", id);
      if (!cand) return { kind: "waiting", mode: "dating" };
      run("update users set status = 'chat', partner_id = ?, last_partner_id = ? where id = ?", cand.id, cand.id, id);
      run("update users set status = 'chat', partner_id = ?, last_partner_id = ? where id = ?", id, id, cand.id);
      return { kind: "matched", other: cand.id, mode: "dating" };
    }
    if (row?.status !== "search" || row.search_mode === "dating") run("update users set status = 'search', partner_id = null, search_mode = 'random' where id = ?", id);
    const cand = one("select id from users where status = 'search' and coalesce(search_mode,'random') = 'random' and id != ? and adult = 1 limit 1", id);
    if (!cand) return { kind: "waiting", mode: "random" };
    run("update users set status = 'chat', partner_id = ?, last_partner_id = ? where id = ?", cand.id, cand.id, id);
    run("update users set status = 'chat', partner_id = ?, last_partner_id = ? where id = ?", id, id, cand.id);
    return { kind: "matched", other: cand.id, mode: "random" };
  });
  if (result.kind === "needprofile") return startForm(id);
  if (result.kind === "needpay") { await send(id, "Пошук за анкетою лише з Premium."); return showPremium(id); }
  if (result.kind === "matched") {
    await send(id, "Співрозмовника знайдено. Пиши.");
    try { await send(result.other, "Співрозмовника знайдено. Пиши."); } catch {}
    return "matched";
  }
  if (result.kind === "waiting") return send(id, result.mode === "dating" ? "Шукаю за анкетою..." : "Шукаю випадково...");
  return result.kind;
}

async function disconnect(id, mode) {
  const outcome = await withLock(() => {
    const me = one("select * from users where id = ?", id);
    if (!me) return { kind: "none" };
    if (me.status === "search") { run("update users set status = 'lobby', partner_id = null where id = ?", id); return { kind: "cancelled" }; }
    if (me.status === "chat" && me.partner_id) {
      const partner = me.partner_id;
      run("update users set status = 'lobby', partner_id = null where id = ?", id);
      run("update users set status = 'lobby', partner_id = null where id = ? and partner_id = ?", partner, id);
      return { kind: "left", partner };
    }
    return { kind: "lobby" };
  });
  if (outcome.kind === "cancelled") return showLobby(id, "Пошук скасовано.");
  if (outcome.kind === "left") {
    await showLobby(id, mode === "gone" ? "Співрозмовник недоступний." : "Діалог завершено.");
    try { await showLobby(outcome.partner, "Співрозмовник завершив діалог."); } catch {}
    if (mode === "next") await enqueue(id);
  }
}

async function relay(message, id) {
  const me = one("select * from users where id = ?", id);
  if (!me || me.status !== "chat" || !me.partner_id) return send(id, "Зараз ти не в діалозі.");
  if (message.text) run("insert into messages (from_id, to_id, text, created_at) values (?, ?, ?, ?)", id, me.partner_id, message.text.slice(0, 1000), nowSec());
  try { await tgRetry("copyMessage", { chat_id: me.partner_id, from_chat_id: message.chat.id, message_id: message.message_id }); }
  catch (err) { if (isGone(err)) await disconnect(id, "gone"); else await send(id, "Не вдалося передати повідомлення."); }
}

async function showProfile(id) {
  const p = one("select * from users where id = ?", id);
  await send(id, `Профіль\nСтать: ${p?.gender || "—"}\nВік: ${p?.profile_age || "—"}\nМісто: ${p?.city || "—"}\nPremium: ${premiumActive(p?.premium_until) ? "так" : "ні"}\nПошуків: ${p?.search_credits || 0}`);
}

async function showPremium(id) {
  const p = one("select * from users where id = ?", id);
  await send(id, `Premium: ${premiumActive(p?.premium_until) ? "активний" : "немає"}\nПошуків: ${p?.search_credits || 0}\n\n1 пошук — 1⭐\n1 день — 20⭐\n1 тиждень — 100⭐\n1 місяць — 1000⭐`, {
    inline_keyboard: [[{ text: "1 пошук · 1⭐", callback_data: "buy:search" }], [{ text: "1 день · 20⭐", callback_data: "buy:day" }], [{ text: "1 тиждень · 100⭐", callback_data: "buy:week" }], [{ text: "1 місяць · 1000⭐", callback_data: "buy:month" }]]
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
  const seen = run("insert into updates (id) values (?) on conflict (id) do nothing", update.update_id);
  if (!seen.changes) return;
  const from = update.callback_query?.from ?? update.message?.from;
  if (!from) return;
  const id = String(from.id);
  const gate = spam(id);
  if (gate !== "ok") {
    if (gate === "warn") try { await send(update.message?.chat.id ?? from.id, "Не так швидко."); } catch {}
    if (update.callback_query) try { await tg("answerCallbackQuery", { callback_query_id: update.callback_query.id }); } catch {}
    return;
  }
  if (update.callback_query) {
    const data = update.callback_query.data ?? "";
    const queryId = update.callback_query.id;
    try {
      if (data === "age:yes") { run("update users set adult = 1, status = 'lobby' where id = ?", id); await tg("answerCallbackQuery", { callback_query_id: queryId, text: "Вік підтверджено" }); await send(id, "Вік підтверджено."); }
      else if (data.startsWith("buy:")) { await tg("answerCallbackQuery", { callback_query_id: queryId }); }
      else if (data === "find:random") { await tg("answerCallbackQuery", { callback_query_id: queryId }); await enqueue(id, "random"); }
      else if (data === "find:dating") { await tg("answerCallbackQuery", { callback_query_id: queryId }); await enqueue(id, "dating"); }
      else await tg("answerCallbackQuery", { callback_query_id: queryId });
    } catch {}
    return;
  }
  const message = update.message;
  if (!message || message.chat.type !== "private") return;
  const me = ensure(id, from);
  if (!me.adult) return showAge(id);
  const text = message.text || "";
  const action = ACTIONS[text];
  if (action === "search") return send(id, "Обери.", { inline_keyboard: [[{ text: "Випадково", callback_data: "find:random" }], [{ text: "За анкетою", callback_data: "find:dating" }]] });
  if (action === "next") return me.status === "chat" ? disconnect(id, "next") : enqueue(id);
  if (action === "stop") return disconnect(id, "stop");
  if (action === "profile") return showProfile(id);
  if (action === "form") return startForm(id);
  if (action === "premium") return showPremium(id);
  if (action === "invite") { const p = one("select invite_code from users where id = ?", id); return send(id, `https://t.me/\( {BOT_USERNAME}?start= \){p?.invite_code}\n\nЗа друга — 3 години Premium.`); }
  if (action === "rules") return send(id, "Правила: 18+, без образ, без контактів.");
  if (action === "help") return send(id, "Кнопки внизу.");
  const pending = one("select pending from users where id = ?", id)?.pending;
  if (pending && me.status !== "chat") return savePending(id, pending, text);
  if (me.status === "chat") return relay(message, id);
  if (me.status === "search") return send(id, "Пошук триває...");
  await showLobby(id);
}

export async function publishCommands() { await tg("setMyCommands", { commands: [{ command: "start", description: "Почати" }] }); }
export function checkpoint() { try { db.exec("pragma wal_checkpoint(TRUNCATE)"); } catch {} }

// ===== ADMIN DASHBOARD =====
const html = `<!DOCTYPE html><html lang="uk"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Адмін</title>
<style>body{font-family:system-ui;background:#111;color:#eee;padding:16px;margin:0}h1{font-size:18px}.stats{display:grid;grid-template-columns:1fr 1fr;gap:8px}.card{background:#1c1c1c;padding:12px;border-radius:8px}.card b{font-size:24px;display:block}.dialog{background:#1c1c1c;margin:8px 0;padding:10px;border-radius:8px}.msg{background:#252525;margin:4px 0;padding:6px;border-radius:4px;font-size:14px}input,button{padding:8px;font-size:16px;border-radius:6px;border:none}button{background:#7c5cff;color:#fff}</style></head>
<body><h1>Невідомий — Моніторинг</h1><div id="login"><input id="pass" type="password" placeholder="Пароль"><button onclick="login()">Увійти</button></div><div id="app" style="display:none"><div class="stats" id="stats"></div><div id="dialogs"></div></div>
<script>let t=localStorage.getItem("a")||"";async function login(){t=document.getElementById("pass").value;localStorage.setItem("a",t);load()}async function load(){const r=await fetch("/api/stats?p="+encodeURIComponent(t));if(!r.ok){document.getElementById("login").style.display="block";return}document.getElementById("login").style.display="none";document.getElementById("app").style.display="block";const d=await r.json();document.getElementById("stats").innerHTML=\`<div class="card"><b>\${d.online}</b>Онлайн</