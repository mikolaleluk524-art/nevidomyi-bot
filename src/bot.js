import { DatabaseSync, backup } from "node:sqlite";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomBytes } from "node:crypto";
import { mkdirSync, readdirSync, statSync, unlinkSync, copyFileSync, existsSync } from "node:fs";
import { readFile, writeFile, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { L, LANGS, LANG_NAMES, guessLang, localizeMarkup, toUk } from "./i18n.js";
import { chatReply } from "../llm.js";

// Секрети — лише зі змінних середовища, не в коді.
// trim(): пробіл чи перенос рядка, скопійований разом із токеном, Telegram API
// пропускає (URL їх відкидає), але підпис Mini App тоді не сходиться.
export const BOT_TOKEN = (process.env.BOT_TOKEN || "").trim();
if (process.env.BOT_TOKEN && process.env.BOT_TOKEN !== BOT_TOKEN) {
  console.warn("[bot] BOT_TOKEN містив пробіли або перенос рядка — їх прибрано");
}
if (!BOT_TOKEN) throw new Error("Не задано змінну середовища BOT_TOKEN");
export const BOT_USERNAME = process.env.BOT_USERNAME || "nevidomyi_chat_bot";
// Адреса гри: домен цього ж сервісу. Railway сам задає RAILWAY_PUBLIC_DOMAIN,
// тож кнопка не поведе на чужий сервер навіть після зміни домену.
const PUBLIC_DOMAIN = (process.env.RAILWAY_PUBLIC_DOMAIN || "nevidomyi-bot-production-16dfedfb.up.railway.app").trim();
export const GAME_URL = `https://${PUBLIC_DOMAIN}/bottle.html`;
export const CLAIM_CODE = process.env.CLAIM_CODE || ""; // порожній = /claim вимкнено
export const ADMIN_ID = Number(process.env.ADMIN_ID || 0);
const FRIEND_PREMIUM = 3 * 60 * 60;
// Супер-реферал: за кожного друга 3 години Premium + 🌹, а на рубежах — більше.
// Друг рахується, коли пройшов перевірку віку. Друг отримує вітальні 🌹🌹.
const REF_TIERS = [
  { n: 3, aims: 3, text: "🎯×3" },
  { n: 5, days: 7, text: "7 днів Premium" },
  { n: 10, days: 30, text: "30 днів Premium" },
];
const WELCOME_ROSES = 2;
const TZ = "Europe/Kiev"; // працює в усіх версіях ICU
export const DB_PATH = join(process.env.DATA_DIR || dirname(fileURLToPath(import.meta.url)), "nevidomyi.sqlite");

const BTN = {
  game: "🍾 Гра в бутилочку",
  search: "🔍 Знайти співрозмовника",
  next: "⏭ Наступний",
  stop: "⛔ Завершити діалог",
  cancel: "✖️ Скасувати пошук",
  gift: "🎁 Подарунок",
  reveal: "👀 Хто це? · 5⭐",
  settings: "⚙️ Налаштування",
  profile: "👤 Мій профіль",
  form: "📝 Заповнити анкету",
  photo: "📷 Завантажити фото",
  premium: "💎 Premium",
  invite: "🎁 Запросити друзів",
  confess: "💌 Анонімні зізнання",
  wall: "🧱 Стіна зізнань",
  qotd: "🌙 Питання дня",
  top: "🏆 Рейтинг",
  report: "⚠️ Поскаржитись",
  rules: "📜 Правила",
  help: "❓ Допомога",
  lang: "🌐 Мова",
};

const ACTIONS = {
  [BTN.game]: "game",
  [BTN.search]: "search",
  [BTN.next]: "next",
  [BTN.stop]: "stop",
  [BTN.cancel]: "stop",
  [BTN.reveal]: "reveal",
  [BTN.settings]: "settings",
  [BTN.profile]: "profile",
  [BTN.form]: "form",
  [BTN.photo]: "photo",
  [BTN.premium]: "premium",
  [BTN.invite]: "invite",
  [BTN.confess]: "confess",
  [BTN.wall]: "wall",
  [BTN.qotd]: "question",
  [BTN.top]: "top",
  [BTN.report]: "report",
  [BTN.rules]: "rules",
  [BTN.help]: "help",
  [BTN.lang]: "language",
  "Шукати співрозмовника": "search",
  "Скасувати пошук": "stop",
  Наступний: "next",
  Зупинити: "stop",
};

// Ті самі кнопки іншими мовами.
for (const [key, label] of Object.entries(BTN)) {
  // «🎁 Подарунок» обробляє gifts.js, тут його пропускаємо.
  if (key === "gift") continue;
  const action = { lang: "language", cancel: "stop" }[key] ?? key;
  for (const lang of LANGS) ACTIONS[L(lang, label)] = action;
}
// Платні дрібниці (зірки).
const REVEAL_STARS = 5;
const BACK_STARS = 5;
// Відповіді кнопками під час анкети: переклад → український оригінал, який зберігаємо в базі.
const CHOICE_WORDS = ["Чоловік", "Жінка", "Інше", "Спілкування", "Дружба", "Стосунки", "Флірт", "Без фото"];

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
    id text primary key,
    adult integer not null default 0,
    banned integer not null default 0,
    premium_until integer not null default 0,
    status text not null default 'new',
    partner_id text,
    last_partner_id text,
    first_name text,
    username text,
    language_code text,
    gender text,
    profile_age integer,
    interests text,
    invite_code text unique,
    invited_by text,
    pending text,
    last_seen integer,
    search_credits integer not null default 0,
    priority integer not null default 0,
    invite_rewarded integer not null default 0,
    city text,
    look_gender text,
    age_min integer,
    age_max integer,
    look_city text,
    search_mode text,
    goal text,
    display_name text,
    aim text,
    public_code text unique,
    created_at integer not null
  );
  create table if not exists photos (
    id text primary key,
    user_id text not null,
    bytes blob not null,
    created_at integer not null
  );
  create table if not exists payments (
    charge_id text primary key,
    user_id text not null,
    payload text not null,
    stars integer not null
  );
  create table if not exists reports (
    id integer primary key autoincrement,
    reporter_id text not null,
    target_id text not null,
    created_at integer not null
  );
  create table if not exists optout (id text primary key);
  create table if not exists admin (id text primary key);
  create table if not exists updates (id integer primary key);
  create table if not exists requests (
    id text primary key,
    from_id text not null,
    to_id text not null
  );
