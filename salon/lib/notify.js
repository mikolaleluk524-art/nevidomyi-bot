// Сповіщення: web-push клієнтам і власниці + (необовʼязково) Telegram власниці.
import webpush from "web-push";
import { all, getSecret, run, setSecret } from "./db.js";

let vapid = { publicKey: process.env.VAPID_PUBLIC_KEY, privateKey: process.env.VAPID_PRIVATE_KEY };
if (!vapid.publicKey || !vapid.privateKey) {
  const saved = getSecret("vapid");
  vapid = saved ? JSON.parse(saved) : webpush.generateVAPIDKeys();
  if (!saved) setSecret("vapid", JSON.stringify(vapid));
}
webpush.setVapidDetails(process.env.VAPID_SUBJECT || "mailto:salon@example.com", vapid.publicKey, vapid.privateKey);

export const VAPID_PUBLIC = vapid.publicKey;

export function saveSubscription(sub, { clientId = null, isAdmin = false } = {}) {
  if (!sub || typeof sub.endpoint !== "string" || !sub.keys?.p256dh || !sub.keys?.auth) throw new Error("bad subscription");
  run(
    `INSERT INTO push_subs(client_id, is_admin, endpoint, data, created_at) VALUES(?, ?, ?, ?, ?)
     ON CONFLICT(endpoint) DO UPDATE SET client_id = COALESCE(excluded.client_id, client_id),
       is_admin = MAX(is_admin, excluded.is_admin), data = excluded.data`,
    clientId,
    isAdmin ? 1 : 0,
    sub.endpoint,
    JSON.stringify({ endpoint: sub.endpoint, keys: sub.keys }),
    Date.now()
  );
}

async function send(rows, payload) {
  const body = JSON.stringify(payload);
  let sent = 0;
  await Promise.all(
    rows.map(async (r) => {
      try {
        await webpush.sendNotification(JSON.parse(r.data), body, { TTL: 60 * 60 * 6 });
        sent++;
      } catch (e) {
        if (e.statusCode === 404 || e.statusCode === 410) run("DELETE FROM push_subs WHERE id = ?", r.id);
        else console.error("[push]", e.statusCode || "", e.body || e.message);
      }
    })
  );
  return sent;
}

/** payload: { title, body, url, tag } */
export const pushClient = (clientId, payload) => send(all("SELECT * FROM push_subs WHERE client_id = ?", clientId), payload);

export async function notifyOwner(payload) {
  await send(all("SELECT * FROM push_subs WHERE is_admin = 1"), payload);
  const token = process.env.TG_BOT_TOKEN?.trim();
  const chat = process.env.TG_CHAT_ID?.trim();
  if (token && chat) {
    try {
      await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ chat_id: chat, text: `${payload.title}\n${payload.body}` }),
      });
    } catch (e) {
      console.error("[tg]", e.message);
    }
  }
}
