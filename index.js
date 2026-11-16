/**
 * Запуск бота 24/7. Логіка чату в src/bot.js.
 * Railway: один інстанс, том на DATA_DIR, команда node --experimental-sqlite index.js.
 */
import { createServer } from "node:http";
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  backupDatabase,
  BOT_USERNAME,
  checkpoint,
  DB_PATH,
  handleUpdate,
  publishCommands,
  tg,
} from "./src/bot.js";

const STALL_MS = 90_000;
const MAX_UPDATE_FAILURES = 3;
const SHUTDOWN_WAIT_MS = 8_000;

let beat = Date.now();
let generation = 0;
let offset = 0;
let stopping = false;
let inflight = null; // проміс поточного handleUpdate
const failures = new Map(); // update_id -> кількість невдач

const offsetFile = join(dirname(DB_PATH), "offset.txt");
const offsetTmp = `${offsetFile}.tmp`;

try {
  const n = Number(readFileSync(offsetFile, "utf8"));
  offset = Number.isFinite(n) && n > 0 ? n : 0;
} catch {
  offset = 0;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// атомарний запис: tmp + rename, щоб файл не пошкодився при падінні
function saveOffset() {
  writeFileSync(offsetTmp, String(offset));
  renameSync(offsetTmp, offsetFile);
}
