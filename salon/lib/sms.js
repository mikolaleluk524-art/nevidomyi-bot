// SMS-нагадування клієнткам напередодні візиту — через TurboSMS (turbosms.ua).
// Потрібна змінна TURBOSMS_TOKEN (токен з кабінету TurboSMS) і зареєстрований там підпис відправника.
import { all, db, getSettings, one, run } from "./db.js";
import { addDays, hm, kyivNow } from "./time.js";

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
    .replace(/\s+/g, " ")
    .trim();
}

/** Відправка однієї SMS. Повертає { ok, info }. */
export async function sendSms(phone, text, bookingId = null) {
  const s = getSettings();
  let ok = false;
  let info = "";
  try {
    if (!token()) throw new Error("не підключено TurboSMS (немає TURBOSMS_TOKEN)");
    const res = await fetch("https://api.turbosms.ua/message/send.json", {
      method: "POST",
      headers: { "content-type": "application/json", Authorization: `Bearer ${token()}` },
      body: JSON.stringify({ recipients: [phone], sms: { sender: s.smsSender || "Magiya", text } }),
    });
    const data = await res.json().catch(() => ({}));
    const r = data.response_result?.[0];
    ok = res.ok && [0, 800, 801, 802, 803].includes(Number(data.response_code)) && (!r || [0, 800, 801, 802, 803].includes(Number(r.response_code)));
    info = (r?.response_status || data.response_status || `HTTP ${res.status}`) + (r?.message_id ? ` · ${r.message_id}` : "");
  } catch (e) {
    info = e.message;
  }
  run("INSERT INTO sms_log(booking_id, phone, text, ok, info, created_at) VALUES(?,?,?,?,?,?)", bookingId, phone, text, ok ? 1 : 0, info, Date.now());
  if (!ok) console.error("[sms]", phone, info);
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
  if (!s.smsEnabled || !smsOn()) return;
  const { date, minutes } = kyivNow();
  const hour = Number.isFinite(Number(s.smsHour)) ? Number(s.smsHour) : 19;
  if (minutes < hour * 60) return;
  const tomorrow = addDays(date, 1);
  const rows = all(
    `SELECT b.*, c.name AS client_name, c.phone AS client_phone FROM bookings b JOIN clients c ON c.id = b.client_id
     WHERE b.date = ? AND b.status = 'confirmed' AND b.sms_sent = 0`,
    tomorrow
  );
  for (const b of rows) {
    run("UPDATE bookings SET sms_sent = 1 WHERE id = ?", b.id); // спершу позначаємо — щоб ніколи не надіслати двічі
    const phone = realPhone(b.client_phone);
    if (!phone) continue;
    await sendSms(phone, smsText(b, s), b.id);
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
