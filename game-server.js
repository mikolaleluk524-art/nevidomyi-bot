/**
 * Гра «Бутилочка»: спільні столи до 10 людей.
 * Крутить той, чия черга. Пляшка обирає гравця (частіше протилежної статі) і дає йому завдання.
 * Гравець відповідає текстом, стіл реагує (❤️😂🔥😮 — це «симпатії» гравця).
 * Потім пара вирішує: 💋 поцілувати, 👋 відштовхнути або 🔒 побути наодинці (приватний чат у боті,
 * якщо обоє обрали). Імена беруться з анкети бота, а не з Telegram.
 * Подарунки (за зірки): дають ❤ (корона найпопулярнішого), видно на аватарці, і отримувач
 * одразу отримує запрошення побути наодинці з тим, хто подарував.
 * Щоденна винагорода: серія днів дає безкоштовні 🌹 (справжній подарунок), 🎯 і на 7-й день
 * день Premium. Пропущений день — серія спочатку. День рахується за київським часом.
 * За столом є спільний чат; посилання, @нікнейми й телефони в ньому приховуються.
 */

import { createHmac, createPublicKey, randomBytes, timingSafeEqual, verify } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { WebSocketServer, WebSocket } from "ws";
import { BOT_TOKEN, BOT_USERNAME, DB_PATH, addPoints, crownOf, langOf, tg } from "./src/bot.js";
import { L, guessLang } from "./src/i18n.js";
import { AIM_STARS, GIFTS, WISH_STARS, createAimInvoice, createGiftInvoice, createWishInvoice, giftList, refundStars, setGiftHooks } from "./gifts.js";

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
// Щоденна винагорода за днями серії (1–7, далі по колу).
export const DAILY = [
  { roses: 1 }, { roses: 1 }, { roses: 1, aims: 1 },
  { roses: 2 }, { roses: 2 }, { roses: 2, aims: 1 },
  { roses: 3, premium: 1 },
];
const kyivDay = (d = new Date()) => d.toLocaleDateString("en-CA", { timeZone: "Europe/Kiev" });
const prevDay = (day) => { const t = new Date(`${day}T12:00:00Z`); t.setUTCDate(t.getUTCDate() - 1); return t.toISOString().slice(0, 10); };
// ✨ Бажання: 5 хвилин на відповіді, переможець отримує 👑.
const WISH_MS = Number(process.env.GAME_WISH_MS) || 5 * 60_000;
const WISH_HEARTS = 40;
const CROWN = { id: "crown", emoji: "👑", name: "Корона бажань" };

// Події, які власник запускає з монітора. 💖 Подвійні серця: усі ❤ ×2.
const events = { doubleUntil: 0 };
const heartMult = () => (Date.now() < events.doubleUntil ? 2 : 1);
const eventView = () => ({ type: "event", doubleUntil: events.doubleUntil, now: Date.now() });

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

