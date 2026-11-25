/**
 * Гра «Бутилочка»: спільні столи до 10 людей.
 * Крутить той, чия черга. Пляшка обирає пару: того, хто крутить, і обраного гравця.
 * Пара вирішує: 💬 піти в чат у боті, 💋 поцілунок за столом або лишитись.
 * Чат відкривається лише коли обоє обрали «чат». Імена беруться з анкети бота, а не з Telegram.
 */

import { createHmac, timingSafeEqual } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { WebSocketServer, WebSocket } from "ws";
import { BOT_TOKEN, DB_PATH, tg } from "./src/bot.js";
import { createGiftInvoice, giftList, setGiftHooks } from "./gifts.js";

const GAME_PATH = "/game";
const SEATS = 10;
const SPIN_MS = 4200;
const TURN_MS = Number(process.env.GAME_TURN_MS) || 30_000;
const PAIR_MS = Number(process.env.GAME_PAIR_MS) || 25_000;

const TASKS = {
  truth: ["Яке твоє найсмішніше побачення?", "Яка твоя найбільша слабкість?", "Коли ти востаннє закохувався?", "Який твій найбільший секрет, яким можеш поділитися?", "Що тебе найбільше приваблює в людині?", "Який твій найбільш незручний момент?", "Кому ти хотів би зараз написати?", "Яка твоя найдивніша звичка?", "Що ти ніколи не пробачиш?", "Який комплімент ти пам'ятаєш досі?"],
  action: ["Зобрази свого партнера протягом 20 секунд.", "Заспівай приспів будь-якої пісні.", "Скажи три щирі компліменти.", "Протягом хвилини говори пошепки.", "Зобрази смішну емоцію.", "Розкажи анекдот.", "Покажи свій найкращий танець.", "Придумай партнерові прізвисько.", "Скажи щось приємне партнерові.", "Протягом наступного раунду відповідай тільки правду."],
  kiss: ["Повітряний поцілунок партнерові.", "Опиши свій ідеальний поцілунок.", "Скажи, що тобі найбільше подобається в партнері.", "Назви три риси, які тебе приваблюють.", "Придумай романтичне побачення.", "Надішли повітряний поцілунок у камеру."],
  adult: ["Який твій найбільш сміливий романтичний досвід?", "Що для тебе найпривабливіше в партнері?", "Яка твоя найбільш несподівана фантазія, якою комфортно поділитися?", "Що для тебе є найважливішим в інтимних стосунках?", "Який романтичний сценарій ти хотів би спробувати?"],
};
const CATS = Object.keys(TASKS);

const tables = new Map();
const sockets = new Map(); // id користувача -> сокет
let tableSeq = 0;

const pick = (list) => list[Math.floor(Math.random() * list.length)];
const safe = (fn) => (...args) => {
  try { return fn(...args); } catch (err) { console.error("[game]", err.message); }
};

function verifyInitData(raw) {
  if (!raw || !BOT_TOKEN) throw new Error("Відкрий гру через Telegram.");
  const params = new URLSearchParams(raw);
  const hash = params.get("hash");
  const authDate = Number(params.get("auth_date"));
  const userRaw = params.get("user");
  if (!hash || !userRaw || !Number.isFinite(authDate)) throw new Error("Некоректний initData");
  if (Math.abs(Date.now() / 1000 - authDate) > 86400) throw new Error("Сесія застаріла. Перезапусти гру.");
  const check = [...params.entries()]
    .filter(([key]) => key !== "hash")
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");
  const secret = createHmac("sha256", "WebAppData").update(BOT_TOKEN).digest();
  const expected = createHmac("sha256", secret).update(check).digest();
  let supplied;
  try { supplied = Buffer.from(hash, "hex"); } catch { throw new Error("Некоректний підпис"); }
  if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) throw new Error("Підпис Telegram не пройшов перевірку");
  const user = JSON.parse(userRaw);
  if (!user?.id) throw new Error("Telegram user відсутній");
  return String(user.id);
}

