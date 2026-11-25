/**
 * 🤖 Помічник у моніторі власника: пропонує новини для розсилки й «прикольні оновлення» —
 * події, які власник запускає однією кнопкою (💖 подвійні серця, 🌹 троянда всім).
 *
 * Тексти пише Claude (потрібна змінна ANTHROPIC_API_KEY на Railway). Без ключа або якщо
 * API недоступний — ідеї з готових шаблонів, тож монітор працює завжди.
 * Кожна новина — трьома мовами: розсилка шле кожному його мовою.
 */

import Anthropic from "@anthropic-ai/sdk";

const MODEL = "claude-opus-5-5";
const CACHE_MS = 6 * 60 * 60 * 1000; // нові ідеї — раз на 6 годин або за кнопкою «Інші ідеї»
let cache = null;
let lastTitles = [];

const FEATURES = [
  "Анонімний чат один на один: випадковий пошук безкоштовно, пошук за віком/статтю/містом — Premium.",
  "Гра в бутилочку до 10 людей за столом: завдання (правда, дія, цьом, 18+), відповіді текстом, реакції ❤️😂🔥😮, корона 👑 найпопулярнішому.",
  "Після завдання пара обирає: 💋 поцілувати, 👋 відштовхнути або 🔒 побути наодинці (приватний чат).",
  "Подарунки за зірки Telegram: 🌹🍫🧸💍💎 — дають ❤ і запрошення наодинці.",
  "✨ Бажання: гравець загадує бажання, хто виконає найкраще — отримує 👑 Корону бажань (+40 ❤).",
  "🎯 Вибрати, на кого покаже пляшка; 👀 «Хто це?» — стать і вік співрозмовника; ↩️ повернути співрозмовника.",
  "Щоденна винагорода: серія 7 днів, безкоштовні 🌹 і 🎯, на 7-й день — день Premium.",
  "Супер-реферал: за друга 3 години Premium + 🌹; 3 друзі — 🎯×3, 5 — 7 днів Premium, 10 — 30 днів Premium.",
  "Мови: українська, русский, English.",
];

const EVENTS = {
  double_hearts: "💖 Подвійні серця на 1 годину: подарунки, реакції й поцілунки дають ×2 ❤",
  free_rose: "🌹 Безкоштовна троянда кожному користувачу (у гаманець гри)",
};