`;

function backupDir() { return join(dirname(DB_PATH), "backups"); }
function dropSidecars() {
  for (const suffix of ["-wal", "-shm"]) {
    try { unlinkSync(DB_PATH + suffix); } catch {}
  }
}
// Основну базу відкриваємо у звичайному режимі (щоб SQLite коректно прочитав WAL),
// копії — лише для читання.
function isHealthy(path, readOnly = true) {
  if (!existsSync(path)) return false;
  let probe;
  try {
    probe = new DatabaseSync(path, { readOnly });
    const row = probe.prepare("pragma integrity_check").get();
    return row?.integrity_check === "ok";
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
function openDatabase() {
  const next = new DatabaseSync(DB_PATH);
  next.exec(SCHEMA);
  // Міграція: обрана мова (uk, ru, en). Порожня — беремо з налаштувань Telegram.
  if (!next.prepare("pragma table_info(users)").all().some((c) => c.name === "lang")) next.exec("alter table users add column lang text");
  // Міграція: з якої рекламної кампанії прийшла людина (посилання ?start=ad_<мітка>).
  if (!next.prepare("pragma table_info(users)").all().some((c) => c.name === "source")) next.exec("alter table users add column source text");
  // Міграція: коли людина вперше зайшла в гру (для воронки в моніторі).
  if (!next.prepare("pragma table_info(users)").all().some((c) => c.name === "game_at")) next.exec("alter table users add column game_at integer");
  // Міграція: «сісти за стіл до друга» — чий стіл і коли запросили (посилання ?start=t_<код>).
  if (!next.prepare("pragma table_info(users)").all().some((c) => c.name === "join_with")) next.exec("alter table users add column join_with text; alter table users add column join_at integer");
  // 💌 Анонімні зізнання: кому людина зараз пише (посилання ?start=c_<код>) і самі повідомлення.
  if (!next.prepare("pragma table_info(users)").all().some((c) => c.name === "confess_to")) next.exec("alter table users add column confess_to text; alter table users add column confess_at integer");
  next.exec("create table if not exists confessions (id text primary key, to_id text not null, from_id text not null, text text not null, created_at integer not null, hint integer not null default 0, reported integer not null default 0, reply_to text)");
  next.exec("create index if not exists confessions_to on confessions (to_id, created_at)");
  next.exec("create index if not exists confessions_from on confessions (from_id, created_at)");
  // ❤️ Симпатії після розмови: токен кнопки → пара, і самі вподобання.
  next.exec("create table if not exists rate_tokens (id text primary key, from_id text not null, to_id text not null, created_at integer not null)");
  next.exec("create table if not exists likes (from_id text not null, to_id text not null, created_at integer not null, primary key (from_id, to_id))");
  // 🎉 Вечірка о 21:00: в який день уже кликали, і хто не хоче запрошень.
  next.exec("create table if not exists party_log (day text primary key, sent integer not null default 0)");
  next.exec("create table if not exists party_off (id text primary key)");
  // 💘 Коли востаннє казали людині «тебе вподобали» (не частіше разу на 6 годин).
  next.exec("create table if not exists like_notify (user_id text primary key, at integer not null)");
  // 👭 «Приведи подругу»: бонус за подругу видається один раз — коли вона сама когось приведе.
  next.exec("create table if not exists friend_bonus (user_id text not null, friend_id text not null, created_at integer not null, primary key (user_id, friend_id))");
  // 🤖 ШІ-співрозмовник, поки людина чекає в пошуку (лічильник повідомлень на добу).
  if (!next.prepare("pragma table_info(users)").all().some((c) => c.name === "ai_chat")) next.exec("alter table users add column ai_chat integer not null default 0");
  next.exec("create table if not exists ai_usage (user_id text not null, day text not null, n integer not null default 0, primary key (user_id, day))");
  // 👋 «Поки тебе не було»: позначка, що людина повернулась після 3+ днів відсутності.
  if (!next.prepare("pragma table_info(users)").all().some((c) => c.name === "welcome_back")) next.exec("alter table users add column welcome_back integer not null default 0");
  // 🧱 Стіна зізнань і 🌙 відповіді на питання дня — одна таблиця постів із реакціями.
  next.exec("create table if not exists posts (id text primary key, author_id text not null, kind text not null, day text, text text not null, created_at integer not null, reports integer not null default 0, hidden integer not null default 0, notified integer not null default 0)");
  next.exec("create index if not exists posts_kind on posts (kind, day, created_at)");
  next.exec("create table if not exists post_reactions (post_id text not null, user_id text not null, emoji text not null, primary key (post_id, user_id))");
  next.exec("create table if not exists post_reports (post_id text not null, user_id text not null, primary key (post_id, user_id))");
  // 🏆 Сезони: очки за активність і переможці.
  next.exec("create table if not exists season_points (season integer not null, user_id text not null, points integer not null default 0, primary key (season, user_id))");
  next.exec("create table if not exists season_winners (season integer not null, user_id text not null, place integer not null, primary key (season, place))");
  return next;
}
function installCopy(src) {
  dropSidecars();
  copyFileSync(src, DB_PATH);
  dropSidecars();
}

export let restoredFrom = null;
if (!existsSync(DB_PATH) || !isHealthy(DB_PATH, false)) {
  const src = newestGoodBackup();
  if (src) {
    installCopy(src);
    restoredFrom = src;
    console.info(`[bot] базу відновлено з ${src}`);
  }
}

let db = openDatabase();
const q = (sql, ...p) => db.prepare(sql).all(...p);
const one = (sql, ...p) => db.prepare(sql).get(...p);
const run = (sql, ...p) => db.prepare(sql).run(...p);

let lock = Promise.resolve();
function withLock(fn) {
  const job = lock.then(() => fn());
  lock = job.then(() => {}, () => {});
  return job;
}

function nowSec() { return Math.floor(Date.now() / 1000); }
// Криптостійкі випадкові коди (символи 0-9a-f).
function code(len = 10) { return randomBytes(Math.ceil(len / 2)).toString("hex").slice(0, len); }
function planOf(payload) {
  const id = String(payload || "").replace(/^prem:/, "");
  return id in PLANS ? { id, ...PLANS[id] } : null;
}
function premiumActive(until) { return Number(until) > nowSec(); }

const hist = new Map();
function spam(id) {
  const now = Date.now();
  if (hist.size > 5000) {
    for (const [k, v] of hist) if (!v.length || now - v[v.length - 1] > 30_000) hist.delete(k);
  }
  const h = (hist.get(id) ?? []).filter(t => now - t < 5000);
  h.push(now);
  hist.set(id, h);
  if (h.length > 8) return h.length === 9 ? "warn" : "drop";
  return "ok";
}

// Меню залежить від того, де людина: у лобі, у пошуку чи в діалозі.
const kb = (rows) => ({ keyboard: rows.map((r) => r.map((text) => ({ text }))), resize_keyboard: true, is_persistent: true });
// «Гра» — звичайна кнопка, а не web_app: Mini App з кнопки клавіатури не отримує initData.
// Бот відповідає інлайн-кнопкою, яка працює.
const lobbyKb = () => kb([[BTN.game], [BTN.search], [BTN.confess, BTN.wall], [BTN.qotd, BTN.top], [BTN.profile, BTN.premium], [BTN.invite, BTN.settings]]);
const chatKb = () => kb([[BTN.next, BTN.stop], [BTN.gift, BTN.reveal], [BTN.report]]);
const searchKb = () => kb([[BTN.cancel], [BTN.game]]);
function menuFor(id) {
  const status = one("select status from users where id = ?", String(id))?.status;
  return status === "chat" ? chatKb() : status === "search" ? searchKb() : lobbyKb();
}
const menuKb = lobbyKb;
function placeKb() {
  return { keyboard: [[{ text: "Моє місцезнаходження", request_location: true }], ...menuKb().keyboard], resize_keyboard: true, is_persistent: true };
}
function choiceKb(row) {
  return { keyboard: [row.map(text => ({ text })), ...menuKb().keyboard], resize_keyboard: true, is_persistent: true };
}
const kbGender = { inline_keyboard: [[{ text: "👨 Хлопець", callback_data: "gender:Чоловік" }, { text: "👩 Дівчина", callback_data: "gender:Жінка" }], [{ text: "Інше", callback_data: "gender:Інше" }, { text: "🌐 Мова / Язык / Language", callback_data: "menu:lang" }]] };
// Вік — одним дотиком: 18…39, «40+» (тоді написати числом) або «менше 18».
const kbAgeGrid = (() => {
  const rows = [];
  for (let a = 18; a <= 39; a += 6) rows.push(Array.from({ length: Math.min(6, 40 - a) }, (_, i) => ({ text: String(a + i), callback_data: `agen:${a + i}` })));
  rows.push([{ text: "40+", callback_data: "agen:40plus" }, { text: "Мені менше 18", callback_data: "agen:minor" }]);
  return { inline_keyboard: rows };
})();

export async function tg(method, body) {
  const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body ?? {}),
    signal: AbortSignal.timeout(method === "getUpdates" ? 40_000 : 20_000),
  });
  const data = await res.json();
  if (!data.ok) {
    const err = new Error(data.description || method);
    err.code = data.error_code;
    err.retryAfter = data.parameters?.retry_after;
    throw err;
  }
  return data.result;
}
function isGone(err) {
  const msg = err instanceof Error ? err.message.toLowerCase() : "";
  return err?.code === 403 || /blocked|deactivated|chat not found|user is deactivated/.test(msg);
}
async function tgRetry(method, body) {
  for (let attempt = 0; attempt < 4; attempt++) {
    try { return await tg(method, body); }
    catch (err) {
      if (!err.retryAfter || attempt === 3) throw err;
      await new Promise(r => setTimeout(r, (err.retryAfter + 0.5) * 1000));
    }
  }
}
// Мова користувача: обрана, інакше з налаштувань Telegram.
export function langOf(id) {
  const row = one("select lang, language_code from users where id = ?", String(id));
  return LANGS.includes(row?.lang) ? row.lang : guessLang(row?.language_code);
}
export const tr = (id, text) => L(langOf(id), text);

async function send(chatId, text, reply_markup) {
  const lang = langOf(chatId);
  await tgRetry("sendMessage", { chat_id: chatId, text: L(lang, text), reply_markup: localizeMarkup(lang, reply_markup ?? menuFor(chatId)) });
}
async function downloadFile(fileId) {
  const file = await tg("getFile", { file_id: fileId });
  if (!file.file_path || (file.file_size ?? 0) > 8_000_000) throw new Error("photo too large");
  const res = await fetch(`https://api.telegram.org/file/bot${BOT_TOKEN}/${file.file_path}`, { signal: AbortSignal.timeout(20_000) });
  if (!res.ok) throw new Error("photo download");
  return new Uint8Array(await res.arrayBuffer());
}
async function sendPhoto(chatId, bytes, caption) {
  const form = new FormData();
  form.set("chat_id", String(chatId));
  form.set("caption", tr(chatId, caption).slice(0, 1000));
  form.set("photo", new Blob([bytes], { type: "image/jpeg" }), "photo.jpg");
  const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendPhoto`, { method: "POST", body: form, signal: AbortSignal.timeout(20_000) });
  const data = await res.json();
  if (!data.ok) {
    const err = new Error(data.description || "sendPhoto");
    err.code = data.error_code;
    throw err;
  }
}

const exec = promisify(execFile);
async function shrink(raw) {
  const stamp = `${Date.now()}-${code(6)}`;
  const input = `/tmp/nv-in-${stamp}`;
  const output = `/tmp/nv-out-${stamp}.jpg`;
  await writeFile(input, raw);
  try {
    await exec("ffmpeg", ["-y", "-i", input, "-frames:v", "1", "-vf", "scale=720:720:force_original_aspect_ratio=decrease", "-q:v", "7", output]);
    const bytes = await readFile(output);
    if (bytes.length > 280_000) throw new Error("big");
    return bytes;
  } catch {
    if (raw.length <= 280_000) return raw;
    throw new Error("big");
  } finally {
    await unlink(input).catch(() => {});
    await unlink(output).catch(() => {});
  }
}

async function cityFromCoords(lat, lon) {
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
  try {
    const url = new URL("https://nominatim.openstreetmap.org/reverse");
    url.searchParams.set("lat", String(lat));
    url.searchParams.set("lon", String(lon));
    url.searchParams.set("format", "jsonv2");
    url.searchParams.set("accept-language", "uk");
    const res = await fetch(url, { headers: { "user-agent": "NevidomyiBot/1.0" }, signal: AbortSignal.timeout(10_000) });
    if (!res.ok) return null;
    const data = await res.json();
    const address = data.address ?? {};
    const city = address.city || address.town || address.village || address.municipality || address.hamlet || address.county;
    return city ? String(city).slice(0, 40) : null;
  } catch { return null; }
}

function ensure(id, from) {
  const existing = one("select * from users where id = ?", id);
  if (!existing) {
    // Коди випадкові: у посиланні більше не зашифровано Telegram ID.
    run("insert into users (id, invite_code, public_code, created_at, last_seen) values (?, ?, ?, ?, ?)", id, code(10), code(10), nowSec(), nowSec());
  }
  // Повернувся після 3+ днів — наступний екран лобі покаже, що нового.
  if (existing?.adult && Number(existing.last_seen) && Number(existing.last_seen) < nowSec() - 3 * 86400) run("update users set welcome_back = 1 where id = ?", id);
  if (from) {
    run("update users set first_name = coalesce(?, first_name), username = ?, language_code = coalesce(?, language_code), last_seen = ? where id = ?", from.first_name ?? null, from.username ?? null, from.language_code ?? null, nowSec(), id);
  } else {
    run("update users set last_seen = ? where id = ?", nowSec(), id);
  }
  return one("select * from users where id = ?", id);
}
function isAdmin(id) {
  if (ADMIN_ID && String(ADMIN_ID) === id) return true;
  return Boolean(one("select id from admin where id = ?", id));
}

// Знайомство з ботом (після вибору мови): стать → вік числом. Бот лише для 18+.
async function showAge(chatId) {
  const id = String(chatId);
  const me = one("select gender, profile_age from users where id = ?", id);
  if (me?.profile_age && me.profile_age < 18) return send(chatId, "Вибач, бот лише для людей від 18 років. Повертайся, коли виповниться 18.", { remove_keyboard: true });
  if (!me?.gender) {
    run("update users set pending = 'onb_gender' where id = ?", id);
    return send(chatId, "Невідомий — анонімний чат.\n\nСпіврозмовник не бачить твоє ім’я, юзернейм і номер. Не надсилай контакти, адресу чи фото документів.\n\nХто ти?", kbGender);
  }
  run("update users set pending = 'onb_age' where id = ?", id);
  await send(chatId, "Скільки тобі років? Натисни своє число.", kbAgeGrid);
}
async function onboardAge(id, text) {
  const n = Number(String(text).trim());
  if (!Number.isInteger(n) || n < 5 || n > 99) return send(id, "Напиши вік числом, наприклад 21.", { remove_keyboard: true });
  if (n < 18) {
    run("update users set pending = null, adult = 0, profile_age = ? where id = ?", n, id);
    return send(id, "Вибач, бот лише для людей від 18 років. Повертайся, коли виповниться 18.", { remove_keyboard: true });
  }
  run("update users set adult = 1, profile_age = ?, pending = null, status = case when status = 'new' then 'lobby' else status end where id = ?", n, id);
  await rewardInvite(id);
  await showLobby(id, "Готово! 🎉\n\n🍾 Гра в бутилочку — спільна гра із завданнями й подарунками.\n🔍 Знайти співрозмовника — анонімний чат один на один.\n💌 Анонімні зізнання — твоє посилання, за яким тобі пишуть анонімно.");
  // Прийшов за посиланням зізнань — одразу даємо написати.
  const confessTo = one("select confess_to from users where id = ? and confess_at > ?", id, nowSec() - 3600)?.confess_to;
  if (confessTo) return askConfess(id, confessTo);
  // Одразу в гру — там уже хтось є (або боти), щоб людина не губилась у меню.
  const friend = one("select join_with from users where id = ? and join_at > ?", id, nowSec() - 3600)?.join_with;
  await send(id, friend ? "🍾 Друг уже чекає тебе за столом:" : "🍾 Почни з гри — стіл уже чекає:", { inline_keyboard: [[{ text: friend ? "🍾 Сісти за стіл" : "🍾 Грати зараз", web_app: { url: GAME_URL } }]] });
  // Одразу показуємо вірусну функцію: своє посилання для зізнань і сторіз одним натиском.
  await send(id, "💌 І ще: хочеш дізнатися, що про тебе думають насправді?\nВиклади своє анонімне посилання в сторіз — друзі напишуть тобі зізнання, а ти не дізнаєшся, хто це 👀", { inline_keyboard: [[storyKb], [{ text: "💌 Моє посилання", callback_data: "conf:mine" }]] });
}
// Живі цифри для першого екрана: людина бачить, що тут уже щось відбувається.
let liveSource = () => ({ players: 0 });
export function setLiveSource(fn) { liveSource = fn; }
function liveLine() {
  const online = one("select count(*) as n from users where adult = 1 and last_seen > ?", nowSec() - 15 * 60)?.n ?? 0;
  const dayStart = nowSec() - 24 * 3600;
  const confessions = one("select count(*) as n from confessions where created_at > ?", dayStart)?.n ?? 0;
  let players = 0;
  try { players = Number(liveSource().players) || 0; } catch {}
  return `🔥 Зараз у клубі: ${Math.max(online, 1)} · за столами: ${players} · 💌 зізнань за добу: ${confessions}`;
}
// Що нового, поки людини не було: пости на стіні, отримані зізнання, питання дня, вечірка.
function welcomeBack(id) {
  const week = nowSec() - 7 * 86400;
  const wall = one("select count(*) as n from posts where kind = 'wall' and hidden = 0 and created_at > ?", week)?.n ?? 0;
  const mine = one("select count(*) as n from confessions where to_id = ? and created_at > ?", id, week)?.n ?? 0;
  const lines = ["👋 З поверненням! Поки тебе не було:"];
  if (mine) lines.push(`💌 тобі написали анонімно: ${mine} — /confess`);
  if (wall) lines.push(`🧱 нових постів на стіні: ${wall} — /wall`);
  lines.push(`🌙 нове питання дня — /question`);
  lines.push(`🎉 вечірка сьогодні о 21:00`);
  return lines.join("\n");
}
async function showLobby(chatId, lead) {
  let text = lead;
  if (!text) {
    text = liveLine();
    const n = likesCount(String(chatId));
    if (n) text += `\n💘 Тебе вподобали: ${n} — /likes`;
    if (run("update users set welcome_back = 0 where id = ? and welcome_back = 1", String(chatId)).changes) text = welcomeBack(String(chatId)) + "\n\n" + text;
  }
  await send(chatId, text, menuFor(chatId));
}

async function sendMatch(to, body, bytes, premium) {
  if (bytes?.length && premium) {
    await sendPhoto(to, bytes, body);
    await send(to, "Пиши. «Наступний» шукає іншу анкету.", menuFor(to));
    return;
  }
  const locked = bytes?.length ? "\nФото є. Його видно лише з Premium." : "";
  await send(to, `${body}${locked}\n\nПиши. «Наступний» шукає іншу анкету.`, menuFor(to));
}
function photoOf(userId) {
  return one("select bytes from photos where user_id = ? order by created_at desc limit 1", userId)?.bytes ?? null;
}

// Хто шукає довше за 30 хв без жодної дії — вже пішов: з ним не з'єднуємо (інакше новачок пише в порожнечу).
const SEARCH_FRESH = 30 * 60;
const CHAT_STALE = 6 * 3600;
// Прибирання «завислих»: пошук без дій 30 хв → лобі; діалог, де обоє мовчать 6 год → завершено.
export function staleTick() {
  const now = nowSec();
  const searches = run("update users set status = 'lobby', partner_id = null, ai_chat = 0 where status = 'search' and coalesce(last_seen, 0) < ?", now - SEARCH_FRESH).changes;
  const pairs = q("select a.id as a, a.partner_id as b from users a join users b on b.id = a.partner_id where a.status = 'chat' and b.status = 'chat' and b.partner_id = a.id and a.id < b.id and coalesce(a.last_seen, 0) < ? and coalesce(b.last_seen, 0) < ?", now - CHAT_STALE, now - CHAT_STALE);
  for (const p of pairs) run("update users set status = 'lobby', partner_id = null where id in (?, ?)", p.a, p.b);
  // Діалог з людиною, якої вже немає в діалозі (зламана пара), теж закриваємо.
  const broken = run("update users set status = 'lobby', partner_id = null where status = 'chat' and (partner_id is null or partner_id not in (select id from users where status = 'chat'))").changes;
  if (searches || pairs.length || broken) console.info(`[bot] прибрано: пошук ${searches}, мовчазні діалоги ${pairs.length}, зламані ${broken}`);
}

async function enqueue(id, mode) {
  const result = await withLock(() => {
    const me = ensure(id);
    if (me.banned || !me.adult) return { kind: "closed" };
    if (me.status === "chat") return { kind: "busy" };
    const row = one("select * from users where id = ?", id);
    const want = mode ?? (row?.search_mode === "dating" ? "dating" : row?.search_mode === "speed" ? "speed" : "random");
    const premium = premiumActive(row?.premium_until);
    if (want === "dating") {
      if (!row?.gender || !row.profile_age || !row.city || !row.look_gender || !row.age_min || !row.look_city) return { kind: "needprofile" };
      if (!premium && Number(row.search_credits) < 1 && !(row.status === "search" && row.search_mode === "dating")) return { kind: "needpay" };
      const already = row.status === "search" && row.search_mode === "dating";
      if (!already) {
        if (!premium) run("update users set status = 'search', partner_id = null, priority = 0, search_mode = 'dating', search_credits = search_credits - 1 where id = ?", id);
        else run("update users set status = 'search', partner_id = null, priority = 0, search_mode = 'dating' where id = ?", id);
      }
      const look = row.look_gender ?? "Будь-хто";
      const min = row.age_min ?? 18;
      const max = row.age_max ?? 99;
      const place = row.look_city ?? "";
      const cand = one(`select id from users where status = 'search' and id <> ? and adult = 1 and banned = 0 and last_seen > ${nowSec() - SEARCH_FRESH} and gender is not null and profile_age is not null and city is not null and (? = 'Будь-хто' or gender = ?) and profile_age >= ? and profile_age <= ? and lower(city) = lower(?) and search_mode = 'dating' and ((look_gender is null or look_gender = 'Будь-хто' or look_gender = ?) and ? >= coalesce(age_min, 18) and ? <= coalesce(age_max, 99) and lower(?) = lower(coalesce(look_city, city))) order by case when id = ? then 1 else 0 end, random() limit 1`, id, look, look, min, max, place, row.gender ?? "", row.profile_age ?? 0, row.profile_age ?? 0, row.city ?? "", me.last_partner_id);
      if (!cand) return { kind: "waiting", mode: "dating" };
      run("update users set status = 'chat', partner_id = ?, last_partner_id = ?, priority = 0, pending = null where id = ?", id, id, cand.id);
      run("update users set status = 'chat', partner_id = ?, last_partner_id = ?, priority = 0, pending = null where id = ?", cand.id, cand.id, id);
      return { kind: "matched", other: cand.id, mode: "dating" };
    }
    // Випадковий чат і ⚡ швидкі побачення — окремі черги з однаковою логікою.
    const queue = want === "speed" ? "speed" : "random";
    if (row?.status !== "search" || (row.search_mode ?? "random") !== queue) run("update users set status = 'search', partner_id = null, priority = 0, search_mode = ? where id = ?", queue, id);
    const cand = one(`select id from users where status = 'search' and id <> ? and adult = 1 and banned = 0 and last_seen > ${nowSec() - SEARCH_FRESH} and coalesce(search_mode, 'random') = ? order by case when id = ? then 1 else 0 end, random() limit 1`, id, queue, me.last_partner_id);
    if (!cand) return { kind: "waiting", mode: queue };
    run("update users set status = 'chat', partner_id = ?, last_partner_id = ?, priority = 0, pending = null where id = ?", id, id, cand.id);
    run("update users set status = 'chat', partner_id = ?, last_partner_id = ?, priority = 0, pending = null where id = ?", cand.id, cand.id, id);
    return { kind: "matched", other: cand.id, mode: queue };
  });
  if (result.kind === "needprofile") { await continueDating(id); return "needprofile"; }
  if (result.kind === "needpay") { await send(id, "Пошук за віком, статтю і містом лише з Premium. Випадковий — безкоштовний."); await showPremium(id); return "needpay"; }
  if (result.kind === "matched") {
    for (const who of [id, result.other]) {
      if (run("update users set ai_chat = 0 where id = ? and ai_chat = 1", who).changes) {
        aiHistory.delete(who);
        try { await send(who, "👤 Знайшлась жива людина! Розмову з 🤖 ШІ завершено."); } catch {}
      }
    }
    if (result.mode === "dating") {
      const mine = one("select * from users where id = ?", id);
      const theirs = one("select * from users where id = ?", result.other);
      const intro = "Знайомство за анкетою. Ім’я, юзернейм і номер не передаю.\n\n";
      const line = c => `Стать: ${c?.gender ?? "—"}\nВік: ${c?.profile_age ?? "—"}\nМісто: ${c?.city ?? "—"}\nЦіль: ${c?.aim ?? "—"}`;
      await sendMatch(id, `${intro}${line(theirs)}`, photoOf(result.other), premiumActive(mine?.premium_until));
      try { await sendMatch(result.other, `${intro}${line(mine)}`, photoOf(id), premiumActive(theirs?.premium_until)); }
      catch (err) { if (isGone(err)) await disconnect(id, "gone"); }
    } else {
      const text = result.mode === "speed"
        ? "⚡ Швидке побачення! У вас 3 хвилини.\n\nПотім кожен вирішить: ❤️ чи 👋. Взаємна симпатія відкриє чат без обмежень."
        : "Співрозмовника знайдено. Пиши — я передам повідомлення без твого імені.\n\n«Наступний» шукає когось іншого. «Завершити діалог» зупиняє розмову.";
      await send(id, text);
      try { await send(result.other, text); }
      catch (err) { if (isGone(err)) { await disconnect(id, "gone"); return "matched"; } }
      await sendIcebreakers(id);
      try { await sendIcebreakers(result.other); } catch {}
      if (result.mode === "speed") startSpeedTimer(id, result.other);
    }
    return "matched";
  }
  if (result.kind === "waiting") {
    await send(id, result.mode === "dating" ? "Шукаю анкету за віком, статтю і містом. Якщо зараз нікого немає — зачекай." : result.mode === "speed" ? "⚡ Шукаю пару для швидкого побачення. Щойно хтось з’явиться — почнемо!" : "Шукаю випадкову людину. Це безкоштовно. Якщо черга порожня — зачекай.");
    if (process.env.GEMINI_API_KEY && !one("select ai_chat from users where id = ?", id)?.ai_chat) {
      await send(id, "🤖 Поки чекаєш — хочеш поговорити з ШІ-співрозмовником? Щойно з’явиться жива людина, я одразу тебе з’єднаю.", { inline_keyboard: [[{ text: "🤖 Поговорити з ШІ", callback_data: "ai:on" }]] });
    }
    return "waiting";
  }
  return result.kind;
}

async function disconnect(id, mode) {
  const outcome = await withLock(() => {
    const me = one("select * from users where id = ?", id);
    if (!me) return { kind: "none" };
    if (me.status === "search") {
      // Якщо скасовано платний пошук за анкетою — повертаємо витрачений пошук.
      const refund = me.search_mode === "dating" && !premiumActive(me.premium_until);
      run(`update users set status = 'lobby', partner_id = null, priority = 0${refund ? ", search_credits = search_credits + 1" : ""} where id = ?`, id);
      return { kind: "cancelled" };
    }
    if (me.status === "chat" && me.partner_id) {
      const partner = me.partner_id;
      run("update users set status = 'lobby', partner_id = null, priority = 0 where id = ?", id);
      run("update users set status = 'lobby', partner_id = null, priority = 0 where id = ? and partner_id = ?", partner, id);
      return { kind: "left", partner };
    }
    return { kind: "lobby" };
  });
  if (run("update users set ai_chat = 0 where id = ? and ai_chat = 1", id).changes) aiHistory.delete(id);
  if (outcome.kind === "cancelled") { await showLobby(id, "Пошук скасовано."); return; }
  if (outcome.kind === "left") {
    if (mode === "timeup") {
      for (const who of [id, outcome.partner]) {
        try { await showLobby(who, "⏰ 3 хвилини минули!"); await offerBack(who); }
        catch (err) { if (!isGone(err)) console.error("[bot] timeup", err.message); }
      }
      return;
    }
    if (mode === "gone") await showLobby(id, "Співрозмовник недоступний.");
    else if (mode === "next") {
      try { await showLobby(outcome.partner, "Співрозмовник пішов шукати когось іншого."); await offerBack(outcome.partner); }
      catch (err) { if (!isGone(err)) console.error("[bot] notify", err.message); }
      await enqueue(id);
    } else {
      await showLobby(id, "Діалог завершено.");
      // Після скарги повернути співрозмовника не пропонуємо нікому.
      if (mode !== "report") await offerBack(id);
      try { await showLobby(outcome.partner, "Співрозмовник завершив діалог."); if (mode !== "report") await offerBack(outcome.partner); }
      catch (err) { if (!isGone(err)) console.error("[bot] notify", err.message); }
    }
    return;
  }
  if (mode === "stop" || mode === "cancel") await showLobby(id, "Ти і так у лобі.");
}

async function relay(message, id) {
  const me = one("select * from users where id = ?", id);
  if (!me || me.status !== "chat" || !me.partner_id) { await send(id, "Зараз ти не в діалозі. Натисни «Знайти співрозмовника»."); return; }
  try { await tgRetry("copyMessage", { chat_id: me.partner_id, from_chat_id: message.chat.id, message_id: message.message_id }); }
  catch (err) {
    if (isGone(err)) { await disconnect(id, "gone"); return; }
    await send(id, "Не вдалося передати це повідомлення.");
  }
}

async function showProfile(id) {
  const p = one("select * from users where id = ?", id);
  const pics = one("select count(*) as n from photos where user_id = ?", id);
  const invites = one("select count(*) as n from users where invited_by = ?", id);
  await send(id, `Профіль\nІм’я: ${p?.display_name ?? "не вказано"}\nСтать: ${p?.gender ?? "не вказано"}\nВік: ${p?.profile_age ?? "не вказано"}\nЗвідки: ${p?.city ?? "не вказано"}\nЦіль: ${p?.aim ?? "не вказано"}\nПро себе: ${p?.interests ?? "не вказано"}\nФото: ${pics?.n ? "є, бачать лише з Premium" : "немає"}\nPremium: ${p && premiumActive(p.premium_until) ? "активний" : "немає"}\nПошуків за анкетою: ${p?.search_credits ?? 0}\nЗапросив друзів: ${invites?.n ?? 0}`, { inline_keyboard: [[{ text: "📝 Заповнити анкету", callback_data: "menu:form" }, { text: "📷 Завантажити фото", callback_data: "menu:photo" }]] });
}

async function showPremium(id) {
  const p = one("select * from users where id = ?", id);
  const until = Number(p?.premium_until ?? 0);
  const when = premiumActive(until) ? `активний до ${new Date(until * 1000).toLocaleString("uk-UA", { timeZone: TZ })}` : "не активний";
  await send(id, `💎 Premium\nСтатус: ${when}\nПошуків за анкетою: ${p?.search_credits ?? 0}\n\nВипадковий пошук безкоштовний.\nЧат знайомств — за підпискою або разово:\nПідписка — 1000⭐ кожні 30 днів\n1 пошук — 1⭐\n1 день — 20⭐\n1 тиждень — 100⭐\n1 місяць — 1000⭐\n\nПідписку Telegram продовжує сам, поки не скасуєш у налаштуваннях.\nЗа друга за посиланням — 3 години Premium.`, {
    inline_keyboard: [
      [{ text: "Підписка на знайомства · 1000⭐", callback_data: "buy:sub" }],
      [{ text: "1 пошук · 1⭐", callback_data: "buy:search" }],
      [{ text: "1 день · 20⭐", callback_data: "buy:day" }],
      [{ text: "1 тиждень · 100⭐", callback_data: "buy:week" }],
      [{ text: "1 місяць · 1000⭐", callback_data: "buy:month" }],
    ],
  });
}

async function sendInvoice(id, planId) {
  const plan = planOf(`prem:${planId}`);
  if (!plan) return;
  const invoice = {
    chat_id: id,
    title: tr(id, plan.title),
    description: tr(id, "subscribe" in plan ? "Чат знайомств на 30 днів. Далі Telegram спише 1000⭐ знову, поки не скасуєш підписку." : `${plan.label} за ${plan.stars}⭐. Оплата зірками Telegram.`),
    payload: `prem:${plan.id}`,
    currency: "XTR",
    provider_token: "",
    prices: [{ label: tr(id, plan.label), amount: plan.stars }],
  };
  if ("subscribe" in plan) invoice.subscription_period = 2592000;
  await tg("sendInvoice", invoice);
}

async function onPreCheckout(query) {
  const [kind, target] = String(query.invoice_payload).split(":");
  if (kind === "likes") {
    const error = query.currency !== "XTR" || query.total_amount !== LIKES_STARS ? "Ціна змінилась." : likesCount(String(query.from.id)) ? null : "Поки тебе ніхто не вподобав.";
    await tg("answerPreCheckoutQuery", { pre_checkout_query_id: query.id, ok: !error, ...(error ? { error_message: tr(query.from.id, error) } : {}) });
    return;
  }
  if (kind === "hint") {
    const error = query.currency !== "XTR" || query.total_amount !== HINT_STARS ? "Ціна змінилась." : hintCheck(String(query.from.id), target);
    await tg("answerPreCheckoutQuery", { pre_checkout_query_id: query.id, ok: !error, ...(error ? { error_message: tr(query.from.id, error) } : {}) });
    return;
  }
  if (kind === "reveal" || kind === "back") {
    const price = kind === "reveal" ? REVEAL_STARS : BACK_STARS;
    const error = query.currency !== "XTR" || query.total_amount !== price ? "Ціна змінилась." : microCheck(String(query.from.id), kind, target);
    await tg("answerPreCheckoutQuery", { pre_checkout_query_id: query.id, ok: !error, ...(error ? { error_message: tr(query.from.id, error) } : {}) });
    return;
  }
  const plan = planOf(query.invoice_payload);
  const ok = Boolean(plan && query.currency === "XTR" && query.total_amount === plan.stars);
  await tg("answerPreCheckoutQuery", { pre_checkout_query_id: query.id, ok, error_message: ok ? undefined : tr(query.from.id, "Тариф змінився. Відкрий Premium ще раз.") });
}

async function onPaid(id, pay) {
  const [kind, target] = String(pay.invoice_payload).split(":");
  if (kind === "reveal" || kind === "back") { ensure(id); return onMicroPaid(id, pay, kind, target); }
  if (kind === "hint") { ensure(id); return onHintPaid(id, pay, target); }
  if (kind === "likes") { ensure(id); return onLikesPaid(id, pay); }
  const plan = planOf(pay.invoice_payload);
  ensure(id);
  if (!plan || pay.currency !== "XTR" || pay.total_amount !== plan.stars) { await send(id, "Оплату отримано, але тариф не збігся. Напиши в Premium ще раз."); return; }
  const applied = await withLock(() => {
    const inserted = run("insert into payments (charge_id, user_id, payload, stars) values (?, ?, ?, ?) on conflict (charge_id) do nothing", pay.telegram_payment_charge_id, id, pay.invoice_payload, pay.total_amount);
    if (!inserted.changes) return false;
    if ("searches" in plan) run("update users set search_credits = search_credits + ? where id = ?", plan.searches, id);
    else {
      const now = nowSec();
      const stacked = !("subscribe" in plan);
      const until = !stacked && pay.subscription_expiration_date ? pay.subscription_expiration_date : now + (plan.seconds ?? 0);
      if (stacked) run("update users set premium_until = max(premium_until, ?) + ? where id = ?", now, plan.seconds ?? 0, id);
      else run("update users set premium_until = max(premium_until, ?) where id = ?", until, id);
    }
    return true;
  });
  if (!applied) return;
  if ("searches" in plan) { await send(id, "⭐ Оплачено. +1 пошук. Натисни «Знайти співрозмовника»."); return; }
  const p = one("select premium_until from users where id = ?", id);
  const till = new Date(Number(p?.premium_until ?? 0) * 1000).toLocaleDateString("uk-UA", { timeZone: TZ });
  await send(id, pay.is_recurring ? `Підписку на чат знайомств продовжено до ${till}.` : "subscribe" in plan ? `Підписку оформлено до ${till}. Далі Telegram продовжить її сам. Скасувати можна в налаштуваннях Telegram.` : `Оплачено. Пошук за анкетою відкрито: ${plan.label}.`);
}

// Безкоштовні 🌹 / 🎯 у грі — той самий гаманець, що й у щоденної винагороди.
function addWallet(id, roses = 0, aims = 0) {
  run("create table if not exists daily (user_id text primary key, last_day text, streak integer not null default 0, roses integer not null default 0, aims integer not null default 0)");
  run("insert into daily (user_id, roses, aims) values (?, ?, ?) on conflict (user_id) do update set roses = daily.roses + excluded.roses, aims = daily.aims + excluded.aims", id, roses, aims);
}
const friendsOf = (id) => one("select count(*) as n from users where invited_by = ? and invite_rewarded = 1", id)?.n ?? 0;

// Друг пройшов перевірку віку: нагорода тому, хто запросив, і вітальний подарунок другу.
async function rewardInvite(id) {
  const me = one("select invited_by from users where id = ?", id);
  if (!me?.invited_by) return;
  const done = run("update users set invite_rewarded = 1 where id = ? and invite_rewarded = 0", id);
  if (!done.changes) return;
  const src = me.invited_by;
  const now = nowSec();
  run("update users set premium_until = max(premium_until, ?) + ? where id = ?", now, FRIEND_PREMIUM, src);
  addWallet(src, 1, 0);
  addWallet(id, WELCOME_ROSES, 0);
  run("create table if not exists ref_rewards (user_id text not null, tier integer not null, primary key (user_id, tier))");
  const n = friendsOf(src);
  const lines = ["🎁 Друг прийшов за твоїм посиланням: +3 години Premium і 🌹 у грі."];
  for (const tier of REF_TIERS) {
    if (n < tier.n) continue;
    if (!run("insert into ref_rewards (user_id, tier) values (?, ?) on conflict do nothing", src, tier.n).changes) continue;
    if (tier.aims) addWallet(src, 0, tier.aims);
    if (tier.days) run("update users set premium_until = max(premium_until, ?) + ? where id = ?", nowSec(), tier.days * 86400, src);
    lines.push(`🏆 Уже ${tier.n} друзів! Бонус: ${tier.text}.`);
  }
  const next = REF_TIERS.find((t) => n < t.n);
  if (next) lines.push(`Наступний бонус: ${next.n} друзів — ${next.text} (ще ${next.n - n}).`);
  try { await send(src, lines.join("\n")); } catch (err) { if (!isGone(err)) console.error("[bot] invite", err.message); }
  try { await send(id, `🎁 Вітальний подарунок: 🌹×${WELCOME_ROSES} у грі — подаруй їх тому, хто сподобається.`); } catch {}
  await friendChain(id, src);
}

// 👭 Приведи подругу: коли подруга, яку ти запросив(ла), сама приведе когось — тобі день Premium і 🌹×3.
const FRIEND_BONUS_DAYS = 1;
const FRIEND_BONUS_ROSES = 3;
async function friendChain(newcomer, src) {
  // 1) Новенька — дівчина: кажемо тому, хто її привів, що бонус попереду, а їй — як його активувати.
  const me = one("select gender from users where id = ?", newcomer);
  if (me?.gender === "Жінка") {
    try { await send(src, `👭 Твоя подруга вже в клубі! Коли вона приведе когось — ти отримаєш ${FRIEND_BONUS_DAYS} день Premium і 🌹×${FRIEND_BONUS_ROSES}.`); } catch (err) { if (!isGone(err)) console.error("[bot] friend", err.message); }
    try { await send(newcomer, "👭 Тебе запросила подруга чи друг. Поділись своїм посиланням (🎁 Запросити друзів) — за кожного, хто прийде, ти отримаєш Premium, і людина, що тебе запросила, теж отримає бонус 💝"); } catch {}
  }
  // 2) Той, хто привів новенького, — дівчина, яку теж хтось запросив: тепер її запрошувач отримує бонус.
  const her = one("select gender, invited_by, invite_rewarded from users where id = ?", src);
  if (her?.gender !== "Жінка" || !her.invited_by || !her.invite_rewarded) return;
  const top = her.invited_by;
  if (!run("insert into friend_bonus (user_id, friend_id, created_at) values (?, ?, ?) on conflict do nothing", top, src, nowSec()).changes) return;
  run("update users set premium_until = max(premium_until, ?) + ? where id = ?", nowSec(), FRIEND_BONUS_DAYS * 86400, top);
  addWallet(top, FRIEND_BONUS_ROSES, 0);
  try { await send(top, `👭 Твоя подруга привела нову людину в клуб! Бонус «Приведи подругу»: +${FRIEND_BONUS_DAYS} день Premium і 🌹×${FRIEND_BONUS_ROSES} 💝`); } catch (err) { if (!isGone(err)) console.error("[bot] friend bonus", err.message); }
}

async function showInvite(id) {
  const p = one("select * from users where id = ?", id);
  const invites = { n: friendsOf(id) };
  const link = `https://t.me/${BOT_USERNAME}?start=t_${p?.invite_code ?? ""}`;
  const share = `https://t.me/share/url?url=${encodeURIComponent(link)}&text=${encodeURIComponent(tr(id, "Анонімний чат і гра в бутилочку з подарунками. Заходь 👉"))}`;
  const ladder = REF_TIERS.map((t) => `${invites.n >= t.n ? "✅" : "▫️"} ${t.n} друзів — ${t.text}`).join("\n");
  const next = REF_TIERS.find((t) => invites.n < t.n);
  const girls = one("select count(*) as n from friend_bonus where user_id = ?", id)?.n ?? 0;
  await send(id, `🎁 Супер-реферал\nНадішли другу це посилання:\n${link}\n\nЗа кожного друга — 3 години Premium + 🌹 у грі.\nДруг теж отримує 🌹🌹.\n\n${ladder}\n\nУже запросили: ${invites.n}${next ? `\nДо наступного бонусу: ще ${next.n - invites.n}` : ""}\n\n👭 Приведи подругу: коли подруга, яку ти запросив(ла), сама приведе когось — ти отримаєш ${FRIEND_BONUS_DAYS} день Premium і 🌹×${FRIEND_BONUS_ROSES}.\nБонусів за подруг: ${girls}`, { inline_keyboard: [[{ text: "📨 Поділитися посиланням", url: share }]] });
}
// ---------- 💌 анонімні зізнання ----------
// Кожен має посилання ?start=c_<код>. Хто перейде — пише анонімне повідомлення власнику.
// Власник може відповісти анонімно, поскаржитись або за зірки дізнатися стать/вік/місто автора.
const HINT_STARS = 10;
const CONFESS_MAX = 600;
const CONFESS_PER_DAY = 30;
const confessLink = (inviteCode) => `https://t.me/${BOT_USERNAME}?start=c_${inviteCode}`;
// 📲 Сторіз однією кнопкою: міні-застосунок малює картинку з кодом і викладає її через Telegram.
const STORY_URL = `https://${PUBLIC_DOMAIN}/story.html`;
const storyKb = { text: "📲 Викласти в сторіз", web_app: { url: STORY_URL } };
export function storyInfo(id) {
  const me = one("select invite_code, adult, banned, lang, language_code from users where id = ?", String(id));
  if (!me || !me.adult || me.banned) return null;
  return { code: me.invite_code, link: confessLink(me.invite_code), tableLink: `https://t.me/${BOT_USERNAME}?start=t_${me.invite_code}`, lang: LANGS.includes(me.lang) ? me.lang : guessLang(me.language_code) };
}
const nameFor = (row) => (String(row?.first_name || "").trim().slice(0, 32) || "Ця людина");
const cancelKb = { inline_keyboard: [[{ text: "✖️ Скасувати", callback_data: "conf:cancel" }]] };