function withDb(fn) {
  const db = new DatabaseSync(DB_PATH);
  try {
    db.exec("pragma busy_timeout = 5000");
    return fn(db);
  } finally {
    db.close();
  }
}

// Звичайний діалог у боті, як після прийнятого запиту. true — відкрито.
function openDialog(a, b) {
  return withDb((db) => {
    try {
      db.exec("begin immediate");
      const rows = db.prepare("select status, adult, banned from users where id in (?, ?)").all(a, b);
      if (rows.length < 2 || rows.some((r) => r.status === "chat" || !r.adult || r.banned)) {
        db.exec("rollback");
        return false;
      }
      const set = db.prepare("update users set status = 'chat', partner_id = ?, last_partner_id = ?, search_mode = null, pending = null, priority = 0 where id = ?");
      set.run(b, b, a);
      set.run(a, a, b);
      db.exec("commit");
      return true;
    } catch (err) {
      try { db.exec("rollback"); } catch { /* вже закрито */ }
      console.error("[game] dialog", err.message);
      return false;
    }
  });
}

const send = (ws, payload) => { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(payload)); };
const seated = (t) => t.players.filter(Boolean);
const broadcast = (t, payload) => { for (const p of seated(t)) send(p.ws, payload); };
const nextSeat = (t, from) => {
  for (let i = 1; i <= SEATS; i++) {
    const s = (((from + i) % SEATS) + SEATS) % SEATS;
    if (t.players[s]) return s;
  }
  return -1;
};
const snapshot = (t) => ({
  type: "table",
  players: t.players.map((p) => p && { name: p.name, g: p.g }),
  turn: t.turn,
  phase: t.phase,
  round: t.round,
  pair: t.pair ? t.pair.seats : null,
  answered: t.pair ? Object.keys(t.pair.answers).map(Number) : [],
});

function clearTimers(t) {
  for (const key of Object.keys(t.timers)) clearTimeout(t.timers[key]);
  t.timers = {};
}

function armTurn(t) {
  clearTimeout(t.timers.turn);
  delete t.timers.turn;
  if (t.phase !== "idle") return;
  t.timers.turn = setTimeout(safe(() => {
    delete t.timers.turn;
    if (t.phase !== "idle") return;
    t.turn = nextSeat(t, t.turn);
    refresh(t);
  }), TURN_MS);
}

// Приводить стіл до ладу після будь-якої зміни і розсилає стан.
function refresh(t) {
  const n = seated(t).length;
  if (!n) {
    clearTimers(t);
    tables.delete(t.id);
    return;
  }
  if (n < 2) {
    clearTimers(t);
    t.phase = "wait";
    t.pair = null;
    t.turn = nextSeat(t, -1);
  } else {
    if (t.phase === "wait") t.phase = "idle";
    if (!t.players[t.turn]) t.turn = nextSeat(t, t.turn);
    if (t.phase === "idle" && !t.timers.turn) armTurn(t);
  }
  broadcast(t, snapshot(t));
}

function sit(ws) {
  let t = null;
  let best = -1;
  for (const c of tables.values()) {
    const k = seated(c).length;
    if (k < SEATS && k > best) { t = c; best = k; }
  }
  if (!t) {
    t = { id: ++tableSeq, players: Array(SEATS).fill(null), turn: 0, phase: "wait", round: 0, spinner: -1, target: -1, pair: null, timers: {} };
    tables.set(t.id, t);
  }
  const seat = t.players.indexOf(null);
  const { display_name: name, gender } = ws.profile;
  ws.table = t;
  ws.seat = seat;
  t.players[seat] = {
    id: ws.userId,
    ws,
    name: name ? String(name).slice(0, 24) : `Анонім ${seat + 1}`,
    g: gender === "Чоловік" ? "♂" : gender === "Жінка" ? "♀" : "",
  };
  send(ws, { type: "joined", seat, gifts: giftList() });
  refresh(t);
}

