// Вільні вікна, створення записів, бонуси, рефералка.
import { randomBytes } from "node:crypto";
import { all, getSettings, one, run, tx } from "./db.js";
import { addDays, hm, humanDate, kyivNow, kyivToUtc, toMin, weekday } from "./time.js";
import { notifyOwner, pushClient } from "./notify.js";
import { paymentsLive, refundPayment } from "./payments.js";

// request — заявка нової клієнтки, яку ще не розглянула майстер (час уже утримується)
const ACTIVE = "('request','pending','confirmed','done')";
export const PENDING_MINUTES = 20;

export const activeMasters = () => all("SELECT * FROM masters WHERE active = 1 ORDER BY sort, id");

export function mastersFor(serviceId) {
  return activeMasters().filter((m) => {
    const list = JSON.parse(m.services || "[]");
    return !list.length || list.includes(Number(serviceId));
  });
}

/** Вільні початки (у хвилинах) для майстра на дату під тривалість. */
export function freeStarts(master, date, duration, s = getSettings()) {
  const sch = JSON.parse(master.schedule || "{}")[weekday(date)];
  if (!sch) return [];
  const open = toMin(sch[0]);
  const close = toMin(sch[1]);
  const busy = [
    ...all(`SELECT start, start + duration AS end FROM bookings WHERE date = ? AND master_id = ? AND status IN ${ACTIVE}`, date, master.id),
    ...all("SELECT start, end FROM blocks WHERE date = ? AND (master_id IS NULL OR master_id = ?)", date, master.id),
  ];
  const earliest = Date.now() + s.minNoticeHours * 3600_000;
  const step = Math.max(5, s.slotStep || 30);
  const out = [];
  for (let t = open; t + duration <= close; t += step) {
    if (kyivToUtc(date, t) < earliest) continue;
    if (busy.some((b) => t < b.end && t + duration > b.start)) continue;
    out.push(t);
  }
  return out;
}

/**
 * Основна послуга + обрані доповнення (френч, ремонт нігтя…) як одна «послуга»:
 * ціна й тривалість сумуються, назва — «Покриття гель-лаком + Френч».
 * Доповнення приймаються лише з тієї ж категорії, що й основна послуга.
 */
export function withAddons(serviceId, addonIds = []) {
  const main = one("SELECT * FROM services WHERE id = ? AND active = 1 AND addon = 0", Number(serviceId));
  if (!main) return null;
  const ids = [...new Set((Array.isArray(addonIds) ? addonIds : String(addonIds || "").split(",")).map(Number).filter(Boolean))];
  const addons = ids
    .map((id) => one("SELECT * FROM services WHERE id = ? AND active = 1 AND addon = 1", id))
    .filter((a) => a && (!a.category || a.category === main.category));
  return {
    ...main,
    mainName: main.name,
    addons,
    name: [main.name, ...addons.map((a) => a.name)].join(" + "),
    price: main.price + addons.reduce((x, a) => x + a.price, 0),
    duration: main.duration + addons.reduce((x, a) => x + a.duration, 0),
  };
}

/** Слоти на день: [{ start, time, masters: [id] }] */
export function daySlots(serviceId, masterId, date, addonIds = []) {
  const service = withAddons(serviceId, addonIds);
  if (!service) return [];
  const s = getSettings();
  const masters = mastersFor(serviceId).filter((m) => !masterId || m.id === Number(masterId));
  const map = new Map();
  for (const m of masters) {
    for (const t of freeStarts(m, date, service.duration, s)) {
      if (!map.has(t)) map.set(t, []);
      map.get(t).push(m.id);
    }
  }
  return [...map.entries()].sort((a, b) => a[0] - b[0]).map(([start, ids]) => ({ start, time: hm(start), masters: ids }));
}

export function availability(serviceId, masterId, days, addonIds = []) {
  const s = getSettings();
  const today = kyivNow().date;
  const n = Math.min(days || s.bookingDays, s.bookingDays, 90);
  const out = [];
  for (let i = 0; i < n; i++) {
    const date = addDays(today, i);
    out.push({ date, free: daySlots(serviceId, masterId, date, addonIds).length });
  }
  return out;
}

