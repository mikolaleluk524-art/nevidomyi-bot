/**
 * Гра «Бутилочка»: спільні столи до 10 людей.
 * Крутить той, чия черга. Пляшка обирає гравця (частіше протилежної статі) і дає йому завдання.
 * Гравець відповідає текстом, стіл реагує (❤️😂🔥😮 — це «симпатії» гравця).
 * Потім пара вирішує: 💋 поцілувати, 👋 відштовхнути або 🔒 побути наодинці (приватний чат у боті,
 * якщо обоє обрали). Імена беруться з анкети бота, а не з Telegram.
 * Подарунки (за зірки): дають ❤ (корона найпопулярнішого), видно на аватарці, і отримувач
 * одразу отримує запрошення побути наодинці з тим, хто подарував.
 * За столом є спільний чат; посилання, @нікнейми й телефони в ньому приховуються.
 */

import { createHmac, createPublicKey, timingSafeEqual, verify } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { WebSocketServer, WebSocket } from "ws";
import { BOT_TOKEN, BOT_USERNAME, DB_PATH, langOf, tg } from "./src/bot.js";
import { L, guessLang } from "./src/i18n.js";
import { GIFTS, createGiftInvoice, giftList, setGiftHooks } from "./gifts.js";

const GAME_PATH = "/game";
const SEATS = 10;
const SPIN_MS = 4200;
const TURN_MS = Number(process.env.GAME_TURN_MS) || 30_000;
const PAIR_MS = Number(process.env.GAME_PAIR_MS) || 25_000;
const ANSWER_MS = Number(process.env.GAME_ANSWER_MS) || 60_000;
const ANSWER_MAX = 200;
const CHAT_MAX = 150;
const REACTIONS = ["❤️", "😂", "🔥", "😮"];
const GENDERS = { Чоловік: "m", Жінка: "f" };
const CHOICES = ["kiss", "push", "alone"];
const INVITE_MS = 5 * 60_000;
// Скільки ❤ дає подарунок: 🌹10⭐ → 2, 💎250⭐ → 50.
export const giftHearts = (stars) => Math.max(1, Math.round(stars / 5));

// Усі завдання виконуються текстом. {name} — ім'я того, хто крутив пляшку.
const TASKS = {
  truth: [
    "Яке твоє найсмішніше побачення?",
    "Коли ти востаннє закохувався(лась)?",
    "Що тебе першим приваблює в людині?",
    "Який твій найбільш незручний момент на побаченні?",
    "Яка твоя найдивніша звичка?",
    "Що ти ніколи не пробачиш партнеру?",
    "Який комплімент ти пам'ятаєш досі?",
    "Ти більше романтик чи реаліст? Чому?",
    "Що для тебе ідеальний вечір удвох?",
    "Чи писав(ла) ти колись першим(ою)? Чим закінчилось?",
    "Яку пісню ти слухаєш, коли сумуєш?",
    "Що {name} має зробити, щоб тебе вразити?",
    "Чи віриш ти в кохання з першого погляду?",
    "Що в тобі помічають найперше?",
    "Яке перше враження в тебе про {name}?",
  ],
  action: [
    "Напиши {name} щирий комплімент.",
    "Опиши себе трьома емоджі.",
    "Придумай для {name} миле прізвисько.",
    "Напиши вірш із двох рядків про цей стіл.",
    "Запроси {name} на вигадане побачення: куди підете?",
    "Напиши, яким би був ваш спільний фільм з {name}: назва і жанр.",
    "Напиши фразу, якою ти почав(ла) би знайомство з {name}.",
    "Опиши свій настрій зараз одним словом і одним емоджі.",
    "Вгадай, звідки {name}, і напиши чому так думаєш.",
    "Напиши три слова, які описують тебе на першому побаченні.",
    "Порадь {name} фільм або серіал на вечір.",
    "Напиши, що б ти приготував(ла) {name} на сніданок.",
  ],
  kiss: [
    "Що тобі подобається в {name}? Хоча б одне.",
    "Опиши свій ідеальний поцілунок.",
    "Куди б ти повів(ла) {name} на перше побачення?",
    "Надішли {name} повітряний поцілунок емоджі і поясни, за що 😘",
    "Яка риса в протилежній статі тебе підкорює?",
    "Напиши {name}, яке в тебе склалося враження за цю гру.",
    "Опиши найромантичніший момент у твоєму житті.",
    "Що для тебе важливіше: погляд, голос чи усмішка?",
    "Обійми чи поцілунок? Поясни свій вибір.",
    "Напиши {name} фразу, від якої він(вона) усміхнеться.",
  ],
  adult: [
    "Який твій найсміливіший романтичний досвід?",
    "Що тебе найбільше заводить у партнері?",
    "Яка твоя фантазія, якою комфортно поділитися?",
    "Що для тебе найважливіше в інтимних стосунках?",
    "Який романтичний сценарій ти хочеш спробувати?",
    "Найнезвичайніше місце для поцілунку, де ти був(ла)?",
    "Що в {name} здається тобі найпривабливішим?",
    "Опиши ідеальну ніч трьома словами.",
  ],
};
const CATS = Object.keys(TASKS);

