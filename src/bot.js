import { DatabaseSync, backup } from "node:sqlite";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomBytes } from "node:crypto";
import { mkdirSync, readdirSync, statSync, unlinkSync, copyFileSync, existsSync } from "node:fs";
import { readFile, writeFile, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Секрети — лише зі змінних середовища, не в коді.
export const BOT_TOKEN = process.env.BOT_TOKEN || "";
if (!BOT_TOKEN) throw new Error("Не задано змінну середовища BOT_TOKEN");
export const BOT_USERNAME = process.env.BOT_USERNAME || "nevidomyi_chat_bot";
export const CLAIM_CODE = process.env.CLAIM_CODE || ""; // порожній = /claim вимкнено
export const ADMIN_ID = Number(process.env.ADMIN_ID || 0);
const FRIEND_PREMIUM = 3 * 60 * 60;
const TZ = "Europe/Kiev"; // працює в усіх версіях ICU
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

function menuKb() {
  return {
    keyboard: [
      [{ text: "🍾 Гра в бутилочку", web_app: { url: "https://nevidomyi-bot-production-023c6fe9.up.railway.app/bottle.html" } }],
      [{ text: BTN.search }],
      [{ text: BTN.next }, { text: BTN.stop }],
      [{ text: BTN.form }],
      [{ text: BTN.photo }],
      [{ text: BTN.profile }, { text: BTN.premium }],
      [{ text: BTN.invite }, { text: BTN.report }],
      [{ text: BTN.rules }, { text: BTN.help }],
    ],
    resize_keyboard: true,
    is_persistent: true,
  };
}
function placeKb() {
  return { keyboard: [[{ text: "Моє місцезнаходження", request_location: true }], ...menuKb().keyboard], resize_keyboard: true, is_persistent: true };
}
function choiceKb(row) {
  return { keyboard: [row.map(text => ({ text })), ...menuKb().keyboard], resize_keyboard: true, is_persistent: true };
}
const kbAge = { inline_keyboard: [[{ text: "Мені є 18", callback_data: "age:yes" }, { text: "Мені немає 18", callback_data: "age:no" }]] };

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
async function send(chatId, text, reply_markup) {
  await tgRetry("sendMessage", { chat_id: chatId, text, reply_markup: reply_markup ?? menuKb() });
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
  form.set("caption", caption.slice(0, 1000));
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

async function showAge(chatId) {
  await send(chatId, "Невідомий — анонімний чат.\n\nСпіврозмовник не бачить твоє ім’я, юзернейм і номер. Не надсилай контакти, адресу чи фото документів.\n\nБот лише для людей від 18 років. Підтверди вік.", kbAge);
}
async function showLobby(chatId, lead) {
  await send(chatId, lead ?? "Ти в лобі.", menuKb());
}

async function sendMatch(to, body, bytes, premium) {
  if (bytes?.length && premium) {
    await sendPhoto(to, bytes, body);
    await send(to, "Пиши. «Наступний» шукає іншу анкету.", menuKb());
    return;
  }
  const locked = bytes?.length ? "\nФото є. Його видно лише з Premium." : "";
  await send(to, `${body}${locked}\n\nПиши. «Наступний» шукає іншу анкету.`, menuKb());
}
function photoOf(userId) {
  return one("select bytes from photos where user_id = ? order by created_at desc limit 1", userId)?.bytes ?? null;
}

async function enqueue(id, mode) {
  const result = await withLock(() => {
    const me = ensure(id);
    if (me.banned || !me.adult) return { kind: "closed" };
    if (me.status === "chat") return { kind: "busy" };
    const row = one("select * from users where id = ?", id);
    const want = mode ?? (row?.search_mode === "dating" ? "dating" : "random");
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
      const cand = one(`select id from users where status = 'search' and id <> ? and adult = 1 and banned = 0 and gender is not null and profile_age is not null and city is not null and (? = 'Будь-хто' or gender = ?) and profile_age >= ? and profile_age <= ? and lower(city) = lower(?) and search_mode = 'dating' and ((look_gender is null or look_gender = 'Будь-хто' or look_gender = ?) and ? >= coalesce(age_min, 18) and ? <= coalesce(age_max, 99) and lower(?) = lower(coalesce(look_city, city))) order by case when id = ? then 1 else 0 end, random() limit 1`, id, look, look, min, max, place, row.gender ?? "", row.profile_age ?? 0, row.profile_age ?? 0, row.city ?? "", me.last_partner_id);
      if (!cand) return { kind: "waiting", mode: "dating" };
      run("update users set status = 'chat', partner_id = ?, last_partner_id = ?, priority = 0, pending = null where id = ?", id, id, cand.id);
      run("update users set status = 'chat', partner_id = ?, last_partner_id = ?, priority = 0, pending = null where id = ?", cand.id, cand.id, id);
      return { kind: "matched", other: cand.id, mode: "dating" };
    }
    if (row?.status !== "search" || row.search_mode === "dating") run("update users set status = 'search', partner_id = null, priority = 0, search_mode = 'random' where id = ?", id);
    const cand = one(`select id from users where status = 'search' and id <> ? and adult = 1 and banned = 0 and coalesce(search_mode, 'random') = 'random' order by case when id = ? then 1 else 0 end, random() limit 1`, id, me.last_partner_id);
    if (!cand) return { kind: "waiting", mode: "random" };
    run("update users set status = 'chat', partner_id = ?, last_partner_id = ?, priority = 0, pending = null where id = ?", id, id, cand.id);
    run("update users set status = 'chat', partner_id = ?, last_partner_id = ?, priority = 0, pending = null where id = ?", cand.id, cand.id, id);
    return { kind: "matched", other: cand.id, mode: "random" };
  });
  if (result.kind === "needprofile") { await continueDating(id); return "needprofile"; }
  if (result.kind === "needpay") { await send(id, "Пошук за віком, статтю і містом лише з Premium. Випадковий — безкоштовний."); await showPremium(id); return "needpay"; }
  if (result.kind === "matched") {
    if (result.mode === "dating") {
      const mine = one("select * from users where id = ?", id);
      const theirs = one("select * from users where id = ?", result.other);
      const intro = "Знайомство за анкетою. Ім’я, юзернейм і номер не передаю.\n\n";
      const line = c => `Стать: ${c?.gender ?? "—"}\nВік: ${c?.profile_age ?? "—"}\nМісто: ${c?.city ?? "—"}\nЦіль: ${c?.aim ?? "—"}`;
      await sendMatch(id, `${intro}${line(theirs)}`, photoOf(result.other), premiumActive(mine?.premium_until));
      try { await sendMatch(result.other, `${intro}${line(mine)}`, photoOf(id), premiumActive(theirs?.premium_until)); }
      catch (err) { if (isGone(err)) await disconnect(id, "gone"); }
    } else {
      const text = "Співрозмовника знайдено. Пиши — я передам повідомлення без твого імені.\n\n«Наступний» шукає когось іншого. «Завершити діалог» зупиняє розмову.";
      await send(id, text);
      try { await send(result.other, text); }
      catch (err) { if (isGone(err)) await disconnect(id, "gone"); }
    }
    return "matched";
  }
  if (result.kind === "waiting") {
    await send(id, result.mode === "dating" ? "Шукаю анкету за віком, статтю і містом. Якщо зараз нікого немає — зачекай." : "Шукаю випадкову людину. Це безкоштовно. Якщо черга порожня — зачекай.");
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
  if (outcome.kind === "cancelled") { await showLobby(id, "Пошук скасовано."); return; }
  if (outcome.kind === "left") {
    if (mode === "gone") await showLobby(id, "Співрозмовник недоступний.");
    else if (mode === "next") {
      try { await showLobby(outcome.partner, "Співрозмовник пішов шукати когось іншого."); }
      catch (err) { if (!isGone(err)) console.error("[bot] notify", err.message); }
      await enqueue(id);
    } else {
      await showLobby(id, "Діалог завершено.");
      try { await showLobby(outcome.partner, "Співрозмовник завершив діалог."); }
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
  await send(id, `Профіль\nІм’я: ${p?.display_name ?? "не вказано"}\nСтать: ${p?.gender ?? "не вказано"}\nВік: ${p?.profile_age ?? "не вказано"}\nЗвідки: ${p?.city ?? "не вказано"}\nЦіль: ${p?.aim ?? "не вказано"}\nПро себе: ${p?.interests ?? "не вказано"}\nФото: ${pics?.n ? "є, бачать лише з Premium" : "немає"}\nPremium: ${p && premiumActive(p.premium_until) ? "активний" : "немає"}\nПошуків за анкетою: ${p?.search_credits ?? 0}\nЗапросив друзів: ${invites?.n ?? 0}`);
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
    title: plan.title,
    description: "subscribe" in plan ? "Чат знайомств на 30 днів. Далі Telegram спише 1000⭐ знову, поки не скасуєш підписку." : `${plan.label} за ${plan.stars}⭐. Оплата зірками Telegram.`,
    payload: `prem:${plan.id}`,
    currency: "XTR",
    provider_token: "",
    prices: [{ label: plan.label, amount: plan.stars }],
  };
  if ("subscribe" in plan) invoice.subscription_period = 2592000;
  await tg("sendInvoice", invoice);
}

async function onPreCheckout(query) {
  const plan = planOf(query.invoice_payload);
  const ok = Boolean(plan && query.currency === "XTR" && query.total_amount === plan.stars);
  await tg("answerPreCheckoutQuery", { pre_checkout_query_id: query.id, ok, error_message: ok ? undefined : "Тариф змінився. Відкрий Premium ще раз." });
}

async function onPaid(id, pay) {
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

async function showInvite(id) {
  const p = one("select * from users where id = ?", id);
  const invites = one("select count(*) as n from users where invited_by = ?", id);
  await send(id, `Надішли другу це посилання:\nhttps://t.me/${BOT_USERNAME}?start=${p?.invite_code ?? ""}\n\nУже запросили: ${invites?.n ?? 0}\nЗа кожного друга — 3 години Premium.`);
}
async function showRules(id) {
  await send(id, "📜 Правила\n• Лише 18+.\n• Не надсилай контакти, адресу, документи і посилання на свої профілі.\n• Не ображай співрозмовника.\n• «Завершити діалог» або /stop зупиняє розмову.\n• «Наступний» шукає іншу людину.\n• Скарга — кнопка під час діалогу.");
}
async function showHelp(id) {
  await send(id, "❓ Допомога\n🔍 Знайти — випадково безкоштовно або за анкетою з Premium\n⏭ Наступний — інша людина\n⛔ Завершити діалог — вийти\n📝 Заповнити анкету — ім’я, стать, вік, місто, ціль\n📷 Завантажити фото — скріпка, видно лише з Premium\n👤 Мій профіль — що вже збережено\n💎 Premium — зірки за пошук за анкетою\n🎁 Запросити друзів — 3 години Premium\n⚠️ Поскаржитись — лише в діалозі\n📜 Правила\n\n/myid — твій Telegram ID\n/stopnews — без новин\n/startnews — знову новини");
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
    if (pending === "look_city" && (value === "." || value.toLowerCase() === "моє" || value.toLowerCase() === "мое")) {
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
  await disconnect(id, "stop");
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
  const footer = "\n\nЩоб відписатись від новин: /stopnews";
  const full = text.slice(0, 4096 - footer.length) + footer; // футер не обрізається
  let sent = 0, blocked = 0, failed = 0;
  for (const row of rows) {
    try { await tgRetry("sendMessage", { chat_id: row.id, text: full }); sent++; }
    catch (err) { if (isGone(err)) blocked++; else failed++; }
    await new Promise(r => setTimeout(r, 50));
  }
  try { await send(adminChat, `Надіслано: ${sent} з ${rows.length}\nНедоступні: ${blocked}\nІнші помилки: ${failed}`); }
  catch (err) { console.error("[bot] broadcast", err.message); }
}

async function stats(chatId) {
  const now = nowSec();
  const s = one(`select count(*) as total, sum(adult = 1) as adults, sum(premium_until > ?) as prem, sum(status = 'search') as searching, sum(status = 'chat') as chatting, sum(banned = 1) as banned from users`, now);
  const opt = one("select count(*) as n from optout");
  await send(chatId, `Усього: ${s?.total ?? 0}\nПідтвердили 18+: ${s?.adults ?? 0}\nЗ Premium: ${s?.prem ?? 0}\nУ пошуку: ${s?.searching ?? 0}\nУ діалозі: ${s?.chatting ?? 0}\nЗаблоковані: ${s?.banned ?? 0}\nВідписані від новин: ${opt?.n ?? 0}`);
}

async function onCommand(chatId, id, name, args, from) {
  if (name === "game") return send(chatId, "🍾 Запустити спільну гру:", { inline_keyboard: [[{ text: "ВІДКРИТИ ГРУ", web_app: { url: "https://nevidomyi-bot-production-023c6fe9.up.railway.app/bottle.html" } }]] });
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
    // Бонус за запрошення — лише для щойно створених акаунтів.
    if (startCode && me.status === "new") {
      const src = one("select id from users where invite_code = ? and id <> ? limit 1", startCode, id);
      if (src) {
        const linked = run("update users set invited_by = ?, invite_rewarded = 1 where id = ? and invited_by is null and invite_rewarded = 0", src.id, id);
        if (linked.changes) {
          const now = nowSec();
          run("update users set premium_until = max(premium_until, ?) + ? where id = ?", now, FRIEND_PREMIUM, src.id);
          try { await send(src.id, "🎁 Друг зайшов за твоїм посиланням. Тобі 3 години Premium."); } catch (err) { if (!isGone(err)) console.error("[bot] invite", err.message); }
        }
      }
    }
    if (me.banned) return send(chatId, "Доступ до бота обмежено.");
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
      return send(chatId, "Обери.", { inline_keyboard: [[{ text: "Випадково", callback_data: "find:random" }], [{ text: "За анкетою", callback_data: "find:dating" }]] });
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
  if (!me.adult) return showAge(id);
  const pending = one("select pending from users where id = ?", id)?.pending;
  // У діалозі текст завжди йде співрозмовнику, а не в анкету.
  if (pending && me.status !== "chat") return savePending(id, pending, text);
  if (me.status === "chat") return relay(message, id);
  if (me.status === "search") return send(id, "Пошук ще триває. «Завершити діалог» скасовує його.");
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
    await tg("answerCallbackQuery", { callback_query_id: queryId, text: "Бот лише для повнолітніх" });
    await send(id, "Тоді цей бот не для тебе. Повертайся, коли виповниться 18.");
    return;
  }
  run("update users set adult = 1, status = 'lobby' where id = ? and status <> 'chat'", id);
  await tg("answerCallbackQuery", { callback_query_id: queryId, text: "Вік підтверджено" });
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
      else if (data.startsWith("gender:")) {
        const gender = data.slice("gender:".length);
        if (["Чоловік", "Жінка", "Інше"].includes(gender)) { ensure(id, from); await saveGender(id, gender); await tg("answerCallbackQuery", { callback_query_id: queryId, text: "Збережено" }); }
        else await tg("answerCallbackQuery", { callback_query_id: queryId });
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
    if (me.status !== "chat") return await showLobby(id, "Фото, голос і стікери можна надсилати лише в діалозі.");
    await relay(message, id);
  } catch (err) { console.error("[bot] message", err.stack || err.message); }
}

export async function publishCommands() {
  await tg("setMyCommands", {
    commands: [
      { command: "start", description: "Почати" },
      { command: "game", description: "Гра в бутилочку" },
      { command: "search", description: "Знайти співрозмовника" },
      { command: "next", description: "Наступний співрозмовник" },
      { command: "stop", description: "Завершити діалог" },
      { command: "profile", description: "Мій профіль" },
      { command: "form", description: "Заповнити анкету" },
      { command: "photo", description: "Завантажити фото" },
      { command: "premium", description: "Premium" },
      { command: "invite", description: "Запросити друзів" },
      { command: "report", description: "Поскаржитись" },
      { command: "rules", description: "Правила" },
      { command: "help", description: "Допомога" },
      { command: "myid", description: "Мій Telegram ID" },
      { command: "stopnews", description: "Відписатись від новин" },
      { command: "startnews", description: "Знову отримувати новини" },
    ],
  });
  await tg("setChatMenuButton", { menu_button: { type: "web_app", text: "🍾 Гра в бутилочку", web_app: { url: "https://nevidomyi-bot-production-023c6fe9.up.railway.app/bottle.html" } } });
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
