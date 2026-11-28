/**
 * 📲 Сторіз однією кнопкою.
 * Міні-застосунок story.html питає в сервера код людини, малює картинку 1080×1920 з цим кодом,
 * завантажує її сюди, а потім викликає Telegram.WebApp.shareToStory з адресою картинки.
 * Картинка зберігається одна на людину (перезаписується) у <DATA_DIR>/stories.
 */

import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DB_PATH, storyInfo } from "./src/bot.js";
import { verifyInitData } from "./game-server.js";

const PAGE = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "story.html"), "utf8");
const DIR = join(dirname(DB_PATH), "stories");
const MAX_BYTES = 3_000_000;
mkdirSync(DIR, { recursive: true });

const tokenOf = (id, code, kind) => createHash("sha256").update(`${id}:${code}:story:${kind}`).digest("hex").slice(0, 20);
const json = (res, status, body) => { res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }); res.end(JSON.stringify(body)); };

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (c) => { size += c.length; if (size > limit) { reject(new Error("too_big")); req.destroy(); } else chunks.push(c); });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function who(initData) {
  const id = verifyInitData(initData);
  const info = storyInfo(id);
  if (!info) throw new Error("not_allowed");
  return { id, ...info };
}

/** Повертає true, якщо запит оброблено. */
export function storyRoutes(req, res) {
  const url = new URL(req.url, "http://x");
  if (url.pathname === "/story.html" || url.pathname === "/story") {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
    res.end(PAGE);
    return true;
  }
  if (url.pathname === "/story/me" && req.method === "POST") {
    readBody(req, 20_000).then((buf) => {
      const { initData } = JSON.parse(buf.toString("utf8") || "{}");
      const me = who(initData);
      json(res, 200, { code: me.code, link: me.link, tableLink: me.tableLink, lang: me.lang });
    }).catch((err) => json(res, 403, { error: err.message }));
    return true;
  }
  if (url.pathname === "/story/upload" && req.method === "POST") {
    readBody(req, MAX_BYTES).then((buf) => {
      const me = who(String(req.headers["x-init-data"] || ""));
      // Лише JPEG (починається з FF D8 FF).
      if (buf.length < 1000 || buf[0] !== 0xff || buf[1] !== 0xd8 || buf[2] !== 0xff) throw new Error("bad_image");
      const kind = req.headers["x-story-kind"] === "game" ? "game" : "confess";
      const token = tokenOf(me.id, me.code, kind);
      writeFileSync(join(DIR, `${token}.jpg`), buf);
      const host = process.env.RAILWAY_PUBLIC_DOMAIN || req.headers.host;
      json(res, 200, { url: `https://${host}/story/img/${token}.jpg?v=${Date.now()}`, link: kind === "game" ? me.tableLink : me.link });
    }).catch((err) => json(res, err.message === "too_big" ? 413 : 400, { error: err.message }));
    return true;
  }
  const img = /^\/story\/img\/([a-f0-9]{20})\.jpg$/.exec(url.pathname);
  if (img && req.method === "GET") {
    const file = join(DIR, `${img[1]}.jpg`);
    if (!existsSync(file)) { res.writeHead(404); res.end(); return true; }
    res.writeHead(200, { "content-type": "image/jpeg", "cache-control": "public, max-age=3600" });
    res.end(readFileSync(file));
    return true;
  }
  return false;
}
