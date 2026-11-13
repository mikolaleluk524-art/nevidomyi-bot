/**
 * Логіка бота «Невідомий».
 */

import { DatabaseSync, backup } from "node:sqlite";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdirSync, readdirSync, statSync, unlinkSync, copyFileSync, existsSync } from "node:fs";
import { readFile, writeFile, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const BOT_TOKEN = "9198483171:AAGiByJqyY9mS6y1arfObdkWMOdBSHBuhRw";
export const BOT_USERNAME = process.env.BOT_USERNAME || "nevidomyi_chat_bot";
export const CLAIM_CODE = process.env.CLAIM_CODE || "secret123";
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