async function showConfess(id) {
  const me = one("select adult, banned, invite_code from users where id = ?", id);
  if (me?.banned) return send(id, "Доступ до бота обмежено.");
  if (!me?.adult) return showAge(id);
  const link = confessLink(me.invite_code);
  const total = one("select count(*) as n from confessions where to_id = ?", id)?.n ?? 0;
  const share = `https://t.me/share/url?url=${encodeURIComponent(link)}&text=${encodeURIComponent(tr(id, "Напиши мені анонімно 👀 Я не дізнаюсь, хто ти"))}`;
  await send(id, `💌 Анонімні зізнання\n\nВиклади своє посилання в сторіз, біо чи канал — і люди зможуть анонімно написати тобі, що насправді про тебе думають 👀\n\n${link}\n\nОтримано зізнань: ${total}`, { inline_keyboard: [
    [storyKb],
    [{ text: "📨 Поділитися посиланням", url: share }],
    [{ text: "📸 Картинка для сторіз вручну", callback_data: "conf:story" }],
  ] });
}

async function sendStoryCard(id) {
  const me = one("select invite_code from users where id = ?", id);
  const link = confessLink(me?.invite_code ?? "");
  try {
    await tgRetry("sendPhoto", { chat_id: id, photo: `https://${PUBLIC_DOMAIN}/story-confess.jpg`, caption: tr(id, "Збережи картинку → відкрий сторіз → додай наліпку «Посилання» і встав своє посилання:") + `\n${link}` });
  } catch (err) {
    console.error("[bot] story card", err.message);
    await send(id, `Відкрий сторіз → наліпка «Посилання» → встав:\n${link}`);
  }
}

async function askConfess(id, ownerId) {
  const owner = one("select id, first_name, banned from users where id = ?", ownerId);
  if (!owner || owner.banned) return send(id, "Цієї людини вже немає в боті.");
  if (owner.id === id) return showConfess(id);
  if (one("select status from users where id = ?", id)?.status === "chat") return send(id, "Спочатку заверши поточний діалог.");
  run("update users set pending = 'confess', confess_to = ?, confess_at = ? where id = ?", owner.id, nowSec(), id);
  await send(id, `💌 Анонімне повідомлення для ${nameFor(owner)}:\n\nНапиши, що думаєш: зізнання, комплімент чи питання. Ніхто не дізнається, що це ти 🤫`, cancelKb);
}

async function deliverConfession(id, text) {
  const me = one("select confess_to from users where id = ?", id);
  run("update users set pending = null where id = ?", id);
  const to = me?.confess_to;
  const owner = to ? one("select id, banned, invite_code from users where id = ?", to) : null;
  if (!owner || owner.banned) return showLobby(id, "Цієї людини вже немає в боті.");
  if (one("select 1 as x from reports where reporter_id = ? and target_id = ?", to, id)) return showLobby(id, "Ця людина не приймає від тебе повідомлень.");
  const body = String(text).trim().slice(0, CONFESS_MAX);
  if (!body) return askConfess(id, to);
  const sentToday = one("select count(*) as n from confessions where from_id = ? and created_at > ?", id, nowSec() - 86400)?.n ?? 0;
  if (sentToday >= CONFESS_PER_DAY) return showLobby(id, "На сьогодні досить зізнань. Повертайся завтра 🙂");
  const cid = code(10);
  run("insert into confessions (id, to_id, from_id, text, created_at) values (?, ?, ?, ?, ?)", cid, to, id, body, nowSec());
  addPoints(to, 1);
  try {
    await send(to, `💌 Нове анонімне повідомлення:\n\n${body}`, { inline_keyboard: [
      [{ text: "↩️ Відповісти анонімно", callback_data: `conf:reply:${cid}` }],
      [{ text: `🔍 Хто це? · ${HINT_STARS}⭐`, callback_data: `conf:hint:${cid}` }, { text: "🚫 Поскаржитись", callback_data: `conf:report:${cid}` }],
    ] });
  } catch (err) {
    run("delete from confessions where id = ?", cid);
    if (isGone(err)) return showLobby(id, "Не вдалося доставити: ця людина вимкнула бота.");
    throw err;
  }
  const mine = one("select invite_code from users where id = ?", id);
  const link = confessLink(mine?.invite_code ?? "");
  const share = `https://t.me/share/url?url=${encodeURIComponent(link)}&text=${encodeURIComponent(tr(id, "Напиши мені анонімно 👀 Я не дізнаюсь, хто ти"))}`;
  await send(id, `✅ Надіслано анонімно!\n\nХочеш, щоб і тобі писали? Ось твоє посилання — виклади його в сторіз чи біо:\n${link}`, { inline_keyboard: [
    [{ text: "✍️ Написати ще", callback_data: "conf:more" }],
    [storyKb],
    [{ text: "📨 Поділитися своїм посиланням", url: share }],
  ] });
}