// Запасні ідеї без ШІ. {online}, {players}, {total} — живі цифри.
const TEMPLATES = [
  { kind: "event", event: "double_hearts", title: "💖 Година подвійних сердець",
    uk: "💖 Година подвійних сердець!\nНаступну годину в 🍾 Грі в бутилочку подарунки, реакції й поцілунки дають ×2 ❤. Найкращий момент забрати 👑 корону столу!\nЗаходь: /game",
    ru: "💖 Час двойных сердец!\nСледующий час в 🍾 Игре в бутылочку подарки, реакции и поцелуи дают ×2 ❤. Лучший момент забрать 👑 корону стола!\nЗаходи: /game",
    en: "💖 Double Hearts Hour!\nFor the next hour in 🍾 Spin the Bottle, gifts, reactions and kisses give ×2 ❤. The perfect moment to take the table's 👑 crown!\nJoin: /game" },
  { kind: "event", event: "free_rose", title: "🌹 Троянда кожному",
    uk: "🌹 Сюрприз! Кожен отримав безкоштовну троянду в грі.\nПодаруй її тому, хто сподобається, — разом із нею піде запрошення побути наодинці 🔒\nВідкривай: /game",
    ru: "🌹 Сюрприз! Каждый получил бесплатную розу в игре.\nПодари её тому, кто понравится, — вместе с ней уйдёт приглашение побыть наедине 🔒\nОткрывай: /game",
    en: "🌹 Surprise! Everyone got a free rose in the game.\nGive it to someone you like — it comes with an invitation to be alone together 🔒\nOpen: /game" },
  { kind: "news", event: "none", title: "✨ Бажання",
    uk: "✨ Нове в грі — Бажання!\nЗагадай, чого хочеш: вірш, комплімент, зізнання… Хто виконає найкраще — отримає від тебе 👑 Корону бажань.\nСпробуй: /game",
    ru: "✨ Новое в игре — Желания!\nЗагадай, чего хочешь: стих, комплимент, признание… Кто исполнит лучше всех — получит от тебя 👑 Корону желаний.\nПопробуй: /game",
    en: "✨ New in the game — Wishes!\nWish for anything: a poem, a compliment, a confession… Whoever grants it best gets your 👑 Wish Crown.\nTry it: /game" },
  { kind: "news", event: "none", title: "🎁 Супер-реферал",
    uk: "🎁 Клич друзів — отримуй Premium!\nЗа кожного друга 3 години Premium і 🌹, за 5 друзів — тиждень Premium, за 10 — цілий місяць.\nТвоє посилання: /invite",
    ru: "🎁 Зови друзей — получай Premium!\nЗа каждого друга 3 часа Premium и 🌹, за 5 друзей — неделя Premium, за 10 — целый месяц.\nТвоя ссылка: /invite",
    en: "🎁 Invite friends — get Premium!\nEach friend gives you 3 hours of Premium and a 🌹, 5 friends — a week of Premium, 10 — a whole month.\nYour link: /invite" },
  { kind: "news", event: "none", title: "🔥 Зараз онлайн",
    uk: "🔥 Зараз у боті {online} людей онлайн!\nЗаходь у 🍾 Гру в бутилочку або знайди співрозмовника — анонімно, без імен і номерів.\n/game · /search",
    ru: "🔥 Сейчас в боте {online} человек онлайн!\nЗаходи в 🍾 Игру в бутылочку или найди собеседника — анонимно, без имён и номеров.\n/game · /search",
    en: "🔥 {online} people are online right now!\nJump into 🍾 Spin the Bottle or find a chat partner — anonymous, no names or numbers.\n/game · /search" },
  { kind: "news", event: "none", title: "📅 Щоденна винагорода",
    uk: "📅 Не забудь забрати щоденну винагороду!\nЗаходь у гру щодня: що довша серія, то кращі подарунки, а на 7-й день — день Premium 💎\n/game",
    ru: "📅 Не забудь забрать ежедневную награду!\nЗаходи в игру каждый день: чем длиннее серия, тем лучше подарки, а на 7-й день — день Premium 💎\n/game",
    en: "📅 Don't forget your daily reward!\nPlay every day: the longer your streak, the better the gifts, and on day 7 you get a day of Premium 💎\n/game" },
  { kind: "news", event: "none", title: "👀 Хто це?",
    uk: "👀 Цікаво, хто по той бік чату?\nНатисни «Хто це?» під час розмови — дізнаєшся стать, вік і місто співрозмовника. Імена й контакти лишаються прихованими.\n/search",
    ru: "👀 Интересно, кто по ту сторону чата?\nНажми «Кто это?» во время разговора — узнаешь пол, возраст и город собеседника. Имена и контакты остаются скрытыми.\n/search",
    en: "👀 Wondering who's on the other side?\nTap “Who's this?” during a chat to see your partner's gender, age and city. Names and contacts stay hidden.\n/search" },
];

const fill = (text, ctx) => text.replace(/\{(online|players|total)\}/g, (_, k) => String(ctx[k] ?? 0));

function fromTemplates(ctx) {
  const pool = [...TEMPLATES].sort(() => Math.random() - 0.5);
  const events = pool.filter((t) => t.kind === "event").slice(0, 1);
  const news = pool.filter((t) => t.kind === "news").slice(0, 3);
  return [...events, ...news].map((t) => ({ ...t, uk: fill(t.uk, ctx), ru: fill(t.ru, ctx), en: fill(t.en, ctx) }));
}