const tables = new Map();
const sockets = new Map(); // id користувача -> сокет
let tableSeq = 0;

const pick = (list) => list[Math.floor(Math.random() * list.length)];

// Текст від гравця: обрізаємо і ховаємо контакти, щоб за столом не обмінювались ними.
function clean(raw, max) {
  return String(raw ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max)
    .replace(/(https?:\/\/|www\.)\S+/gi, "•••")
    .replace(/\b[\w-]+\.(com|net|org|me|ua|ru|io|link)\S*/gi, "•••")
    .replace(/@[a-z0-9_]{3,}/gi, "•••")
    .replace(/\+?\d[\d\s()-]{7,}\d/g, "•••");
}
const safe = (fn) => (...args) => {
  try { return fn(...args); } catch (err) { console.error("[game]", err.message); }
};

// Telegram також підписує initData ключем Ed25519 (без токена, лише з bot_id):
// https://core.telegram.org/bots/webapps#validating-data-for-third-party-use
const TG_ED25519 = createPublicKey({
  key: { kty: "OKP", crv: "Ed25519", x: Buffer.from("e7bf03a2fa4602af4580703d88dda5bb59f32ed8b02a56c187fe7d34caed242d", "hex").toString("base64url") },
  format: "jwk",
});
const OUR_BOT_ID = BOT_TOKEN.split(":")[0];

function ed25519For(params, botId) {
  const sig = params.get("signature");
  if (!sig || !botId) return false;
  const body = [...params.entries()]
    .filter(([key]) => key !== "hash" && key !== "signature")
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");
  try {
    return verify(null, Buffer.from(`${botId}:WebAppData\n${body}`), TG_ED25519, Buffer.from(sig, "base64url"));
  } catch {
    return false;
  }
}

const verifyEd25519 = (params) => ed25519For(params, OUR_BOT_ID);

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
  // Telegram: secret_key = HMAC-SHA256(key = "WebAppData", data = bot_token)
  const secret = createHmac("sha256", "WebAppData").update(BOT_TOKEN).digest();
  const expected = createHmac("sha256", secret).update(check).digest();
  let supplied;
  try { supplied = Buffer.from(hash, "hex"); } catch { throw new Error("Некоректний підпис"); }
  const hmacOk = supplied.length === expected.length && timingSafeEqual(supplied, expected);
  if (!hmacOk && !verifyEd25519(params)) {
    console.error(`[game] initData відхилено: наш bot_id=${OUR_BOT_ID}, signature ${params.has("signature") ? "є, але не від нашого бота" : "відсутній"}, поля=${[...params.keys()].join(",")}`);
    throw new Error("Підпис Telegram не пройшов перевірку");
  }
  if (!hmacOk) console.warn("[game] HMAC не зійшовся, але підпис Ed25519 від Telegram для нашого бота вірний — перевір BOT_TOKEN");
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