function cancelRound(t, text) {
  clearTimeout(t.timers.spin);
  clearTimeout(t.timers.pair);
  delete t.timers.spin;
  delete t.timers.pair;
  t.pair = null;
  t.phase = "idle";
  broadcast(t, { type: "notice", text });
  t.turn = nextSeat(t, t.spinner);
}

function leave(ws) {
  const t = ws.table;
  if (!t) return;
  const seat = ws.seat;
  t.players[seat] = null;
  ws.table = null;
  ws.seat = -1;
  if ((t.phase === "spin" || t.phase === "pair") && (seat === t.spinner || seat === t.target)) {
    cancelRound(t, "Гравець вийшов зі столу. Раунд скасовано.");
  } else if (t.phase === "idle" && t.turn === seat) {
    clearTimeout(t.timers.turn);
    delete t.timers.turn;
  }
  refresh(t);
}

function onSpin(ws, msg) {
  const t = ws.table;
  if (!t || t.phase !== "idle" || t.turn !== ws.seat) return;
  const targets = t.players.map((p, i) => (p && i !== ws.seat ? i : -1)).filter((i) => i >= 0);
  if (!targets.length) return;
  const selected = CATS.includes(msg.selected) ? msg.selected : "all";
  const category = selected === "all" ? pick(CATS) : selected;
  const task = pick(TASKS[category]);
  const target = pick(targets);
  clearTimeout(t.timers.turn);
  delete t.timers.turn;
  t.phase = "spin";
  t.spinner = ws.seat;
  t.target = target;
  t.round += 1;
  broadcast(t, { type: "spin_start", spinner: t.spinner, target, turns: 4 + Math.floor(Math.random() * 3), duration: SPIN_MS, round: t.round });
  t.timers.spin = setTimeout(safe(() => {
    if (t.phase !== "spin") return;
    t.phase = "pair";
    t.pair = { seats: [t.spinner, t.target], answers: {} };
    broadcast(t, { type: "spin_result", spinner: t.spinner, target: t.target, category, task });
    broadcast(t, snapshot(t));
    t.timers.pair = setTimeout(safe(() => finishPair(t)), PAIR_MS);
  }), SPIN_MS + 200);
}

function onPair(ws, msg) {
  const t = ws.table;
  if (!t || t.phase !== "pair" || !t.pair.seats.includes(ws.seat) || t.pair.answers[ws.seat]) return;
  if (!["chat", "kiss", "skip"].includes(msg.choice)) return;
  t.pair.answers[ws.seat] = msg.choice;
  if (t.pair.seats.every((s) => t.pair.answers[s])) finishPair(t);
  else broadcast(t, snapshot(t));
}

function finishPair(t) {
  if (t.phase !== "pair") return;
  clearTimeout(t.timers.pair);
  delete t.timers.pair;
  const [a, b] = t.pair.seats;
  const pa = t.players[a];
  const pb = t.players[b];
  const ca = t.pair.answers[a] ?? "skip";
  const cb = t.pair.answers[b] ?? "skip";
  t.pair = null;
  t.phase = "idle";
  let outcome = "none";
  if (pa && pb && ca === "chat" && cb === "chat") outcome = openDialog(pa.id, pb.id) ? "chat" : "busy";
  else if (pa && pb && ca === "kiss" && cb === "kiss") outcome = "kiss";
  broadcast(t, { type: "pair_done", a, b, outcome });
  if (outcome === "chat") {
    for (const p of [pa, pb]) {
      t.players[p.ws.seat] = null;
      p.ws.table = null;
      p.ws.seat = -1;
      send(p.ws, { type: "chat_opened" });
      tg("sendMessage", { chat_id: p.id, text: "💬 Ви обрали одне одного за столом. Пиши: я передам повідомлення без твого імені. «Завершити діалог» зупиняє розмову." }).catch((err) => console.error("[game] notify", err.message));
    }
  }
  t.turn = nextSeat(t, t.spinner);
  refresh(t);
}