async function deliverReply(id, cid, text) {
  run("update users set pending = null where id = ?", id);
  const c = one("select * from confessions where id = ? and to_id = ?", cid, id);
  if (!c) return showLobby(id);
  const body = String(text).trim().slice(0, CONFESS_MAX);
  if (!body) return showLobby(id);
  const rid = code(10);
  // Відповідь теж зберігаємо як повідомлення: автор може відповісти на неї, і так далі.
  run("insert into confessions (id, to_id, from_id, text, created_at, reply_to) values (?, ?, ?, ?, ?, ?)", rid, c.from_id, id, body, nowSec(), cid);
  const quote = c.text.length > 120 ? c.text.slice(0, 117) + "…" : c.text;
  try {
    await send(c.from_id, `💬 Відповідь на твоє анонімне повідомлення\n«${quote}»\n\n${body}`, { inline_keyboard: [
      [{ text: "↩️ Відповісти", callback_data: `conf:reply:${rid}` }],
      [{ text: "🚫 Поскаржитись", callback_data: `conf:report:${rid}` }],
    ] });
  } catch (err) {
    if (isGone(err)) return showLobby(id, "Не вдалося доставити: ця людина вимкнула бота.");
    throw err;
  }
  await showLobby(id, "✅ Відповідь надіслано анонімно.");
}

async function onConfessCallback(id, data, queryId, from) {
  await tg("answerCallbackQuery", { callback_query_id: queryId });
  const me = ensure(id, from);
  if (me.banned) return send(id, "Доступ до бота обмежено.");
  if (!me.adult) return showAge(id);
  const [, action, cidRaw] = data.split(":");
  const cid = String(cidRaw || "").replace(/[^a-f0-9]/g, "").slice(0, 12);
  if (action === "cancel") { run("update users set pending = null where id = ?", id); return showLobby(id); }
  if (action === "story") return sendStoryCard(id);
  if (action === "mine") return showConfess(id);
  if (action === "more") return me.confess_to ? askConfess(id, me.confess_to) : showConfess(id);
  const c = cid ? one("select * from confessions where id = ?", cid) : null;
  if (!c || c.to_id !== id) return send(id, "Це повідомлення вже недоступне.");
  if (action === "reply") {
    if (me.status === "chat") return send(id, "Спочатку заверши поточний діалог.");
    if (one("select 1 as x from reports where reporter_id = ? and target_id = ?", c.from_id, id)) return send(id, "Ця людина не приймає від тебе повідомлень.");
    run("update users set pending = ? where id = ?", `creply:${cid}`, id);
    return send(id, "Напиши відповідь — вона піде анонімно.", cancelKb);
  }
  if (action === "report") {
    run("update confessions set reported = 1 where id = ?", cid);
    run("insert into reports (reporter_id, target_id, created_at) values (?, ?, ?)", id, c.from_id, nowSec());
    return send(id, "Скаргу прийнято. Ця людина більше не зможе тобі писати.");
  }
  if (action === "hint") {
    if (c.hint) return sendHint(id, c);
    return starInvoice(id, "🔍 Хто написав", "Стать, вік і місто автора повідомлення. Ім’я і контакти не показуємо.", `hint:${cid}`, HINT_STARS);
  }
}

function hintCheck(payer, cid) {
  const c = one("select to_id, from_id, hint from confessions where id = ?", cid);
  if (!c || c.to_id !== payer) return "Це повідомлення вже недоступне.";
  if (c.hint) return "Підказку вже відкрито.";
  return null;
}
async function sendHint(id, c) {
  const a = one("select gender, profile_age, city from users where id = ?", c.from_id);
  const age = a?.profile_age ? `${Math.floor(a.profile_age / 5) * 5}–${Math.floor(a.profile_age / 5) * 5 + 4}` : "не вказано";
  await send(id, `🔍 Хто написав\nСтать: ${a?.gender ?? "не вказано"}\nВік: ${age}\nМісто: ${a?.city ?? "не вказано"}`);
}
async function onHintPaid(id, pay, cid) {
  const fresh = run("insert into payments (charge_id, user_id, payload, stars) values (?, ?, ?, ?) on conflict (charge_id) do nothing", pay.telegram_payment_charge_id, id, pay.invoice_payload, pay.total_amount).changes;
  if (!fresh) return;
  const error = pay.currency !== "XTR" || pay.total_amount !== HINT_STARS ? "Ціна змінилась." : hintCheck(id, cid);
  if (error) return refundStars(id, pay.telegram_payment_charge_id, `${error} Зірки повернено.`);
  run("update confessions set hint = 1 where id = ?", cid);
  await sendHint(id, one("select * from confessions where id = ?", cid));
}

// ---------- 🧱 стіна зізнань, 🌙 питання дня, 🏆 сезони ----------
const POST_MAX = 300;
const WALL_PER_DAY = 3;
const REACTS = ["❤️", "😂", "🔥"];
const REACT_MILESTONES = [5, 20, 50, 100];
// Без посилань, юзернеймів і номерів: стіна анонімна, і рекламу сюди не пускаємо.
const leaksContact = (t) => /(https?:\/\/|t\.me\/|www\.|@[a-z0-9_]{4,}|\+?\d[\d\s\-()]{8,}\d)/i.test(t);

// Сезон триває 14 днів від понеділка 23.11.2026 00:00 за Києвом.
const SEASON_EPOCH = Date.UTC(2026, 10, 22, 22, 0, 0) / 1000;
const SEASON_LEN = 14 * 86400;
const seasonNow = () => Math.floor((nowSec() - SEASON_EPOCH) / SEASON_LEN) + 1;
const SEASON_PRIZES = [{ place: 1, days: 7, medal: "🥇" }, { place: 2, days: 3, medal: "🥈" }, { place: 3, days: 1, medal: "🥉" }];
export function addPoints(userId, n) {
  if (!userId || !n) return;
  try {
    run("insert into season_points (season, user_id, points) select ?, ?, ? where exists (select 1 from users where id = ? and adult = 1 and banned = 0) on conflict (season, user_id) do update set points = points + excluded.points", seasonNow(), String(userId), n, String(userId));
  } catch (err) { console.error("[bot] points", err.message); }
}
export const crownOf = (userId) => (one("select 1 as x from season_winners where user_id = ? and place = 1", userId) ? "👑 " : "");
const nickOf = (row) => (String(row?.display_name || row?.first_name || "").trim().slice(0, 16) || `Невідомий #${String(row?.id ?? "").slice(-4)}`);

// Питання дня: те саме для всіх, змінюється опівночі за Києвом.
const QOTD = [
  "Що ти зробив(ла) б, якби завтра не треба було йти на роботу чи навчання?",
  "Яке твоє найбільше «ніколи більше»? 😅",
  "Що тебе найбільше приваблює в людині з першого погляду?",
  "Яка пісня описує твій настрій сьогодні? 🎧",
  "Що б ти сказав(ла) собі 15-річному(ій)?",
  "Найдивніше місце, де ти засинав(ла)? 😴",
  "Що для тебе означає «ідеальне побачення»? 💘",
  "Яку річ ти робиш краще за всіх?",
  "Що ти востаннє зробив(ла) вперше?",
  "Без чого ти не уявляєш свого дня? ☕",
  "Яке твоє guilty pleasure? 🙈",
  "Яке місто ти хотів(ла) б побачити найбільше? ✈️",
  "Що тебе може розсмішити навіть у поганий день? 😂",
  "Яку суперсилу ти обрав(ла) б і чому? 🦸",
  "Який найкращий комплімент тобі робили? 💌",
  "Чого ти навчився(лась) цього року?",
  "Як виглядає твоя ідеальна неділя?",
  "Що ти ніколи не пробачиш у стосунках?",
  "Який фільм чи серіал радиш усім? 🎬",
  "Що б ти зробив(ла) з мільйоном гривень? 💸",
  "Яка твоя найсмішніша історія з побачення? 😅",
];
function qotdToday() {
  const { day } = kyivNow();
  const n = Math.floor(Date.UTC(...day.split("-").map((v, i) => (i === 1 ? Number(v) - 1 : Number(v)))) / 86400000);
  return { day, question: QOTD[n % QOTD.length] };
}

function postView(id, scope, offset, pid = null) {
  const where = scope === "q" ? "kind = 'qotd' and day = ?" : "kind = 'wall' and created_at > ?";
  const arg = scope === "q" ? qotdToday().day : nowSec() - 14 * 86400;
  const base = `from posts p where ${where} and hidden = 0 and id not in (select post_id from post_reports where user_id = ?)`;
  const total = one(`select count(*) as n ${base}`, arg, id)?.n ?? 0;
  if (!total) return null;
  const i = ((offset % total) + total) % total;
  // Після реакції показуємо той самий пост, навіть якщо порядок змінився.
  const post = (pid && one("select * from posts where id = ? and hidden = 0", pid)) || one(`select p.*, (select count(*) from post_reactions r where r.post_id = p.id) as score ${base} order by score desc, created_at desc limit 1 offset ?`, arg, id, i);
  if (!post) return null;
  const counts = Object.fromEntries(REACTS.map((e) => [e, one("select count(*) as n from post_reactions where post_id = ? and emoji = ?", post.id, e)?.n ?? 0]));
  const mine = one("select emoji from post_reactions where post_id = ? and user_id = ?", post.id, id)?.emoji;
  const hours = Math.max(0, Math.floor((nowSec() - post.created_at) / 3600));
  const ago = hours < 1 ? "щойно" : hours < 24 ? `${hours} год тому` : `${Math.floor(hours / 24)} дн. тому`;
  const head = scope === "q" ? `🌙 Відповіді на питання дня · ${i + 1}/${total}\n«${qotdToday().question}»` : `🧱 Стіна зізнань · ${i + 1}/${total}`;
  const text = `${head}\n\n${post.text}\n\n🕒 ${ago}${post.author_id === id ? " · це твоє" : ""}`;
  const markup = { inline_keyboard: [
    REACTS.map((e) => ({ text: `${mine === e ? "✅" : e} ${counts[e]}`, callback_data: `wall:r:${scope}:${i}:${REACTS.indexOf(e)}:${post.id}` })),
    [{ text: "⏭ Далі", callback_data: `wall:v:${scope}:${i + 1}` }, { text: scope === "q" ? "🌙 Питання" : "✍️ Написати своє", callback_data: scope === "q" ? "wall:qotd" : "wall:new" }],
    [{ text: "🚩 Поскаржитись", callback_data: `wall:x:${scope}:${i}:0:${post.id}` }],
  ] };
  return { text, markup };
}
async function editOrSend(id, messageId, text, markup) {
  const lang = langOf(id);
  if (messageId) {
    try { await tg("editMessageText", { chat_id: id, message_id: messageId, text: L(lang, text), reply_markup: localizeMarkup(lang, markup) }); return; }
    catch (err) { if (/not modified/i.test(err.message)) return; }
  }
  await send(id, text, markup);
}
async function showWall(id, scope = "w", offset = 0, messageId = null, pid = null) {
  const me = one("select adult, banned from users where id = ?", id);
  if (me?.banned) return send(id, "Доступ до бота обмежено.");
  if (!me?.adult) return showAge(id);
  if (scope === "q" && !one("select 1 as x from posts where author_id = ? and kind = 'qotd' and day = ?", id, qotdToday().day)) return showQotd(id);
  const view = postView(id, scope, offset, pid);
  if (!view) {
    return scope === "q"
      ? editOrSend(id, messageId, "🌙 Ти відповів(ла) першим! Інші відповіді з’являться згодом — загляни пізніше 😉", { inline_keyboard: [[{ text: "🧱 Стіна зізнань", callback_data: "wall:v:w:0" }]] })
      : editOrSend(id, messageId, "🧱 Стіна зізнань поки порожня. Стань першим — напиши анонімне зізнання для всіх 👀", { inline_keyboard: [[{ text: "✍️ Написати своє", callback_data: "wall:new" }]] });
  }
  await editOrSend(id, messageId, view.text, view.markup);
}
async function showQotd(id) {
  const me = one("select adult, banned, status from users where id = ?", id);
  if (me?.banned) return send(id, "Доступ до бота обмежено.");
  if (!me?.adult) return showAge(id);
  const { day, question } = qotdToday();
  const answered = Boolean(one("select 1 as x from posts where author_id = ? and kind = 'qotd' and day = ?", id, day));
  const n = one("select count(*) as n from posts where kind = 'qotd' and day = ? and hidden = 0", day)?.n ?? 0;
  if (answered) return send(id, `🌙 Питання дня\n\n${question}\n\nВідповіли: ${n}`, { inline_keyboard: [[{ text: "👀 Відповіді інших", callback_data: "wall:v:q:0" }]] });
  if (me.status === "chat") return send(id, "Спочатку заверши поточний діалог.");
  run("update users set pending = 'qotd' where id = ?", id);
  await send(id, `🌙 Питання дня\n\n${question}\n\nНапиши відповідь — вона буде анонімною. Відповіси — побачиш, що написали інші (уже ${n}) 👀`, cancelKb);
}
async function startWallPost(id) {
  const me = one("select status from users where id = ?", id);
  if (me?.status === "chat") return send(id, "Спочатку заверши поточний діалог.");
  const today = one("select count(*) as n from posts where author_id = ? and kind = 'wall' and created_at > ?", id, nowSec() - 86400)?.n ?? 0;
  if (today >= WALL_PER_DAY) return send(id, "На сьогодні досить постів на стіні. Повертайся завтра 🙂");
  run("update users set pending = 'wallpost' where id = ?", id);
  await send(id, "✍️ Напиши анонімне зізнання для всіх: таємницю, думку чи історію. Ніхто не дізнається, що це ти 🤫\n\nБез імен, посилань і номерів.", cancelKb);
}
async function savePost(id, kind, text) {
  run("update users set pending = null where id = ?", id);
  const body = String(text).trim().slice(0, POST_MAX);
  if (!body) return showLobby(id);
  if (leaksContact(body)) {
    run("update users set pending = ? where id = ?", kind === "qotd" ? "qotd" : "wallpost", id);
    return send(id, "Без посилань, юзернеймів і номерів — тут усе анонімно 🙂 Напиши ще раз.", cancelKb);
  }
  const day = kind === "qotd" ? qotdToday().day : null;
  if (kind === "qotd" && one("select 1 as x from posts where author_id = ? and kind = 'qotd' and day = ?", id, day)) return showWall(id, "q", 0);
  run("insert into posts (id, author_id, kind, day, text, created_at) values (?, ?, ?, ?, ?, ?)", code(10), id, kind, day, body, nowSec());
  addPoints(id, kind === "qotd" ? 2 : 1);
  if (kind === "qotd") { await send(id, "✅ Відповідь збережено! +2 очки сезону 🏆\nОсь що написали інші:"); return showWall(id, "q", 0); }
  await send(id, "✅ Опубліковано на стіні! Коли твоє зізнання почнуть вподобувати — я скажу 😉");
  return showWall(id, "w", 0);
}
async function onWallCallback(id, data, cbq) {
  const queryId = cbq.id;
  const messageId = cbq.message?.message_id ?? null;
  const me = ensure(id, cbq.from);
  if (me.banned || !me.adult) { await tg("answerCallbackQuery", { callback_query_id: queryId }); return me.banned ? send(id, "Доступ до бота обмежено.") : showAge(id); }
  const [, action, scopeRaw, iRaw, eRaw, pidRaw] = data.split(":");
  const scope = scopeRaw === "q" ? "q" : "w";
  if (action === "new") { await tg("answerCallbackQuery", { callback_query_id: queryId }); return startWallPost(id); }
  if (action === "qotd") { await tg("answerCallbackQuery", { callback_query_id: queryId }); return showQotd(id); }
  if (action === "v") { await tg("answerCallbackQuery", { callback_query_id: queryId }); return showWall(id, scope, Number(iRaw) || 0, messageId); }
  if (action === "r") {
    const pid = String(pidRaw || "").replace(/[^a-f0-9]/g, "").slice(0, 12);
    const emoji = REACTS[Number(eRaw)];
    const post = pid && emoji ? one("select * from posts where id = ? and hidden = 0", pid) : null;
    if (!post) { await tg("answerCallbackQuery", { callback_query_id: queryId }); return showWall(id, scope, 0, messageId); }
    const prev = one("select emoji from post_reactions where post_id = ? and user_id = ?", pid, id)?.emoji;
    if (prev === emoji) run("delete from post_reactions where post_id = ? and user_id = ?", pid, id);
    else run("insert into post_reactions (post_id, user_id, emoji) values (?, ?, ?) on conflict (post_id, user_id) do update set emoji = excluded.emoji", pid, id, emoji);
    await tg("answerCallbackQuery", { callback_query_id: queryId, text: prev === emoji ? "" : emoji });
    if (!prev && post.author_id !== id) {
      addPoints(post.author_id, 1);
      const total = one("select count(*) as n from post_reactions where post_id = ?", pid)?.n ?? 0;
      const hit = REACT_MILESTONES.filter((m) => total >= m && post.notified < m).pop();
      if (hit) {
        run("update posts set notified = ? where id = ?", hit, pid);
        const quote = post.text.length > 80 ? post.text.slice(0, 77) + "…" : post.text;
        try { await send(post.author_id, `🔥 Твій пост зібрав ${hit} реакцій!\n«${quote}»`); } catch (err) { if (!isGone(err)) console.error("[bot] wall notify", err.message); }
      }
    }
    return showWall(id, scope, Number(iRaw) || 0, messageId, pid);
  }
  if (action === "x") {
    const pid = String(pidRaw || "").replace(/[^a-f0-9]/g, "").slice(0, 12);
    await tg("answerCallbackQuery", { callback_query_id: queryId, text: tr(id, "Скаргу прийнято") });
    if (pid && run("insert into post_reports (post_id, user_id) values (?, ?) on conflict do nothing", pid, id).changes) {
      run("update posts set reports = reports + 1, hidden = case when reports + 1 >= 3 then 1 else hidden end where id = ?", pid);
    }
    return showWall(id, scope, Number(iRaw) || 0, messageId);
  }
  await tg("answerCallbackQuery", { callback_query_id: queryId });
}

