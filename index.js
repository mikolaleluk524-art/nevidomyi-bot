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
          await handleUpdate(update);
          // offset рухаємо лише після успішної обробки
          offset = update.update_id + 1;
          saveOffset();
        } catch (err) {
          console.error("[bot] update", err.message);
          // не рухаємо offset — Telegram надішле цей update ще раз
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
  createServer((req, res) => {
    const fresh = Date.now() - beat < 90_000;
    res.writeHead(fresh ? 200 : 503, { "content-type": "text/plain; charset=utf-8" });
    res.end(fresh ? "ok" : "poll stalled");
  }).listen(port, "0.0.0.0", () => {
    console.info(`[bot] health :${port}`);
  });
}

async function main() {
  listen();
  const stop = () => {
    try {
      checkpoint();
    } catch (err) {
      console.error("[bot] checkpoint", err.message);
    }
    process.exit(0);
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);

  await tg("deleteWebhook", { drop_pending_updates: false });
  try {
    await publishCommands();
  } catch (err) {
    console.error("[bot] commands", err.message);
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