// ---------- щоденна винагорода і гаманець безкоштовних 🌹 / 🎯 ----------
function dailyRow(db, id) {
  db.exec("create table if not exists daily (user_id text primary key, last_day text, streak integer not null default 0, roses integer not null default 0, aims integer not null default 0)");
  return db.prepare("select * from daily where user_id = ?").get(id) ?? { last_day: null, streak: 0, roses: 0, aims: 0 };
}
function dailyNext(row) {
  const today = kyivDay();
  const claimed = row.last_day === today;
  const streak = claimed ? row.streak : row.last_day === prevDay(today) ? row.streak + 1 : 1;
  return { today, claimed, streak, day: ((streak - 1) % DAILY.length) + 1 };
}
function dailyState(id) {
  return withDb((db) => { const row = dailyRow(db, id); return { ...dailyNext(row), roses: row.roses, aims: row.aims }; });
}
function claimDaily(id) {
  return withDb((db) => {
    db.exec("begin immediate");
    try {
      const row = dailyRow(db, id);
      const next = dailyNext(row);
      if (next.claimed) { db.exec("rollback"); return null; }
      const reward = DAILY[next.day - 1];
      db.prepare("insert into daily (user_id, last_day, streak, roses, aims) values (?, ?, ?, ?, ?) on conflict (user_id) do update set last_day = excluded.last_day, streak = excluded.streak, roses = daily.roses + ?, aims = daily.aims + ?")
        .run(id, next.today, next.streak, row.roses + (reward.roses ?? 0), row.aims + (reward.aims ?? 0), reward.roses ?? 0, reward.aims ?? 0);
      if (reward.premium) {
        const now = Math.floor(Date.now() / 1000);
        db.prepare("update users set premium_until = max(premium_until, ?) + ? where id = ?").run(now, reward.premium * 86400, id);
      }
      db.exec("commit");
      const after = dailyRow(db, id);
      return { day: next.day, streak: next.streak, reward, roses: after.roses, aims: after.aims };
    } catch (err) {
      try { db.exec("rollback"); } catch { /* вже закрито */ }
      throw err;
    }
  });
}
// Списати одну безкоштовну 🌹 або 🎯. true — списано.
function spend(id, kind) {
  return withDb((db) => { dailyRow(db, id); return db.prepare(`update daily set ${kind} = ${kind} - 1 where user_id = ? and ${kind} > 0`).run(id).changes > 0; });
}
const sendWallet = (ws) => { const w = dailyState(ws.userId); send(ws, { type: "wallet", roses: w.roses, aims: w.aims }); };

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
  players: t.players.map((p) => p && { name: p.name, g: p.g, age: p.age, hearts: p.hearts, badge: p.badge, ...(p.bot ? { bot: true } : {}) }),
  turn: t.turn,
  phase: t.phase,
  round: t.round,
  task: t.task,
  pair: t.pair ? t.pair.seats : null,
  answered: t.pair ? Object.keys(t.pair.answers).map(Number) : [],
});

// ---------- 🤖 боти-гравці ----------
// Коли за столом мало людей, сідають боти з позначкою «бот» біля імені, щоб гра не простоювала.
// Вони крутять пляшку, відповідають на завдання, реагують і в парі обирають 💋 або 👋.
// «Наодинці» з ботом неможливе, подарунки, 🎯 і бажання на ботів не діють.
const BOT_TABLE = 3; // скільки учасників тримати за столом, поки людей менше
const BOT_NAMES = { f: ["Аліса", "Віра", "Соня", "Марта", "Ліза", "Дарина", "Ніка"], m: ["Макс", "Артем", "Денис", "Тарас", "Олег", "Назар"] };
const BOT_ANSWERS = {
  uk: ["Ой, це секрет 🤫", "Чесно? Кава і хороша компанія ☕", "Ха, я ж бот — у мене все за алгоритмом 😅", "Мабуть, усмішка. Завжди усмішка 🙂", "Обіцяю розповісти, якщо пляшка покаже на мене ще раз 😉", "Тут треба подумати… 🤔 Давай далі!", "Сонце, море і ніяких будильників 🌊", "Комплімент: у тебе чудове почуття гумору 😄"],
  ru: ["Ой, это секрет 🤫", "Честно? Кофе и хорошая компания ☕", "Ха, я же бот — у меня всё по алгоритму 😅", "Наверное, улыбка. Всегда улыбка 🙂", "Обещаю рассказать, если бутылочка укажет на меня ещё раз 😉", "Тут надо подумать… 🤔 Давай дальше!", "Солнце, море и никаких будильников 🌊", "Комплимент: у тебя отличное чувство юмора 😄"],
  en: ["Oh, that's a secret 🤫", "Honestly? Coffee and good company ☕", "Ha, I'm a bot — everything goes by the algorithm 😅", "A smile, probably. Always a smile 🙂", "I'll tell you if the bottle picks me again 😉", "Let me think… 🤔 Next!", "Sun, sea and no alarm clocks 🌊", "Compliment: you have a great sense of humour 😄"],
};
const humans = (t) => seated(t).filter((p) => !p.bot);
const rnd = (a, b) => a + Math.floor(Math.random() * (b - a));
let botSeq = 0;

