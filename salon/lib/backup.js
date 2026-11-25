// Резервні копії бази: щогодини (зберігаємо 48) і щодня (зберігаємо 90).
// Копія — повний знімок SQLite (VACUUM INTO), узгоджений навіть під час запису.
// Якщо підключено Telegram-зошит — копія кожні 2 години (якщо були зміни) йде ще й туди, поза Railway.
import { existsSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { BACKUP_DIR, db, getSecret, setSecret } from "./db.js";
import { sendDocumentToOwners } from "./telegram.js";

const KEEP_HOURLY = 48;
const KEEP_DAILY = 90;

const kyiv = (fmt) => new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Kyiv", ...fmt }).format(new Date());
const today = () => kyiv({ year: "numeric", month: "2-digit", day: "2-digit" });
const hour = () => kyiv({ hour: "2-digit", hourCycle: "h23" });

function snapshot(name) {
  const file = join(BACKUP_DIR, name);
  const tmp = file + ".tmp";
  if (existsSync(tmp)) unlinkSync(tmp);
  db.exec(`VACUUM INTO '${tmp.replace(/'/g, "''")}'`);
  renameSync(tmp, file);
  return file;
}

function rotate(prefix, keep) {
  const files = readdirSync(BACKUP_DIR).filter((f) => f.startsWith(prefix) && f.endsWith(".sqlite")).sort();
  for (const f of files.slice(0, Math.max(0, files.length - keep))) unlinkSync(join(BACKUP_DIR, f));
}

// «Відбиток» даних: змінюється, коли змінилися записи, клієнтки, бонуси, сертифікати, відгуки чи прайс.
function fingerprint() {
  return db
    .prepare(
      `SELECT (SELECT COALESCE(MAX(id),0) FROM booking_log) || '-' || (SELECT COUNT(*) FROM clients) || '-' ||
        (SELECT COALESCE(SUM(LENGTH(note) + bonus + LENGTH(name)),0) FROM clients) || '-' || (SELECT COALESCE(MAX(id),0) FROM bonus_log) || '-' ||
        (SELECT COALESCE(MAX(id),0) FROM gift_log) || '-' || (SELECT COUNT(*) FROM gift_certs) || '-' || (SELECT COUNT(*) || ':' || COALESCE(SUM(LENGTH(reply)),0) FROM reviews) || '-' ||
        (SELECT COALESCE(SUM(price + duration + active),0) FROM services) || '-' || (SELECT COUNT(*) FROM blocks) AS f`
    )
    .get().f;
}

async function sendToTelegram(file, silent) {
  const when = kyiv({ day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
  return sendDocumentToOwners(
    gzipSync(readFileSync(file)),
    `magiia-krasy-${today()}-${hour()}.sqlite.gz`,
    `🗄 Повна копія бази «Магія краси» · ${when}\nНічого робити не треба — просто не видаляйте. З будь-якої копії можна відновити все.`,
    silent
  );
}

/** Копія «зараз» у Telegram (кнопка «🗄 Копія бази»). */
export async function sendBackupNow() {
  const f = snapshot(`hourly-${today()}-${hour()}.sqlite`);
  setSecret("last_backup", String(Date.now()));
  const ok = await sendToTelegram(f, false);
  if (ok) {
    setSecret("tg_backup_at", String(Date.now()));
    setSecret("tg_backup_fp", fingerprint());
  }
  return ok;
}

/**
 * Копія поза Railway (у Telegram): кожні 2 години, якщо дані змінилися, і щонайменше раз на добу.
 * Надсилається тихо, без звуку.
 */
export async function telegramBackupTick() {
  const last = Number(getSecret("tg_backup_at")) || 0;
  const age = Date.now() - last;
  if (age < 2 * 3600_000) return;
  const fp = fingerprint();
  if (fp === getSecret("tg_backup_fp") && age < 24 * 3600_000) return;
  const f = snapshot(`hourly-${today()}-${hour()}.sqlite`);
  if (await sendToTelegram(f, true)) {
    setSecret("tg_backup_at", String(Date.now()));
    setSecret("tg_backup_fp", fp);
    setSecret("tg_backup_day", today());
  }
}

/** Робить потрібні копії: щогодинну завжди, щоденну — раз на добу. */
export async function runBackups() {
  try {
    snapshot(`hourly-${today()}-${hour()}.sqlite`);
    rotate("hourly-", KEEP_HOURLY);
    const daily = `daily-${today()}.sqlite`;
    if (!existsSync(join(BACKUP_DIR, daily))) {
      snapshot(daily);
      rotate("daily-", KEEP_DAILY);
    }
    setSecret("last_backup", String(Date.now()));
  } catch (e) {
    console.error("[backup]", e.message);
  }
}

export function listBackups() {
  return readdirSync(BACKUP_DIR)
    .filter((f) => f.endsWith(".sqlite"))
    .map((f) => ({ file: f, size: statSync(join(BACKUP_DIR, f)).size, at: statSync(join(BACKUP_DIR, f)).mtimeMs }))
    .sort((a, b) => b.at - a.at);
}

export const backupPath = (f) => (/^(hourly|daily)-[\d-]+\.sqlite$/.test(f) ? join(BACKUP_DIR, f) : null);

export function startBackups() {
  setTimeout(runBackups, 15_000).unref();
  setInterval(runBackups, 60 * 60_000).unref();
}
