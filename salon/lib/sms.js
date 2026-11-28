// SMS-нагадування клієнткам напередодні візиту — через TurboSMS (turbosms.ua).
// Потрібна змінна TURBOSMS_TOKEN (токен з кабінету TurboSMS) і зареєстрований там підпис відправника.
import { all, db, getSettings, one, run } from "./db.js";
import { addDays, hm, kyivNow } from "./time.js";
import { sendViber, viberOn } from "./viber.js";

db.exec(`CREATE TABLE IF NOT EXISTS sms_log (
  id INTEGER PRIMARY KEY,
  booking_id INTEGER,
  phone TEXT NOT NULL,
  text TEXT NOT NULL,
  ok INTEGER NOT NULL,
  info TEXT DEFAULT '',
  created_at INTEGER NOT NULL
)`);

const token = () => process.env.TURBOSMS_TOKEN?.trim();
export const smsOn = () => Boolean(token());

const MONTHS = ["січня", "лютого", "березня", "квітня", "травня", "червня", "липня", "серпня", "вересня", "жовтня", "листопада", "грудня"];

/** Справжній номер клієнтки (записи з паперового зошита мають позначку « #N» — їм не пишемо). */
export function realPhone(p) {
  const s = String(p || "");
  if (s.includes(" #")) return null;
  const d = s.replace(/\D/g, "");
  return /^380\d{9}$/.test(d) ? d : null;
}

// «Покриття гель-лаком» → «покриття гель-лаком»; запис без процедури — «процедуру»
const serviceText = (name) => (!name || name.startsWith("Запис із зошита") ? "процедуру" : name[0].toLowerCase() + name.slice(1));