/** Найближче вільне вікно на будь-яку послугу (для головного екрана). */
export function nearestFree() {
  const service = one("SELECT * FROM services WHERE active = 1 AND addon = 0 ORDER BY duration, sort LIMIT 1");
  if (!service) return null;
  const today = kyivNow().date;
  for (let i = 0; i < 14; i++) {
    const date = addDays(today, i);
    const slots = daySlots(service.id, null, date);
    if (slots.length) return { date, time: slots[0].time, count: slots.length };
  }
  return null;
}

// ---- Клієнти ----
export function normPhone(p) {
  let d = String(p || "").replace(/\D/g, "");
  if (d.length === 10 && d.startsWith("0")) d = "38" + d;
  if (d.length === 9) d = "380" + d;
  if (d.length < 10 || d.length > 15) return null;
  return "+" + d;
}

const code = (n) => {
  const abc = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  return [...randomBytes(n)].map((b) => abc[b % abc.length]).join("");
};

export function clientByToken(token) {
  return token ? one("SELECT * FROM clients WHERE token = ?", String(token)) : null;
}

export function upsertClient({ token, name, phone, ref, src = "" }) {
  let c = clientByToken(token);
  if (!c) c = one("SELECT * FROM clients WHERE phone = ?", phone);
  if (c) {
    if (name && name !== c.name) run("UPDATE clients SET name = ? WHERE id = ?", name, c.id);
    return one("SELECT * FROM clients WHERE id = ?", c.id);
  }
  const referrer = ref ? one("SELECT id FROM clients WHERE ref_code = ?", String(ref).toUpperCase()) : null;
  let refCode = code(6);
  while (one("SELECT id FROM clients WHERE ref_code = ?", refCode)) refCode = code(6);
  const r = run(
    "INSERT INTO clients(name, phone, token, ref_code, referred_by, src, created_at) VALUES(?, ?, ?, ?, ?, ?, ?)",
    name,
    phone,
    randomBytes(24).toString("base64url"),
    refCode,
    referrer?.id ?? null,
    String(src || "").slice(0, 40),
    Date.now()
  );
  return one("SELECT * FROM clients WHERE id = ?", r.lastInsertRowid);
}

export function addBonus(clientId, delta, reason) {
  if (!delta) return;
  run("UPDATE clients SET bonus = MAX(0, bonus + ?) WHERE id = ?", delta, clientId);
  run("INSERT INTO bonus_log(client_id, delta, reason, created_at) VALUES(?, ?, ?, ?)", clientId, delta, reason, Date.now());
}

const isFirstVisit = (clientId) => !one(`SELECT id FROM bookings WHERE client_id = ? AND status IN ${ACTIVE}`, clientId);

function birthdayWeek(birthday, date) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(birthday || "")) return false;
  const y = Number(date.slice(0, 4));
  for (const yy of [y - 1, y, y + 1]) {
    const bd = `${yy}${birthday.slice(4)}`;
    const diff = Math.abs(kyivToUtc(bd, 0) - kyivToUtc(date, 0)) / 86400_000;
    if (diff <= 3) return true;
  }
  return false;
}

/**
 * Чи потрібна передоплата цій клієнтці:
 *   "none" — записується одразу без передоплати
 *   "now"  — платить передоплату, щоб записатися
 *   "ask"  — надсилає заявку, а майстер вирішує (з передоплатою чи без)
 * Постійна клієнтка = хоча б один візит і жодного пропуску.
 */
export function prepayDecision(client, s = getSettings()) {
  if (!s.onlinePay || !(s.prepayPercent > 0)) return "none";
  if (client?.prepay_rule === "never") return "none";
  if (client?.prepay_rule === "always") return "now";
  const visits = client ? one("SELECT COUNT(*) n FROM bookings WHERE client_id = ? AND status = 'done'", client.id).n : 0;
  const noShows = client ? one("SELECT COUNT(*) n FROM bookings WHERE client_id = ? AND status = 'no_show'", client.id).n : 0;
  const regular = visits > 0 && noShows === 0;
  if (s.prepayMode === "all") return "now";
  if (s.prepayMode === "new") return regular ? "none" : "now";
  return regular ? "none" : "ask"; // manual
}

