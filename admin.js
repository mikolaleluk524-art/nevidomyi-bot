/**
 * Адмін API для Невідомий.
 * Підключається в index.js, читає ту саму SQLite.
 *
 * Змінні середовища:
 *   ADMIN_KEY  — секрет для заголовка X-Admin-Key (обов'язково)
 */

import { DatabaseSync } from "node:sqlite";
import { createHash, timingSafeEqual } from "node:crypto";
import { DB_PATH } from "./src/bot.js";

// Порівняння ключа за постійний час (хеші однакової довжини).
function sameKey(given, expected) {
  const a = createHash("sha256").update(String(given ?? "")).digest();
  const b = createHash("sha256").update(String(expected)).digest();
  return timingSafeEqual(a, b);
}

function openReadOnly() {
  return new DatabaseSync(DB_PATH, { readOnly: true });
}

function nowSec() {
  return Math.floor(Date.now() / 1000);
}

// index.js передає сюди стан процесу: опитування Telegram, ігрові столи, пам'ять.
let monitorSource = () => ({});
export function setMonitorSource(fn) { monitorSource = fn; }

const kyivDay = (sec) => new Date(sec * 1000).toLocaleDateString("en-CA", { timeZone: "Europe/Kiev" });
// Вид покупки за payload рахунку.
function payKind(payload) {
  const p = String(payload);
  if (p.startsWith("gift:")) return "gift";
  if (p.startsWith("reveal:")) return "reveal";
  if (p.startsWith("back:")) return "back";
  if (p.startsWith("aim:")) return "aim";
  if (p === "prem:search") return "search";
  if (p === "prem:sub") return "sub";
  if (p.startsWith("prem:")) return "premium";
  return "other";
}
const hasTable = (db, name) => Boolean(db.prepare("select 1 as x from sqlite_master where type = 'table' and name = ?").get(name));

function monitorData(db) {
  const now = nowSec();
  const day = now - 86400;
  const one = (sql, ...a) => db.prepare(sql).get(...a);
  const users = one(`select count(*) as total,
      sum(last_seen > ? and banned = 0) as online,
      sum(status = 'chat' and banned = 0) as inChat,
      sum(status = 'search' and banned = 0) as inSearch,
      sum(premium_until > ? and banned = 0) as premium,
      sum(banned = 1) as banned,
      sum(created_at > ?) as new24,
      sum(adult = 1) as adults,
      sum(lang = 'uk') as uk, sum(lang = 'ru') as ru, sum(lang = 'en') as en,
      sum(gender = 'Чоловік') as male, sum(gender = 'Жінка') as female
    from users`, now - 300, now, day);

  const pays = db.prepare("select payload, stars, created_at, user_id from payments").all();
  const money = { day: 0, week: 0, total: 0, byKind: {}, count24: 0 };
  for (const p of pays) {
    money.total += p.stars;
    if (p.created_at > now - 7 * 86400) money.week += p.stars;
    if (p.created_at > day) { money.day += p.stars; money.count24 += 1; }
    const k = payKind(p.payload);
    money.byKind[k] = (money.byKind[k] ?? 0) + p.stars;
  }
  const recent = pays.filter((p) => p.created_at).sort((a, b) => b.created_at - a.created_at).slice(0, 15)
    .map((p) => ({ kind: payKind(p.payload), payload: p.payload, stars: p.stars, at: p.created_at }));

  // Графіки за 7 днів (київський час).
  const days = [];
  for (let i = 6; i >= 0; i--) days.push(kyivDay(now - i * 86400));
  const series = Object.fromEntries(days.map((d) => [d, { users: 0, stars: 0 }]));
  for (const r of db.prepare("select created_at from users where created_at > ?").all(now - 8 * 86400)) {
    const d = kyivDay(r.created_at); if (series[d]) series[d].users += 1;
  }
  for (const p of pays) if (p.created_at) { const d = kyivDay(p.created_at); if (series[d]) series[d].stars += p.stars; }

  const gifts = hasTable(db, "gifts") ? one("select count(*) as c, sum(stars = 0) as free, coalesce(sum(stars), 0) as stars from gifts where created_at > ?", day) : { c: 0, free: 0, stars: 0 };
  const daily = hasTable(db, "daily") ? one("select count(*) as c, max(streak) as best from daily where last_day = ?", kyivDay(now)) : { c: 0, best: 0 };
  const reports = one("select count(*) as c from reports where created_at > ?", day).c;
  const lastReports = db.prepare("select created_at, target_id from reports order by created_at desc limit 5").all();

  return {
    now,
    users,
    money,
    recent,
    series: days.map((d) => ({ day: d, ...series[d] })),
    gifts: { count: gifts.c ?? 0, free: gifts.free ?? 0, stars: gifts.stars ?? 0 },
    daily: { claimed: daily.c ?? 0, bestStreak: daily.best ?? 0 },
    reports: { day: reports, last: lastReports },
    process: monitorSource(),
  };
}

