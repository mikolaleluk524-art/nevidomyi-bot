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

export function adminRoutes(req, res) {
  const key = process.env.ADMIN_KEY;
  if (!key || !sameKey(req.headers["x-admin-key"], key)) {
    res.writeHead(401, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "unauthorized" }));
    return true;
  }

  const url = new URL(req.url, "http://localhost");
  const path = url.pathname;

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