// Кожен гравець отримує завдання, повідомлення й назви подарунків своєю мовою.
// Тексти гравців (відповіді, чат) не перекладаємо.
const fill = (lang, tpl, name) => L(lang, tpl).replaceAll("{name}", name);
const anon = (lang, name) => (/^Анонім \d+$/.test(name) ? L(lang, name) : name);
function localize(ws, payload) {
  const lang = ws.lang || "uk";
  const p = { ...payload };
  if (p.type === "notice" && p.text) p.text = L(lang, p.text);
  if (p.type === "error" && p.message) p.message = L(lang, p.message);
  if (p.taskName !== undefined) { p.task = fill(lang, p.task, p.taskName); delete p.taskName; }
  if (p.type === "table") {
    p.players = p.players.map((x) => x && { ...x, name: anon(lang, x.name) });
    if (p.task) p.task = { ...p.task, text: fill(lang, p.task.tpl, p.task.name) };
  }
  if (p.gifts) p.gifts = p.gifts.map((g) => ({ ...g, name: L(lang, g.name) }));
  if (p.gift) p.gift = { ...p.gift, name: L(lang, p.gift.name) };
  return p;
}
const send = (ws, payload) => { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(localize(ws, payload))); };
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
  players: t.players.map((p) => p && { name: p.name, g: p.g, age: p.age, hearts: p.hearts, badge: p.badge }),
  turn: t.turn,
  phase: t.phase,
  round: t.round,
  task: t.task,
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
    t.task = null;
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
    t = { id: ++tableSeq, players: Array(SEATS).fill(null), turn: 0, phase: "wait", round: 0, spinner: -1, target: -1, pair: null, task: null, last: null, invites: new Map(), timers: {} };
    tables.set(t.id, t);
  }
  const seat = t.players.indexOf(null);
  const { display_name: name, gender, profile_age: age } = ws.profile;
  ws.table = t;
  ws.seat = seat;
  t.players[seat] = {
    id: ws.userId,
    ws,
    name: name ? String(name).slice(0, 24) : `Анонім ${seat + 1}`,
    g: GENDERS[gender] ?? "",
    age: Number.isInteger(age) && age >= 18 && age < 100 ? age : null,
    hearts: 0,
    badge: "",
  };
  send(ws, { type: "joined", seat, gifts: giftList() });
  refresh(t);
}

