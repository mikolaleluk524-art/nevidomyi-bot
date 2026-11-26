/**
 * Застосунок б'юті-салону (PWA): онлайн-запис, передоплата, нагадування, маршрут, роботи, відгуки, бонуси.
 *
 * Змінні середовища (усі необовʼязкові):
 *   PORT              — порт (Railway задає сам)
 *   DATA_DIR          — папка для бази й фото (на Railway — том, напр. /data)
 *   PUBLIC_URL        — адреса сайту, напр. https://salon.up.railway.app (інакше береться з RAILWAY_PUBLIC_DOMAIN)
 *   ADMIN_PASSWORD    — пароль кабінету власниці (якщо не задано — створюється під час першого входу в /admin)
 *   LIQPAY_PUBLIC_KEY, LIQPAY_PRIVATE_KEY — ключі LiqPay (ПриватБанк) для передоплати
 *   MONO_TOKEN        — або токен monobank еквайрингу (без жодних ключів — тестова оплата)
 *   TG_BOT_TOKEN      — токен Telegram-бота «Зошит записів» (власниця підключається кнопкою в кабінеті)
 */
import { createServer } from "node:http";
import { createHmac, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { copyFileSync, createReadStream, existsSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { all, db, getSecret, getSettings, integrity, one, run, setSecret, setSettings, UPLOAD_DIR } from "./lib/db.js";
import { backupPath, listBackups, runBackups, startBackups } from "./lib/backup.js";
import { readTemplate, renderIndex, robots, sitemap } from "./lib/seo.js";
import { botInfo, linkCode, ownerChats, removeChat, startTelegram, telegramOn } from "./lib/telegram.js";
import { addDays, hm, humanDate, isDate, kyivNow, toMin } from "./lib/time.js";
import { notifyOwner, pushClient, saveSubscription, VAPID_PUBLIC } from "./lib/notify.js";
import { activateGift, createGift, GIFT_PENDING_MINUTES, giftByCode, giftLog, publicGift, redeemGift } from "./lib/gifts.js";
import { createPayment, liqpayCallback, paymentStatus, paymentsLive, provider } from "./lib/payments.js";
import {
  addBonus,
  applyPayment,
  availability,
  BookingError,
  cancelBooking,
  clientByToken,
  completeBooking,
  createBooking,
  daySlots,
  getBooking,
  nearestFree,
  normPhone,
  notifyWaitlist,
  PENDING_MINUTES,
  quote,
  upsertClient,
  decideRequest,
  when,
  withAddons,
} from "./lib/booking.js";

const ROOT = dirname(fileURLToPath(import.meta.url));
const PUBLIC = join(ROOT, "public");
const PORT = Number(process.env.PORT || 8080);

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".webmanifest": "application/manifest+json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".mp4": "video/mp4",
  ".mov": "video/quicktime",
  ".ico": "image/x-icon",
};

// ---------- утиліти HTTP ----------
class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function send(res, status, body, headers = {}) {
  const isBuf = Buffer.isBuffer(body);
  const data = isBuf || typeof body === "string" ? body : JSON.stringify(body);
  res.writeHead(status, {
    "content-type": isBuf || typeof body === "string" ? "text/plain; charset=utf-8" : "application/json; charset=utf-8",
    "cache-control": "no-store",
    ...headers,
  });
  res.end(data);
}

function readBody(req, limit = 64 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size > limit) {
        reject(new HttpError(413, "Завеликий файл"));
        req.destroy();
      } else chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

async function json(req) {
  const buf = await readBody(req);
  if (!buf.length) return {};
  try {
    return JSON.parse(buf.toString("utf8"));
  } catch {
    throw new HttpError(400, "Некоректні дані");
  }
}

function baseUrl(req) {
  if (process.env.PUBLIC_URL) return process.env.PUBLIC_URL.replace(/\/$/, "");
  if (process.env.RAILWAY_PUBLIC_DOMAIN) return `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`;
  const proto = req.headers["x-forwarded-proto"] || "http";
  return `${proto}://${req.headers.host}`;
}

// Простий ліміт запитів на IP для публічних дій.
const hits = new Map();
function rateLimit(req, key, max, windowMs) {
  const ip = (req.headers["x-forwarded-for"] || req.socket.remoteAddress || "").split(",")[0].trim();
  const k = key + ip;
  const now = Date.now();
  const arr = (hits.get(k) || []).filter((t) => now - t < windowMs);
  if (arr.length >= max) throw new HttpError(429, "Забагато спроб. Спробуйте трохи пізніше.");
  arr.push(now);
  hits.set(k, arr);
}
setInterval(() => hits.clear(), 3600_000).unref();

// ---------- кабінет власниці ----------
function passwordHash() {
  if (process.env.ADMIN_PASSWORD) return null;
  return getSecret("admin_pw");
}
function checkPassword(pw) {
  if (process.env.ADMIN_PASSWORD) {
    const a = Buffer.from(String(pw));
    const b = Buffer.from(process.env.ADMIN_PASSWORD);
    return a.length === b.length && timingSafeEqual(a, b);
  }
  const saved = passwordHash();
  if (!saved) return false;
  const [salt, hash] = saved.split(":");
  const h = scryptSync(String(pw), salt, 32);
  return timingSafeEqual(h, Buffer.from(hash, "hex"));
}
function sessionSecret() {
  let s = getSecret("session_secret");
  if (!s) {
    s = randomBytes(32).toString("hex");
    setSecret("session_secret", s);
  }
  return s + (process.env.ADMIN_PASSWORD || passwordHash() || "");
}
const adminToken = () => createHmac("sha256", sessionSecret()).update("admin").digest("base64url");
function isAdmin(req) {
  // Для завантаження файлів (копія бази, таблиця) токен можна передати в посиланні: ?t=…
  const t = String(req.headers["x-admin-token"] || new URL(req.url, "http://x").searchParams.get("t") || "");
  const good = adminToken();
  return t.length === good.length && timingSafeEqual(Buffer.from(t), Buffer.from(good));
}

// ---------- представлення ----------
function publicBooking(b) {
  return {
    id: b.id,
    service: b.service_name,
    serviceId: b.service_id,
    master: b.master_name,
    masterId: b.master_id,
    date: b.date,
    time: hm(b.start),
    duration: b.duration,
    when: when(b),
    startUtc: b.start_utc,
    price: b.price,
    discount: b.discount,
    bonusUsed: b.bonus_used,
    prepay: b.prepay,
    payUntil: b.pay_until || 0,
    paid: b.paid,
    status: b.status,
    reviewed: Boolean(one("SELECT id FROM reviews WHERE booking_id = ?", b.id)),
  };
}

function me(client) {
  const bookings = all(
    `SELECT b.*, c.name AS client_name, c.phone AS client_phone, m.name AS master_name FROM bookings b
     JOIN clients c ON c.id = b.client_id JOIN masters m ON m.id = b.master_id
     WHERE b.client_id = ? AND b.status != 'expired' ORDER BY b.start_utc DESC LIMIT 50`,
    client.id
  ).map(publicBooking);
  const invited = all("SELECT name, ref_rewarded FROM clients WHERE referred_by = ?", client.id);
  return {
    name: client.name,
    phone: client.phone,
    birthday: client.birthday,
    bonus: client.bonus,
    refCode: client.ref_code,
    invited: invited.map((c) => ({ name: c.name.split(" ")[0], came: Boolean(c.ref_rewarded) })),
    bonusLog: all("SELECT delta, reason, created_at FROM bonus_log WHERE client_id = ? ORDER BY id DESC LIMIT 20", client.id),
    bookings,
  };
}

function publicInfo() {
  const s = getSettings();
  const reviews = all("SELECT name, service, rating, text, reply, created_at FROM reviews WHERE status = 'approved' ORDER BY id DESC LIMIT 100");
  const avg = one("SELECT AVG(rating) AS avg, COUNT(*) AS n FROM reviews WHERE status = 'approved'");
  return {
    settings: s,
    services: all("SELECT id, category, name, description, price, duration, addon, price_from AS priceFrom FROM services WHERE active = 1 ORDER BY sort, id"),
    masters: all("SELECT id, name, role, photo, about, services FROM masters WHERE active = 1 ORDER BY sort, id").map((m) => ({
      ...m,
      services: JSON.parse(m.services || "[]"),
    })),
    gallery: all("SELECT id, kind, file, caption FROM gallery ORDER BY kind, sort, id DESC"),
    reviews,
    rating: { avg: avg.avg ? Math.round(avg.avg * 10) / 10 : null, count: avg.n },
    nearest: nearestFree(),
    vapidPublicKey: VAPID_PUBLIC,
    payments: provider(),
  };
}

async function startPayment(req, b) {
  if (!paymentsLive()) return { demoPay: true };
  const base = baseUrl(req);
  const pay = await createPayment({
    amount: b.prepay,
    // Для кожної спроби оплати — новий номер замовлення (LiqPay не дозволяє повторювати).
    orderId: `booking-${b.id}-${Date.now().toString(36)}`,
    description: `Передоплата: ${b.service_name}, ${b.date} ${hm(b.start)}`,
    resultUrl: `${base}/#/paid/${b.id}`,
    serverUrl: `${base}/api/pay/webhook`,
  });
  run("UPDATE bookings SET invoice_id = ? WHERE id = ?", pay.ref, b.id);
  return { payUrl: pay.pageUrl };
}

async function syncGift(g) {
  if (!g?.invoice_id || g.status !== "pending" || !paymentsLive()) return g;
  const st = await paymentStatus(g.invoice_id);
  return st.paid ? activateGift(g.id, st.amount) : g;
}

async function syncPayment(b) {
  if (!b?.invoice_id || b.paid || !paymentsLive()) return b;
  const st = await paymentStatus(b.invoice_id);
  if (st.paid) return applyPayment(b.id, st.amount || b.prepay);
  return b;
}

function ics(b, s) {
  const dt = (ms) => new Date(ms).toISOString().replace(/[-:]/g, "").replace(/\.\d+/, "");
  const esc = (t) => String(t).replace(/([,;\\])/g, "\\$1").replace(/\n/g, "\\n");
  return [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//salon//booking//UK",
    "BEGIN:VEVENT",
    `UID:booking-${b.id}@salon`,
    `DTSTAMP:${dt(Date.now())}`,
    `DTSTART:${dt(b.start_utc)}`,
    `DTEND:${dt(b.start_utc + b.duration * 60000)}`,
    `SUMMARY:${esc(`${b.service_name} — ${s.name}`)}`,
    `LOCATION:${esc(`${s.address}, ${s.cabinet}`)}`,
    `GEO:${s.lat};${s.lng}`,
    `DESCRIPTION:${esc(`${s.howToFind}\nТелефон: ${s.phone}`)}`,
    "BEGIN:VALARM",
    "TRIGGER:-PT2H",
    "ACTION:DISPLAY",
    "DESCRIPTION:Нагадування про запис",
    "END:VALARM",
    "END:VEVENT",
    "END:VCALENDAR",
  ].join("\r\n");
}

// ---------- маршрути API ----------
async function api(req, res, url) {
  const p = url.pathname;
  const m = req.method;
  const q = Object.fromEntries(url.searchParams);
  const client = () => {
    const c = clientByToken(req.headers["x-client-token"] || q.token);
    if (!c) throw new HttpError(401, "Спочатку запишіться — і ми вас запамʼятаємо");
    return c;
  };

  // --- публічне ---
  if (m === "GET" && p === "/api/public") return send(res, 200, publicInfo());

  if (m === "GET" && p === "/api/availability") {
    return send(res, 200, { days: availability(Number(q.service), Number(q.master) || null, Number(q.days) || 0, q.addons) });
  }

  if (m === "GET" && p === "/api/slots") {
    if (!isDate(q.date)) throw new HttpError(400, "Некоректна дата");
    return send(res, 200, { slots: daySlots(Number(q.service), Number(q.master) || null, q.date, q.addons) });
  }

  if (m === "POST" && p === "/api/scan") {
    // Лічильник сканувань QR (по одному на пристрій — це контролює застосунок).
    rateLimit(req, "scan", 30, 3600_000);
    const src = String((await json(req)).src || "").replace(/[^\w-]/g, "").slice(0, 40);
    if (src) run("INSERT INTO scans(src, scans) VALUES(?, 1) ON CONFLICT(src) DO UPDATE SET scans = scans + 1", src);
    return send(res, 200, { ok: true });
  }

  if (m === "POST" && p === "/api/quote") {
    const body = await json(req);
    const service = withAddons(body.serviceId, body.addons);
    if (!service) throw new HttpError(404, "Послугу не знайдено");
    const c = clientByToken(req.headers["x-client-token"]);
    return send(res, 200, quote({ service, client: c, date: body.date || kyivNow().date, useBonus: body.useBonus, ref: body.ref }));
  }

  if (m === "POST" && p === "/api/book") {
    rateLimit(req, "book", 15, 3600_000);
    const body = await json(req);
    const name = String(body.name || "").trim().slice(0, 80);
    const phone = normPhone(body.phone);
    if (name.length < 2) throw new HttpError(400, "Вкажіть, будь ласка, імʼя");
    if (!phone) throw new HttpError(400, "Перевірте номер телефону");
    if (!isDate(body.date) || !Number.isInteger(body.start)) throw new HttpError(400, "Оберіть дату й час");
    const c = upsertClient({ token: req.headers["x-client-token"], name, phone, ref: body.ref, src: body.src });
    const b = createBooking({
      serviceId: Number(body.serviceId),
      addonIds: body.addons,
      masterId: Number(body.masterId) || null,
      date: body.date,
      start: body.start,
      client: c,
      comment: body.comment,
      useBonus: Boolean(body.useBonus),
    });
    const pay = b.status === "pending" ? await startPayment(req, b).catch((e) => {
      console.error("[pay]", e.message);
      return { payError: "Не вдалося відкрити оплату. Спробуйте ще раз з розділу «Мої записи»." };
    }) : {};
    return send(res, 200, { token: c.token, booking: publicBooking(b), ...pay });
  }

  const payM = p.match(/^\/api\/bookings\/(\d+)\/(pay|status|cancel|demo-pay|ics)$/);
  if (payM) {
    const c = client();
    const b = getBooking(Number(payM[1]));
    if (!b || b.client_id !== c.id) throw new HttpError(404, "Запис не знайдено");
    const action = payM[2];
    if (action === "pay" && m === "POST") {
      if (b.status !== "pending") throw new HttpError(400, "Цей запис не очікує оплати");
      run("UPDATE bookings SET created_at = ? WHERE id = ?", Date.now(), b.id); // продовжуємо бронь
      return send(res, 200, await startPayment(req, b));
    }
    if (action === "demo-pay" && m === "POST") {
      if (paymentsLive()) throw new HttpError(400, "Тестова оплата вимкнена");
      return send(res, 200, { booking: publicBooking(await applyPayment(b.id, b.prepay)) });
    }
    if (action === "status" && m === "GET") {
      const nb = await syncPayment(b).catch(() => b);
      return send(res, 200, { booking: publicBooking(nb) });
    }
    if (action === "cancel" && m === "POST") {
      const r = await cancelBooking(b.id, { byClient: true });
      return send(res, 200, { ...r, booking: publicBooking(getBooking(b.id)) });
    }
    if (action === "ics" && m === "GET") {
      return send(res, 200, ics(b, getSettings()), {
        "content-type": "text/calendar; charset=utf-8",
        "content-disposition": `attachment; filename="zapys-${b.id}.ics"`,
      });
    }
  }

  // --- подарункові сертифікати ---
  if (m === "POST" && p === "/api/gifts") {
    rateLimit(req, "gift", 10, 3600_000);
    const body = await json(req);
    const amount = Math.round(Number(body.amount));
    const name = String(body.name || "").trim().slice(0, 80);
    const phone = normPhone(body.phone);
    if (!getSettings().onlinePay) throw new HttpError(400, "Онлайн-оплата поки недоступна. Замовте сертифікат у майстра — телефоном чи в месенджері.");
    if (!(amount >= 200 && amount <= 20000)) throw new HttpError(400, "Сума сертифіката — від 200 до 20 000 грн");
    if (name.length < 2) throw new HttpError(400, "Вкажіть, будь ласка, ваше імʼя");
    if (!phone) throw new HttpError(400, "Перевірте номер телефону");
    const g = createGift({ amount, buyerName: name, buyerPhone: phone, recipient: body.recipient, message: body.message });
    if (!paymentsLive()) return send(res, 200, { code: g.code, demoPay: true });
    const base = baseUrl(req);
    const pay = await createPayment({
      amount,
      orderId: `gift-${g.id}-${Date.now().toString(36)}`,
      description: `Подарунковий сертифікат «${getSettings().name}» на ${amount} грн`,
      resultUrl: `${base}/#/gift/${g.code}`,
      serverUrl: `${base}/api/pay/webhook`,
    });
    run("UPDATE gift_certs SET invoice_id = ? WHERE id = ?", pay.ref, g.id);
    return send(res, 200, { code: g.code, payUrl: pay.pageUrl });
  }
  const gc = p.match(/^\/api\/gifts\/([A-Za-z0-9-]+)(\/demo-pay)?$/);
  if (gc) {
    let g = giftByCode(gc[1]);
    if (!g || g.status === "cancelled") throw new HttpError(404, "Сертифікат не знайдено");
    if (gc[2] && m === "POST") {
      if (paymentsLive()) throw new HttpError(400, "Тестова оплата вимкнена");
      g = activateGift(g.id, g.amount);
    } else g = await syncGift(g).catch(() => g);
    return send(res, 200, publicGift(g));
  }

  if (m === "GET" && p === "/api/me") return send(res, 200, me(client()));

  if (m === "POST" && p === "/api/me") {
    const c = client();
    const body = await json(req);
    const name = String(body.name || c.name).trim().slice(0, 80);
    const birthday = /^\d{4}-\d{2}-\d{2}$/.test(body.birthday || "") ? body.birthday : c.birthday;
    if (c.birthday && birthday !== c.birthday) throw new HttpError(400, "День народження можна вказати лише один раз");
    run("UPDATE clients SET name = ?, birthday = ? WHERE id = ?", name, birthday, c.id);
    return send(res, 200, me(clientByToken(c.token)));
  }

  if (m === "POST" && p === "/api/reviews") {
    const c = client();
    const body = await json(req);
    const b = getBooking(Number(body.bookingId));
    if (!b || b.client_id !== c.id || b.status !== "done") throw new HttpError(400, "Відгук можна залишити після візиту");
    if (one("SELECT id FROM reviews WHERE booking_id = ?", b.id)) throw new HttpError(400, "Ви вже залишили відгук на цей візит");
    const rating = Math.max(1, Math.min(5, Number(body.rating) || 5));
    run(
      "INSERT INTO reviews(client_id, booking_id, name, service, rating, text, created_at) VALUES(?,?,?,?,?,?,?)",
      c.id,
      b.id,
      c.name.split(" ")[0],
      b.service_name,
      rating,
      String(body.text || "").slice(0, 1500),
      Date.now()
    );
    notifyOwner({ title: `⭐ Новий відгук: ${"★".repeat(rating)}`, body: `${c.name}: ${String(body.text || "").slice(0, 200)}`, url: "/admin#reviews" }).catch(() => {});
    return send(res, 200, { ok: true });
  }

  if (m === "POST" && p === "/api/waitlist") {
    const c = client();
    const body = await json(req);
    if (!isDate(body.date)) throw new HttpError(400, "Некоректна дата");
    run(
      "INSERT OR IGNORE INTO waitlist(client_id, service_id, master_id, date, created_at) VALUES(?,?,?,?,?)",
      c.id,
      Number(body.serviceId),
      Number(body.masterId) || null,
      body.date,
      Date.now()
    );
    return send(res, 200, { ok: true });
  }

  if (m === "POST" && p === "/api/push/subscribe") {
    const body = await json(req);
    const admin = isAdmin(req);
    const c = clientByToken(req.headers["x-client-token"]);
    if (!admin && !c) throw new HttpError(401, "Немає доступу");
    saveSubscription(body.subscription, { clientId: c?.id ?? null, isAdmin: admin });
    return send(res, 200, { ok: true });
  }

  if (m === "POST" && (p === "/api/pay/webhook" || p === "/api/mono/webhook")) {
    // Не довіряємо тілу запиту: для LiqPay перевіряємо підпис, і в обох випадках перепитуємо статус у банку.
    const raw = (await readBody(req)).toString("utf8");
    let ref = null;
    if (provider() === "liqpay") ref = liqpayCallback(Object.fromEntries(new URLSearchParams(raw)))?.order_id;
    else {
      try {
        ref = JSON.parse(raw).invoiceId;
      } catch {}
    }
    const b = ref ? one("SELECT * FROM bookings WHERE invoice_id = ?", String(ref)) : null;
    if (b) await syncPayment(b).catch((e) => console.error("[webhook]", e.message));
    const g = ref && !b ? one("SELECT * FROM gift_certs WHERE invoice_id = ?", String(ref)) : null;
    if (g) await syncGift(g).catch((e) => console.error("[webhook gift]", e.message));
    return send(res, 200, { ok: true });
  }

  // --- кабінет власниці ---
  if (p === "/api/admin/state" && m === "GET") {
    return send(res, 200, { needsSetup: !process.env.ADMIN_PASSWORD && !passwordHash(), authed: isAdmin(req) });
  }
  if (p === "/api/admin/login" && m === "POST") {
    rateLimit(req, "login", 10, 15 * 60_000);
    const body = await json(req);
    if (!process.env.ADMIN_PASSWORD && !passwordHash()) {
      if (String(body.password || "").length < 6) throw new HttpError(400, "Пароль має бути щонайменше 6 символів");
      const salt = randomBytes(16).toString("hex");
      setSecret("admin_pw", `${salt}:${scryptSync(String(body.password), salt, 32).toString("hex")}`);
    } else if (!checkPassword(body.password || "")) throw new HttpError(401, "Невірний пароль");
    return send(res, 200, { token: adminToken() });
  }

  if (p.startsWith("/api/admin/")) {
    if (!isAdmin(req)) throw new HttpError(401, "Увійдіть у кабінет");
    return adminApi(req, res, p, m, q);
  }

  throw new HttpError(404, "Не знайдено");
}

async function adminApi(req, res, p, m, q) {
  if (m === "GET" && p === "/api/admin/bookings") {
    const from = isDate(q.from) ? q.from : kyivNow().date;
    const to = isDate(q.to) ? q.to : addDays(from, 6);
    const rows = all(
      `SELECT b.*, c.name AS client_name, c.phone AS client_phone, c.note AS client_note, m.name AS master_name,
        (SELECT COUNT(*) FROM bookings x WHERE x.client_id = b.client_id AND x.status = 'done') AS visits,
        (SELECT COUNT(*) FROM bookings x WHERE x.client_id = b.client_id AND x.status = 'no_show') AS no_shows
       FROM bookings b JOIN clients c ON c.id = b.client_id JOIN masters m ON m.id = b.master_id
       WHERE b.date BETWEEN ? AND ? AND b.status != 'expired' ORDER BY b.date, b.start`,
      from,
      to
    ).map((b) => ({ ...publicBooking(b), clientName: b.client_name, clientPhone: b.client_phone, clientNote: b.client_note, comment: b.comment, visits: b.visits, noShows: b.no_shows, source: b.source, clientId: b.client_id }));
    const blocks = all("SELECT * FROM blocks WHERE date BETWEEN ? AND ? ORDER BY date, start", from, to);
    return send(res, 200, { from, to, bookings: rows, blocks });
  }

  if (m === "GET" && p === "/api/admin/gifts") {
    const q2 = `%${String(q.q || "").trim()}%`;
    const rows = all(
      "SELECT * FROM gift_certs WHERE status != 'pending' AND status != 'cancelled' AND (code LIKE ? OR buyer_name LIKE ? OR buyer_phone LIKE ? OR recipient LIKE ?) ORDER BY id DESC LIMIT 200",
      q2, q2, q2, q2
    );
    return send(res, 200, rows.map((g) => ({ ...publicGift(g), id: g.id, buyerName: g.buyer_name, buyerPhone: g.buyer_phone, createdAt: g.created_at, log: giftLog(g.id) })));
  }
  if (m === "GET" && p === "/api/admin/gifts/lookup") {
    const g = giftByCode(q.code);
    if (!g || g.status === "pending" || g.status === "cancelled") throw new HttpError(404, "Сертифікат з таким кодом не знайдено");
    return send(res, 200, { ...publicGift(g), id: g.id, buyerName: g.buyer_name, buyerPhone: g.buyer_phone, log: giftLog(g.id) });
  }
  const gr = p.match(/^\/api\/admin\/gifts\/(\d+)\/redeem$/);
  if (gr && m === "POST") {
    const body = await json(req);
    try {
      return send(res, 200, publicGift(redeemGift(Number(gr[1]), Number(body.amount), body.note || "")));
    } catch (e) {
      throw new HttpError(400, e.message);
    }
  }
  if (m === "POST" && p === "/api/admin/gifts") {
    // Сертифікат, проданий у салоні за готівку / на картку
    const body = await json(req);
    const amount = Math.round(Number(body.amount));
    if (!(amount > 0)) throw new HttpError(400, "Вкажіть суму");
    const g = createGift({ amount, buyerName: String(body.name || "Салон").trim() || "Салон", buyerPhone: normPhone(body.phone) || "", recipient: body.recipient, message: body.message });
    run("UPDATE gift_certs SET status = 'pending' WHERE id = ?", g.id);
    const a = activateGift(g.id, amount);
    return send(res, 200, publicGift(a));
  }

  // --- збереження даних ---
  const hm2 = p.match(/^\/api\/admin\/bookings\/(\d+)\/history$/);
  if (hm2 && m === "GET") return send(res, 200, all("SELECT old_status, new_status, at FROM booking_log WHERE booking_id = ? ORDER BY id", Number(hm2[1])));

  if (m === "GET" && p === "/api/admin/backups") {
    const r = (sql) => one(sql).n;
    return send(res, 200, {
      integrity,
      lastBackup: Number(getSecret("last_backup")) || 0,
      telegram: telegramOn() && ownerChats().length > 0,
      lastTelegram: getSecret("tg_backup_day") || "",
      onVolume: Boolean(process.env.RAILWAY_VOLUME_MOUNT_PATH),
      counts: { bookings: r("SELECT COUNT(*) n FROM bookings"), clients: r("SELECT COUNT(*) n FROM clients") },
      backups: listBackups().slice(0, 20),
    });
  }
  if (m === "GET" && p === "/api/admin/telegram") {
    if (!telegramOn()) return send(res, 200, { on: false });
    const bot = await botInfo();
    return send(res, 200, {
      on: true,
      bot: bot?.username || null,
      chats: ownerChats().map((c) => ({ id: String(c.id), name: c.name })),
      // Підключити можна лише один Telegram; щоб змінити — спершу відключити поточний
      link: bot && !ownerChats().length ? `https://t.me/${bot.username}?start=${linkCode()}` : null,
    });
  }
  const tcm = p.match(/^\/api\/admin\/telegram\/(-?\d+)$/);
  if (tcm && m === "DELETE") {
    removeChat(tcm[1]);
    return send(res, 200, { ok: true });
  }

  if (m === "POST" && p === "/api/admin/backups") {
    await runBackups();
    return send(res, 200, { ok: true });
  }
  if (m === "GET" && p === "/api/admin/backup") {
    // Свіжа копія бази — щоб зберегти собі на телефон / компʼютер
    const f = q.file ? backupPath(q.file) : null;
    let file = f;
    if (!file) {
      await runBackups();
      file = backupPath(listBackups()[0]?.file || "");
    }
    if (!file || !existsSync(file)) throw new HttpError(404, "Копію не знайдено");
    res.writeHead(200, {
      "content-type": "application/octet-stream",
      "content-disposition": `attachment; filename="magiia-krasy-${new Date().toISOString().slice(0, 10)}.sqlite"`,
      "cache-control": "no-store",
    });
    return createReadStream(file).pipe(res);
  }
  if (m === "GET" && p === "/api/admin/export.csv") {
    // Усі записи таблицею — відкривається в Excel / Google Таблицях
    const rows = all(
      `SELECT b.id, b.date, b.start, b.service_name, b.price, b.discount, b.bonus_used, b.paid, b.status, b.comment, b.created_at,
        c.name, c.phone, m.name AS master FROM bookings b JOIN clients c ON c.id = b.client_id JOIN masters m ON m.id = b.master_id
       ORDER BY b.date DESC, b.start DESC`
    );
    const STAT = { request: "заявка", pending: "очікує оплати", confirmed: "підтверджено", done: "прийшла", cancelled: "скасовано", no_show: "не прийшла", expired: "не оплачено" };
    const cell = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
    const lines = [
      ["№", "Дата", "Час", "Клієнтка", "Телефон", "Послуга", "Майстер", "Ціна", "Знижка", "Бонуси", "Сплачено наперед", "Статус", "Коментар", "Створено"].map(cell).join(";"),
      ...rows.map((b) =>
        [b.id, b.date, hm(b.start), b.name, b.phone, b.service_name, b.master, b.price, b.discount, b.bonus_used, b.paid, STAT[b.status] || b.status, b.comment, new Date(b.created_at).toLocaleString("uk-UA", { timeZone: "Europe/Kyiv" })]
          .map(cell)
          .join(";")
      ),
    ];
    res.writeHead(200, {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="zapysy-${new Date().toISOString().slice(0, 10)}.csv"`,
      "cache-control": "no-store",
    });
    return res.end("\ufeff" + lines.join("\r\n"));
  }

  if (m === "GET" && p === "/api/admin/requests") {
    // Усі нерозглянуті заявки нових клієнток, найближчі — першими
    const rows = all(
      `SELECT b.*, c.name AS client_name, c.phone AS client_phone, c.note AS client_note, m.name AS master_name,
        (SELECT COUNT(*) FROM bookings x WHERE x.client_id = b.client_id AND x.status = 'no_show') AS no_shows
       FROM bookings b JOIN clients c ON c.id = b.client_id JOIN masters m ON m.id = b.master_id
       WHERE b.status = 'request' ORDER BY b.start_utc`
    ).map((b) => ({ ...publicBooking(b), clientName: b.client_name, clientPhone: b.client_phone, clientNote: b.client_note, comment: b.comment, noShows: b.no_shows }));
    return send(res, 200, rows);
  }

  if (m === "GET" && p === "/api/admin/stats") {
    const today = kyivNow().date;
    const monthStart = today.slice(0, 8) + "01";
    const r = (sql, ...a) => one(sql, ...a);
    return send(res, 200, {
      today: r("SELECT COUNT(*) n FROM bookings WHERE date = ? AND status IN ('confirmed','done')", today).n,
      upcoming: r("SELECT COUNT(*) n FROM bookings WHERE date >= ? AND status = 'confirmed'", today).n,
      monthRevenue: r("SELECT COALESCE(SUM(price - discount - bonus_used),0) s FROM bookings WHERE date >= ? AND date <= ? AND status = 'done'", monthStart, today).s,
      monthVisits: r("SELECT COUNT(*) n FROM bookings WHERE date >= ? AND date <= ? AND status = 'done'", monthStart, today).n,
      clients: r("SELECT COUNT(*) n FROM clients").n,
      newClients: r("SELECT COUNT(*) n FROM clients WHERE created_at >= ?", Date.now() - 30 * 86400_000).n,
      pendingReviews: r("SELECT COUNT(*) n FROM reviews WHERE status = 'pending'").n,
      requests: r("SELECT COUNT(*) n FROM bookings WHERE status = 'request'").n,
      payments: getSettings().onlinePay ? provider() : "off",
      telegram: telegramOn() && ownerChats().length > 0,
    });
  }

  const bm = p.match(/^\/api\/admin\/bookings\/(\d+)$/);
  if (bm && m === "POST") {
    const body = await json(req);
    const id = Number(bm[1]);
    const b = getBooking(id);
    if (!b) throw new HttpError(404, "Запис не знайдено");
    if (body.decision === "confirm" || body.decision === "prepay") decideRequest(id, { withPrepay: body.decision === "prepay", remember: Boolean(body.remember) });
    else if (body.status === "done") completeBooking(id);
    else if (body.status === "cancelled") await cancelBooking(id, { refund: body.refund !== false });
    else if (body.status === "no_show") run("UPDATE bookings SET status = 'no_show' WHERE id = ?", id);
    else if (body.status === "confirmed") {
      // «Повернути запис» (напр. скасували помилково) — лише якщо час ще вільний
      if (["cancelled", "no_show", "expired"].includes(b.status)) {
        const clash = one(
          "SELECT id FROM bookings WHERE id != ? AND date = ? AND master_id = ? AND status IN ('request','pending','confirmed','done') AND start < ? AND start + duration > ?",
          id, b.date, b.master_id, b.start + b.duration, b.start
        );
        if (clash) throw new HttpError(409, "Цей час уже зайняв інший запис — запишіть клієнтку на інший час");
      }
      run("UPDATE bookings SET status = 'confirmed' WHERE id = ?", id);
    }
    if (typeof body.paid === "number") run("UPDATE bookings SET paid = ? WHERE id = ?", body.paid, id);
    return send(res, 200, { ok: true });
  }

  if (m === "POST" && p === "/api/admin/bookings") {
    const body = await json(req);
    const phone = normPhone(body.phone);
    if (!phone || !String(body.name || "").trim()) throw new HttpError(400, "Вкажіть імʼя і телефон");
    const c = upsertClient({ name: String(body.name).trim(), phone });
    const b = createBooking({
      serviceId: Number(body.serviceId),
      addonIds: body.addons,
      masterId: Number(body.masterId) || null,
      date: body.date,
      start: toMin(body.time),
      client: c,
      comment: body.comment,
      source: "admin",
      skipPrepay: true,
    });
    return send(res, 200, { booking: publicBooking(b) });
  }

  if (p === "/api/admin/settings") {
    if (m === "POST") setSettings(await json(req));
    return send(res, 200, getSettings());
  }

  if (p === "/api/admin/services") {
    if (m === "GET") return send(res, 200, all("SELECT * FROM services ORDER BY sort, id"));
    if (m === "POST") {
      const s = await json(req);
      const addon = s.addon ? 1 : 0;
      const vals = [String(s.category || ""), String(s.name || "").trim(), String(s.description || ""), Math.max(0, Number(s.price) || 0), Math.max(addon ? 0 : 5, Number(s.duration) || (addon ? 0 : 60)), s.active === false ? 0 : 1, Number(s.sort) || 0, addon, s.priceFrom ? 1 : 0];
      if (!vals[1]) throw new HttpError(400, "Вкажіть назву послуги");
      if (s.id) run("UPDATE services SET category=?, name=?, description=?, price=?, duration=?, active=?, sort=?, addon=?, price_from=? WHERE id=?", ...vals, Number(s.id));
      else run("INSERT INTO services(category, name, description, price, duration, active, sort, addon, price_from) VALUES(?,?,?,?,?,?,?,?,?)", ...vals);
      return send(res, 200, { ok: true });
    }
  }
  const sd = p.match(/^\/api\/admin\/services\/(\d+)$/);
  if (sd && m === "DELETE") {
    // Якщо послуга вже є в записах — просто ховаємо.
    if (one("SELECT id FROM bookings WHERE service_id = ? LIMIT 1", Number(sd[1]))) run("UPDATE services SET active = 0 WHERE id = ?", Number(sd[1]));
    else run("DELETE FROM services WHERE id = ?", Number(sd[1]));
    return send(res, 200, { ok: true });
  }

  if (p === "/api/admin/masters") {
    if (m === "GET") return send(res, 200, all("SELECT * FROM masters ORDER BY sort, id"));
    if (m === "POST") {
      const s = await json(req);
      const schedule = {};
      for (const [d, v] of Object.entries(s.schedule || {})) {
        if (Array.isArray(v) && /^\d\d:\d\d$/.test(v[0]) && /^\d\d:\d\d$/.test(v[1]) && toMin(v[1]) > toMin(v[0])) schedule[d] = v;
      }
      const vals = [String(s.name || "").trim(), String(s.role || ""), String(s.photo || ""), String(s.about || ""), JSON.stringify(schedule), JSON.stringify((s.services || []).map(Number)), s.active === false ? 0 : 1, Number(s.sort) || 0];
      if (!vals[0]) throw new HttpError(400, "Вкажіть імʼя майстра");
      if (s.id) run("UPDATE masters SET name=?, role=?, photo=?, about=?, schedule=?, services=?, active=?, sort=? WHERE id=?", ...vals, Number(s.id));
      else run("INSERT INTO masters(name, role, photo, about, schedule, services, active, sort) VALUES(?,?,?,?,?,?,?,?)", ...vals);
      return send(res, 200, { ok: true });
    }
  }

  if (p === "/api/admin/blocks") {
    if (m === "GET") return send(res, 200, all("SELECT * FROM blocks WHERE date >= ? ORDER BY date, start", kyivNow().date));
    if (m === "POST") {
      const b = await json(req);
      if (!isDate(b.date)) throw new HttpError(400, "Вкажіть дату");
      const dates = [b.date];
      if (isDate(b.dateTo)) for (let d = addDays(b.date, 1); d <= b.dateTo && dates.length < 60; d = addDays(d, 1)) dates.push(d);
      const start = b.allDay ? 0 : toMin(b.start || "00:00");
      const end = b.allDay ? 1440 : toMin(b.end || "23:59");
      for (const d of dates) run("INSERT INTO blocks(master_id, date, start, end, note) VALUES(?,?,?,?,?)", Number(b.masterId) || null, d, start, end, String(b.note || ""));
      return send(res, 200, { ok: true });
    }
  }
  const bd = p.match(/^\/api\/admin\/blocks\/(\d+)$/);
  if (bd && m === "DELETE") {
    const blk = one("SELECT * FROM blocks WHERE id = ?", Number(bd[1]));
    run("DELETE FROM blocks WHERE id = ?", Number(bd[1]));
    if (blk) for (const s of all("SELECT DISTINCT service_id FROM waitlist WHERE date = ? AND notified = 0", blk.date)) notifyWaitlist(blk.date, s.service_id);
    return send(res, 200, { ok: true });
  }

  if (m === "POST" && p === "/api/admin/upload") {
    const kind = ["work", "cert", "route", "salon", "master", "review"].includes(q.kind) ? q.kind : "work";
    const type = String(req.headers["content-type"] || "");
    const video = /video\/(mp4|quicktime)/.test(type);
    const ext = video ? (type.includes("quicktime") ? ".mov" : ".mp4") : type.includes("png") ? ".png" : type.includes("webp") ? ".webp" : ".jpg";
    const buf = await readBody(req, (video ? 60 : 10) * 1024 * 1024);
    if (buf.length < 100) throw new HttpError(400, "Порожній файл");
    const file = `${Date.now().toString(36)}${randomBytes(4).toString("hex")}${ext}`;
    writeFileSync(join(UPLOAD_DIR, file), buf);
    if (kind === "master") return send(res, 200, { file });
    const r = run("INSERT INTO gallery(kind, file, caption, sort, created_at) VALUES(?,?,?,?,?)", kind, file, String(q.caption || "").slice(0, 300), Number(q.sort) || 0, Date.now());
    return send(res, 200, { id: Number(r.lastInsertRowid), file });
  }
  const gm = p.match(/^\/api\/admin\/gallery\/(\d+)$/);
  if (gm) {
    const g = one("SELECT * FROM gallery WHERE id = ?", Number(gm[1]));
    if (!g) throw new HttpError(404, "Фото не знайдено");
    if (m === "DELETE") {
      run("DELETE FROM gallery WHERE id = ?", g.id);
      try {
        unlinkSync(join(UPLOAD_DIR, g.file));
      } catch {}
      return send(res, 200, { ok: true });
    }
    if (m === "POST") {
      const body = await json(req);
      run("UPDATE gallery SET caption = ?, sort = ? WHERE id = ?", String(body.caption ?? g.caption).slice(0, 300), Number(body.sort ?? g.sort) || 0, g.id);
      return send(res, 200, { ok: true });
    }
  }

  if (m === "GET" && p === "/api/admin/reviews") return send(res, 200, all("SELECT * FROM reviews ORDER BY id DESC LIMIT 300"));
  const rm = p.match(/^\/api\/admin\/reviews\/(\d+)$/);
  if (rm && m === "POST") {
    const body = await json(req);
    const r = one("SELECT * FROM reviews WHERE id = ?", Number(rm[1]));
    if (!r) throw new HttpError(404, "Відгук не знайдено");
    const status = ["approved", "hidden", "pending"].includes(body.status) ? body.status : r.status;
    run("UPDATE reviews SET status = ?, reply = ? WHERE id = ?", status, String(body.reply ?? r.reply).slice(0, 1500), r.id);
    if (body.reply && body.reply !== r.reply && r.client_id) pushClient(r.client_id, { title: "Вам відповіли на відгук 💬", body: String(body.reply).slice(0, 120), url: "/#/reviews" }).catch(() => {});
    return send(res, 200, { ok: true });
  }

  if (m === "GET" && p === "/api/admin/clients") {
    const s = `%${String(q.q || "").trim()}%`;
    return send(
      res,
      200,
      all(
        `SELECT c.id, c.name, c.phone, c.bonus, c.birthday, c.note, c.ref_code, c.src, c.prepay_rule, c.created_at,
          (SELECT name FROM clients r WHERE r.id = c.referred_by) AS referred_by_name,
          (SELECT COUNT(*) FROM bookings b WHERE b.client_id = c.id AND b.status = 'done') AS visits,
          (SELECT MAX(date) FROM bookings b WHERE b.client_id = c.id AND b.status = 'done') AS last_visit,
          (SELECT COUNT(*) FROM clients r WHERE r.referred_by = c.id) AS invited
         FROM clients c WHERE c.name LIKE ? OR c.phone LIKE ? ORDER BY c.id DESC LIMIT 300`,
        s,
        s
      )
    );
  }
  const cm = p.match(/^\/api\/admin\/clients\/(\d+)$/);
  if (cm && m === "POST") {
    const body = await json(req);
    const id = Number(cm[1]);
    if (typeof body.note === "string") run("UPDATE clients SET note = ? WHERE id = ?", body.note.slice(0, 1000), id);
    if (["", "never", "always"].includes(body.prepayRule)) run("UPDATE clients SET prepay_rule = ? WHERE id = ?", body.prepayRule, id);
    if (Number(body.bonusDelta)) addBonus(id, Math.trunc(Number(body.bonusDelta)), body.reason || "Коригування від майстра");
    return send(res, 200, { ok: true });
  }

  if (m === "GET" && p === "/api/admin/sources") {
    // Які QR-постери працюють: сканування → нові клієнтки → візити.
    const rows = all(
      `SELECT s.src, s.scans,
        (SELECT COUNT(*) FROM clients c WHERE c.src = s.src) AS clients,
        (SELECT COUNT(*) FROM bookings b JOIN clients c ON c.id = b.client_id WHERE c.src = s.src AND b.status = 'done') AS visits
       FROM scans s ORDER BY s.scans DESC`
    );
    return send(res, 200, rows);
  }

  if (m === "POST" && p === "/api/admin/broadcast") {
    // Розсилка всім клієнтам з увімкненими сповіщеннями (акції, вільні вікна).
    const body = await json(req);
    if (!String(body.title || "").trim()) throw new HttpError(400, "Вкажіть заголовок");
    const ids = all("SELECT DISTINCT client_id FROM push_subs WHERE client_id IS NOT NULL").map((r) => r.client_id);
    let sent = 0;
    for (const id of ids) sent += await pushClient(id, { title: String(body.title).slice(0, 80), body: String(body.body || "").slice(0, 300), url: body.url || "/#/book" });
    return send(res, 200, { sent, clients: ids.length });
  }

  throw new HttpError(404, "Не знайдено");
}

// ---------- статика ----------
function serveStatic(req, res, url) {
  let p = decodeURIComponent(url.pathname);
  if (p.startsWith("/uploads/")) {
    const f = normalize(join(UPLOAD_DIR, p.slice(9)));
    if (!f.startsWith(UPLOAD_DIR) || !existsSync(f)) return send(res, 404, "Not found");
    const size = statSync(f).size;
    const head = { "content-type": MIME[extname(f)] || "application/octet-stream", "cache-control": "public, max-age=31536000, immutable", "accept-ranges": "bytes" };
    // Відео на iPhone грає лише з підтримкою Range-запитів.
    const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || "");
    if (range) {
      let start = range[1] ? Number(range[1]) : size - Number(range[2]);
      let end = range[1] && range[2] ? Number(range[2]) : size - 1;
      if (!(start >= 0 && start <= end && end < size)) {
        res.writeHead(416, { "content-range": `bytes */${size}` });
        return res.end();
      }
      res.writeHead(206, { ...head, "content-range": `bytes ${start}-${end}/${size}`, "content-length": end - start + 1 });
      return createReadStream(f, { start, end }).pipe(res);
    }
    res.writeHead(200, { ...head, "content-length": size });
    return createReadStream(f).pipe(res);
  }
  if (p === "/robots.txt") return send(res, 200, robots(baseUrl(req)), { "content-type": "text/plain; charset=utf-8", "cache-control": "public, max-age=3600" });
  if (p === "/sitemap.xml") return send(res, 200, sitemap(baseUrl(req)), { "content-type": "application/xml; charset=utf-8", "cache-control": "public, max-age=3600" });
  if (p === "/admin" || p === "/admin/") p = "/admin.html";
  if (p === "/poster" || p === "/poster/") p = "/poster.html";
  const f = normalize(join(PUBLIC, p));
  if (p === "/" || p === "/index.html" || !f.startsWith(PUBLIC) || !existsSync(f) || !statSync(f).isFile()) {
    // Головна (і невідомі шляхи) — з текстом і даними для Google
    const html = renderIndex(readTemplate(join(PUBLIC, "index.html")), baseUrl(req));
    return send(res, 200, html, { "content-type": "text/html; charset=utf-8", "cache-control": "no-cache" });
  }
  serveFile(res, f);
}

function serveFile(res, f) {
  const ext = extname(f);
  const noCache = [".html", ".webmanifest"].includes(ext) || f.endsWith("sw.js");
  res.writeHead(200, {
    "content-type": MIME[ext] || "application/octet-stream",
    "cache-control": noCache ? "no-cache" : "public, max-age=3600",
    ...(f.endsWith("sw.js") ? { "service-worker-allowed": "/" } : {}),
  });
  res.end(readFileSync(f));
}

// ---------- стартові фото робіт (папка seed/) — додаються один раз при першому запуску ----------
(function seedGallery() {
  const dir = join(ROOT, "seed");
  if (!existsSync(dir)) return;
  const captions = {
    "w01-marmur": "Мармуровий дизайн",
    "w02-marmur-dovgi": "Мармур на довгих нігтях",
    "w03-french": "Класичний френч",
    "w04-fuksiia": "Соковита фуксія",
    "w05-pudra-mygdal": "Пудровий мигдаль",
    "w06-pudra-ruka": "Ніжний нюд",
    "w07-chervoni": "Класичний червоний",
    "w08-chervoni-kulak": "Червоний мигдаль",
    "w09-konfeti": "Нюд з конфеті",
    "w10-nude-zoloto": "Нюд із золотою поталлю",
    "w11-opal": "Опаловий блиск",
    "w12-vyshnia": "Вишневий квадрат",
    "w13-pedykiur-zhovtyi": "Педикюр · ніжний жовтий",
    "w14-pera": "Дизайн «пір'я» з поталлю",
    "v01-pudra": "Пудровий мигдаль — відео",
    "v02-chervoni": "Червоний мигдаль — відео",
    "v03-fuksiia": "Фуксія — відео",
    "v04-marmur": "Мармур — відео",
    "c01-dont-stop-school": "Навчання в Don't Stop Nail School · листопад 2024",
    "r01-nadiageorgian": "«Жіночі радості ❤️ Це було круто!»",
    "r02-nadiageorgian-lift": "«Після манікюру і на нього авжеж 😅»",
    "r03-nadiageorgian-dijshla": "«Я дійшла на манікюр 🥰»",
    "r04-mblond-chystka": "«Ну просто ідеальна чистка»",
    "r05-mblond-rozhevi": "«Вони ідеальні. Дякую»",
    "r06-olga-krasa": "«Краса номер раз 🤍»",
    "r07-malysh-idealni": "«Як завжди ідеальні ❤️»",
    "r08-malysh-morozyvo": "Колаж від постійної клієнтки",
    "r09-malysh-0540": "О 05:40 — бо потрібен новий манікюр 😄",
    "r10-dija-zoloto": "Яскравий дизайн із поталлю",
    "r11-dija-french": "Ніжний френч 🥰",
    "r12-nadezhda": "«Дякую, моя дорога»",
  };
  const KIND = { w: "work", v: "work", c: "cert", r: "review" };
  // Кожен стартовий файл додається лише ОДИН раз — видалене майстром фото не повернеться.
  const seeded = new Set(JSON.parse(getSecret("seeded_files") || "[]"));
  if (getSecret("seeded_gallery") && !seeded.size) {
    // перехід зі старої схеми: усе, що вже є в галереї, вважаємо доданим
    for (const g of all("SELECT file FROM gallery")) seeded.add(g.file);
    for (const f of readdirSync(dir)) if (/^(w(0\d|1[0-2])|v0[1-4]|c01)/.test(f)) seeded.add(f);
  }
  const files = readdirSync(dir).filter((f) => /\.(jpg|mp4)$/.test(f)).sort();
  let sort = (one("SELECT MAX(sort) n FROM gallery").n || 0) + 1;
  for (const f of files) {
    if (!existsSync(join(UPLOAD_DIR, f))) copyFileSync(join(dir, f), join(UPLOAD_DIR, f));
    if (f.endsWith("-poster.jpg") || seeded.has(f)) continue;
    if (f.startsWith("m")) {
      // Фото майстра — лише якщо Марина Олександрівна ще не поставила своє в кабінеті
      run("UPDATE masters SET photo = ? WHERE id = (SELECT id FROM masters ORDER BY sort, id LIMIT 1) AND COALESCE(photo, '') = ''", f);
      seeded.add(f);
      continue;
    }
    const base = f.replace(/\.\w+$/, "");
    const kind = KIND[f[0]] || "work";
    // Відео — першими, щоб головна виглядала «живою»
    run("INSERT INTO gallery(kind, file, caption, sort, created_at) VALUES(?,?,?,?,?)", kind, f, captions[base] || "", f.startsWith("v") ? sort++ - 1000 : sort++, Date.now());
    seeded.add(f);
  }
  setSecret("seeded_files", JSON.stringify([...seeded]));
  setSecret("seeded_gallery", "1");
})();

// ---------- фонові задачі: нагадування, згорання броней ----------
async function tick() {
  const now = Date.now();
  // Неоплачені броні звільняють час через PENDING_MINUTES хв.
  // pay_until > 0 — передоплату попросила майстер, у клієнтки є кілька годин; інакше — 20 хв.
  for (const b of all(
    "SELECT * FROM bookings WHERE status = 'pending' AND ((pay_until > 0 AND pay_until < ?) OR (pay_until = 0 AND created_at < ?))",
    now,
    now - PENDING_MINUTES * 60_000
  )) {
    const fresh = await syncPayment(b).catch(() => b);
    if (fresh.status === "pending") {
      run("UPDATE bookings SET status = 'expired' WHERE id = ?", b.id);
      if (b.bonus_used) addBonus(b.client_id, b.bonus_used, `Повернення бонусів, бронь #${b.id} не оплачена`);
      notifyWaitlist(b.date, b.service_id);
      if (b.pay_until) {
        const c = one("SELECT name, phone FROM clients WHERE id = ?", b.client_id);
        notifyOwner({ title: "⌛ Передоплату не внесено", body: `${c.name} (${c.phone}): ${b.service_name}, ${b.date} ${hm(b.start)} — час знову вільний.`, url: "/admin" }).catch(() => {});
      }
    }
  }
  // Неоплачені сертифікати
  for (const g of all("SELECT * FROM gift_certs WHERE status = 'pending' AND created_at < ?", now - GIFT_PENDING_MINUTES * 60_000)) {
    const fresh = await syncGift(g).catch(() => g);
    if (fresh.status === "pending") run("UPDATE gift_certs SET status = 'cancelled' WHERE id = ?", g.id);
  }
  // Заявки, які так і не розглянули до початку візиту
  for (const b of all("SELECT * FROM bookings WHERE status = 'request' AND start_utc < ?", now)) {
    run("UPDATE bookings SET status = 'expired' WHERE id = ?", b.id);
    if (b.bonus_used) addBonus(b.client_id, b.bonus_used, `Повернення бонусів, заявка #${b.id} не розглянута`);
  }
  const s = getSettings();
  for (const b of all("SELECT * FROM bookings WHERE status = 'confirmed' AND reminded24 = 0 AND start_utc - ? BETWEEN 0 AND ?", now, 24 * 3600_000)) {
    run("UPDATE bookings SET reminded24 = 1 WHERE id = ?", b.id);
    if (b.start_utc - now < 3 * 3600_000) continue; // записалися день у день — вистачить нагадування за 2 год
    await pushClient(b.client_id, {
      title: `Нагадуємо: ${b.service_name}`,
      body: `${humanDate(b.date)} о ${hm(b.start)}. ${s.address}. Якщо плани змінилися — скасуйте у застосунку.`,
      url: `/#/visit/${b.id}`,
      tag: "remind-" + b.id,
    });
  }
  for (const b of all("SELECT * FROM bookings WHERE status = 'confirmed' AND reminded2 = 0 AND start_utc - ? BETWEEN 0 AND ?", now, 2 * 3600_000)) {
    run("UPDATE bookings SET reminded2 = 1 WHERE id = ?", b.id);
    await pushClient(b.client_id, {
      title: `Чекаємо вас о ${hm(b.start)} 💖`,
      body: `Натисніть — відкриємо карту і покажемо, як дійти до кабінету (${s.cabinet}).`,
      url: `/#/visit/${b.id}`,
      tag: "remind-" + b.id,
      requireInteraction: true,
    });
  }
  // Через 3 години після візиту — прохання залишити відгук.
  for (const b of all("SELECT * FROM bookings WHERE status = 'done' AND asked_review = 0 AND start_utc + duration * 60000 < ?", now - 3 * 3600_000)) {
    run("UPDATE bookings SET asked_review = 1 WHERE id = ?", b.id);
    if (b.start_utc < now - 3 * 86400_000) continue;
    await pushClient(b.client_id, {
      title: "Як вам результат? ✨",
      body: "Залиште коротенький відгук — це дуже допомагає майстру.",
      url: `/#/review/${b.id}`,
    });
  }
}

let ticking = false;
setInterval(async () => {
  if (ticking) return;
  ticking = true;
  try {
    await tick();
  } catch (e) {
    console.error("[tick]", e.message);
  } finally {
    ticking = false;
  }
}, 60_000);

// ---------- сервер ----------
startBackups();
startTelegram();
if (integrity !== "ok") notifyOwner({ title: "⚠️ Перевірка бази", body: `Перевірка цілісності: ${integrity}. Є резервні копії — напишіть розробнику.` }).catch(() => {});

// Коректне завершення при оновленні: дописуємо все на диск і закриваємо базу.
for (const sig of ["SIGTERM", "SIGINT"]) {
  process.on(sig, () => {
    try {
      db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
      db.close();
    } catch {}
    process.exit(0);
  });
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  try {
    if (url.pathname.startsWith("/api/")) return await api(req, res, url);
    if (url.pathname === "/health") return send(res, 200, { ok: true });
    if (req.method !== "GET" && req.method !== "HEAD") return send(res, 405, "Method not allowed");
    serveStatic(req, res, url);
  } catch (e) {
    const status = e instanceof HttpError ? e.status : e instanceof BookingError ? 409 : 500;
    if (status === 500) console.error("[http]", req.method, url.pathname, e);
    if (!res.headersSent) send(res, status, { error: status === 500 ? "Щось пішло не так. Спробуйте ще раз." : e.message });
  }
}).listen(PORT, "0.0.0.0", () => console.log(`[salon] http://localhost:${PORT}`));
