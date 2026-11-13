/**
 * Логіка бота «Невідомий».
 * Токен і код власника тільки з process.env. Секрети в код не вписані.
 */

import { DatabaseSync, backup } from "node:sqlite";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdirSync, readdirSync, statSync, unlinkSync, copyFileSync, existsSync } from "node:fs";
import { readFile, writeFile, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const BOT_TOKEN = process.env.BOT_TOKEN || "";
export const BOT_USERNAME = process.env.BOT_USERNAME || "nevidomyi_chat_bot";
export const CLAIM_CODE = process.env.CLAIM_CODE || "";
export const ADMIN_ID = Number(process.env.ADMIN_ID || "0") || 0;
const FRIEND_PREMIUM = 3 * 60 * 60;
export const DB_PATH = join(process.env.DATA_DIR || dirname(fileURLToPath(import.meta.url)), "nevidomyi.sqlite");

if (!BOT_TOKEN) {
  console.error("Немає BOT_TOKEN. Задай змінну оточення і запусти знову.");
  process.exit(1);
}
if (!CLAIM_CODE) {
  console.error("Немає CLAIM_CODE. Задай змінну оточення і запусти знову.");
  process.exit(1);
}

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
  sub: {
    stars: 1000,
    seconds: 30 * 24 * 60 * 60,
    subscribe: true,
    title: "Підписка на чат знайомств",
    label: "30 днів",
  },
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

function backupDir() {
  return join(dirname(DB_PATH), "backups");
}

function dropSidecars() {
  for (const suffix of ["-wal", "-shm"]) {
    try {
      unlinkSync(DB_PATH + suffix);
    } catch {
      /* немає */
    }
  }
}

function isHealthy(path) {
  if (!existsSync(path)) return false;
  let probe;
  try {
    probe = new DatabaseSync(path, { readOnly: true });
    const row = probe.prepare("pragma integrity_check").get();
    return row?.integrity_check === "ok";
  } catch {
    return false;
  } finally {
    try {
      probe?.close();
    } catch {
      /* ignore */
    }
  }
}

function backupFiles() {
  try {
    return readdirSync(backupDir())
      .filter((name) => name.startsWith("nevidomyi-") && name.endsWith(".sqlite"))
      .map((name) => ({ path: join(backupDir(), name), time: statSync(join(backupDir(), name)).mtimeMs }))
      .sort((a, b) => b.time - a.time);
  } catch {
    return [];
  }
}

function newestGoodBackup() {
  return backupFiles().find((file) => isHealthy(file.path))?.path ?? null;
}

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
if (!existsSync(DB_PATH) || !isHealthy(DB_PATH)) {
  const src = newestGoodBackup();
  if (src) {
    installCopy(src);
    restoredFrom = src;
    console.info(`[bot] базу відновлено з ${src}`);
  }
}

let db = openDatabase();

const q = (sql, ...params) => db.prepare(sql).all(...params);
const one = (sql, ...params) => db.prepare(sql).get(...params);
const run = (sql, ...params) => db.prepare(sql).run(...params);

let lock = Promise.resolve();
function withLock(fn) {
  const job = lock.then(() => fn());
  lock = job.then(
    () => undefined,
    () => undefined,
  );
  return job;
}

function nowSec() {
  return Math.floor(Date.now() / 1000);
}
function code(len = 10) {
  return Math.random().toString(36).slice(2, 2 + len);
}
function planOf(payload) {
  const id = String(payload || "").replace(/^prem:/, "");
  return id in PLANS ? { id, ...PLANS[id] } : null;
}
function premiumActive(until) {
  return Number(until) > nowSec();
}

const hist = new Map();
function spam(id) {
  const now = Date.now();
  if (hist.size > 5000) {
    for (const [k, v] of hist) if (!v.length || now - v[v.length - 1] > 30_000) hist.delete(k);
  }
  const h = (hist.get(id) ?? []).filter((t) => now - t < 5000);
  h.push(now);
  hist.set(id, h);
  if (h.length > 8) return h.length === 9 ? "warn" : "drop";
  return "ok";
}

function menuKb() {
  return {
    keyboard: [
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
  return {
    keyboard: [[{ text: "Моє місцезнаходження", request_location: true }], ...menuKb().keyboard],
    resize_keyboard: true,
    is_persistent: true,
  };
}
function choiceKb(row) {
  return {
    keyboard: [row.map((text) => ({ text })), ...menuKb().keyboard],
    resize_keyboard: true,
    is_persistent: true,
  };
}
const kbAge = {
  inline_keyboard: [
    [
      { text: "Мені є 18", callback_data: "age:yes" },
      { text: "Мені немає 18", callback_data: "age:no" },
    ],
  ],
};

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
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      return await tg(method, body);
    } catch (err) {
      if (!err.retryAfter || attempt === 3) throw err;
      await new Promise((r) => setTimeout(r, (err.retryAfter + 0.5) * 1000));
    }
  }
}
async function send(chatId, text, reply_markup) {
  await tgRetry("sendMessage", {
    chat_id: chatId,
    text,
    reply_markup: reply_markup ?? menuKb(),
  });
}
async function downloadFile(fileId) {
  const file = await tg("getFile", { file_id: fileId });
  if (!file.file_path || (file.file_size ?? 0) > 8_000_000) throw new Error("photo too large");
  const res = await fetch(`https://api.telegram.org/file/bot${BOT_TOKEN}/${file.file_path}`, {
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error("photo download");
  return new Uint8Array(await res.arrayBuffer());
}
async function sendPhoto(chatId, bytes, caption) {
  const form = new FormData();
  form.set("chat_id", String(chatId));
  form.set("caption", caption.slice(0, 1000));
  form.set("photo", new Blob([bytes], { type: "image/jpeg" }), "photo.jpg");
  const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendPhoto`, {
    method: "POST",
    body: form,
    signal: AbortSignal.timeout(20_000),
  });
  const data = await res.json();
  if (!data.ok) throw new Error(data.description || "sendPhoto");
}

const exec = promisify(execFile);
async function shrink(raw) {
  const stamp = `${Date.now()}-${code(6)}`;
  const input = `/tmp/nv-in-${stamp}`;
  const output = `/tmp/nv-out-${stamp}.jpg`;
  await writeFile(input, raw);
  try {
    await exec("ffmpeg", ["-y", "-i", input, "-vf", "scale=720:720:force_original_aspect_ratio=decrease", "-q:v", "7", output]);
    const bytes = await readFile(output);
    if (bytes.length > 280_000) throw new Error("big");
    return bytes;
  } catch {
    if (raw.length <= 280_000) return raw;
    throw new Error("big");
  } finally {
    await unlink(input).catch(() => undefined);
    await unlink(output).catch(() => undefined);
  }
}

async function cityFromCoords(lat, lon) {
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
  const url = new URL("https://nominatim.openstreetmap.org/reverse");
  url.searchParams.set("lat", String(lat));
  url.searchParams.set("lon", String(lon));
  url.searchParams.set("format", "jsonv2");
  url.searchParams.set("accept-language", "uk");
  const res = await fetch(url, { headers: { "user-agent": "NevidomyiBot/1.0" } });
  if (!res.ok) return null;
  const data = await res.json();
  const address = data.address ?? {};
  const city = address.city || address.town || address.village || address.municipality || address.hamlet || address.county;
  return city ? String(city).slice(0, 40) : null;
}

function ensure(id, from) {
  const existing = one("select * from users where id = ?", id);
  if (!existing) {
    run(
      "insert into users (id, invite_code, public_code, created_at, last_seen) values (?, ?, ?, ?, ?)",
      id,
      BigInt(id).toString(36),
      code(8),
      nowSec(),
      nowSec(),
    );
  }
  if (from) {
    run(
      "update users set first_name = coalesce(?, first_name), username = ?, language_code = coalesce(?, language_code), last_seen = ? where id = ?",
      from.first_name ?? null,
      from.username ?? null,
      from.language_code ?? null,
      nowSec(),
      id,
    );
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
  await send(
    chatId,
    "Невідомий — анонімний чат.\n\nСпіврозмовник не бачить твоє ім’я, юзернейм і номер. Не надсилай контакти, адресу чи фото документів.\n\nБот лише для людей від 18 років. Підтверди вік.",
    kbAge,
  );
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
      if (!row?.gender || !row.profile_age || !row.city || !row.look_gender || !row.age_min || !row.look_city) {
        return { kind: "needprofile" };
      }
      if (!premium && Number(row.search_credits) < 1 && row.status !== "search") return { kind: "needpay" };
      const already = row.status === "search" && row.search_mode === "dating";
      if (!already) {
        if (!premium) {
          run(
            "update users set status = 'search', partner_id = null, priority = 0, search_mode = 'dating', search_credits = search_credits - 1 where id = ?",
            id,
          );
        } else {
          run(
            "update users set status = 'search', partner_id = null, priority = 0, search_mode = 'dating' where id = ?",
            id,
          );
        }
      }
      const look = row.look_gender ?? "Будь-хто";
      const min = row.age_min ?? 18;
      const max = row.age_max ?? 99;
      const place = row.look_city ?? "";
      const cand = one(
        `select id from users
         where status = 'search' and id <> ? and adult = 1 and banned = 0
           and gender is not null and profile_age is not null and city is not null
           and (? = 'Будь-хто' or gender = ?)
           and profile_age >= ? and profile_age <= ?
           and lower(city) = lower(?)
           and search_mode = 'dating'
           and (
             (look_gender is null or look_gender = 'Будь-хто' or look_gender = ?)
             and ? >= coalesce(age_min, 18)
             and ? <= coalesce(age_max, 99)
             and lower(?) = lower(coalesce(look_city, city))
           )
         order by case when id = ? then 1 else 0 end, random()
         limit 1`,
        id,
        look,
        look,
        min,
        max,
        place,
        row.gender ?? "",
        row.profile_age ?? 0,
        row.profile_age ?? 0,
        row.city ?? "",
        me.last_partner_id,
      );
      if (!cand) return { kind: "waiting", mode: "dating" };
      run("update users set status = 'chat', partner_id = ?, last_partner_id = ?, priority = 0 where id = ?", id, id, cand.id);
      run("update users set status = 'chat', partner_id = ?, last_partner_id = ?, priority = 0 where id = ?", cand.id, cand.id, id);
      return { kind: "matched", other: cand.id, mode: "dating" };
    }
    if (row?.status !== "search" || row.search_mode === "dating") {
      run(
        "update users set status = 'search', partner_id = null, priority = 0, search_mode = 'random' where id = ?",
        id,
      );
    }
    const cand = one(
      `select id from users
       where status = 'search' and id <> ? and adult = 1 and banned = 0
         and coalesce(search_mode, 'random') = 'random'
       order by case when id = ? then 1 else 0 end, random()
       limit 1`,
      id,
      me.last_partner_id,
    );
    if (!cand) return { kind: "waiting", mode: "random" };
    run("update users set status = 'chat', partner_id = ?, last_partner_id = ?, priority = 0 where id = ?", id, id, cand.id);
    run("update users set status = 'chat', partner_id = ?, last_partner_id = ?, priority = 0 where id = ?", cand.id, cand.id, id);
    return { kind: "matched", other: cand.id, mode: "random" };
  });
  if (result.kind === "needprofile") {
    await continueDating(id);
    return "needprofile";
  }
  if (result.kind === "needpay") {
    await send(id, "Пошук за віком, статтю і містом лише з Premium. Випадковий — безкоштовний.");
    await showPremium(id);
    return "needpay";
  }
  if (result.kind === "matched") {
    if (result.mode === "dating") {
      const mine = one("select * from users where id = ?", id);
      const theirs = one("select * from users where id = ?", result.other);
      const intro = "Знайомство за анкетою. Ім’я, юзернейм і номер не передаю.\n\n";
      const line = (c) => `Стать: ${c?.gender ?? "—"}\nВік: ${c?.profile_age ?? "—"}\nМісто: ${c?.city ?? "—"}\nЦіль: ${c?.aim ?? "—"}`;
      await sendMatch(id, `${intro}${line(theirs)}`, photoOf(result.other), premiumActive(mine?.premium_until));
      try {
        await sendMatch(result.other, `${intro}${line(mine)}`, photoOf(id), premiumActive(theirs?.premium_until));
      } catch (err) {
        if (isGone(err)) await disconnect(id, "gone");
      }
    } else {
      const text =
        "Співрозмовника знайдено. Пиши — я передам повідомлення без твого імені.\n\n«Наступний» шукає когось іншого. «Завершити діалог» зупиняє розмову.";
      await send(id, text);
      try {
        await send(result.other, text);
      } catch (err) {
        if (isGone(err)) await disconnect(id, "gone");
      }
    }
    return "matched";
  }
  if (result.kind === "waiting") {
    await send(
      id,
      result.mode === "dating"
        ? "Шукаю анкету за віком, статтю і містом. Якщо зараз нікого немає — зачекай."
        : "Шукаю випадкову людину. Це безкоштовно. Якщо черга порожня — зачекай.",
    );
    return "waiting";
  }
  return result.kind;
}

async function disconnect(id, mode) {
  const outcome = await withLock(() => {
    const me = one("select * from users where id = ?", id);
    if (!me) return { kind: "none" };
    if (me.status === "search") {
      run("update users set status = 'lobby', partner_id = null, priority = 0 where id = ?", id);
      return { kind: "cancelled" };
    }
    if (me.status === "chat" && me.partner_id) {
      const partner = me.partner_id;
      run("update users set status = 'lobby', partner_id = null, priority = 0 where id = ?", id);
      run(
        "update users set status = 'lobby', partner_id = null, priority = 0 where id = ? and partner_id = ?",
        partner,
        id,
      );
      return { kind: "left", partner };
    }
    return { kind: "lobby" };
  });
  if (outcome.kind === "cancelled") {
    await showLobby(id, "Пошук скасовано.");
    return;
  }
  if (outcome.kind === "left") {
    if (mode === "gone") await showLobby(id, "Співрозмовник недоступний.");
    else if (mode === "next") {
      try {
        await showLobby(outcome.partner, "Співрозмовник пішов шукати когось іншого.");
      } catch (err) {
        if (!isGone(err)) console.error("[bot] notify", err.message);
      }
      await enqueue(id);
    } else {
      await showLobby(id, "Діалог завершено.");
      try {
        await showLobby(outcome.partner, "Співрозмовник завершив діалог.");
      } catch (err) {
        if (!isGone(err)) console.error("[bot] notify", err.message);
      }
    }
   