function botLater(t, ms, fn) {
  const key = "bot" + ++botSeq;
  t.timers[key] = setTimeout(safe(() => { delete t.timers[key]; fn(); }), ms);
}

function addBot(t) {
  const seat = t.players.indexOf(null);
  if (seat < 0) return;
  // Переважно протилежна стать до людей за столом.
  const hs = humans(t);
  const males = hs.filter((p) => p.g === "m").length, females = hs.filter((p) => p.g === "f").length;
  const g = males > females ? "f" : females > males ? "m" : Math.random() < 0.5 ? "f" : "m";
  const taken = new Set(seated(t).map((p) => p.name));
  const free = BOT_NAMES[g].filter((n) => !taken.has(n));
  const name = free.length ? pick(free) : BOT_NAMES[g][0];
  const id = "bot:" + randomBytes(4).toString("hex");
  const ws = { bot: true, readyState: 3, userId: id, table: t, seat, lang: "uk", send() {}, close() {} };
  t.players[seat] = { id, ws, name, g, age: rnd(20, 30), hearts: 0, badge: "", bot: true };
}

// Тримаємо за столом BOT_TABLE учасників, поки людей менше; прибираємо ботів лише між раундами.
function maintainBots(t) {
  const h = humans(t).length;
  const want = h === 0 || h >= BOT_TABLE ? 0 : BOT_TABLE - h;
  let bots = t.players.map((p, i) => (p?.bot ? i : -1)).filter((i) => i >= 0);
  if (bots.length > want && (t.phase === "idle" || t.phase === "wait")) {
    for (const i of bots.slice(want)) t.players[i] = null;
    bots = bots.slice(0, want);
  }
  for (let k = bots.length; k < want; k++) addBot(t);
}

const firstHumanLang = (t) => humans(t)[0]?.ws?.lang || "uk";

function scheduleBotSpin(t) {
  const p = t.players[t.turn];
  const key = t.round + ":" + t.turn;
  if (t.phase !== "idle" || !p?.bot || t.botSpinKey === key) return;
  t.botSpinKey = key;
  const round = t.round;
  botLater(t, rnd(2500, 4500), () => {
    if (t.phase === "idle" && t.round === round && t.players[t.turn] === p) onSpin(p.ws, { selected: "all" });
  });
}

function botAnswer(t) {
  const p = t.players[t.target];
  if (!p?.bot) return;
  const round = t.round;
  botLater(t, rnd(3000, 6000), () => {
    if (t.phase === "answer" && t.round === round) onAnswer(p.ws, { text: pick(BOT_ANSWERS[firstHumanLang(t)] || BOT_ANSWERS.uk) });
  });
}

function botsAfterAnswer(t) {
  const round = t.round;
  // Реакції ботів на відповідь людини.
  const author = t.last?.id;
  if (author && !author.startsWith("bot:")) {
    for (const p of seated(t)) {
      if (!p.bot || Math.random() < 0.3) continue;
      botLater(t, rnd(1200, 3500), () => { if (t.round === round) onReact(p.ws, { emoji: pick(REACTIONS) }); });
    }
  }
  // Бот у парі: 💋 або 👋, ніколи не «наодинці».
  for (const s of t.pair?.seats ?? []) {
    const p = t.players[s];
    if (!p?.bot) continue;
    botLater(t, rnd(2500, 6000), () => {
      if (t.phase === "pair" && t.round === round) onPair(p.ws, { choice: Math.random() < 0.65 ? "kiss" : "push" });
    });
  }
}

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
  if (!humans(t).length) {
    clearTimers(t);
    tables.delete(t.id);
    return;
  }
  maintainBots(t);
  const n = seated(t).length;
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
  scheduleBotSpin(t);
}