function cancelRound(t, text) {
  for (const key of ["spin", "answer", "pair"]) {
    clearTimeout(t.timers[key]);
    delete t.timers[key];
  }
  t.pair = null;
  t.task = null;
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
  if (["spin", "answer", "pair"].includes(t.phase) && (seat === t.spinner || seat === t.target)) {
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
  // Пляшка частіше показує на протилежну стать: так гра — про знайомства.
  const me = t.players[ws.seat];
  const opposite = me.g ? targets.filter((i) => t.players[i].g && t.players[i].g !== me.g) : [];
  const target = pick(opposite.length && Math.random() < 0.8 ? opposite : targets);
  const selected = CATS.includes(msg.selected) ? msg.selected : "all";
  const category = selected === "all" ? pick(CATS) : selected;
  const tpl = pick(TASKS[category]);
  clearTimeout(t.timers.turn);
  delete t.timers.turn;
  t.phase = "spin";
  t.spinner = ws.seat;
  t.target = target;
  t.round += 1;
  broadcast(t, { type: "spin_start", spinner: t.spinner, target, turns: 4 + Math.floor(Math.random() * 3), duration: SPIN_MS, round: t.round });
  t.timers.spin = setTimeout(safe(() => {
    if (t.phase !== "spin") return;
    t.phase = "answer";
    t.task = { category, tpl, name: me.name, spinner: t.spinner, target: t.target, until: Date.now() + ANSWER_MS };
    broadcast(t, { type: "spin_result", spinner: t.spinner, target: t.target, category, task: tpl, taskName: me.name });
    broadcast(t, snapshot(t));
    t.timers.answer = setTimeout(safe(() => finishAnswer(t, "")), ANSWER_MS);
  }), SPIN_MS + 200);
}

function onAnswer(ws, msg) {
  const t = ws.table;
  if (!t || t.phase !== "answer" || ws.seat !== t.target) return;
  finishAnswer(t, msg.skip ? "" : clean(msg.text, ANSWER_MAX));
}

// Відповідь показуємо всім, далі пара вирішує, що робити.
function finishAnswer(t, text) {
  if (t.phase !== "answer") return;
  clearTimeout(t.timers.answer);
  delete t.timers.answer;
  const who = t.players[t.target];
  t.last = who ? { id: who.id, reacted: new Set() } : null;
  broadcast(t, { type: "answer", seat: t.target, category: t.task.category, task: t.task.tpl, taskName: t.task.name, text });
  t.task = null;
  t.phase = "pair";
  t.pair = { seats: [t.spinner, t.target], answers: {} };
  broadcast(t, snapshot(t));
  t.timers.pair = setTimeout(safe(() => finishPair(t)), PAIR_MS);
}

// Реакція на останню відповідь: одна від кожного гравця, кожна дає ❤ автору.
function onReact(ws, msg) {
  const t = ws.table;
  if (!t?.last || !REACTIONS.includes(msg.emoji)) return;
  if (t.last.id === ws.userId || t.last.reacted.has(ws.userId)) return;
  const to = t.players.findIndex((p) => p?.id === t.last.id);
  if (to < 0) return;
  t.last.reacted.add(ws.userId);
  t.players[to].hearts += 1;
  broadcast(t, { type: "react", from: ws.seat, to, emoji: msg.emoji });
  broadcast(t, snapshot(t));
}

function onChat(ws, msg) {
  const t = ws.table;
  const now = Date.now();
  if (!t || now - (ws.lastChat ?? 0) < 1500) return;
  const text = clean(msg.text, CHAT_MAX);
  if (!text) return;
  ws.lastChat = now;
  broadcast(t, { type: "chat", seat: ws.seat, text });
}

// Стать для гри, якщо її немає в анкеті. Зберігаємо в анкету, щоб не питати вдруге.
function onGender(ws, msg) {
  if (ws.table || !GENDERS[msg.gender]) return;
  withDb((db) => db.prepare("update users set gender = ? where id = ? and gender is null").run(msg.gender, ws.userId));
  ws.profile.gender = msg.gender;
  sit(ws);
}

function join(ws) {
  if (ws.table) return;
  if (!ws.profile.gender) send(ws, { type: "need_gender" });
  else sit(ws);
}

function onPair(ws, msg) {
  const t = ws.table;
  if (!t || t.phase !== "pair" || !t.pair.seats.includes(ws.seat) || t.pair.answers[ws.seat]) return;
  if (!CHOICES.includes(msg.choice)) return;
  t.pair.answers[ws.seat] = msg.choice;
  if (t.pair.seats.every((s) => t.pair.answers[s])) finishPair(t);
  else broadcast(t, snapshot(t));
}

// Обоє йдуть у приватний чат у боті й залишають стіл.
function goPrivate(t, pa, pb, text) {
  for (const p of [pa, pb]) {
    if (p.ws.table === t && t.players[p.ws.seat] === p) t.players[p.ws.seat] = null;
    p.ws.table = null;
    p.ws.seat = -1;
    t.invites.delete(p.id);
    send(p.ws, { type: "chat_opened" });
    tg("sendMessage", { chat_id: p.id, text: L(p.ws.lang || "uk", text) }).catch((err) => console.error("[game] notify", err.message));
  }
}

// Відштовхнув хоч один → відштовхнули. Обоє «наодинці» → приватний чат.
// Поцілунок, якщо хтось хоче поцілувати, а інший не проти (поцілувати чи наодинці).
function pairOutcome(ca, cb) {
  if (ca === "push" || cb === "push") return "push";
  if (ca === "alone" && cb === "alone") return "alone";
  if (ca && cb && (ca === "kiss" || cb === "kiss")) return "kiss";
  return "none";
}

function finishPair(t) {
  if (t.phase !== "pair") return;
  clearTimeout(t.timers.pair);
  delete t.timers.pair;
  const [a, b] = t.pair.seats;
  const pa = t.players[a];
  const pb = t.players[b];
  const ca = t.pair.answers[a] ?? null;
  const cb = t.pair.answers[b] ?? null;
  t.pair = null;
  t.phase = "idle";
  let outcome = pa && pb ? pairOutcome(ca, cb) : "none";
  if (outcome === "alone" && !openDialog(pa.id, pb.id)) outcome = "busy";
  if (outcome === "kiss") { pa.hearts += 1; pb.hearts += 1; }
  broadcast(t, { type: "pair_done", a, b, ca, cb, outcome });
  if (outcome === "alone") goPrivate(t, pa, pb, "🔒 Ви обрали побути наодинці. Пиши: я передам повідомлення без твого імені. «Завершити діалог» зупиняє розмову.");
  t.turn = nextSeat(t, t.spinner);
  refresh(t);
}

// Відповідь на запрошення після подарунка.
function onInvite(ws, msg) {
  const t = ws.table;
  const inv = t?.invites.get(ws.userId);
  if (!inv) return;
  t.invites.delete(ws.userId);
  const from = t.players.find((p) => p?.id === inv.fromId);
  const me = t.players[ws.seat];
  if (!from || !me || Date.now() - inv.at > INVITE_MS) return send(ws, { type: "notice", text: "Запрошення вже неактуальне." });
  if (!msg.yes) return send(from.ws, { type: "notice", text: `${me.name} дякує за подарунок, але поки лишається за столом.` });
  if (!openDialog(from.id, me.id)) return send(ws, { type: "notice", text: "Не вийшло: хтось із вас уже в іншому діалозі." });
  broadcast(t, { type: "pair_done", a: from.ws.seat, b: ws.seat, outcome: "alone" });
  goPrivate(t, from, me, "🔒 Подарунок спрацював: ви наодинці. Пиши: я передам повідомлення без твого імені. «Завершити діалог» зупиняє розмову.");
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
      const fromSeat = sender?.table === t ? sender.seat : -1;
      const hearts = giftHearts(GIFTS[gift.id]?.stars ?? 5);
      const p = t.players[target.seat];
      if (p) { p.hearts += hearts; p.badge = gift.emoji; }
      broadcast(t, { type: "gift", from: fromSeat, to: target.seat, gift, hearts });
      broadcast(t, snapshot(t));
      // Подарунок = запрошення побути наодинці з тим, хто подарував.
      if (fromSeat >= 0) {
        t.invites.set(String(to), { fromId: String(from), at: Date.now() });
        send(target, { type: "gift_invite", from: fromSeat, gift });
      }
      return true;
    },
  });

  wss.on("connection", (ws, req) => {
    let userId;
    let profile;
    // Мова до авторизації — з налаштувань Telegram у initData (для повідомлень про помилку).
    try { ws.lang = guessLang(JSON.parse(new URLSearchParams(new URL(req.url, "http://localhost").searchParams.get("initData") || "").get("user") || "{}").language_code); } catch { ws.lang = "uk"; }
    try {
      userId = verifyInitData(new URL(req.url, "http://localhost").searchParams.get("initData") || "");
      profile = withDb((db) => db.prepare("select adult, banned, display_name, gender, profile_age from users where id = ?").get(userId));
      ws.lang = langOf(userId);
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
    send(ws, { type: "hello", lang: ws.lang, bot: BOT_USERNAME, invite: withDb((db) => db.prepare("select invite_code from users where id = ?").get(userId))?.invite_code || "" });
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
      else if (msg.type === "answer") onAnswer(ws, msg);
      else if (msg.type === "react") onReact(ws, msg);
      else if (msg.type === "chat") onChat(ws, msg);
      else if (msg.type === "pair") onPair(ws, msg);
      else if (msg.type === "gender") onGender(ws, msg);
      else if (msg.type === "invite") onInvite(ws, msg);
      else if (msg.type === "gift_invoice") void onGiftInvoice(ws, msg);
      else if (msg.type === "join") join(ws);
    }));
    ws.on("close", safe(() => {
      leave(ws);
      if (sockets.get(userId) === ws) sockets.delete(userId);
    }));
    ws.on("error", () => {});
    safe(join)(ws);
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