// Адреса сайту для посилання в повідомленні (клієнтка натискає — відкривається сайт, звідти можна встановити застосунок)
const siteUrl = () => (process.env.PUBLIC_URL || (process.env.RAILWAY_PUBLIC_DOMAIN ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}` : "https://magiia-krasy.up.railway.app")).replace(/\/$/, ""); // без зайвих символів — щоб нагадування вміщалося в 3 SMS

export function smsText(b, s = getSettings()) {
  const parts = String(b.client_name || "").split(" ");
  const first = parts[0].endsWith(".") ? parts.join(" ") : parts[0];
  const [, m, d] = b.date.split("-").map(Number);
  return String(s.smsText || "")
    .replaceAll("{імʼя}", first)
    .replaceAll("{час}", hm(b.start))
    .replaceAll("{дата}", `${d} ${MONTHS[m - 1]}`)
    .replaceAll("{процедура}", serviceText(b.service_name))
    .replaceAll("{адреса}", [s.address, s.cabinet].filter(Boolean).join(", "))
    .replaceAll("{телефон}", s.phone.replace(/^\+38/, ""))
    .replaceAll("{сайт}", siteUrl())
    .replace(/\s+/g, " ")
    .trim();
}

/** Відправка однієї SMS. Повертає { ok, info }. */
async function turbo(phone, text, sender, channel) {
  const res = await fetch("https://api.turbosms.ua/message/send.json", {
    method: "POST",
    headers: { "content-type": "application/json", Authorization: `Bearer ${token()}` },
    // Канал: viber (лише Viber), viber+sms (Viber, а якщо не доставлено — SMS), sms
    body: JSON.stringify({
      recipients: [phone],
      ...(channel !== "sms" ? { viber: { sender, text, ttl: 3600 } } : {}),
      ...(channel !== "viber" ? { sms: { sender, text } } : {}),
    }),
  });
  const data = await res.json().catch(() => ({}));
  const r = data.response_result?.[0];
  const okCode = (c) => [0, 800, 801, 802, 803].includes(Number(c));
  return {
    ok: res.ok && okCode(data.response_code) && (!r || okCode(r.response_code)),
    status: String(r?.response_status || data.response_status || `HTTP ${res.status}`),
    id: r?.message_id,
  };
}

// Підпис, який TurboSMS гарантовано дозволяє цьому акаунту (поки не затверджено власний)
const SAFE_SENDER = "TAXI";

/** Відправка одного нагадування. Якщо підпис/канал не дозволені — повтор як SMS з підписом TAXI. Повертає { ok, info }. */
export async function sendSms(phone, text, bookingId = null) {
  const s = getSettings();
  let ok = false;
  let info = "";
  try {
    if (!token()) throw new Error("не підключено TurboSMS (немає TURBOSMS_TOKEN)");
    let r = await turbo(phone, text, s.smsSender || SAFE_SENDER, s.smsChannel || "sms");
    if (!r.ok && /SENDER|VIBER/i.test(r.status) && (s.smsSender !== SAFE_SENDER || s.smsChannel !== "sms")) {
      const first = r.status;
      r = await turbo(phone, text, SAFE_SENDER, "sms");
      r.status = `${r.status} (підпис «${s.smsSender}» не дозволено: ${first} — надіслано як SMS від ${SAFE_SENDER})`;
    }
    ok = r.ok;
    info = r.status + (r.id ? ` · ${r.id}` : "");
  } catch (e) {
    info = e.message;
  }
  run("INSERT INTO sms_log(booking_id, phone, text, ok, info, created_at) VALUES(?,?,?,?,?,?)", bookingId, phone, text, ok ? 1 : 0, info, Date.now());
  if (!ok) console.error("[sms]", phone, info);
  else console.log("[sms] надіслано", phone, info);
  return { ok, info };
}

export async function smsBalance() {
  if (!token()) return null;
  try {
    const res = await fetch("https://api.turbosms.ua/user/balance.json", { headers: { Authorization: `Bearer ${token()}` } });
    const data = await res.json();
    return data.response_result?.balance ?? null;
  } catch {
    return null;
  }
}

/** Щовечора о smsHour — нагадування всім, хто записаний на завтра і має справжній номер. */
export async function smsTick() {
  const s = getSettings();
  if (!s.smsEnabled || (!smsOn() && !viberOn())) return;
  const { date, minutes } = kyivNow();
  const hour = Number.isFinite(Number(s.smsHour)) ? Number(s.smsHour) : 19;
  if (minutes < hour * 60) return;
  const tomorrow = addDays(date, 1);
  const rows = all(
    `SELECT b.*, c.name AS client_name, c.phone AS client_phone, c.viber_id FROM bookings b JOIN clients c ON c.id = b.client_id
     WHERE b.date = ? AND b.status = 'confirmed' AND b.sms_sent = 0`,
    tomorrow
  );
  for (const b of rows) {
    run("UPDATE bookings SET sms_sent = 1 WHERE id = ?", b.id); // спершу позначаємо — щоб ніколи не надіслати двічі
    const text = smsText(b, s);
    // Спершу безкоштовний Viber-бот (якщо клієнтка підписалася), інакше — SMS
    if (b.viber_id && viberOn()) {
      try {
        await sendViber(b.viber_id, text);
        run("INSERT INTO sms_log(booking_id, phone, text, ok, info, created_at) VALUES(?,?,?,1,'Viber-бот',?)", b.id, realPhone(b.client_phone) || "viber", text, Date.now());
        continue;
      } catch (e) {
        console.error("[viber]", e.message);
      }
    }
    const phone = realPhone(b.client_phone);
    if (!phone || !smsOn()) continue;
    await sendSms(phone, text, b.id);
  }
}

export const smsLog = (limit = 30) => all("SELECT * FROM sms_log ORDER BY id DESC LIMIT ?", limit);
export const smsTomorrowPreview = () => {
  const tomorrow = addDays(kyivNow().date, 1);
  return all(
    `SELECT b.*, c.name AS client_name, c.phone AS client_phone FROM bookings b JOIN clients c ON c.id = b.client_id
     WHERE b.date = ? AND b.status = 'confirmed' ORDER BY b.start`,
    tomorrow
  ).map((b) => ({ id: b.id, time: hm(b.start), name: b.client_name, phone: realPhone(b.client_phone), sent: Boolean(b.sms_sent), text: smsText(b) }));
};
export const lastSms = (bookingId) => one("SELECT ok, info, created_at FROM sms_log WHERE booking_id = ? ORDER BY id DESC LIMIT 1", bookingId);