// Друг прийшов за посиланням «сідай за мій стіл»: шукаємо стіл того, хто кликав.
function friendTable(ws) {
  const host = ws.profile.join_with;
  const fresh = Number(ws.profile.join_at) > Date.now() / 1000 - 3600;
  if (!host) return null;
  ws.profile.join_with = null;
  try { withDb((db) => db.prepare("update users set join_with = null where id = ?").run(ws.userId)); } catch { /* стара база */ }
  const h = fresh ? sockets.get(String(host)) : null;
  const t = h?.table;
  if (!t) return null;
  if (t.players.indexOf(null) < 0) {
    // Місце звільняє бот (якщо він не в поточному раунді).
    const busy = new Set([t.spinner, t.target, ...(t.pair?.seats ?? [])]);
    const bot = t.players.findIndex((p, i) => p?.bot && (t.phase === "idle" || t.phase === "wait" || !busy.has(i)));
    if (bot < 0) return null;
    t.players[bot] = null;
  }
  return { t, hostName: t.players[h.seat]?.name ?? "" };
}

function sit(ws) {
  const friend = friendTable(ws);
  let t = friend?.t ?? null;
  let best = -1;
  if (!t) for (const c of tables.values()) {
    const k = seated(c).length;
    if (k < SEATS && k > best) { t = c; best = k; }
  }
  if (!t) {
    t = { id: ++tableSeq, players: Array(SEATS).fill(null), turn: 0, phase: "wait", round: 0, spinner: -1, target: -1, pair: null, task: null, last: null, invites: new Map(), timers: {} };
    tables.set(t.id, t);
  }
  const seat = t.players.indexOf(null);
  const { display_name: rawName, gender, profile_age: age } = ws.profile;
  // 👑 Переможець сезону — з короною біля імені.
  let name = rawName;
  try { if (rawName && crownOf(ws.userId)) name = `👑 ${rawName}`; } catch {}
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
  send(ws, { type: "joined", seat, gifts: giftList(), aimStars: AIM_STARS });
  if (friend) broadcast(t, { type: "notice", text: `🎉 ${t.players[seat].name} сідає за стіл за запрошенням ${friend.hostName}!` });
  refresh(t);
  const w = dailyState(ws.userId);
  send(ws, { type: "wallet", roses: w.roses, aims: w.aims });
  if (!w.claimed) send(ws, { type: "daily", day: w.day, streak: w.streak, rewards: DAILY });
  if (events.doubleUntil > Date.now()) send(ws, eventView());
  if (t.wish) send(ws, { type: "wish", wish: wishView(t) });
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
  if (t.wish?.fromId === ws.userId) closeWish(t, null);
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
  let target = pick(opposite.length && Math.random() < 0.8 ? opposite : targets);
  // 🎯 Оплачений вибір: пляшка показує на обраного гравця, якщо він ще за столом.
  if (me.aimAt) {
    const forced = targets.find((i) => t.players[i].id === me.aimAt);
    if (forced !== undefined) target = forced;
    delete me.aimAt;
  }
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
    botAnswer(t);
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
  botsAfterAnswer(t);
}

