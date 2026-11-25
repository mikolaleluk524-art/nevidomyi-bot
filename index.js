/**
 * Запуск бота 24/7 + адмін API.
 * Railway: один інстанс, том на DATA_DIR, команда node --experimental-sqlite index.js
 *
 * Змінні:
 *   ADMIN_KEY — секрет для X-Admin-Key
 */

import { createServer } from "node:http";
import { DatabaseSync } from "node:sqlite";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  backupDatabase,
  BOT_USERNAME,
  checkpoint,
  DB_PATH,
  handleUpdate,
  publishCommands,
  tg,
} from "./src/bot.js";
import { adminRoutes } from "./admin.js";
import { attachBottleGame } from "./game-server.js";
import { handleGiftUpdate, publishGiftCommand } from "./gifts.js";

const DASHBOARD = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "dashboard.html"), "utf8");
const BOTTLE_GAME = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "bottle.html"), "utf8");

let beat = Date.now();
let generation = 0;
let offset = 0;
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
          // Подарунки (оплата зірками, /gift) обробляє gifts.js, решту — bot.js.
          if (!(await handleGiftUpdate(update))) await handleUpdate(update);
          offset = update.update_id + 1;
          saveOffset();
        } catch (err) {
          console.error("[bot] update", err.message);
        }
      }
    } catch (err) {
      if (generation !== gen) return;
      const msg = err instanceof Error ? err.message : "";
      if (msg.includes("Conflict") || msg.includes("terminated by other")) {
        console.error("[bot] інший процес уже тримає бота");
        await new Promise((r) => setTimeout(r, 1500));
        continue;
      }
      console.error("[bot] poll", msg || "fail");
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
}

function armWatchdog() {
  setInterval(() => {
    if (Date.now() - beat < 90_000) return;
    generation += 1;
    const gen = generation;
    beat = Date.now();
    console.info("[bot] опитування зависло, перезапуск");
    void loop(gen);
  }, 20_000);
}

function listen() {
  const port = Number(process.env.PORT || 8080);
  const server = createServer((req, res) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Headers", "X-Admin-Key, Content-Type");
    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    if (req.url === "/bottle.html" || req.url === "/bottle" || req.url.startsWith("/bottle.html?")) {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      res.end(BOTTLE_GAME);
      return;
    }

    if (req.url === "/" || req.url === "/admin" || req.url === "/admin/") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(DASHBOARD);
      return;
    }

    if (req.url.startsWith("/admin/")) {
      if (adminRoutes(req, res)) return;
    }

    const fresh = Date.now() - beat < 90_000;
    res.writeHead(fresh ? 200 : 503, { "content-type": "text/plain; charset=utf-8" });
    res.end(fresh ? "ok" : "poll stalled");
  });
  attachBottleGame(server);
  server.listen(port, "0.0.0.0", () => {
    console.info(`[bot] health + admin + bottle game :${port}`);
  });
}

// Міграція: час оплати для статистики за 24 год (старі записи лишаються без часу).
function migratePayments() {
  const d = new DatabaseSync(DB_PATH);
  try {
    const cols = d.prepare("pragma table_info(payments)").all();
    if (!cols.some((c) => c.name === "created_at")) d.exec("alter table payments add column created_at integer");
    d.exec("create trigger if not exists payments_stamp after insert on payments when new.created_at is null begin update payments set created_at = cast(strftime('%s','now') as integer) where charge_id = new.charge_id; end;");
  } finally {
    d.close();
  }
}

async function main() {
  try {
    migratePayments();
  } catch (err) {
    console.error("[bot] migrate", err.message);
  }
  listen();
  const stop = () => {
    try { checkpoint(); } catch (err) {
      console.error("[bot] checkpoint", err.message);
    }
    process.exit(0);
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);

  try {
    await tg("deleteWebhook", { drop_pending_updates: false });
  } catch (err) {
    console.error("[bot] deleteWebhook", err.message);
  }
  try {
    await publishCommands();
  } catch (err) {
    console.error("[bot] commands", err.message);
  }
  try {
    await publishGiftCommand();
  } catch (err) {
    console.error("[bot] gift command", err.message);
  }
  try {
    console.info(`[bot] резервна копія ${await backupDatabase()}`);
  } catch (err) {
    console.error("[bot] backup", err.message);
  }
  setInterval(() => {
    backupDatabase()
      .then((path) => console.info(`[bot] резервна копія ${path}`))
      .catch((err) => console.error("[bot] backup", err.message));
  }, 6 * 60 * 60 * 1000);

  generation += 1;
  beat = Date.now();
  console.info(`[bot] polling @${BOT_USERNAME}`);
  console.info(`[bot] база ${DB_PATH}`);
  armWatchdog();
  await loop(generation);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});