/** Розрахунок ціни. Повертає { price, discount, discountReason, bonusUse, total, prepay, prepayAmount, prepayMode } */
export function quote({ service, client, date, useBonus, ref }) {
  const s = getSettings();
  const price = service.price;
  let discount = 0;
  let discountReason = "";
  const firstTime = !client || isFirstVisit(client.id);
  const referred = client ? client.referred_by : ref && one("SELECT id FROM clients WHERE ref_code = ?", String(ref).toUpperCase());
  if (firstTime && referred && s.refDiscount > 0) {
    discount = Math.min(s.refDiscount, price);
    discountReason = "Знижка за запрошенням подруги";
  }
  if (client && s.birthdayDiscount > 0 && birthdayWeek(client.birthday, date)) {
    const bd = Math.round((price * s.birthdayDiscount) / 100);
    if (bd > discount) {
      discount = bd;
      discountReason = `З днем народження! −${s.birthdayDiscount}%`;
    }
  }
  let bonusUse = 0;
  if (useBonus && client?.bonus > 0) {
    bonusUse = Math.min(client.bonus, Math.floor((price * s.maxBonusPercent) / 100), price - discount);
  }
  const total = Math.max(0, price - discount - bonusUse);
  const prepayAmount = s.prepayPercent > 0 ? Math.ceil((total * Math.min(100, s.prepayPercent)) / 100) : 0;
  const prepayMode = prepayAmount > 0 ? prepayDecision(client, s) : "none";
  return { price, discount, discountReason, bonusUse, total, prepay: prepayMode === "now" ? prepayAmount : 0, prepayAmount, prepayMode };
}

export class BookingError extends Error {}

