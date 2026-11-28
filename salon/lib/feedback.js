// Опитування після візиту (смайлики + кілька коротких питань) і рейтинг клієнтки від майстра.
import { randomBytes } from "node:crypto";
import { all, db, one, run } from "./db.js";

db.exec(`CREATE TABLE IF NOT EXISTS feedback (
  id INTEGER PRIMARY KEY,
  booking_id INTEGER UNIQUE NOT NULL,
  client_id INTEGER NOT NULL,
  answers TEXT NOT NULL,          -- JSON { q1: "😍", ... }
  mood INTEGER NOT NULL,          -- 1..5 (з першого питання)
  text TEXT DEFAULT '',
  created_at INTEGER NOT NULL
)`);

// Питання для клієнтки. Перше — загальне враження, з нього рахується оцінка 1–5.
export const QUESTIONS = [
  { id: "result", q: "Як вам результат?", options: [["😍", "Неймовірно"], ["😊", "Гарно"], ["😐", "Нормально"], ["😕", "Не дуже"], ["😞", "Погано"]] },
  { id: "comfort", q: "Чи комфортно вам було під час процедури?", options: [["😌", "Дуже комфортно"], ["🙂", "Добре"], ["😬", "Трохи неприємно"], ["😣", "Боляче"]] },
  { id: "time", q: "Чи почали вчасно?", options: [["⏰", "Так, вчасно"], ["⌛", "Трохи зачекала"], ["🐢", "Довго чекала"]] },
  { id: "place", q: "Як вам атмосфера і чистота в кабінеті?", options: [["✨", "Ідеально"], ["👍", "Добре"], ["🤔", "Є що покращити"]] },
  { id: "again", q: "Прийдете до Марини ще раз?", options: [["💯", "Обовʼязково"], ["🙂", "Мабуть, так"], ["🤷‍♀️", "Ще не знаю"]] },
  { id: "recommend", q: "Порадите Марину подрузі?", options: [["💖", "Вже раджу!"], ["👌", "Так"], ["🙊", "Поки ні"]] },
];
const MOOD = { "😍": 5, "😊": 4, "😐": 3, "😕": 2, "😞": 1 };

// Рейтинг клієнтки, який ставить майстер (бачить лише вона)
export const CLIENT_RATINGS = [
  ["😍", "Улюблена клієнтка"],
  ["🙂", "Приємна"],
  ["😐", "Звичайна"],
  ["⏰", "Часто запізнюється"],
  ["😤", "Складна"],
  ["🚫", "Не записувати"],
];

export function feedbackToken(bookingId) {
  const b = one("SELECT fb_token FROM bookings WHERE id = ?", bookingId);
  if (!b) return null;
  if (b.fb_token) return b.fb_token;
  const t = randomBytes(9).toString("base64url");
  run("UPDATE bookings SET fb_token = ? WHERE id = ?", t, bookingId);
  return t;
}

export function feedbackByToken(token) {
  const b = one(
    `SELECT b.id, b.client_id, b.service_name, b.date, b.start, b.status, m.name AS master FROM bookings b
     JOIN masters m ON m.id = b.master_id WHERE b.fb_token = ?`,
    String(token || "")
  );
  if (!b) return null;
  return { booking: b, answered: Boolean(one("SELECT id FROM feedback WHERE booking_id = ?", b.id)) };
}

/** Зберігає відповіді. Повертає { mood }. */
export function saveFeedback(bookingId, clientId, answers, text) {
  const clean = {};
  for (const q of QUESTIONS) {
    const a = answers?.[q.id];
    if (q.options.some(([e]) => e === a)) clean[q.id] = a;
  }
  if (!clean.result) throw new Error("Оберіть, будь ласка, смайлик у першому питанні");
  const mood = MOOD[clean.result];
  run(
    "INSERT INTO feedback(booking_id, client_id, answers, mood, text, created_at) VALUES(?,?,?,?,?,?) ON CONFLICT(booking_id) DO NOTHING",
    bookingId,
    clientId,
    JSON.stringify(clean),
    mood,
    String(text || "").slice(0, 1500),
    Date.now()
  );
  return { mood, answers: clean };
}

export function feedbackList(limit = 200) {
  return all(
    `SELECT f.*, c.name AS client_name, b.service_name, b.date FROM feedback f
     JOIN clients c ON c.id = f.client_id JOIN bookings b ON b.id = f.booking_id ORDER BY f.id DESC LIMIT ?`,
    limit
  ).map((f) => ({ ...f, answers: JSON.parse(f.answers) }));
}

export const feedbackFor = (bookingId) => {
  const f = one("SELECT answers, mood, text FROM feedback WHERE booking_id = ?", bookingId);
  return f ? { ...f, answers: JSON.parse(f.answers) } : null;
};

/** Короткий підсумок відповідей одним рядком смайликів (для журналу/Telegram). */
export const summary = (answers) => QUESTIONS.map((q) => answers[q.id]).filter(Boolean).join(" ");
