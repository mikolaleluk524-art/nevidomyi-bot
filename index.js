/**
 * Запуск бота 24/7. Логіка чату в src/bot.js.
 * Railway: один інстанс, том на DATA_DIR, команда node --experimental-sqlite index.js.
 */
import { createServer } from "node:http";
import { readFileSync, writeFileSync } from "node:fs";
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

let beat = Date.now();
let generation = 0;
let offset = 0;
const startedAt = Date.now(); // [СТАТИСТИКА]
const stats = { processed: 0, failed: 0 }; // [СТАТИСТИКА]
const offsetFile = join(dirname(DB_PATH), "offset.txt");

try {
  offset = Number(readFileSync(offsetFile, "utf8")) || 0;
} catch {
  offset = 0;
}

function saveOffset() {
  writeFileSync(offsetFile, String(offset));
}

async function loop(gen) {
  while (generation === gen) {
    try {
      const updates = await tg("getUpdates", {
        offset,
        timeout: 25,
        allowed_updates: ["message", "callback_query", "pre_checkout_query"],
      });
      beat = Date.now();
      for (const update of updates) {
        try {