const SCHEMA = {
  type: "object",
  properties: {
    items: {
      type: "array",
      items: {
        type: "object",
        properties: {
          kind: { type: "string", enum: ["news", "event"] },
          event: { type: "string", enum: ["none", "double_hearts", "free_rose"] },
          title: { type: "string" },
          uk: { type: "string" },
          ru: { type: "string" },
          en: { type: "string" },
        },
        required: ["kind", "event", "title", "uk", "ru", "en"],
        additionalProperties: false,
      },
    },
  },
  required: ["items"],
  additionalProperties: false,
};

function prompt(ctx) {
  return `Ти — помічник власника Telegram-бота «Невідомий» (анонімний чат 18+ і гра в бутилочку). Запропонуй 4 ідеї для розсилки всім користувачам: 3 новини (kind "news", event "none") і 1 «прикольне оновлення» — подію, яку власник запустить однією кнопкою (kind "event", event — одна з подій нижче).

Що вміє бот:
${FEATURES.map((f) => "- " + f).join("\n")}

Події, які можна запустити:
${Object.entries(EVENTS).map(([k, v]) => `- ${k}: ${v}`).join("\n")}

Зараз (київський час ${ctx.time}): онлайн ${ctx.online}, у грі ${ctx.players}, усього користувачів ${ctx.total}, нових за добу ${ctx.new24}.${ctx.doubleActive ? " Зараз уже йдуть подвійні серця — не пропонуй double_hearts." : ""}
Недавні ідеї (не повторюй): ${lastTitles.join("; ") || "немає"}.

Вимоги до кожного тексту:
- коротко: 2–4 рядки, живо й по-дружньому, 1–3 емоджі, заклик до дії з командою (/game, /search, /invite, /premium);
- лише правда про функції зі списку, без вигаданих знижок, цифр чи обіцянок;
- без натяків на неповнолітніх, без відвертого сексуального змісту;
- uk — українською, ru — російською, en — англійською, однакові за змістом;
- title — 2–5 слів українською з емоджі, для власника.`;
}

async function fromClaude(ctx) {
  const client = new Anthropic();
  const request = {
    model: MODEL,
    max_tokens: 4000,
    output_config: { effort: "low", format: { type: "json_schema", schema: SCHEMA } },
    messages: [{ role: "user", content: prompt(ctx) }],
  };
  let response;
  try {
    // Якщо модель відмовить, сервер сам спробує запасну модель.
    response = await client.beta.messages.create({ ...request, betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" });
  } catch (err) {
    if (!(err instanceof Anthropic.BadRequestError)) throw err;
    response = await client.messages.create(request);
  }
  if (response.stop_reason === "refusal") throw new Error("refusal");
  const text = response.content.find((b) => b.type === "text")?.text ?? "";
  const items = JSON.parse(text).items.filter((i) => i.uk && i.ru && i.en).slice(0, 6);
  if (!items.length) throw new Error("empty");
  return items;
}

export const aiEnabled = () => Boolean(process.env.ANTHROPIC_API_KEY);

export async function getSuggestions(ctx, refresh = false) {
  if (!refresh && cache && Date.now() - cache.at < CACHE_MS) return cache;
  let items;
  let source = "templates";
  if (aiEnabled()) {
    try {
      items = await fromClaude(ctx);
      source = "claude";
    } catch (err) {
      if (err instanceof Anthropic.AuthenticationError) console.error("[assistant] ключ ANTHROPIC_API_KEY не підходить");
      else if (err instanceof Anthropic.RateLimitError) console.error("[assistant] ліміт запитів, беру шаблони");
      else if (err instanceof Anthropic.APIConnectionError) console.error("[assistant] немає з'єднання з API, беру шаблони");
      else if (err instanceof Anthropic.APIError) console.error(`[assistant] API ${err.status}: ${err.message}`);
      else console.error("[assistant]", err.message);
    }
  }
  if (!items) items = fromTemplates(ctx);
  lastTitles = items.map((i) => i.title).slice(0, 8);
  cache = { at: Date.now(), source, items };
  return cache;
}
