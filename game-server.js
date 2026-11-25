import { createHmac, timingSafeEqual } from "node:crypto";
import { WebSocketServer, WebSocket } from "ws";
import { BOT_TOKEN } from "./src/bot.js";

const GAME_PATH = "/game";
const waiting = [];
const sockets = new Map();
const rooms = new Map();
const timers = new Map();

function verifyInitData(raw) {
  if (!raw || !BOT_TOKEN) throw new Error("Telegram initData відсутній");
  const params = new URLSearchParams(raw);
  const hash = params.get("hash");
  const authDate = Number(params.get("auth_date"));
  const userRaw = params.get("user");
  if (!hash || !userRaw || !Number.isFinite(authDate)) throw new Error("Некоректний initData");
  if (Math.abs(Date.now() / 1000 - authDate) > 86400) throw new Error("initData застарів");
  const check = [...params.entries()]
    .filter(([key]) => key !== "hash")
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");
  const secret = createHmac("sha256", "WebAppData").update(BOT_TOKEN).digest();
  const expected = createHmac("sha256", secret).update(check).digest();
  let supplied;
  try { supplied = Buffer.from(hash, "hex"); } catch { throw new Error("Некоректний підпис"); }
  if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
    throw new Error("Підпис Telegram не пройшов перевірку");
  }
  const user = JSON.parse(userRaw);
  if (!user?.id) throw new Error("Telegram user відсутній");
  return {
    id: String(user.id),
    name: String(user.first_name || user.username || "Гравець").slice(0, 40),
  };
}

function send(ws, payload) {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(payload));
}
function removeFromQueue(ws) {
  const i = waiting.indexOf(ws);
  if (i !== -1) waiting.splice(i, 1);
}
function sendRoom(room, payload) {
  for (const player of room.players) send(player.ws, payload);
}
function endRoom(room, leavingId) {
  const timer = timers.get(room.id);
  if (timer) clearTimeout(timer);
  timers.delete(room.id);
  rooms.delete(room.id);
  for (const player of room.players) {
    if (player.id !== leavingId) {
      send(player.ws, { type: "opponent_left" });
      player.room = null;
    }
  }
}
function matchPlayers() {
  while (waiting.length >= 2) {
    const a = waiting.shift();
    if (a.readyState !== WebSocket.OPEN || a.room) continue;
    const bIndex = waiting.findIndex((b) => b.readyState === WebSocket.OPEN && !b.room && b.user.id !== a.user.id);
    if (bIndex < 0) {
      waiting.unshift(a);
      return;
    }
    const [b] = waiting.splice(bIndex, 1);
    const room = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
      players: [
        { id: a.user.id, name: a.user.name, ws: a, seat: 0 },
        { id: b.user.id, name: b.user.name, ws: b, seat: 1 },
      ],
      round: 0,
      spinning: false,
    };
    a.room = b.room = room;
    rooms.set(room.id, room);
    for (const player of room.players) {
      send(player.ws, {
        type: "matched",
        roomId: room.id,
        seat: player.seat,
        players: room.players.map(({ id, name }) => ({ id, name })),
      });
    }
  }
}

function handleMessage(ws, data) {
  let msg;
  try { msg = JSON.parse(String(data)); } catch { return; }
  if (msg.type === "cancel") {
    removeFromQueue(ws);
    send(ws, { type: "cancelled" });
    return;
  }
  if (msg.type === "spin") {
    const room = ws.room;
    if (!room || room.spinning) return;
    const selected = ["all", "truth", "action", "kiss", "adult"].includes(msg.selected) ? msg.selected : "all";
    const tasks = msg.tasks && typeof msg.tasks === "object" ? msg.tasks : {};
    const keys = selected === "all" ? ["truth", "action", "kiss", "adult"] : [selected];
    const available = keys.filter((key) => Array.isArray(tasks[key]) && tasks[key].length);
    if (!available.length) return send(ws, { type: "error", message: "Немає завдань для цієї категорії." });
    const category = available[Math.floor(Math.random() * available.length)];
    const list = tasks[category].filter((item) => typeof item === "string" && item.length <= 500);
    if (!list.length) return;
    const task = list[Math.floor(Math.random() * list.length)];
    const winnerSeat = Math.floor(Math.random() * 2);
    room.round += 1;
    room.spinning = true;
    const spinId = `${room.id}:${room.round}`;
    sendRoom(room, {
      type: "spin_start",
      spinId,
      round: room.round,
      winnerSeat,
      category,
      task,
      duration: 4100,
      rotation: (Math.random() < 0.5 ? -1 : 1) * (1440 + Math.floor(Math.random() * 1440)),
    });
    const timer = setTimeout(() => {
      if (rooms.get(room.id) !== room) return;
      room.spinning = false;
      sendRoom(room, { type: "spin_result", spinId, round: room.round, winnerSeat, category, task });
      timers.delete(room.id);
    }, 4100);
    timers.set(room.id, timer);
  }
}

export function attachBottleGame(server) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 16_384 });
  server.on("upgrade", (req, socket, head) => {
    let pathname;
    try { pathname = new URL(req.url, "http://localhost").pathname; } catch { socket.destroy(); return; }
    if (pathname !== GAME_PATH) return;
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
  });

  wss.on("connection", (ws, req) => {
    try {
      const url = new URL(req.url, "http://localhost");
      const user = verifyInitData(url.searchParams.get("initData") || "");
      const old = sockets.get(user.id);
      if (old && old !== ws) {
        removeFromQueue(old);
        if (old.room) endRoom(old.room, user.id);
        old.close(4001, "Reconnected");
      }
      ws.user = user;
      sockets.set(user.id, ws);
      waiting.push(ws);
      send(ws, { type: "waiting" });
      matchPlayers();
    } catch (err) {
      send(ws, { type: "error", message: err.message || "Не вдалося авторизувати Telegram." });
      ws.close(4003, "Unauthorized");
      return;
    }

    ws.on("message", (data) => handleMessage(ws, data));
    ws.on("close", () => {
      removeFromQueue(ws);
      if (ws.room) endRoom(ws.room, ws.user.id);
      if (sockets.get(ws.user.id) === ws) sockets.delete(ws.user.id);
      matchPlayers();
    });
    ws.on("error", () => {});
  });

  return wss;
}
