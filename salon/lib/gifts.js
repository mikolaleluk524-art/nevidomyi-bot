// Подарункові сертифікати: купівля онлайн, перевірка і списання майстром.
import { randomBytes } from "node:crypto";
import { all, db, getSettings, one, run } from "./db.js";
import { notifyOwner } from "./notify.js";

db.exec(`
CREATE TABLE IF NOT EXISTS gift_certs (
  id INTEGER PRIMARY KEY,
  code TEXT UNIQUE NOT NULL,             -- напр. MK-7Q2X-9KDP
  amount INTEGER NOT NULL,               -- номінал, грн
  balance INTEGER NOT NULL,              -- залишок, грн
  buyer_name TEXT NOT NULL,
  buyer_phone TEXT NOT NULL,
  recipient TEXT DEFAULT '',
  message TEXT DEFAULT '',
  status TEXT NOT NULL,                  -- pending | active | used | expired | cancelled
  invoice_id TEXT,
  paid INTEGER DEFAULT 0,
  created_at INTEGER NOT NULL,
  expires_at INTEGER DEFAULT 0
);
CREATE TABLE IF NOT EXISTS gift_log (
  id INTEGER PRIMARY KEY,
  gift_id INTEGER NOT NULL,
  delta INTEGER NOT NULL,
  note TEXT DEFAULT '',
  created_at INTEGER NOT NULL
);
`);

export const GIFT_PENDING_MINUTES = 30;

const abc = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const chunk = () => [...randomBytes(4)].map((b) => abc[b % abc.length]).join("");
export const normCode = (c) => String(c || "").toUpperCase().replace(/[^A-Z0-9]/g, "").replace(/^MK/, "");

export function createGift({ amount, buyerName, buyerPhone, recipient, message }) {
  let code;
  do code = `MK-${chunk()}-${chunk()}`;
  while (one("SELECT id FROM gift_certs WHERE code = ?", code));
  const r = run(
    `INSERT INTO gift_certs(code, amount, balance, buyer_name, buyer_phone, recipient, message, status, created_at)
     VALUES(?,?,?,?,?,?,?, 'pending', ?)`,
    code,
    amount,
    amount,
    buyerName,
    buyerPhone,
    String(recipient || "").slice(0, 80),
    String(message || "").slice(0, 300),
    Date.now()
  );
  return one("SELECT * FROM gift_certs WHERE id = ?", r.lastInsertRowid);
}

export const giftByCode = (code) => {
  const n = normCode(code);
  if (n.length !== 8) return null;
  return one("SELECT * FROM gift_certs WHERE code = ?", `MK-${n.slice(0, 4)}-${n.slice(4)}`);
};

/** Оплата сертифіката надійшла → активуємо на giftMonths місяців. */
export function activateGift(id, paid) {
  const g = one("SELECT * FROM gift_certs WHERE id = ?", id);
  if (!g || g.status !== "pending") return g;
  const months = getSettings().giftMonths || 6;
  const exp = new Date();
  exp.setMonth(exp.getMonth() + months);
  run("UPDATE gift_certs SET status = 'active', paid = ?, expires_at = ? WHERE id = ?", paid || g.amount, exp.getTime(), id);
  run("INSERT INTO gift_log(gift_id, delta, note, created_at) VALUES(?,?,?,?)", id, g.amount, "Сертифікат оплачено", Date.now());
  notifyOwner({
    title: `🎁 Продано сертифікат на ${g.amount} грн`,
    body: `${g.buyer_name} (${g.buyer_phone})${g.recipient ? ` → для: ${g.recipient}` : ""}\nКод: ${g.code}`,
    url: "/admin#gifts",
  }).catch(() => {});
  return one("SELECT * FROM gift_certs WHERE id = ?", id);
}

/** Списання з сертифіката майстром під час візиту. */
export function redeemGift(id, amount, note = "") {
  const g = one("SELECT * FROM gift_certs WHERE id = ?", id);
  if (!g) throw new Error("Сертифікат не знайдено");
  if (g.status !== "active") throw new Error("Сертифікат неактивний");
  if (g.expires_at && g.expires_at < Date.now()) throw new Error("Термін дії сертифіката минув");
  const sum = Math.min(Math.max(1, Math.round(amount)), g.balance);
  const left = g.balance - sum;
  run("UPDATE gift_certs SET balance = ?, status = ? WHERE id = ?", left, left > 0 ? "active" : "used", id);
  run("INSERT INTO gift_log(gift_id, delta, note, created_at) VALUES(?,?,?,?)", id, -sum, String(note).slice(0, 200), Date.now());
  return one("SELECT * FROM gift_certs WHERE id = ?", id);
}

export function publicGift(g) {
  const expired = g.status === "active" && g.expires_at && g.expires_at < Date.now();
  return {
    code: g.code,
    amount: g.amount,
    balance: g.balance,
    recipient: g.recipient,
    message: g.message,
    from: g.buyer_name.split(" ")[0],
    status: expired ? "expired" : g.status,
    expiresAt: g.expires_at,
  };
}

export const giftLog = (id) => all("SELECT delta, note, created_at FROM gift_log WHERE gift_id = ? ORDER BY id", id);