async function onGiftInvoice(ws, msg) {
  const t = ws.table;
  const to = t?.players[Number(msg.toSeat)];
  const now = Date.now();
  if (now - (ws.lastInvoice ?? 0) < 2000) return;
  ws.lastInvoice = now;
  if (!to || to.id === ws.userId) return send(ws, { type: "error", message: "Обери іншого гравця за столом." });
  try {
    send(ws, { type: "invoice", link: await createGiftInvoice(ws.userId, to.id, String(msg.gift), "t") });
  } catch (err) {
    console.error("[game] invoice", err.message);
    send(ws, { type: "error", message: "Не вдалося створити рахунок. Спробуй ще раз." });
  }
}

export function attachBottleGame(server) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 2048 });
  server.on("upgrade", (req, socket, head) => {
    let pathname;
    try { pathname = new URL(req.url, "http://localhost").pathname; } catch { socket.destroy(); return; }
    if (pathname !== GAME_PATH) { socket.destroy(); return; }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
  });

  setGiftHooks({
    sameTable: (a, b) => {
      const x = sockets.get(a);
      const y = sockets.get(b);
      return Boolean(x?.table && x.table === y?.table);
    },
    tableGift: (from, to, gift) => {
      const target = sockets.get(to);
      const t = target?.table;
      if (!t) return false;
      const sender = sockets.get(from);
      broadcast(t, { type: "gift", from: sender?.table === t ? sender.seat : -1, to: target.seat, gift });
      return true;
    },
  });

  wss.on("connection", (ws, req) => {
    let userId;
    let profile;
    try {
      userId = verifyInitData(new URL(req.url, "http://localhost").searchParams.get("initData") || "");
      profile = withDb((db) => db.prepare("select adult, banned, display_name, gender from users where id = ?").get(userId));
    } catch (err) {
      send(ws, { type: "error", message: err.message || "Не вдалося авторизувати Telegram." });
      ws.close(4003, "Unauthorized");
      return;
    }
    if (!profile || !profile.adult || profile.banned) {
      send(ws, { type: "error", code: "need_start", message: "Спершу відкрий бота, натисни /start і підтверди вік." });
      ws.close(4004, "Not allowed");
      return;
    }

    const old = sockets.get(userId);
    if (old && old !== ws) {
      leave(old);
      old.close(4001, "Reconnected");
    }
    ws.userId = userId;
    ws.profile = profile;
    ws.alive = true;
    ws.window = 0;
    ws.count = 0;
    sockets.set(userId, ws);

    ws.on("pong", () => { ws.alive = true; });
    ws.on("message", safe((data) => {
      const now = Date.now();
      if (now - ws.window > 5000) { ws.window = now; ws.count = 0; }
      if (++ws.count > 25) return;
      let msg;
      try { msg = JSON.parse(String(data)); } catch { return; }
      if (!msg || typeof msg !== "object") return;
      if (msg.type === "spin") onSpin(ws, msg);
      else if (msg.type === "pair") onPair(ws, msg);
      else if (msg.type === "gift_invoice") void onGiftInvoice(ws, msg);
      else if (msg.type === "join" && !ws.table) sit(ws);
    }));
    ws.on("close", safe(() => {
      leave(ws);
      if (sockets.get(userId) === ws) sockets.delete(userId);
    }));
    ws.on("error", () => {});
    safe(sit)(ws);
  });

  const heartbeat = setInterval(() => {
    for (const c of wss.clients) {
      if (c.alive === false) { c.terminate(); continue; }
      c.alive = false;
      c.ping();
    }
  }, 25_000);
  heartbeat.unref();
  wss.on("close", () => clearInterval(heartbeat));
  return wss;
}