async function showTop(id) {
  const me = one("select adult, banned from users where id = ?", id);
  if (me?.banned) return send(id, "Доступ до бота обмежено.");
  if (!me?.adult) return showAge(id);
  const season = seasonNow();
  const left = SEASON_EPOCH + season * SEASON_LEN - nowSec();
  const rows = q("select sp.user_id, sp.points, u.display_name, u.first_name, u.id from season_points sp join users u on u.id = sp.user_id where sp.season = ? and u.banned = 0 and sp.points > 0 order by sp.points desc, sp.user_id limit 10", season);
  const medals = ["🥇", "🥈", "🥉"];
  const lines = rows.map((r, i) => `${medals[i] ?? `${i + 1}.`} ${crownOf(r.user_id)}${nickOf(r)} — ${r.points}`);
  const mine = one("select points from season_points where season = ? and user_id = ?", season, id)?.points ?? 0;
  const place = mine ? (one("select count(*) as n from season_points where season = ? and points > ?", season, mine)?.n ?? 0) + 1 : 0;
  await send(id, `🏆 Сезон ${season} · до кінця ${Math.floor(left / 86400)} дн. ${Math.floor((left % 86400) / 3600)} год\n\n${lines.join("\n") || "Поки ніхто не набрав очок — стань першим!"}\n\nТи: ${place ? `#${place} · ${mine} очок` : "ще без очок"}\n\nОчки дають: ❤️ реакції й 💋 поцілунки в грі, 🎁 подарунки, реакції на стіні, 🌙 відповіді на питання дня, 💞 взаємні симпатії.\nНагороди: 🥇 7 днів Premium, 🥈 3 дні, 🥉 1 день. Переможець отримує корону 👑 біля імені.`);
}
// Кінець сезону: нагороджуємо топ-3 минулого сезону (раз, навіть після перезапуску).
export async function seasonTick() {
  const prev = seasonNow() - 1;
  if (prev < 1 || one("select 1 as x from season_winners where season = ?", prev)) return;
  const top = q("select sp.user_id from season_points sp join users u on u.id = sp.user_id where sp.season = ? and u.banned = 0 and sp.points > 0 order by sp.points desc, sp.user_id limit 3", prev);
  if (!top.length) { run("insert into season_winners (season, user_id, place) values (?, '', 0) on conflict do nothing", prev); return; }
  for (const [i, row] of top.entries()) {
    const prize = SEASON_PRIZES[i];
    if (!run("insert into season_winners (season, user_id, place) values (?, ?, ?) on conflict do nothing", prev, row.user_id, prize.place).changes) continue;
    run("update users set premium_until = max(premium_until, ?) + ? where id = ?", nowSec(), prize.days * 86400, row.user_id);
    try { await send(row.user_id, `${prize.medal} Сезон ${prev} завершено — ти на ${prize.place} місці!\nНагорода: ${prize.days} дн. Premium${prize.place === 1 ? " і корона 👑 біля імені" : ""}. Новий сезон уже почався 🏆`); }
    catch (err) { if (!isGone(err)) console.error("[bot] season", err.message); }
  }
}

async function showRules(id) {
  await send(id, "📜 Правила\n• Лише 18+.\n• Не надсилай контакти, адресу, документи і посилання на свої профілі.\n• Не ображай співрозмовника.\n• «Завершити діалог» або /stop зупиняє розмову.\n• «Наступний» шукає іншу людину.\n• Скарга — кнопка під час діалогу.");
}
async function showHelp(id) {
  await send(id, "❓ Допомога\n🍾 Гра в бутилочку — гра за столом із подарунками\n🔍 Знайти співрозмовника — випадково безкоштовно або за анкетою з Premium\n\nУ діалозі:\n⏭ Наступний — інша людина\n⛔ Завершити діалог — вийти\n🎁 Подарунок — подарувати співрозмовнику\n👀 Хто це? — стать, вік, місто і ціль співрозмовника\n⚠️ Поскаржитись\n\n👤 Мій профіль — анкета і фото\n💎 Premium — пошук за віком, статтю і містом\n🎁 Запросити друзів — 3 години Premium\n⚙️ Налаштування — мова, правила, новини\n\n/myid — твій Telegram ID");
}
async function showSettings(id) {
  const off = Boolean(one("select id from optout where id = ?", id));
  const partyOff = Boolean(one("select id from party_off where id = ?", id));
  await send(id, "⚙️ Налаштування", { inline_keyboard: [
    [{ text: "🌐 Мова", callback_data: "menu:lang" }],
    [{ text: partyOff ? "🎉 Кликати на вечірки" : "🔕 Не кликати на вечірки", callback_data: "menu:party" }],
    [{ text: "📜 Правила", callback_data: "menu:rules" }, { text: "❓ Допомога", callback_data: "menu:help" }],
    [{ text: off ? "🔔 Увімкнути новини" : "🔕 Вимкнути новини", callback_data: "menu:news" }],
  ] });
}

// ---------- дрібні платні функції ----------
async function starInvoice(id, title, description, payload, stars) {
  await tg("sendInvoice", { chat_id: id, title: tr(id, title), description: tr(id, description), payload, currency: "XTR", provider_token: "", prices: [{ label: tr(id, title), amount: stars }] });
}
// 👀 Хто це: стать, вік, місто і ціль співрозмовника у випадковому чаті.
async function askReveal(id) {
  const me = one("select status, partner_id from users where id = ?", id);
  if (me?.status !== "chat" || !me.partner_id) return send(id, "Це працює лише під час діалогу.");
  await starInvoice(id, "👀 Хто співрозмовник", "Стать, вік, місто і ціль співрозмовника. Ім’я і контакти не показуємо.", `reveal:${me.partner_id}`, REVEAL_STARS);
}
// ↩️ Після діалогу: запит колишньому співрозмовнику продовжити розмову.
// Після розмови: ❤️ чи 👋. Взаємна симпатія — безкоштовно відкриває чат знову.
// Однобічна — можна попросити повернути співрозмовника за зірки.
async function offerBack(id) {
  const me = one("select last_partner_id, status from users where id = ?", id);
  if (!me?.last_partner_id || me.status === "chat") return;
  const tok = code(10);
  run("delete from rate_tokens where created_at < ?", nowSec() - 7 * 86400);
  run("insert into rate_tokens (id, from_id, to_id, created_at) values (?, ?, ?, ?)", tok, id, me.last_partner_id, nowSec());
  await send(id, "Як тобі співрозмовник? Якщо симпатія взаємна — я відкрию чат знову 😉", { inline_keyboard: [
    [{ text: "❤️ Сподобався", callback_data: `like:y:${tok}` }, { text: "👋 Не дуже", callback_data: `like:n:${tok}` }],
    [{ text: `↩️ Повернути співрозмовника · ${BACK_STARS}⭐`, callback_data: "back" }],
  ] });
}
async function onLike(id, yes, tok, queryId) {
  const row = one("select * from rate_tokens where id = ? and from_id = ?", tok, id);
  run("delete from rate_tokens where id = ?", tok);
  if (!row) return tg("answerCallbackQuery", { callback_query_id: queryId });
  if (!yes) return tg("answerCallbackQuery", { callback_query_id: queryId, text: tr(id, "Зрозумів 👋") });
  run("insert into likes (from_id, to_id, created_at) values (?, ?, ?) on conflict do update set created_at = excluded.created_at", id, row.to_id, nowSec());
  const mutual = one("select 1 as x from likes where from_id = ? and to_id = ? and created_at > ?", row.to_id, id, nowSec() - 3 * 86400);
  if (!mutual) {
    await tg("answerCallbackQuery", { callback_query_id: queryId, text: tr(id, "Збережено ❤️") });
    await send(id, "❤️ Збережено. Якщо симпатія взаємна — я скажу 😉");
    return notifyLiked(row.to_id);
  }
  await tg("answerCallbackQuery", { callback_query_id: queryId, text: "💞" });
  run("delete from likes where (from_id = ? and to_id = ?) or (from_id = ? and to_id = ?)", id, row.to_id, row.to_id, id);
  addPoints(id, 3); addPoints(row.to_id, 3);
  const req = code(8);
  run("delete from requests where from_id = ? and to_id = ?", id, row.to_id);
  run("insert into requests (id, from_id, to_id) values (?, ?, ?)", req, id, row.to_id);
  await send(id, "💞 Взаємна симпатія! Ви сподобались одне одному.\nЯ запропонував співрозмовнику продовжити — чекай.");
  try {
    await send(row.to_id, "💞 Взаємна симпатія! Ви сподобались одне одному.\nПродовжити розмову?", { inline_keyboard: [[{ text: "💬 Так, до чату", callback_data: `meet:yes:${req}` }, { text: "Ні", callback_data: `meet:no:${req}` }]] });
  } catch (err) { if (!isGone(err)) console.error("[bot] mutual", err.message); }
}

// 💘 «Тебе вподобали»: тизер одразу після ❤️, а хто саме — за зірки (з можливістю написати).
const LIKES_STARS = 15;
const likersOf = (id) => q("select l.from_id, u.gender, u.profile_age, u.city from likes l join users u on u.id = l.from_id where l.to_id = ? and l.created_at > ? and u.banned = 0 order by l.created_at desc limit 10", id, nowSec() - 7 * 86400);
const likesCount = (id) => one("select count(*) as n from likes l join users u on u.id = l.from_id where l.to_id = ? and l.created_at > ? and u.banned = 0", id, nowSec() - 7 * 86400)?.n ?? 0;
async function notifyLiked(to) {
  const last = one("select at from like_notify where user_id = ?", to)?.at ?? 0;
  if (nowSec() - last < 6 * 3600) return;
  run("insert into like_notify (user_id, at) values (?, ?) on conflict (user_id) do update set at = excluded.at", to, nowSec());
  const n = likesCount(to);
  try {
    await send(to, `💘 Ти комусь сподобався(лась)! Уже вподобали: ${n} 👀\nПостав ❤️ після розмови у відповідь — і чат відкриється знову. Або дізнайся, хто це.`, { inline_keyboard: [[{ text: `💘 Хто мене вподобав · ${LIKES_STARS}⭐`, callback_data: "likes:buy" }]] });
  } catch (err) { if (!isGone(err)) console.error("[bot] like notify", err.message); }
}
async function showLikes(id) {
  const me = one("select adult, banned from users where id = ?", id);
  if (me?.banned) return send(id, "Доступ до бота обмежено.");
  if (!me?.adult) return showAge(id);
  const n = likesCount(id);
  if (!n) return send(id, "💘 Поки тебе ніхто не вподобав. Спілкуйся в чаті й грі — після кожної розмови люди ставлять ❤️ 😉");
  await send(id, `💘 Тебе вподобали: ${n} за тиждень 👀\nДізнайся, хто це (стать, вік, місто), і напиши першим(ою).`, { inline_keyboard: [[{ text: `💘 Хто мене вподобав · ${LIKES_STARS}⭐`, callback_data: "likes:buy" }]] });
}
async function revealLikes(id) {
  const rows = likersOf(id);
  if (!rows.length) return send(id, "💘 Поки тебе ніхто не вподобав.");
  const kb = [];
  const lines = rows.map((r, i) => {
    const tok = code(10);
    run("insert into rate_tokens (id, from_id, to_id, created_at) values (?, ?, ?, ?)", tok, id, r.from_id, nowSec());
    kb.push([{ text: `💬 Написати №${i + 1}`, callback_data: `likes:ask:${tok}` }]);
    return `${i + 1}. ${r.gender ?? "—"}, ${r.profile_age ?? "—"}, ${r.city ?? "—"}`;
  });
  await send(id, `💘 Тебе вподобали:\n\n${lines.join("\n")}\n\nНатисни «Написати» — людина отримає запит на чат.`, { inline_keyboard: kb });
}
async function onLikesCallback(id, data, queryId) {
  await tg("answerCallbackQuery", { callback_query_id: queryId });
  const me = ensure(id);
  if (me.banned || !me.adult) return me.banned ? send(id, "Доступ до бота обмежено.") : showAge(id);
  const [, action, tokRaw] = data.split(":");
  if (action === "buy") {
    if (!likesCount(id)) return showLikes(id);
    return starInvoice(id, "💘 Хто мене вподобав", "Стать, вік і місто людей, які поставили тобі ❤️ за тиждень, і можливість написати їм першим.", "likes:all", LIKES_STARS);
  }
  if (action === "ask") {
    const tok = String(tokRaw || "").replace(/[^a-f0-9]/g, "").slice(0, 12);
    const row = one("select * from rate_tokens where id = ? and from_id = ?", tok, id);
    run("delete from rate_tokens where id = ?", tok);
    if (!row) return send(id, "Запит уже не діє.");
    if (me.status === "chat") return send(id, "Спочатку заверши поточний діалог.");
    const req = code(8);
    run("delete from requests where from_id = ? and to_id = ?", id, row.to_id);
    run("insert into requests (id, from_id, to_id) values (?, ?, ?)", req, id, row.to_id);
    try {
      await send(row.to_id, "💘 Тобі хочуть написати — людина, якій ти поставив(ла) ❤️ після розмови. Відкрити чат?", { inline_keyboard: [[{ text: "💬 Так, до чату", callback_data: `meet:yes:${req}` }, { text: "Ні", callback_data: `meet:no:${req}` }]] });
    } catch (err) { if (isGone(err)) return send(id, "Ця людина вже вимкнула бота."); throw err; }
    return send(id, "Запит надіслано 💘 Якщо людина прийме — відкриється чат.");
  }
}
async function onLikesPaid(id, pay) {
  const fresh = run("insert into payments (charge_id, user_id, payload, stars) values (?, ?, ?, ?) on conflict (charge_id) do nothing", pay.telegram_payment_charge_id, id, pay.invoice_payload, pay.total_amount).changes;
  if (!fresh) return;
  if (pay.currency !== "XTR" || pay.total_amount !== LIKES_STARS) return refundStars(id, pay.telegram_payment_charge_id, "Ціна змінилась. Зірки повернено.");
  if (!likesCount(id)) return refundStars(id, pay.telegram_payment_charge_id, "Поки тебе ніхто не вподобав. Зірки повернено.");
  await revealLikes(id);
}

// 🤖 ШІ-співрозмовник: розмовляє з людиною, поки вона в черзі пошуку. Завжди підписаний «🤖».
// Людина лишається в черзі: щойно з’явиться жива людина — enqueue з’єднає, а ШІ-чат закриється.
const AI_PER_DAY = 40;
const aiHistory = new Map(); // id → [{ role, text }]
const aiBusy = new Set();
const AI_LANG = { uk: "українською", ru: "російською", en: "англійською" };
function aiSystem(id) {
  const me = one("select gender, profile_age from users where id = ?", id);
  return `Ти — 🤖 ШІ-співрозмовник у Telegram-боті «Невідомий» (анонімний чат 18+, гра в бутилочку, анонімні зізнання). Ти розмовляєш з людиною, поки вона чекає на живого співрозмовника.
Правила:
- Завжди чесно кажи, що ти ШІ, якщо питають. Ніколи не вдавай людину, не вигадуй собі тіло, фото, місто чи зустрічі.
- Пиши ${AI_LANG[langOf(id)] || "українською"}, коротко: 1–3 речення, живо, тепло, з гумором, 0–2 емоджі. Став зустрічні запитання, щоб розмова йшла.
- Легкий флірт можна, але без відвертого сексуального змісту і без грубощів.
- Не проси й не давай контакти, номери, адреси, посилання.
- Якщо людина каже, що їй менше 18 — ввічливо скажи, що бот лише для 18+, і не продовжуй тему.
- Якщо людині погано або йдеться про небезпеку для життя — підтримай і порадь звернутися до близьких або на лінію допомоги (в Україні: 7333 — Lifeline Ukraine).
- Іноді (не частіше разу на 5 повідомлень) доречно згадай функції бота: 🍾 гра в бутилочку, 💌 анонімні зізнання, 🧱 стіна зізнань.
Про співрозмовника: стать — ${me?.gender || "невідомо"}, вік — ${me?.profile_age || "невідомо"}.`;
}
async function aiStart(id) {
  const me = one("select status, ai_chat from users where id = ?", id);
  if (me?.status !== "search") return send(id, "Це працює, поки ти шукаєш співрозмовника. Натисни «Знайти співрозмовника».");
  run("update users set ai_chat = 1 where id = ?", id);
  aiHistory.set(id, []);
  await send(id, "🤖 Привіт! Я ШІ-співрозмовник — поговорю з тобою, поки шукаю живу людину. Можеш писати що завгодно 🙂\n\n«Скасувати пошук» — вийти.");
}
async function aiTalk(id, text) {
  if (aiBusy.has(id)) return;
  const { day } = kyivNow();
  const used = one("select n from ai_usage where user_id = ? and day = ?", id, day)?.n ?? 0;
  if (used >= AI_PER_DAY) {
    run("update users set ai_chat = 0 where id = ?", id);
    aiHistory.delete(id);
    return send(id, "🤖 На сьогодні я вже наговорився 😅 Продовжую шукати тобі живу людину — а поки загляни в 🍾 гру чи на 🧱 стіну зізнань.");
  }
  run("insert into ai_usage (user_id, day, n) values (?, ?, 1) on conflict (user_id, day) do update set n = n + 1", id, day);
  const hist = aiHistory.get(id) ?? [];
  hist.push({ role: "user", text: String(text).slice(0, 800) });
  aiBusy.add(id);
  try { await tg("sendChatAction", { chat_id: id, action: "typing" }); } catch {}
  let answer;
  try { answer = await chatReply(aiSystem(id), hist.slice(-16)); }
  catch (err) { console.error("[bot] ai", err.message); answer = null; }
  finally { aiBusy.delete(id); }
  // Поки ШІ думав, людину могли з’єднати з живим співрозмовником.
  if (!one("select ai_chat from users where id = ?", id)?.ai_chat) return;
  if (!answer) { hist.pop(); return send(id, "🤖 Щось я задумався… Напиши ще раз 🙂"); }
  answer = answer.replace(/^🤖\s*/, "").slice(0, 1500);
  hist.push({ role: "model", text: answer });
  aiHistory.set(id, hist.slice(-20));
  // Відповідь ШІ не перекладаємо — вона вже мовою людини.
  await tgRetry("sendMessage", { chat_id: id, text: `🤖 ${answer}` });
}

// 💡 Підказки для першого повідомлення: натиснув — питання пішло співрозмовнику.
const ICEBREAKERS = [
  "Яка твоя найдивніша звичка? 😅",
  "Куди б ти полетів(ла) прямо зараз, якби квиток був безкоштовний? ✈️",
  "Що тебе сьогодні порадувало?",
  "Яку пісню ти слухаєш на повторі останнім часом? 🎧",
  "Ти більше сова чи жайворонок? 🦉",
  "Яке найкраще побачення ти можеш уявити?",
  "Що ти ніколи не їв(ла) б навіть за гроші? 🤢",
  "Який фільм можеш переглядати безкінечно? 🎬",
  "Чим займаєшся, коли не сидиш у телефоні?",
  "Якби мав(ла) суперсилу на один день — яку б обрав(ла)? 🦸",
  "Що для тебе ідеальний вечір п’ятниці?",
  "Ти вже колись закохувався(лась) з першого погляду? 💘",
  "Кава чи чай? І чому саме так ☕",
  "Що найсміливіше ти робив(ла) у житті?",
  "Яка твоя улюблена погода і чому? ☀️",
];
async function sendIcebreakers(id) {
  const picks = [...ICEBREAKERS.keys()].sort(() => Math.random() - 0.5).slice(0, 3);
  await send(id, "💡 Не знаєш, з чого почати? Натисни — і питання піде співрозмовнику:", { inline_keyboard: picks.map((n) => [{ text: ICEBREAKERS[n], callback_data: `ice:${n}` }]) });
}
async function onIcebreaker(id, n, queryId) {
  const me = one("select status, partner_id from users where id = ?", id);
  const question = ICEBREAKERS[n];
  if (!question || me?.status !== "chat" || !me.partner_id) return tg("answerCallbackQuery", { callback_query_id: queryId, text: tr(id, "Діалог уже завершено.") });
  await tg("answerCallbackQuery", { callback_query_id: queryId, text: tr(id, "Надіслано ✅") });
  try { await send(me.partner_id, `💬 Співрозмовник питає:\n${question}`); }
  catch (err) { if (isGone(err)) return disconnect(id, "gone"); throw err; }
  await send(id, `Ти запитав(ла): ${question}`);
}

// ⚡ Швидке побачення: через 3 хвилини чат закривається і кожен ставить ❤️ чи 👋.
const SPEED_MS = Number(process.env.SPEED_MS) || 3 * 60 * 1000; // SPEED_MS — лише для тестів
function startSpeedTimer(a, b) {
  const t = setTimeout(async () => {
    const me = one("select status, partner_id from users where id = ?", a);
    if (me?.status !== "chat" || me.partner_id !== b) return;
    try { await disconnect(a, "timeup"); } catch (err) { console.error("[bot] speed", err.message); }
  }, SPEED_MS);
  t.unref?.();
  const warn = setTimeout(async () => {
    const me = one("select status, partner_id from users where id = ?", a);
    if (me?.status !== "chat" || me.partner_id !== b) return;
    for (const who of [a, b]) { try { await send(who, "⏳ Залишилось 30 секунд!"); } catch {} }
  }, Math.max(1000, SPEED_MS - 30_000));
  warn.unref?.();
}

// 🎉 Вечірка о 21:00 (Київ): о 20:50 кличемо тих, хто заходив за тиждень, о 21:00 — подвійні серця на годину.
const PARTY_INVITE = "20:50";
const PARTY_START = "21:00";
function kyivNow() {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-GB", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(new Date()).map((p) => [p.type, p.value]));
  return { day: `${parts.year}-${parts.month}-${parts.day}`, hm: `${parts.hour}:${parts.minute}` };
}
// Тема вечора залежить від дня тижня (0 — неділя).
const PARTY_THEMES = [
  { event: "double_hearts", text: "🌙 Тихий вечір питань о 21:00!\nВідповідай на 🌙 питання дня, читай 🧱 стіну зізнань — а в 🍾 бутилочці годину подвійні серця ❤️×2.", buttons: [[{ text: "🌙 Питання дня", callback_data: "wall:qotd" }], [{ text: "🍾 У гру", web_app: { url: GAME_URL } }]] },
  { event: "double_hearts", text: "💌 Ніч зізнань о 21:00!\nНапиши анонімне зізнання на 🧱 стіну або комусь особисто. А в 🍾 бутилочці годину подвійні серця ❤️×2.", buttons: [[{ text: "🧱 Стіна зізнань", callback_data: "wall:v:w:0" }], [{ text: "🍾 У гру", web_app: { url: GAME_URL } }]] },
  { event: "double_hearts", text: "⚡ Вечір швидких побачень о 21:00!\n3 хвилини з новою людиною, потім ❤️ чи 👋. Взаємна симпатія — і чат відкриється знову 💞", buttons: [[{ text: "⚡ Швидке побачення", callback_data: "find:speed" }], [{ text: "🍾 У гру", web_app: { url: GAME_URL } }]] },
  { event: "double_hearts", text: "💖 Середа подвійних сердець о 21:00!\nЦілу годину в 🍾 бутилочці реакції, поцілунки й подарунки дають ×2 ❤️ — і очки сезону 🏆", buttons: [[{ text: "🍾 На вечірку", web_app: { url: GAME_URL } }]] },
  { event: "free_rose", text: "🌹 Четвер троянд о 21:00!\nКожен отримає безкоштовну троянду в гру — подаруй її тому, хто сподобається, разом із запрошенням наодинці 🔒", buttons: [[{ text: "🍾 На вечірку", web_app: { url: GAME_URL } }]] },
  { event: "double_hearts", text: "🎉 Велика п’ятнична вечірка о 21:00!\nУсі за столи 🍾: подвійні серця ❤️×2, бажання ✨ і корона 👑 найпопулярнішому.", buttons: [[{ text: "🍾 На вечірку", web_app: { url: GAME_URL } }]] },
  { event: "double_hearts", text: "✨ Субота бажань о 21:00!\nЗагадай бажання в 🍾 бутилочці — хто виконає найкраще, отримає корону 👑. І годину подвійні серця ❤️×2.", buttons: [[{ text: "🍾 На вечірку", web_app: { url: GAME_URL } }]] },
];
function kyivWeekday() {
  const wd = new Intl.DateTimeFormat("en-US", { timeZone: TZ, weekday: "short" }).format(new Date());
  return ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(wd);
}
let partyBusy = false;
export async function partyTick(startEvent) {
  const { day, hm } = kyivNow();
  const theme = PARTY_THEMES[kyivWeekday()] ?? PARTY_THEMES[3];
  if (hm === PARTY_START && run("insert into party_log (day) values (?) on conflict do nothing", day + ":start").changes) {
    try { startEvent?.(theme.event); if (theme.event !== "double_hearts") startEvent?.("double_hearts"); } catch (err) { console.error("[bot] party event", err.message); }
  }
  await weeklyTopTick();
  if (hm < PARTY_INVITE || hm >= PARTY_START || partyBusy) return;
  if (!run("insert into party_log (day) values (?) on conflict do nothing", day).changes) return;
  partyBusy = true;
  try {
    const rows = q("select id from users where adult = 1 and banned = 0 and status <> 'chat' and last_seen > ? and id not in (select id from optout) and id not in (select id from party_off)", nowSec() - 7 * 86400);
    let sent = 0;
    for (const row of rows) {
      try {
        await send(row.id, theme.text, { inline_keyboard: [...theme.buttons, [{ text: "🔕 Не кликати на вечірки", callback_data: "party:off" }]] });
        sent++;
      } catch (err) { if (!isGone(err)) console.error("[bot] party", err.message); }
      await new Promise((r) => setTimeout(r, 60));
    }
    run("update party_log set sent = ? where day = ?", sent, day);
    console.info(`[bot] вечірка: запрошено ${sent}`);
  } finally { partyBusy = false; }
}
// 🏆 Щонеділі о 19:00 (Київ): топ-3 постів стіни за тиждень — усім, хто заходив за місяць.
let topBusy = false;
async function weeklyTopTick() {
  const { day, hm } = kyivNow();
  if (kyivWeekday() !== 0 || hm < "19:00" || hm >= "19:30" || topBusy) return;
  const posts = q("select p.text, (select count(*) from post_reactions r where r.post_id = p.id) as score from posts p where p.kind = 'wall' and p.hidden = 0 and p.created_at > ? order by score desc, p.created_at desc limit 3", nowSec() - 7 * 86400).filter((p) => p.score > 0);
  if (posts.length < 3) return;
  if (!run("insert into party_log (day) values (?) on conflict do nothing", day + ":top").changes) return;
  topBusy = true;
  try {
    const medals = ["🥇", "🥈", "🥉"];
    const body = posts.map((p, i) => `${medals[i]} ${p.text.length > 160 ? p.text.slice(0, 157) + "…" : p.text}\n   ❤️ ${p.score}`).join("\n\n");
    const rows = q("select id from users where adult = 1 and banned = 0 and last_seen > ? and id not in (select id from optout)", nowSec() - 30 * 86400);
    let sent = 0;
    for (const row of rows) {
      try { await send(row.id, `🏆 Топ стіни тижня\n\n${body}\n\nЧитай більше й пиши своє анонімно 👇`, { inline_keyboard: [[{ text: "🧱 Стіна зізнань", callback_data: "wall:v:w:0" }]] }); sent++; }
      catch (err) { if (!isGone(err)) console.error("[bot] weekly top", err.message); }
      await new Promise((r) => setTimeout(r, 60));
    }
    console.info(`[bot] топ стіни: надіслано ${sent}`);
  } finally { topBusy = false; }
}
async function askBack(id) {
  const me = one("select last_partner_id, status from users where id = ?", id);
  if (!me?.last_partner_id) return send(id, "Немає кого повертати.");
  const error = microCheck(id, "back", me.last_partner_id);
  if (error) return send(id, error);
  await starInvoice(id, "↩️ Повернути співрозмовника", "Колишній співрозмовник отримає запит продовжити розмову. Він може відмовитись.", `back:${me.last_partner_id}`, BACK_STARS);
}
// Чи можна зараз оплатити reveal/back. Повертає текст помилки або null.
function microCheck(payer, kind, target) {
  if (kind === "reveal") {
    const me = one("select status, partner_id from users where id = ?", payer);
    return me?.status === "chat" && me.partner_id === target ? null : "Діалог уже завершено.";
  }
  const other = one("select id, banned from users where id = ?", target);
  if (!other || other.banned) return "Цього співрозмовника вже немає.";
  if (one("select 1 as x from reports where reporter_id = ? and target_id = ?", target, payer)) return "Ця людина не хоче продовжувати розмову.";
  if (one("select status from users where id = ?", payer)?.status === "chat") return "Спочатку заверши поточний діалог.";
  return null;
}
async function refundStars(id, chargeId, why) {
  try { await tg("refundStarPayment", { user_id: Number(id), telegram_payment_charge_id: chargeId }); } catch (err) { console.error("[bot] refund", err.message); }
  run("delete from payments where charge_id = ?", chargeId);
  await send(id, why);
}
async function onMicroPaid(id, pay, kind, target) {
  const fresh = run("insert into payments (charge_id, user_id, payload, stars) values (?, ?, ?, ?) on conflict (charge_id) do nothing", pay.telegram_payment_charge_id, id, pay.invoice_payload, pay.total_amount).changes;
  if (!fresh) return;
  const price = kind === "reveal" ? REVEAL_STARS : BACK_STARS;
  const error = pay.currency !== "XTR" || pay.total_amount !== price ? "Ціна змінилась." : microCheck(id, kind, target);
  if (error) return refundStars(id, pay.telegram_payment_charge_id, `${error} Зірки повернено.`);
  if (kind === "reveal") {
    const c = one("select gender, profile_age, city, aim from users where id = ?", target);
    return send(id, `👀 Співрозмовник\nСтать: ${c?.gender ?? "не вказано"}\nВік: ${c?.profile_age ?? "не вказано"}\nМісто: ${c?.city ?? "не вказано"}\nЦіль: ${c?.aim ?? "не вказано"}`);
  }
  const req = code(8);
  run("delete from requests where from_id = ? and to_id = ?", id, target);
  run("insert into requests (id, from_id, to_id) values (?, ?, ?)", req, id, target);
  try {
    await send(target, "↩️ Колишній співрозмовник хоче продовжити розмову.", { inline_keyboard: [[{ text: "Прийняти", callback_data: `meet:yes:${req}` }, { text: "Ні", callback_data: `meet:no:${req}` }]] });
  } catch (err) {
    if (isGone(err)) return refundStars(id, pay.telegram_payment_charge_id, "Цього співрозмовника вже немає. Зірки повернено.");
    console.error("[bot] back", err.message);
  }
  await send(id, "Запит надіслано. Якщо людина прийме, діалог відкриється.");
}

async function startForm(id) {
  const me = ensure(id);
  if (me.banned) return send(id, "Доступ до бота обмежено.");
  if (!me.adult) return showAge(id);
  if (me.status === "chat") return send(id, "Спочатку заверши поточний діалог.");
  run("update users set pending = 'form_name' where id = ?", id);
  await send(id, "Анкета. Як тебе звати?");
}
async function askFormGender(id) { run("update users set pending = 'form_gender' where id = ?", id); await send(id, "Твоя стать?", choiceKb(["Чоловік", "Жінка", "Інше"])); }
async function askFormAge(id) { run("update users set pending = 'form_age' where id = ?", id); await send(id, "Скільки тобі років? Напиши число від 18 до 99."); }
async function askFormCity(id) { run("update users set pending = 'form_city' where id = ?", id); await send(id, "Звідки ти? Напиши місто або натисни «Моє місцезнаходження».", placeKb()); }
async function askFormAim(id) { run("update users set pending = 'form_aim' where id = ?", id); await send(id, "Яка ціль знайомства?", choiceKb(["Спілкування", "Дружба", "Стосунки", "Флірт"])); }
async function askFormAbout(id) { run("update users set pending = 'form_about' where id = ?", id); await send(id, "Коротко про себе. До 300 символів."); }
async function askFormPhoto(id) { run("update users set pending = 'form_photo' where id = ?", id); await send(id, "Натисни скріпку біля поля і надішли фото. Його побачать лише люди з Premium. Або натисни «Без фото».", choiceKb(["Без фото"])); }
async function finishForm(id) { run("update users set pending = null where id = ?", id); await showProfile(id); }

async function askGender(id, dating = false) {
  run("update users set pending = 'gender' where id = ?", id);
  await send(id, dating ? "Для знайомств обери свою стать. Її бачить лише людина, яку підбере анкета." : "Обери стать. У випадковому чаті її не показую.", { inline_keyboard: [[{ text: "Чоловік", callback_data: "gender:Чоловік" }, { text: "Жінка", callback_data: "gender:Жінка" }, { text: "Інше", callback_data: "gender:Інше" }]] });
}
async function askAge(id, dating = false) { run("update users set pending = 'age' where id = ?", id); await send(id, dating ? "Напиши свій вік числом, від 18 до 99. Він буде в анкеті." : "Напиши свій вік числом, від 18 до 99."); }
async function askCity(id) { run("update users set pending = 'city' where id = ?", id); await send(id, "Надішли місто або натисни «Моє місцезнаходження».", placeKb()); }
async function askLook(id) {
  run("update users set pending = null where id = ?", id);
  await send(id, "Кого шукати?", { inline_keyboard: [[{ text: "Чоловіка", callback_data: "look:Чоловік" }, { text: "Жінку", callback_data: "look:Жінка" }], [{ text: "Будь-кого", callback_data: "look:Будь-хто" }]] });
}
async function askBand(id) {
  await send(id, "Який вік шукати?", { inline_keyboard: [[{ text: "18–25", callback_data: "band:18:25" }, { text: "26–35", callback_data: "band:26:35" }], [{ text: "36–45", callback_data: "band:36:45" }, { text: "46+", callback_data: "band:46:99" }]] });
}
async function askLookCity(id) { run("update users set pending = 'look_city' where id = ?", id); await send(id, "Надішли місто, де шукати, або натисни «Моє місцезнаходження».", placeKb()); }
async function continueDating(id) {
  const p = one("select * from users where id = ?", id);
  if (!p?.gender) return askGender(id, true);
  if (!p.profile_age) return askAge(id, true);
  if (!p.city) return askCity(id);
  if (!p.look_gender) return askLook(id);
  if (!p.age_min) return askBand(id);
  if (!p.look_city) return askLookCity(id);
  run("update users set goal = null where id = ?", id);
  await enqueue(id, "dating");
}
async function startDating(id) {
  const me = ensure(id);
  if (me.banned) return send(id, "Доступ до бота обмежено.");
  if (!me.adult) return showAge(id);
  if (me.status === "chat") return send(id, "Спочатку заверши поточний діалог.");
  const row = one("select premium_until, search_credits from users where id = ?", id);
  if (!premiumActive(row?.premium_until) && Number(row?.search_credits ?? 0) < 1) { await send(id, "Пошук за віком, статтю і містом лише з Premium. Випадковий — безкоштовний."); await showPremium(id); return; }
  run("update users set goal = 'dating' where id = ?", id);
  await continueDating(id);
}

async function saveGender(id, gender) {
  run("update users set gender = ?, pending = null where id = ?", gender, id);
  if (!one("select adult from users where id = ?", id)?.adult) return showAge(id);
  const goal = one("select goal from users where id = ?", id);
  if (goal?.goal === "dating") return continueDating(id);
  await send(id, `Стать збережено: ${gender}.`);
}

async function savePending(id, pending, text) {
  if (pending === "form_name") {
    const name = text.trim().slice(0, 40);
    if (name.length < 2) return send(id, "Напиши ім’я, хоча б два символи.");
    run("update users set display_name = ? where id = ?", name, id);
    return askFormGender(id);
  }
  if (pending === "form_gender") {
    const map = { чоловік: "Чоловік", жінка: "Жінка", інше: "Інше" };
    const gender = map[text.trim().toLowerCase()];
    if (!gender) return askFormGender(id);
    run("update users set gender = ? where id = ?", gender, id);
    return askFormAge(id);
  }
  if (pending === "form_aim") {
    const aims = ["Спілкування", "Дружба", "Стосунки", "Флірт"];
    const aim = aims.find(item => item.toLowerCase() === text.trim().toLowerCase());
    if (!aim) return askFormAim(id);
    run("update users set aim = ? where id = ?", aim, id);
    return askFormAbout(id);
  }
  if (pending === "form_age") {
    const n = Number(text.trim());
    if (!Number.isInteger(n) || n < 18 || n > 99) return send(id, "Потрібне ціле число від 18 до 99.");
    run("update users set profile_age = ? where id = ?", n, id);
    return askFormCity(id);
  }
  if (pending === "form_city") {
    const value = text.trim().slice(0, 40);
    if (!value) return send(id, "Напиши назву міста.", placeKb());
    run("update users set city = ? where id = ?", value, id);
    return askFormAim(id);
  }
  if (pending === "form_about") {
    const about = text.trim().slice(0, 300);
    if (about.length < 2) return send(id, "Напиши хоча б кілька слів.");
    run("update users set interests = ? where id = ?", about, id);
    return askFormPhoto(id);
  }
  if (pending === "form_photo") {
    if (text.trim() === "Без фото" || text.trim() === "-") return finishForm(id);
    return askFormPhoto(id);
  }
  if (pending === "gender") {
    // Приймаємо лише відомі значення, інакше фільтр пошуку не працюватиме.
    const known = ["чоловік", "жінка", "інше"];
    const hit = known.find(g => g === text.trim().toLowerCase());
    if (!hit) return askGender(id, one("select goal from users where id = ?", id)?.goal === "dating");
    return saveGender(id, hit[0].toUpperCase() + hit.slice(1));
  }
  if (pending === "age") {
    const n = Number(text.trim());
    if (!Number.isInteger(n) || n < 18 || n > 99) return send(id, "Потрібне ціле число від 18 до 99.");
    run("update users set profile_age = ?, pending = null where id = ?", n, id);
    const goal = one("select goal from users where id = ?", id);
    if (goal?.goal === "dating") return continueDating(id);
    return send(id, `Вік збережено: ${n}.`);
  }
  if (pending === "city" || pending === "look_city") {
    let value = text.trim().slice(0, 40);
    if (!value) return send(id, "Напиши назву міста.");
    if (pending === "look_city" && (value === "." || ["моє", "мое", "my"].includes(value.toLowerCase()))) {
      value = (one("select city from users where id = ?", id)?.city ?? "").trim();
      if (!value) return send(id, "Спочатку напиши своє місто.");
    }
    if (pending === "city") run("update users set city = ?, pending = null where id = ?", value, id);
    else run("update users set look_city = ?, pending = null where id = ?", value, id);
    const goal = one("select goal from users where id = ?", id);
    if (goal?.goal === "dating") return continueDating(id);
    return send(id, "Місто збережено.");
  }
  if (pending === "interests") {
    const interests = text.trim().slice(0, 300);
    if (!interests) return send(id, "Напиши хоча б кілька слів.");
    run("update users set interests = ?, pending = null where id = ?", interests, id);
    await send(id, "Інтереси збережено.");
  }
}

async function onLocation(id, lat, lon) {
  const me = ensure(id);
  if (me.banned) return send(id, "Доступ до бота обмежено.");
  if (!me.adult) return showAge(id);
  const row = one("select pending, goal from users where id = ?", id);
  // Геопозиція має сенс лише тоді, коли бот чекає місто.
  if (!["city", "look_city", "form_city"].includes(row?.pending)) return send(id, "Зараз місто не потрібне.");
  const city = await cityFromCoords(lat, lon);
  if (!city) return send(id, "Не бачу місто за цією точкою. Напиши його словами.", placeKb());
  if (row.pending === "form_city") { run("update users set city = ? where id = ?", city, id); return askFormAim(id); }
  if (row.pending === "look_city") run("update users set look_city = ?, pending = null where id = ?", city, id);
  else run("update users set city = ?, pending = null where id = ?", city, id);
  if (row.goal === "dating") return continueDating(id);
  await send(id, `Місто: ${city}.`);
}

async function saveFormPhoto(id, sizes) {
  const file = sizes[sizes.length - 1];
  if (!file || (file.file_size ?? 0) > 8_000_000) { await send(id, "Це фото завелике. Надішли інше.", choiceKb(["Без фото"])); return; }
  try {
    const bytes = await shrink(await downloadFile(file.file_id));
    run("delete from photos where user_id = ?", id);
    run("insert into photos (id, user_id, bytes, created_at) values (?, ?, ?, ?)", code(10), id, bytes, nowSec());
  } catch { await send(id, "Не вдалося зберегти фото. Надішли ще раз або натисни «Без фото».", choiceKb(["Без фото"])); return; }
  await finishForm(id);
}

async function reportPartner(id) {
  const me = one("select status, partner_id from users where id = ?", id);
  if (!me || me.status !== "chat" || !me.partner_id) return send(id, "Скаржитись можна лише під час діалогу.");
  run("insert into reports (reporter_id, target_id, created_at) values (?, ?, ?)", id, me.partner_id, nowSec());
  await disconnect(id, "report");
  await send(id, "Скаргу збережено. Діалог завершено.");
}

async function askMeet(id, publicCode) {
  const me = ensure(id);
  if (me.banned) return send(id, "Доступ до бота обмежено.");
  if (!me.adult) return showAge(id);
  if (me.status === "chat") return send(id, "Спочатку заверши поточний діалог.");
  const person = one("select * from users where public_code = ? and adult = 1 and banned = 0 limit 1", publicCode);
  if (!person) return send(id, "Цієї анкети вже немає.");
  if (person.id === id) return send(id, "Це твоя анкета. Написати собі не вийде.");
  const req = code(8);
  run("delete from requests where from_id = ? and to_id = ?", id, person.id);
  run("insert into requests (id, from_id, to_id) values (?, ?, ?)", req, id, person.id);
  const mine = one("select * from users where id = ?", id);
  const who = [mine?.display_name, mine?.profile_age, mine?.city, mine?.aim].filter(Boolean).join(", ");
  const them = [person.display_name, person.profile_age, person.city].filter(Boolean).join(", ");
  await send(id, `Запит пішов: ${them || "анкета"}. Якщо людина прийме, відкриється діалог.`);
  try {
    await send(person.id, `Хочуть написати.\n${who || "Анкета без імені"}`, { inline_keyboard: [[{ text: "Прийняти", callback_data: `meet:yes:${req}` }, { text: "Ні", callback_data: `meet:no:${req}` }]] });
  } catch (err) { if (!isGone(err)) console.error("[bot] meet", err.message); }
}

async function acceptMeet(id, req, yes) {
  const row = one("select * from requests where id = ? and to_id = ?", req, id);
  run("delete from requests where id = ?", req);
  if (!row) return send(id, "Запит уже не діє.");
  if (!yes) {
    await send(id, "Запит відхилено.");
    try { await send(row.from_id, "Людина не прийняла запит."); } catch (err) { if (!isGone(err)) console.error("[bot] meet", err.message); }
    return;
  }
  const opened = await withLock(() => {
    const people = q("select id, status from users where id = ? or id = ?", row.from_id, row.to_id);
    if (people.length < 2 || people.some(person => person.status === "chat")) return false;
    run("update users set status = 'chat', partner_id = ?, last_partner_id = ?, search_mode = null, pending = null where id = ?", row.to_id, row.to_id, row.from_id);
    run("update users set status = 'chat', partner_id = ?, last_partner_id = ?, search_mode = null, pending = null where id = ?", row.from_id, row.from_id, row.to_id);
    return true;
  });
  if (!opened) {
    await send(id, "Зараз не вийшло: хтось уже в діалозі.");
    try { await send(row.from_id, "Зараз не вийшло відкрити діалог. Спробуй ще раз."); } catch {}
    return;
  }
  await send(row.from_id, "Людина прийняла запит. Пиши. «Завершити діалог» зупиняє розмову.");
  await send(id, "Діалог відкрито. Пиши. «Завершити діалог» зупиняє розмову.");
}

async function broadcast(adminChat, text) {
  const rows = q("select id from users where adult = 1 and banned = 0 and id not in (select id from optout)");
  let sent = 0, blocked = 0, failed = 0;
  for (const row of rows) {
    const footer = "\n\n" + tr(row.id, "Щоб відписатись від новин: /stopnews");
    const full = text.slice(0, 4096 - footer.length) + footer; // футер не обрізається
    try { await tgRetry("sendMessage", { chat_id: row.id, text: full }); sent++; }
    catch (err) { if (isGone(err)) blocked++; else failed++; }
    await new Promise(r => setTimeout(r, 50));
  }
  try { await send(adminChat, `Надіслано: ${sent} з ${rows.length}\nНедоступні: ${blocked}\nІнші помилки: ${failed}`); }
  catch (err) { console.error("[bot] broadcast", err.message); }
}

// Розсилка з монітора: кожен отримує текст своєю мовою (uk, ru, en). Одна розсилка за раз.
export const broadcastStatus = { running: false, total: 0, sent: 0, blocked: 0, failed: 0, startedAt: 0, finishedAt: 0 };
export function broadcastAll(texts) {
  if (broadcastStatus.running) return null;
  const rows = q("select id, lang, language_code from users where adult = 1 and banned = 0 and id not in (select id from optout)");
  Object.assign(broadcastStatus, { running: true, total: rows.length, sent: 0, blocked: 0, failed: 0, startedAt: Date.now(), finishedAt: 0 });
  void (async () => {
    for (const row of rows) {
      const lang = LANGS.includes(row.lang) ? row.lang : guessLang(row.language_code);
      const body = String(texts[lang] || texts.uk || "").trim();
      if (!body) { broadcastStatus.failed++; continue; }
      const footer = "\n\n" + L(lang, "Щоб відписатись від новин: /stopnews");
      // Разом з новиною оновлюємо меню: нові кнопки з'являються одразу, без /start.
      try { await tgRetry("sendMessage", { chat_id: row.id, text: body.slice(0, 4096 - footer.length) + footer, reply_markup: localizeMarkup(lang, menuFor(row.id)) }); broadcastStatus.sent++; }
      catch (err) { if (isGone(err)) broadcastStatus.blocked++; else broadcastStatus.failed++; }
      await new Promise((r) => setTimeout(r, 50));
    }
    broadcastStatus.running = false;
    broadcastStatus.finishedAt = Date.now();
  })();
  return rows.length;
}
export const newsAudience = () => one("select count(*) as n from users where adult = 1 and banned = 0 and id not in (select id from optout)")?.n ?? 0;

async function stats(chatId) {
  const now = nowSec();
  const s = one(`select count(*) as total, sum(adult = 1) as adults, sum(premium_until > ?) as prem, sum(status = 'search') as searching, sum(status = 'chat') as chatting, sum(banned = 1) as banned from users`, now);
  const opt = one("select count(*) as n from optout");
  await send(chatId, `Усього: ${s?.total ?? 0}\nПідтвердили 18+: ${s?.adults ?? 0}\nЗ Premium: ${s?.prem ?? 0}\nУ пошуку: ${s?.searching ?? 0}\nУ діалозі: ${s?.chatting ?? 0}\nЗаблоковані: ${s?.banned ?? 0}\nВідписані від новин: ${opt?.n ?? 0}`);
}

async function showLanguage(chatId) {
  await send(chatId, "Обери мову / Выбери язык / Choose language", { inline_keyboard: LANGS.map((l) => [{ text: LANG_NAMES[l], callback_data: `lang:${l}` }]) });
}

async function setLanguage(id, lang, queryId) {
  if (!LANGS.includes(lang)) return;
  const me = ensure(id);
  run("update users set lang = ? where id = ?", lang, id);
  await tg("answerCallbackQuery", { callback_query_id: queryId, text: LANG_NAMES[lang] }).catch(() => {});
  // Кнопка гри біля поля вводу — мовою користувача.
  await tg("setChatMenuButton", { chat_id: Number(id), menu_button: { type: "web_app", text: L(lang, BTN.game), web_app: { url: GAME_URL } } }).catch(() => {});
  if (me.banned) return send(id, "Доступ до бота обмежено.");
  if (!me.adult) return showAge(id);
  await showLobby(id, "Мову змінено: українська.");
}

async function onCommand(chatId, id, name, args, from) {
  if (name === "language" || name === "lang") { ensure(id, from); return showLanguage(chatId); }
  if (name === "settings") { ensure(id, from); return showSettings(id); }
  if (name === "reveal") { ensure(id, from); return askReveal(id); }
  if (name === "game") return send(chatId, "🍾 Запустити спільну гру:", { inline_keyboard: [[{ text: "ВІДКРИТИ ГРУ", web_app: { url: GAME_URL } }]] });
  run("update users set pending = null where id = ? and pending is not null", id);
  if (name !== "gender" && name !== "age") run("update users set goal = null where id = ? and goal = 'dating'", id);
  if (name === "myid") return send(chatId, `Твій ID: ${id}`);
  if (name === "stopnews") { run("insert into optout (id) values (?) on conflict (id) do nothing", id); return send(chatId, "✅ Ти відписався від новин бота."); }
  if (name === "startnews") { run("delete from optout where id = ?", id); return send(chatId, "✅ Ти знову підписаний на новини бота."); }
  if (name === "claim") {
    if (!CLAIM_CODE || args.trim() !== CLAIM_CODE) return;
    if (one("select id from admin limit 1")) return send(chatId, "Власника вже призначено.");
    run("insert into admin (id) values (?) on conflict (id) do nothing", id);
    return send(chatId, "Ти власник бота. Доступні /stats, /broadcast, /backup і /restore.");
  }
  if (name === "stats") { if (!isAdmin(id)) return; return stats(chatId); }
  if (name === "backup") { if (!isAdmin(id)) return; const dest = await backupDatabase(); const n = one("select count(*) as n from users")?.n ?? 0; return send(chatId, `Базу збережено. Користувачів: ${n}.\n${dest}`); }
  if (name === "restore") { if (!isAdmin(id)) return; const src = await restoreDatabase(); if (!src) return send(chatId, "Немає справної копії для відновлення."); const n = one("select count(*) as n from users")?.n ?? 0; return send(chatId, `Базу відновлено. Користувачів: ${n}.\n${src}`); }
  if (name === "broadcast") {
    if (!isAdmin(id)) return;
    if (!args.trim()) return send(chatId, "Напиши так: /broadcast текст повідомлення");
    await send(chatId, "Розсилку запущено.");
    void broadcast(chatId, args.trim());
    return;
  }
  if (name === "start") {
    const me = ensure(id, from);
    const startCode = args.trim();
    if (startCode.startsWith("meet_")) return askMeet(id, startCode.slice(5).replace(/[^a-z0-9]/gi, "").slice(0, 12));
    // 💌 Посилання для анонімних зізнань: ?start=c_<код власника>.
    if (startCode.startsWith("c_")) {
      const owner = one("select id, first_name from users where invite_code = ? limit 1", startCode.slice(2).replace(/[^a-z0-9]/gi, "").slice(0, 12));
      if (owner && owner.id === id) return showConfess(id);
      if (owner) {
        // Хто прийшов за посиланням зізнань — теж друг власника (бонус після перевірки віку).
        if (me.status === "new") run("update users set invited_by = ? where id = ? and invited_by is null and invite_rewarded = 0", owner.id, id);
        run("update users set confess_to = ?, confess_at = ? where id = ?", owner.id, nowSec(), id);
        if (me.banned) return send(chatId, "Доступ до бота обмежено.");
        if (!me.lang) run("update users set lang = ? where id = ? and lang is null", guessLang(me.language_code), id);
        if (!me.adult) {
          await send(chatId, `💌 ${nameFor(owner)} чекає на твоє анонімне повідомлення!

Два швидкі питання — і пиши. Ніхто не дізнається, що це ти 🤫`, { remove_keyboard: true });
          return showAge(chatId);
        }
        return askConfess(id, owner.id);
      }
    }
    // Рекламна мітка: запам'ятовуємо лише для нових людей, щоб не перебивати джерело.
    if (startCode.startsWith("ad_")) {
      const tag = startCode.slice(3).replace(/[^a-z0-9_-]/gi, "").slice(0, 40).toLowerCase();
      if (tag) run("update users set source = ? where id = ? and source is null and status = 'new'", tag, id);
    }
    // Запрошення друга: ?start=<код> або ?start=t_<код> («сідай за мій стіл»).
    const table = startCode.startsWith("t_");
    const inviteCode = table ? startCode.slice(2) : startCode;
    const src = inviteCode && !startCode.startsWith("ad_") ? one("select id from users where invite_code = ? and id <> ? limit 1", inviteCode, id) : null;
    // Бонус за запрошення — лише для щойно створених акаунтів; нагорода — після перевірки віку (rewardInvite).
    if (src && me.status === "new") run("update users set invited_by = ? where id = ? and invited_by is null and invite_rewarded = 0", src.id, id);
    // Посадити за стіл до друга, коли людина відкриє гру (діє годину).
    if (src && table) run("update users set join_with = ?, join_at = ? where id = ?", src.id, nowSec(), id);
    if (src && table && me.adult && !me.banned && me.status !== "chat") {
      return send(chatId, "🍾 Друг кличе тебе за свій стіл!", { inline_keyboard: [[{ text: "🍾 Сісти за стіл", web_app: { url: GAME_URL } }]] });
    }
    if (me.banned) return send(chatId, "Доступ до бота обмежено.");
    // Новачок спершу обирає мову.
    // Мова — автоматично з налаштувань Telegram; змінити можна кнопкою «🌐» на першому екрані.
    if (!me.lang) run("update users set lang = ? where id = ? and lang is null", guessLang(me.language_code), id);
    if (!me.adult) return showAge(chatId);
    if (me.status === "chat") return send(chatId, "Ти зараз у діалозі. «Завершити діалог» або /stop зупиняє його.");
    if (me.status === "search") return send(chatId, "Пошук ще триває.");
    run("update users set status = 'lobby' where id = ? and status = 'new'", id);
    return showLobby(chatId);
  }
  if (name === "search" || name === "next" || name === "stop") {
    const me = ensure(id, from);
    if (me.banned) return send(chatId, "Доступ до бота обмежено.");
    if (!me.adult) return showAge(chatId);
    if (name === "search") {
      if (me.status === "chat") return send(chatId, "Спочатку заверши поточний діалог.");
      return send(chatId, "Обери.", { inline_keyboard: [[{ text: "🎲 Випадково", callback_data: "find:random" }], [{ text: "⚡ Швидке побачення · 3 хв", callback_data: "find:speed" }], [{ text: "💞 За анкетою", callback_data: "find:dating" }]] });
    }
    if (name === "next") { if (me.status === "chat") return disconnect(id, "next"); return enqueue(id); }
    return disconnect(id, me.status === "search" ? "cancel" : "stop");
  }
  if (name === "profile") { ensure(id, from); return showProfile(id); }
  if (name === "photo") {
    const me = ensure(id, from);
    if (me.banned) return send(id, "Доступ до бота обмежено.");
    if (!me.adult) return showAge(id);
    if (me.status === "chat") return send(id, "Спочатку заверши поточний діалог.");
    return askFormPhoto(id);
  }
  if (name === "form" || name === "gender" || name === "age" || name === "interests") { ensure(id, from); return startForm(id); }
  if (name === "premium") { ensure(id, from); return showPremium(id); }
  if (name === "invite") { ensure(id, from); return showInvite(id); }
  if (name === "confess") { ensure(id, from); return showConfess(id); }
  if (name === "wall") { ensure(id, from); return showWall(id, "w", 0); }
  if (name === "question" || name === "qotd") { ensure(id, from); return showQotd(id); }
  if (name === "top" || name === "season") { ensure(id, from); return showTop(id); }
  if (name === "likes") { ensure(id, from); return showLikes(id); }
  if (name === "report") { ensure(id, from); return reportPartner(id); }
  if (name === "rules") return showRules(id);
  if (name === "help") return showHelp(id);
}

async function onText(message, id, text) {
  const cmd = text.startsWith("/") ? text.trim().split(/\s+/) : null;
  if (cmd) {
    const name = cmd[0].split("@")[0].slice(1).toLowerCase();
    return onCommand(String(message.chat.id), id, name, cmd.slice(1).join(" "), message.from);
  }
  const action = ACTIONS[text];
  if (action) return onCommand(String(message.chat.id), id, action, "", message.from);
  const me = ensure(id, message.from);
  if (me.banned) return send(id, "Доступ до бота обмежено.");
  if (!me.adult) return me.pending === "onb_age" ? onboardAge(id, text) : showAge(id);
  const pending = one("select pending from users where id = ?", id)?.pending;
  if (pending === "confess" && me.status !== "chat") return deliverConfession(id, text);
  if (pending === "wallpost" && me.status !== "chat") return savePost(id, "wall", text);
  if (pending === "qotd" && me.status !== "chat") return savePost(id, "qotd", text);
  if (pending?.startsWith("creply:") && me.status !== "chat") return deliverReply(id, pending.slice(7), text);
  // У діалозі текст завжди йде співрозмовнику, а не в анкету.
  if (pending && me.status !== "chat") return savePending(id, pending, ["form_gender", "form_aim", "form_photo", "gender"].includes(pending) ? toUk(text, CHOICE_WORDS) : text);
  if (me.status === "chat") return relay(message, id);
  if (me.status === "search" && me.ai_chat) return aiTalk(id, text);
  if (me.status === "search") return send(id, "Пошук ще триває. «Завершити діалог» скасовує його.");
  // Код зі сторіз друга (10 символів) — одразу пишемо йому анонімно.
  const typed = text.trim().toLowerCase().replace(/^код[:\s]*/i, "").replace(/^c_/, "");
  if (/^[a-f0-9]{10}$/.test(typed)) {
    const owner = one("select id, first_name from users where invite_code = ?", typed);
    if (owner && owner.id === id) return showConfess(id);
    if (owner) return send(id, `🎭 Це код ${nameFor(owner)}. Що робимо?`, { inline_keyboard: [
      [{ text: "💌 Написати анонімно", callback_data: `code:c:${typed}` }],
      [{ text: "🍾 Сісти за стіл у грі", callback_data: `code:t:${typed}` }],
    ] });
  }
  await showLobby(id);
}

async function onAge(id, yes, queryId) {
  const me = ensure(id);
  if (me.banned) {
    await tg("answerCallbackQuery", { callback_query_id: queryId });
    await send(id, "Доступ до бота обмежено.");
    return;
  }
  if (!yes) {
    if (me.status === "chat" || me.status === "search") await disconnect(id, "stop");
    run("update users set adult = 0, status = 'new' where id = ?", id);
    await tg("answerCallbackQuery", { callback_query_id: queryId, text: tr(id, "Бот лише для повнолітніх") });
    await send(id, "Тоді цей бот не для тебе. Повертайся, коли виповниться 18.");
    return;
  }
  run("update users set adult = 1, status = 'lobby' where id = ? and status <> 'chat'", id);
  await rewardInvite(id);
  await tg("answerCallbackQuery", { callback_query_id: queryId, text: tr(id, "Вік підтверджено") });
  await showLobby(id, "Вік підтверджено.");
}

export async function handleUpdate(update) {
  const seen = run("insert into updates (id) values (?) on conflict (id) do nothing", update.update_id);
  if (!seen.changes) return;
  // Таблиця дедуплікації не має рости безкінечно.
  if (update.update_id % 500 === 0) run("delete from updates where id < ?", update.update_id - 100000);
  if (update.pre_checkout_query) { try { await onPreCheckout(update.pre_checkout_query); } catch (err) { console.error("[bot] precheckout", err.message); } return; }
  const from = update.callback_query?.from ?? update.message?.from;
  if (!from) return;
  const id = String(from.id);
  // Оплату ніколи не відкидаємо антиспамом — інакше користувач заплатить і нічого не отримає.
  const paid = Boolean(update.message?.successful_payment);
  const gate = paid ? "ok" : spam(id);
  if (gate !== "ok") {
    if (gate === "warn") {
      const chat = update.message?.chat.id ?? update.callback_query?.message?.chat.id ?? from.id;
      try { await send(chat, "Не так швидко, зачекай кілька секунд."); } catch {}
    }
    if (update.callback_query) try { await tg("answerCallbackQuery", { callback_query_id: update.callback_query.id }); } catch {}
    return;
  }
  if (update.callback_query) {
    const data = update.callback_query.data ?? "";
    const queryId = update.callback_query.id;
    try {
      if (data === "age:yes") await onAge(id, true, queryId);
      else if (data === "age:no") await onAge(id, false, queryId);
      else if (data.startsWith("agen:")) {
        await tg("answerCallbackQuery", { callback_query_id: queryId });
        const me = ensure(id, from);
        const v = data.slice(5);
        if (me.adult || me.banned) { /* уже пройдено */ }
        else if (v === "40plus") { run("update users set pending = 'onb_age' where id = ?", id); await send(id, "Напиши свій вік числом, наприклад 45.", { remove_keyboard: true }); }
        else if (v === "minor") await onboardAge(id, "17");
        else await onboardAge(id, v);
      }
      else if (data.startsWith("gender:")) {
        const gender = data.slice("gender:".length);
        if (["Чоловік", "Жінка", "Інше"].includes(gender)) { ensure(id, from); await saveGender(id, gender); await tg("answerCallbackQuery", { callback_query_id: queryId, text: tr(id, "Збережено") }); }
        else await tg("answerCallbackQuery", { callback_query_id: queryId });
      }
      else if (data.startsWith("lang:")) { ensure(id, from); await setLanguage(id, data.slice(5), queryId); }
      else if (data.startsWith("conf:")) await onConfessCallback(id, data, queryId, from);
      else if (data.startsWith("wall:")) await onWallCallback(id, data, update.callback_query);
      else if (data.startsWith("code:")) {
        await tg("answerCallbackQuery", { callback_query_id: queryId });
        const [, what, c] = data.split(":");
        const owner = one("select id from users where invite_code = ?", String(c || "").replace(/[^a-f0-9]/g, "").slice(0, 10));
        const me = ensure(id, from);
        if (!owner || me.banned || !me.adult) await showLobby(id);
        else if (what === "c") await askConfess(id, owner.id);
        else { run("update users set join_with = ?, join_at = ? where id = ?", owner.id, nowSec(), id); await send(id, "🍾 Тебе вже чекають за столом:", { inline_keyboard: [[{ text: "🍾 Сісти за стіл", web_app: { url: GAME_URL } }]] }); }
      }
      else if (data === "ai:on") { await tg("answerCallbackQuery", { callback_query_id: queryId }); ensure(id, from); await aiStart(id); }
      else if (data.startsWith("likes:")) { ensure(id, from); await onLikesCallback(id, data, queryId); }
      else if (data.startsWith("like:")) { const [, v, tok] = data.split(":"); ensure(id, from); await onLike(id, v === "y", String(tok || "").replace(/[^a-f0-9]/g, "").slice(0, 12), queryId); }
      else if (data.startsWith("ice:")) { ensure(id, from); await onIcebreaker(id, Number(data.slice(4)), queryId); }
      else if (data === "party:off") { run("insert into party_off (id) values (?) on conflict do nothing", id); await tg("answerCallbackQuery", { callback_query_id: queryId }); await send(id, "🔕 Більше не кличу на вечірки. Увімкнути знову: ⚙️ Налаштування."); }
      else if (data === "find:speed") { await tg("answerCallbackQuery", { callback_query_id: queryId }); await enqueue(id, "speed"); }
      else if (data === "back") { await tg("answerCallbackQuery", { callback_query_id: queryId }); ensure(id, from); await askBack(id); }
      else if (data.startsWith("menu:")) {
        await tg("answerCallbackQuery", { callback_query_id: queryId });
        const item = data.slice(5);
        if (item === "lang") await showLanguage(id);
        else if (item === "rules") await showRules(id);
        else if (item === "help") await showHelp(id);
        else if (item === "form" || item === "photo") await onCommand(id, id, item, "", from);
        else if (item === "party") {
          const was = Boolean(one("select id from party_off where id = ?", id));
          if (was) run("delete from party_off where id = ?", id); else run("insert into party_off (id) values (?) on conflict do nothing", id);
          await send(id, was ? "🎉 Кликатиму на вечірки о 21:00." : "🔕 Більше не кличу на вечірки.");
        }
        else if (item === "news") {
          const off = Boolean(one("select id from optout where id = ?", id));
          if (off) run("delete from optout where id = ?", id); else run("insert into optout (id) values (?) on conflict (id) do nothing", id);
          await send(id, off ? "✅ Ти знову підписаний на новини бота." : "✅ Ти відписався від новин бота.");
        }
      }
      else if (data.startsWith("buy:")) { await tg("answerCallbackQuery", { callback_query_id: queryId }); await sendInvoice(id, data.slice(4)); }
      else if (data === "find:random") { await tg("answerCallbackQuery", { callback_query_id: queryId }); await enqueue(id, "random"); }
      else if (data === "find:dating") { await tg("answerCallbackQuery", { callback_query_id: queryId }); await startDating(id); }
      else if (data.startsWith("meet:")) { const [, answer, req] = data.split(":"); await tg("answerCallbackQuery", { callback_query_id: queryId }); await acceptMeet(id, (req ?? "").replace(/[^a-z0-9]/gi, "").slice(0, 12), answer === "yes"); }
      else if (data.startsWith("look:")) {
        const look = data.slice(5);
        if (["Чоловік", "Жінка", "Будь-хто"].includes(look)) run("update users set look_gender = ? where id = ?", look, id);
        await tg("answerCallbackQuery", { callback_query_id: queryId });
        await continueDating(id);
      }
      else if (data.startsWith("band:")) {
        const [min, max] = data.slice(5).split(":").map(Number);
        if (Number.isInteger(min) && Number.isInteger(max) && min >= 18 && max <= 99 && min <= max) run("update users set age_min = ?, age_max = ? where id = ?", min, max, id);
        await tg("answerCallbackQuery", { callback_query_id: queryId });
        await continueDating(id);
      }
      else await tg("answerCallbackQuery", { callback_query_id: queryId });
    } catch (err) {
      console.error("[bot] callback", err.message);
      try { await tg("answerCallbackQuery", { callback_query_id: queryId }); } catch {}
    }
    return;
  }
  const message = update.message;
  if (!message) return;
  if (message.chat.type !== "private") {
    // У групах відповідаємо лише на команди, щоб не спамити.
    if (typeof message.text === "string" && message.text.startsWith("/")) { try { await send(message.chat.id, "Напиши мені в особисті — так чат лишається анонімним.", { remove_keyboard: true }); } catch {} }
    return;
  }
  // `await` обов'язковий: без нього помилки з return-ed промісів не потрапляють у catch.
  try {
    if (message.successful_payment) return await onPaid(id, message.successful_payment);
    if (message.location) return await onLocation(id, message.location.latitude, message.location.longitude);
    if (message.photo?.length && one("select pending from users where id = ?", id)?.pending === "form_photo") return await saveFormPhoto(id, message.photo);
    if (typeof message.text === "string") return await onText(message, id, message.text);
    const me = ensure(id, from);
    if (me.banned) return await send(id, "Доступ до бота обмежено.");
    if (!me.adult) return await showAge(id);
    if (["confess", "wallpost", "qotd"].includes(me.pending) || me.pending?.startsWith("creply:")) return await send(id, "Поки що можна надіслати лише текст ✍️", cancelKb);
    if (me.status !== "chat") return await showLobby(id, "Фото, голос і стікери можна надсилати лише в діалозі.");
    await relay(message, id);
  } catch (err) { console.error("[bot] message", err.stack || err.message); }
}

const COMMANDS = [
  ["start", "Почати"], ["game", "Гра в бутилочку"], ["search", "Знайти співрозмовника"], ["next", "Наступний співрозмовник"],
  ["stop", "Завершити діалог"], ["profile", "Мій профіль"], ["form", "Заповнити анкету"], ["photo", "Завантажити фото"],
  ["premium", "Premium"], ["confess", "Анонімні зізнання"], ["wall", "Стіна зізнань"], ["question", "Питання дня"], ["top", "Рейтинг сезону"], ["likes", "Хто мене вподобав"], ["invite", "Запросити друзів"], ["report", "Поскаржитись"], ["rules", "Правила"], ["help", "Допомога"],
  ["settings", "Налаштування"], ["language", "Змінити мову"], ["myid", "Мій Telegram ID"], ["stopnews", "Відписатись від новин"], ["startnews", "Знову отримувати новини"],
];
export const commandList = (lang) => COMMANDS.map(([command, description]) => ({ command, description: L(lang, description) }));

// Опис, який люди бачать до /start і в пошуку Telegram.
const ABOUT = {
  uk: {
    short: "Нічний клуб у Telegram 🌙 Анонімні зізнання, гра в бутилочку і чат 18+ без імен і номерів.",
    long: "Невідомий — нічний клуб у Telegram, 18+ 🌙\n\n💌 Анонімні зізнання: виклади своє посилання — і дізнайся, що про тебе думають насправді\n🍾 Гра в бутилочку: завдання, поцілунки, подарунки\n🔍 Анонімний чат один на один — безкоштовно\n💞 Пошук за віком, статтю і містом\n\nНіхто не бачить твоє ім’я, юзернейм і номер.",
  },
  ru: {
    short: "Ночной клуб в Telegram 🌙 Анонимные признания, игра в бутылочку и чат 18+ без имён и номеров.",
    long: "Невідомий — ночной клуб в Telegram, 18+ 🌙\n\n💌 Анонимные признания: выложи свою ссылку — и узнай, что о тебе думают на самом деле\n🍾 Игра в бутылочку: задания, поцелуи, подарки\n🔍 Анонимный чат один на один — бесплатно\n💞 Поиск по возрасту, полу и городу\n\nНикто не видит твоё имя, юзернейм и номер.",
  },
  en: {
    short: "A night club in Telegram 🌙 Anonymous confessions, Spin the Bottle and 18+ chat — no names or numbers.",
    long: "Nevidomyi — a night club in Telegram, 18+ 🌙\n\n💌 Anonymous confessions: share your link and find out what people really think of you\n🍾 Spin the Bottle: dares, kisses, gifts\n🔍 Anonymous one-on-one chat — free\n💞 Search by age, gender and city\n\nNobody sees your name, username or phone number.",
  },
};

export async function publishCommands() {
  for (const lang of LANGS) {
    const scope = lang === "uk" ? {} : { language_code: lang };
    await tg("setMyCommands", { commands: commandList(lang), ...scope });
    await tg("setMyShortDescription", { short_description: ABOUT[lang].short, ...scope }).catch((err) => console.error("[bot] short description", err.message));
    await tg("setMyDescription", { description: ABOUT[lang].long, ...scope }).catch((err) => console.error("[bot] description", err.message));
  }
  await tg("setChatMenuButton", { menu_button: { type: "web_app", text: "🍾 Гра в бутилочку", web_app: { url: GAME_URL } } });
}

export function checkpoint() { db.exec("pragma wal_checkpoint(TRUNCATE)"); }

export async function backupDatabase() {
  mkdirSync(backupDir(), { recursive: true });
  try { checkpoint(); } catch {}
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const dest = join(backupDir(), `nevidomyi-${stamp}.sqlite`);
  await backup(db, dest);
  if (!isHealthy(dest)) { try { unlinkSync(dest); } catch {} throw new Error("копія не пройшла перевірку"); }
  for (const file of backupFiles().slice(14)) unlinkSync(file.path);
  return dest;
}

export async function restoreDatabase() {
  return withLock(async () => {
    const src = newestGoodBackup();
    if (!src) return null;
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const safety = join(backupDir(), `before-restore-${stamp}.sqlite`);
    try { checkpoint(); await backup(db, safety); } catch (err) { console.error("[bot] safety", err.message); }
    db.close();
    installCopy(src);
    db = openDatabase();
    restoredFrom = src;
    return src;
  });
}
