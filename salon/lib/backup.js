// Резервні копії бази: щогодини (зберігаємо 48) і щодня (зберігаємо 90).
// Копія — повний знімок SQLite (VACUUM INTO), узгоджений навіть під час запису.
// Якщо підключено Telegram-зошит — щоденна копія ще й надсилається туди (поза Railway).
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

async function sendToTelegram(file) {
  return sendDocumentToOwners(
    gzipSync(readFileSync(file)),
    `magiia-krasy-${today()}.sqlite.gz`,
    `🗄 Резервна копія записів «Магія краси» за ${today()}.\nПросто зберігайте цей файл — з нього можна відновити все.`
  );
}

/** Копія «зараз» у Telegram (кнопка «🗄 Копія бази»). */
export async function sendBackupNow() {
  const f = snapshot(`hourly-${today()}-${hour()}.sqlite`);
  setSecret("last_backup", String(Date.now()));
  return sendToTelegram(f);
}

/** Робить потрібні копії: щогодинну завжди, щоденну — раз на добу. */
export async function runBackups() {
  try {
    snapshot(`hourly-${today()}-${hour()}.sqlite`);
    rotate("hourly-", KEEP_HOURLY);
    const daily = `daily-${today()}.sqlite`;
    if (!existsSync(join(BACKUP_DIR, daily))) {
      const f = snapshot(daily);
      rotate("daily-", KEEP_DAILY);
      if (getSecret("tg_backup_day") !== today()) {
        const sent = await sendToTelegram(f).catch((e) => (console.error("[backup tg]", e.message), false));
        if (sent) setSecret("tg_backup_day", today());
      }
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