// Реакція на останню відповідь: одна від кожного гравця, кожна дає ❤ автору.
function onReact(ws, msg) {
  const t = ws.table;
  if (!t?.last || !REACTIONS.includes(msg.emoji)) return;
  if (t.last.id === ws.userId || t.last.reacted.has(ws.userId)) return;
  const to = t.players.findIndex((p) => p?.id === t.last.id);
  if (to < 0) return;
  t.last.reacted.add(ws.userId);
  t.players[to].hearts += heartMult();
  if (!t.players[to].bot) addPoints(t.players[to].id, heartMult()); // 🏆 очки сезону
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
  if (outcome === "kiss") {
    pa.hearts += heartMult(); pb.hearts += heartMult();
    for (const p of [pa, pb]) if (!p.bot) addPoints(p.id, 2 * heartMult()); // 🏆 очки сезону
  }
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

// Подарунок за столом: ❤, значок на аватарці і запрошення побути наодинці.
function deliverTableGift(from, to, gift, baseHearts) {
  const target = sockets.get(String(to));
  const t = target?.table;
  if (!t) return false;
  const sender = sockets.get(String(from));
  const fromSeat = sender?.table === t ? sender.seat : -1;
  const hearts = (baseHearts ?? giftHearts(GIFTS[gift.id]?.stars ?? 5)) * heartMult();
  const p = t.players[target.seat];
  if (p) { p.hearts += hearts; p.badge = gift.emoji; if (!p.bot) addPoints(p.id, 5); } // 🏆 очки сезону
  broadcast(t, { type: "gift", from: fromSeat, to: target.seat, gift, hearts });
  broadcast(t, snapshot(t));
  if (fromSeat >= 0) {
    t.invites.set(String(to), { fromId: String(from), at: Date.now() });
    send(target, { type: "gift_invite", from: fromSeat, gift });
  }
  return true;
}

// ---------- ✨ бажання ----------
const seatOf = (t, id) => t.players.findIndex((p) => p?.id === String(id));
function wishView(t) {
  const w = t.wish;
  if (!w) return null;
  return {
    from: seatOf(t, w.fromId),
    text: w.text,
    left: Math.max(0, w.until - Date.now()),
    hearts: WISH_HEARTS,
    answers: w.answers.map((a) => ({ seat: seatOf(t, a.userId), name: a.name, text: a.text })),
  };
}
const broadcastWish = (t) => broadcast(t, { type: "wish", wish: wishView(t) });

async function onWishInvoice(ws, msg) {
  const t = ws.table;
  if (!t) return;
  const now = Date.now();
  if (now - (ws.lastInvoice ?? 0) < 2000) return;
  ws.lastInvoice = now;
  if (t.wish) return send(ws, { type: "error", message: "За столом уже є бажання. Зачекай, поки його виконають." });
  if (humans(t).length < 2) return send(ws, { type: "error", message: "Потрібен хоча б ще один гравець за столом." });
  const text = clean(msg.text, 150);
  if (text.length < 3) return send(ws, { type: "error", message: "Напиши бажання, хоча б кілька слів." });
  ws.pendingWish = { id: randomBytes(6).toString("hex"), text };
  try {
    send(ws, { type: "invoice", link: await createWishInvoice(ws.userId, ws.pendingWish.id) });
  } catch (err) {
    console.error("[game] wish invoice", err.message);
    send(ws, { type: "error", message: "Не вдалося створити рахунок. Спробуй ще раз." });
  }
}

function wishReady(from, id) {
  const ws = sockets.get(String(from));
  return Boolean(ws?.table && ws.pendingWish?.id === id && !ws.table.wish);
}

function wishPaid(from, id, chargeId) {
  if (!wishReady(from, id)) return false;
  const ws = sockets.get(String(from));
  const t = ws.table;
  t.wish = { id, fromId: ws.userId, text: ws.pendingWish.text, until: Date.now() + WISH_MS, answers: [], chargeId };
  delete ws.pendingWish;
  clearTimeout(t.timers.wish);
  t.timers.wish = setTimeout(safe(() => closeWish(t, null)), WISH_MS);
  broadcastWish(t);
  return true;
}

function onWishAnswer(ws, msg) {
  const t = ws.table;
  const w = t?.wish;
  if (!w || ws.userId === w.fromId || w.answers.some((a) => a.userId === ws.userId)) return;
  const text = clean(msg.text, 150);
  if (!text) return;
  w.answers.push({ userId: ws.userId, name: t.players[ws.seat]?.name ?? "", text });
  broadcastWish(t);
}

function onWishPick(ws, msg) {
  const t = ws.table;
  const w = t?.wish;
  if (!w || ws.userId !== w.fromId) return;
  const a = w.answers[Number(msg.idx)];
  if (a) closeWish(t, a);
}

// Кінець бажання: 👑 обраному (або першому, хто ще за столом); якщо відповідей немає — повертаємо зірки.
function closeWish(t, pick) {
  const w = t.wish;
  if (!w) return;
  clearTimeout(t.timers.wish);
  delete t.timers.wish;
  t.wish = null;
  const present = (a) => seatOf(t, a.userId) >= 0;
  const winner = pick && present(pick) ? pick : w.answers.find(present);
  if (!winner) {
    broadcast(t, { type: "wish_done", from: seatOf(t, w.fromId), to: -1, text: w.text });
    void refundStars(w.fromId, w.chargeId, "✨ Твоє бажання ніхто не виконав — зірки повернено.");
    return;
  }
  broadcast(t, { type: "wish_done", from: seatOf(t, w.fromId), to: seatOf(t, winner.userId), text: w.text, answer: winner.text });
  deliverTableGift(w.fromId, winner.userId, CROWN, WISH_HEARTS);
  withDb((db) => {
    db.exec("create table if not exists gifts (id integer primary key autoincrement, from_id text not null, to_id text not null, gift text not null, stars integer not null, charge_id text unique, created_at integer not null)");
    db.prepare("insert into gifts (from_id, to_id, gift, stars, charge_id, created_at) values (?, ?, 'crown', ?, ?, ?)").run(w.fromId, winner.userId, WISH_STARS, w.chargeId, Math.floor(Date.now() / 1000));
  });
}

// ---------- події від власника ----------
export function setGameEvent(type, hours) {
  if (type === "double_hearts") {
    events.doubleUntil = Date.now() + Math.max(0.25, Math.min(24, Number(hours) || 1)) * 3600_000;
    for (const ws of sockets.values()) send(ws, eventView());
    return { doubleUntil: events.doubleUntil };
  }
  if (type === "free_rose") {
    withDb((db) => {
      db.exec("create table if not exists daily (user_id text primary key, last_day text, streak integer not null default 0, roses integer not null default 0, aims integer not null default 0)");
      db.prepare("insert into daily (user_id, roses) select id, 1 from users where adult = 1 and banned = 0 on conflict (user_id) do update set roses = daily.roses + 1").run();
    });
    for (const ws of sockets.values()) { sendWallet(ws); send(ws, { type: "notice", text: "🌹 Подарунок від бота: безкоштовна троянда кожному!" }); }
    return { ok: true };
  }
  return null;
}
export const gameEvents = () => ({ doubleUntil: events.doubleUntil > Date.now() ? events.doubleUntil : 0 });

function onDailyClaim(ws) {
  const res = claimDaily(ws.userId);
  if (!res) return sendWallet(ws);
  send(ws, { type: "daily_done", day: res.day, reward: res.reward });
  send(ws, { type: "wallet", roses: res.roses, aims: res.aims });
}

// Безкоштовна 🌹 з щоденної винагороди — такий самий подарунок, як оплачений.
function onFreeGift(ws, msg) {
  const t = ws.table;
  const to = t?.players[Number(msg.toSeat)];
  if (!to || to.id === ws.userId) return send(ws, { type: "error", message: "Обери іншого гравця за столом." });
  if (to.bot) return send(ws, { type: "error", message: "Це бот — подарунки, 🎯 і «наодинці» діють лише на людей." });
  if (!spend(ws.userId, "roses")) { sendWallet(ws); return send(ws, { type: "notice", text: "Безкоштовних троянд немає." }); }
  const g = GIFTS.rose;
  deliverTableGift(ws.userId, to.id, { id: "rose", emoji: g.emoji, name: g.name });
  withDb((db) => {
    db.exec("create table if not exists gifts (id integer primary key autoincrement, from_id text not null, to_id text not null, gift text not null, stars integer not null, charge_id text unique, created_at integer not null)");
    db.prepare("insert into gifts (from_id, to_id, gift, stars, charge_id, created_at) values (?, ?, 'rose', 0, null, ?)").run(ws.userId, to.id, Math.floor(Date.now() / 1000));
  });
  sendWallet(ws);
}

function onFreeAim(ws, msg) {
  const t = ws.table;
  const to = t?.players[Number(msg.toSeat)];
  const me = t?.players[ws.seat];
  if (!me || !to || to.id === ws.userId) return send(ws, { type: "error", message: "Обери іншого гравця за столом." });
  if (to.bot) return send(ws, { type: "error", message: "Це бот — подарунки, 🎯 і «наодинці» діють лише на людей." });
  if (!spend(ws.userId, "aims")) { sendWallet(ws); return send(ws, { type: "notice", text: "Безкоштовних 🎯 немає." }); }
  me.aimAt = to.id;
  send(ws, { type: "aim_set", to: Number(msg.toSeat) });
  sendWallet(ws);
}

async function onAimInvoice(ws, msg) {
  const t = ws.table;
  const to = t?.players[Number(msg.toSeat)];
  const now = Date.now();
  if (now - (ws.lastInvoice ?? 0) < 2000) return;
  ws.lastInvoice = now;
  if (!to || to.id === ws.userId) return send(ws, { type: "error", message: "Обери іншого гравця за столом." });
  if (to.bot) return send(ws, { type: "error", message: "Це бот — подарунки, 🎯 і «наодинці» діють лише на людей." });
  try {
    send(ws, { type: "invoice", link: await createAimInvoice(ws.userId, to.id) });
  } catch (err) {
    console.error("[game] aim invoice", err.message);
    send(ws, { type: "error", message: "Не вдалося створити рахунок. Спробуй ще раз." });
  }
}

async function onGiftInvoice(ws, msg) {
  const t = ws.table;
  const to = t?.players[Number(msg.toSeat)];
  const now = Date.now();
  if (now - (ws.lastInvoice ?? 0) < 2000) return;
  ws.lastInvoice = now;
  if (!to || to.id === ws.userId) return send(ws, { type: "error", message: "Обери іншого гравця за столом." });
  if (to.bot) return send(ws, { type: "error", message: "Це бот — подарунки, 🎯 і «наодинці» діють лише на людей." });
  try {
    send(ws, { type: "invoice", link: await createGiftInvoice(ws.userId, to.id, String(msg.gift), "t") });
  } catch (err) {
    console.error("[game] invoice", err.message);
    send(ws, { type: "error", message: "Не вдалося створити рахунок. Спробуй ще раз." });
  }
}

// Для монітора власника: що зараз відбувається за столами.
export function gameStats() {
  const list = [...tables.values()].map((t) => ({ id: t.id, players: humans(t).length, bots: seated(t).length - humans(t).length, phase: t.phase, round: t.round }));
  return { tables: list.length, players: list.reduce((n, t) => n + t.players, 0), bots: list.reduce((n, t) => n + t.bots, 0), list };
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
    tableGift: deliverTableGift,
    wishReady,
    wishPaid,
    aim: (from, to) => {
      const me = sockets.get(String(from));
      const t = me?.table;
      const p = t?.players[me.seat];
      const seat = t ? t.players.findIndex((x) => x?.id === String(to)) : -1;
      if (!p || seat < 0) return false;
      p.aimAt = String(to);
      send(me, { type: "aim_set", to: seat });
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
      profile = withDb((db) => {
        const cols = db.prepare("pragma table_info(users)").all().map((c) => c.name);
        const extra = cols.includes("join_with") ? ", join_with, join_at" : "";
        return db.prepare(`select adult, banned, display_name, gender, profile_age${extra} from users where id = ?`).get(userId);
      });
      ws.lang = langOf(userId);
      // Для воронки в моніторі: коли людина вперше зайшла в гру.
      try { withDb((db) => db.prepare("update users set game_at = coalesce(game_at, ?) where id = ?").run(Math.floor(Date.now() / 1000), userId)); } catch { /* стара база без колонки */ }
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
      else if (msg.type === "aim_invoice") void onAimInvoice(ws, msg);
      else if (msg.type === "daily_claim") onDailyClaim(ws);
      else if (msg.type === "wish_invoice") void onWishInvoice(ws, msg);
      else if (msg.type === "wish_answer") onWishAnswer(ws, msg);
      else if (msg.type === "wish_pick") onWishPick(ws, msg);
      else if (msg.type === "free_gift") onFreeGift(ws, msg);
      else if (msg.type === "free_aim") onFreeAim(ws, msg);
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