export function adminRoutes(req, res) {
  const key = process.env.ADMIN_KEY;
  if (!key || !sameKey(req.headers["x-admin-key"], key)) {
    res.writeHead(401, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "unauthorized" }));
    return true;
  }

  const url = new URL(req.url, "http://localhost");
  const path = url.pathname;

  if (path === "/admin/monitor") {
    const db = openReadOnly();
    try {
      res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
      res.end(JSON.stringify(monitorData(db)));
    } finally {
      db.close();
    }
    return true;
  }

  if (path === "/admin/stats") {
    const db = openReadOnly();
    try {
      const now = nowSec();
      const online = db.prepare(
        "select count(*) as c from users where last_seen > ? and banned = 0"
      ).get(now - 300).c;

      const inChat = db.prepare(
        "select count(*) as c from users where status = 'chat' and banned = 0"
      ).get().c;

      const inSearch = db.prepare(
        "select count(*) as c from users where status = 'search' and banned = 0"
      ).get().c;

      const premium = db.prepare(
        "select count(*) as c from users where premium_until > ? and banned = 0"
      ).get(now).c;

      const banned = db.prepare(
        "select count(*) as c from users where banned = 1"
      ).get().c;

      const total = db.prepare("select count(*) as c from users").get().c;

      // Останні 24 години (а не з опівночі UTC, щоб не залежати від часового поясу сервера).
      const since = now - 86400;
      const paymentsToday = db.prepare(
        "select coalesce(sum(stars), 0) as stars, count(*) as c from payments where created_at > ?"
      ).get(since);

      const reportsToday = db.prepare(
        "select count(*) as c from reports where created_at > ?"
      ).get(since).c;

      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        online,
        inChat,
        inSearch,
        premium,
        banned,
        total,
        paymentsToday: paymentsToday.stars,
        paymentsCount: paymentsToday.c,
        reportsToday,
        timestamp: now,
      }));
    } finally {
      db.close();
    }
    return true;
  }

  if (path === "/admin/dialogs") {
    const db = openReadOnly();
    try {
      const rows = db.prepare(`
        select 
          u1.id as user1_id,
          u1.gender as user1_gender,
          u1.profile_age as user1_age,
          u1.city as user1_city,
          u1.premium_until as user1_premium,
          u2.id as user2_id,
          u2.gender as user2_gender,
          u2.profile_age as user2_age,
          u2.city as user2_city,
          u2.premium_until as user2_premium
        from users u1
        join users u2 on u1.partner_id = u2.id
        where u1.status = 'chat' and u1.id < u2.id
        limit 50
      `).all();

      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(rows));
    } finally {
      db.close();
    }
    return true;
  }

  if (path === "/admin/queue") {
    const db = openReadOnly();
    try {
      const rows = db.prepare(`
        select 
          id, gender, profile_age, city, search_mode, 
          premium_until, last_seen
        from users 
        where status = 'search' and banned = 0
        order by last_seen desc
        limit 100
      `).all();

      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(rows));
    } finally {
      db.close();
    }
    return true;
  }

  if (path === "/admin/payments") {
    const db = openReadOnly();
    try {
      const rows = db.prepare(`
        select p.charge_id, p.user_id, p.payload, p.stars,
               u.gender, u.profile_age, u.city
        from payments p
        left join users u on u.id = p.user_id
        order by p.charge_id desc
        limit 50
      `).all();

      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(rows));
    } finally {
      db.close();
    }
    return true;
  }

  if (path === "/admin/reports") {
    const db = openReadOnly();
    try {
      const rows = db.prepare(`
        select r.id, r.reporter_id, r.target_id, r.created_at,
               u1.gender as reporter_gender, u1.city as reporter_city,
               u2.gender as target_gender, u2.city as target_city
        from reports r
        left join users u1 on u1.id = r.reporter_id
        left join users u2 on u2.id = r.target_id
        order by r.created_at desc
        limit 50
      `).all();

      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(rows));
    } finally {
      db.close();
    }
    return true;
  }

  return false;
}