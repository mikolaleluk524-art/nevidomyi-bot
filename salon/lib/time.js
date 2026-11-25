// Час салону — завжди Київ, незалежно від часового поясу сервера.
export const TZ = "Europe/Kyiv";

const fmt = new Intl.DateTimeFormat("en-CA", {
  timeZone: TZ,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

function parts(ms) {
  const p = Object.fromEntries(fmt.formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  return { y: +p.year, m: +p.month, d: +p.day, h: +p.hour, min: +p.minute };
}

// Зміщення Києва від UTC у хвилинах для моменту ms.
function offsetMin(ms) {
  const p = parts(ms);
  return (Date.UTC(p.y, p.m - 1, p.d, p.h, p.min) - Math.floor(ms / 60000) * 60000) / 60000;
}

/** Київська дата "YYYY-MM-DD" + хвилини від півночі → мітка часу UTC (мс). */
export function kyivToUtc(date, minutes) {
  const [y, m, d] = date.split("-").map(Number);
  const guess = Date.UTC(y, m - 1, d, 0, minutes);
  let ts = guess - offsetMin(guess) * 60000;
  ts = guess - offsetMin(ts) * 60000;
  return ts;
}

export function kyivNow() {
  const p = parts(Date.now());
  return { date: ymd(p.y, p.m, p.d), minutes: p.h * 60 + p.min };
}

export function ymd(y, m, d) {
  return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

export function addDays(date, n) {
  const [y, m, d] = date.split("-").map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + n));
  return ymd(t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate());
}

/** 0 = неділя … 6 = субота */
export function weekday(date) {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

export const hm = (min) => `${String(Math.floor(min / 60)).padStart(2, "0")}:${String(min % 60).padStart(2, "0")}`;
export const toMin = (s) => {
  const [h, m] = String(s).split(":").map(Number);
  return h * 60 + (m || 0);
};

export const isDate = (s) => typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s);

const MONTHS = ["січня", "лютого", "березня", "квітня", "травня", "червня", "липня", "серпня", "вересня", "жовтня", "листопада", "грудня"];
const DAYS = ["неділя", "понеділок", "вівторок", "середа", "четвер", "пʼятниця", "субота"];
export function humanDate(date) {
  const [, m, d] = date.split("-").map(Number);
  return `${d} ${MONTHS[m - 1]}, ${DAYS[weekday(date)]}`;
}