export function createBooking({ serviceId, addonIds = [], masterId, date, start, client, comment, useBonus, source = "app", skipPrepay = false }) {
  const service = withAddons(serviceId, addonIds);
  if (!service) throw new BookingError("Послугу не знайдено");
  const s = getSettings();
  const today = kyivNow().date;
  if (date < today || date > addDays(today, s.bookingDays)) throw new BookingError("Ця дата недоступна для запису");
  return tx(() => {
    const masters = mastersFor(service.id).filter((m) => !masterId || m.id === Number(masterId));
    const master = masters.find((m) => (source === "admin" ? true : freeStarts(m, date, service.duration, s).includes(start)));
    if (!master) throw new BookingError("Цей час щойно зайняли. Оберіть, будь ласка, інший.");
    if (source === "admin") {
      const clash = one(
        `SELECT id FROM bookings WHERE date = ? AND master_id = ? AND status IN ${ACTIVE} AND start < ? AND start + duration > ?`,
        date,
        master.id,
        start + service.duration,
        start
      );
      if (clash) throw new BookingError("На цей час уже є запис");
    }
    const q = quote({ service, client, date, useBonus });
    const mode = skipPrepay ? "none" : q.prepayMode;
    // Для заявки зберігаємо суму передоплати — на випадок, якщо майстер її попросить.
    const prepay = mode === "none" ? 0 : q.prepayAmount;
    const status = mode === "now" ? "pending" : mode === "ask" ? "request" : "confirmed";
    const r = run(
      `INSERT INTO bookings(client_id, master_id, service_id, service_name, date, start, duration, start_utc, price, discount,
        bonus_used, prepay, status, comment, source, created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      client.id,
      master.id,
      service.id,
      service.name,
      date,
      start,
      service.duration,
      kyivToUtc(date, start),
      q.price,
      q.discount,
      q.bonusUse,
      prepay,
      status,
      String(comment || "").slice(0, 500),
      source,
      Date.now()
    );
    if (q.bonusUse) addBonus(client.id, -q.bonusUse, `Оплата бонусами, запис #${r.lastInsertRowid}`);
    const b = getBooking(r.lastInsertRowid);
    if (status === "confirmed") onConfirmed(b);
    if (status === "request") {
      notifyOwner({
        title: "📩 Нова заявка — нова клієнтка",
        body: `${b.client_name} (${b.client_phone})\n${b.service_name} — ${when(b)}\nПідтвердіть без передоплати або попросіть передоплату.`,
        url: "/admin",
        tag: "booking-" + b.id,
        requireInteraction: true,
      }).catch(() => {});
    }
    return b;
  });
}

export function getBooking(id) {
  return one(
    `SELECT b.*, c.name AS client_name, c.phone AS client_phone, m.name AS master_name
     FROM bookings b JOIN clients c ON c.id = b.client_id JOIN masters m ON m.id = b.master_id WHERE b.id = ?`,
    id
  );
}

export const when = (b) => `${humanDate(b.date)} о ${hm(b.start)}`;

function onConfirmed(b) {
  const paid = b.paid ? ` · передоплата ${b.paid} грн` : "";
  notifyOwner({
    title: "💅 Новий запис",
    body: `${b.client_name} (${b.client_phone})\n${b.service_name} — ${when(b)}${paid}`,
    url: "/admin",
    tag: "booking-" + b.id,
  }).catch(() => {});
}

/**
 * Рішення майстра щодо заявки: без передоплати (запис підтверджено) або з передоплатою
 * (клієнтка отримує сповіщення і має сплатити протягом prepayHours годин).
 * remember=true запамʼятовує вибір для цієї клієнтки на майбутнє.
 */
export function decideRequest(id, { withPrepay, remember = false }) {
  const b = getBooking(id);
  if (!b || b.status !== "request") throw new BookingError("Ця заявка вже розглянута");
  const s = getSettings();
  if (remember) run("UPDATE clients SET prepay_rule = ? WHERE id = ?", withPrepay ? "always" : "never", b.client_id);
  if (!withPrepay || !b.prepay) {
    run("UPDATE bookings SET status = 'confirmed', prepay = 0 WHERE id = ?", id);
    pushClient(b.client_id, { title: "Ваш запис підтверджено ✓", body: `${b.service_name} — ${when(b)}. Чекаємо на вас!`, url: "/#/me", tag: "booking-" + id }).catch(() => {});
    return getBooking(id);
  }
  // Час на оплату: prepayHours, але не пізніше ніж за 1 год до візиту (і не менше 20 хв).
  const until = Math.max(Date.now() + PENDING_MINUTES * 60_000, Math.min(Date.now() + (s.prepayHours || 3) * 3600_000, b.start_utc - 3600_000));
  run("UPDATE bookings SET status = 'pending', pay_until = ?, created_at = ? WHERE id = ?", until, Date.now(), id);
  const t = new Date(until).toLocaleTimeString("uk-UA", { timeZone: "Europe/Kyiv", hour: "2-digit", minute: "2-digit" });
  pushClient(b.client_id, {
    title: `Підтвердіть запис передоплатою ${b.prepay} грн`,
    body: `${b.service_name} — ${when(b)}. Сплатіть до ${t}, щоб закріпити час.`,
    url: "/#/me",
    tag: "booking-" + id,
    requireInteraction: true,
  }).catch(() => {});
  return getBooking(id);
}

/** Позначити оплату (з вебхука або тестової оплати). */
export async function applyPayment(id, amount) {
  const b = getBooking(id);
  if (!b || b.paid) return b;
  if (b.status === "pending") {
    run("UPDATE bookings SET paid = ?, status = 'confirmed' WHERE id = ?", amount, id);
    const nb = getBooking(id);
    onConfirmed(nb);
    return nb;
  }
  // Оплата прийшла після того, як бронь згоріла: підтверджуємо, якщо час ще вільний, інакше — повертаємо гроші.
  if (b.status === "expired") {
    const free = freeStarts(one("SELECT * FROM masters WHERE id = ?", b.master_id), b.date, b.duration).includes(b.start);
    if (free) {
      run("UPDATE bookings SET paid = ?, status = 'confirmed' WHERE id = ?", amount, id);
      const nb = getBooking(id);
      onConfirmed(nb);
      return nb;
    }
    if (b.invoice_id && paymentsLive()) await refundPayment(b.invoice_id, amount).catch((e) => console.error("[refund]", e.message));
  }
  return getBooking(id);
}

/** Скасування. byClient=true перевіряє дедлайн. */
export async function cancelBooking(id, { byClient = false, refund = true } = {}) {
  const b = getBooking(id);
  if (!b || !["request", "pending", "confirmed"].includes(b.status)) throw new BookingError("Цей запис уже не можна скасувати");
  const s = getSettings();
  const late = b.start_utc - Date.now() < s.cancelHours * 3600_000;
  if (byClient && late && b.paid) throw new BookingError(`Безкоштовне скасування — не пізніше ніж за ${s.cancelHours} год. Напишіть, будь ласка, майстру.`);
  run("UPDATE bookings SET status = 'cancelled' WHERE id = ?", id);
  if (b.bonus_used) addBonus(b.client_id, b.bonus_used, `Повернення бонусів, скасовано запис #${id}`);
  let refunded = false;
  if (refund && b.paid && b.invoice_id && paymentsLive()) {
    try {
      await refundPayment(b.invoice_id, b.paid);
      refunded = true;
    } catch (e) {
      console.error("[refund]", e.message);
    }
  }
  if (byClient) {
    notifyOwner({ title: "❌ Скасування", body: `${b.client_name}: ${b.service_name} — ${when(b)}`, url: "/admin" }).catch(() => {});
  } else {
    pushClient(b.client_id, { title: "Запис скасовано", body: `${b.service_name} — ${when(b)}. Оберіть інший час у застосунку.`, url: "/#/book" }).catch(() => {});
  }
  notifyWaitlist(b.date, b.service_id);
  return { refunded };
}

/** Візит відбувся: кешбек + винагорода за подругу. */
export function completeBooking(id) {
  const b = getBooking(id);
  if (!b || b.status === "done") return;
  run("UPDATE bookings SET status = 'done' WHERE id = ?", id);
  const s = getSettings();
  const total = b.price - b.discount - b.bonus_used;
  const cashback = Math.floor((total * s.cashbackPercent) / 100);
  if (cashback > 0) addBonus(b.client_id, cashback, `Кешбек ${s.cashbackPercent}% за візит #${id}`);
  const c = one("SELECT * FROM clients WHERE id = ?", b.client_id);
  if (c.referred_by && !c.ref_rewarded && s.refBonus > 0) {
    run("UPDATE clients SET ref_rewarded = 1 WHERE id = ?", c.id);
    addBonus(c.referred_by, s.refBonus, `Подруга ${c.name} прийшла на перший візит`);
    pushClient(c.referred_by, {
      title: "🎁 +" + s.refBonus + " бонусів",
      body: `${c.name} прийшла за вашим запрошенням. Дякуємо! Бонуси вже на рахунку.`,
      url: "/#/me",
    }).catch(() => {});
  }
}

export function notifyWaitlist(date, serviceId) {
  const rows = all("SELECT * FROM waitlist WHERE date = ? AND service_id = ? AND notified = 0", date, serviceId);
  if (!rows.length) return;
  const slots = daySlots(serviceId, null, date);
  if (!slots.length) return;
  for (const w of rows) {
    run("UPDATE waitlist SET notified = 1 WHERE id = ?", w.id);
    pushClient(w.client_id, {
      title: "Звільнилося місце!",
      body: `${humanDate(date)} — є вільний час о ${slots[0].time}. Встигніть записатися.`,
      url: `/#/book?service=${serviceId}&date=${date}`,
      tag: "wait-" + date,
    }).catch(() => {});
  }
}
