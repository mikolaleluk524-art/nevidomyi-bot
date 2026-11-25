/**
 * 📣 Реклама в моніторі власника:
 *  - кампанії: окреме посилання ?start=ad_<мітка> для кожного каналу і статистика,
 *    скільки людей прийшло, пройшли вік, заплатили і скільки зірок принесли;
 *  - набір для реклами: готові пости під формати (канал знайомств, гумор, відео, сторіс);
 *  - лист адміну каналу з пропозицією взаємного піару або платної реклами.
 * Тексти пише Claude (ANTHROPIC_API_KEY), без ключа — шаблони.
 */

import Anthropic from "@anthropic-ai/sdk";
import { DatabaseSync } from "node:sqlite";
import { BOT_USERNAME, DB_PATH } from "./src/bot.js";

const MODEL = "claude-opus-5-5";

function withDb(fn, readOnly = false) {
  const db = new DatabaseSync(DB_PATH, { readOnly });
  try {
    if (!readOnly) db.exec("create table if not exists campaigns (tag text primary key, name text not null, created_at integer not null)");
    return fn(db);
  } finally {
    db.close();
  }
}

export const campaignLink = (tag) => `https://t.me/${BOT_USERNAME}?start=ad_${tag}`;

// Мітка з назви: латиниця, цифри, дефіс (транслітерація кирилиці).
const TR = { а: "a", б: "b", в: "v", г: "h", ґ: "g", д: "d", е: "e", є: "ie", ж: "zh", з: "z", и: "y", і: "i", ї: "i", й: "i", к: "k", л: "l", м: "m", н: "n", о: "o", п: "p", р: "r", с: "s", т: "t", у: "u", ф: "f", х: "kh", ц: "ts", ч: "ch", ш: "sh", щ: "shch", ь: "", ю: "iu", я: "ia", ы: "y", э: "e", ё: "io", ъ: "" };
function slug(name) {
  const base = String(name).toLowerCase().split("").map((c) => TR[c] ?? c).join("")
    .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 30);
  return base || "kanal";
}

export function createCampaign(name) {
  const clean = String(name ?? "").trim().slice(0, 60);
  if (clean.length < 2) return null;
  return withDb((db) => {
    let tag = slug(clean);
    for (let i = 2; db.prepare("select 1 as x from campaigns where tag = ?").get(tag); i++) tag = `${slug(clean).slice(0, 26)}-${i}`;
    db.prepare("insert into campaigns (tag, name, created_at) values (?, ?, ?)").run(tag, clean, Math.floor(Date.now() / 1000));
    return { tag, name: clean, link: campaignLink(tag) };
  });
}

export function deleteCampaign(tag) {
  return withDb((db) => db.prepare("delete from campaigns where tag = ?").run(String(tag)).changes > 0);
}

// Кампанії зі статистикою: прийшли → пройшли вік → платили → зірки.
export function listCampaigns() {
  return withDb((db) => {
    const rows = db.prepare("select tag, name, created_at from campaigns order by created_at desc").all();
    const users = db.prepare("select count(*) as joined, coalesce(sum(adult = 1), 0) as adults from users where source = ?");
    const pays = db.prepare("select count(distinct p.user_id) as payers, coalesce(sum(p.stars), 0) as stars from payments p join users u on u.id = p.user_id where u.source = ?");
    return rows.map((r) => ({ ...r, link: campaignLink(r.tag), ...users.get(r.tag), ...pays.get(r.tag) }));
  });
}

/* ---------- тексти ---------- */

const FEATURES = "анонімний чат 18+ (випадковий співрозмовник безкоштовно), гра в бутилочку за столом до 10 людей: завдання, відповіді, реакції, 💋 поцілувати / 👋 відштовхнути / 🔒 наодинці, подарунки за зірки, ✨ бажання з 👑 короною, щоденні нагороди, мови: українська, русский, English";

export const FORMATS = {
  dating: "Пост у Telegram-канал знайомств",
  humor: "Пост у розважальний / гумористичний канал",
  video: "Сценарій короткого відео для TikTok / Reels / Shorts (що показати на екрані + підпис)",
  story: "Текст для сторіс (дуже коротко, 1–2 рядки)",
};

const PROMO_TEMPLATES = {
  dating: {
    uk: "💘 Втомився від анкет і «привіт, як справи»?\nСпробуй 🍾 Гру в бутилочку в Telegram: крутиш пляшку, відповідаєш на завдання, а пара обирає — 💋 поцілувати, 👋 відштовхнути чи 🔒 піти в приватний чат.\nАнонімно, без імен і номерів. 18+\n👉 {link}",
    ru: "💘 Устал от анкет и «привет, как дела»?\nПопробуй 🍾 Игру в бутылочку в Telegram: крутишь бутылочку, отвечаешь на задания, а пара выбирает — 💋 поцеловать, 👋 оттолкнуть или 🔒 уйти в приватный чат.\nАнонимно, без имён и номеров. 18+\n👉 {link}",
    en: "💘 Tired of profiles and “hey, how are you”?\nTry 🍾 Spin the Bottle in Telegram: spin, answer dares, and the pair chooses — 💋 kiss, 👋 push away or 🔒 go to a private chat.\nAnonymous, no names or numbers. 18+\n👉 {link}",
  },
  humor: {
    uk: "🍾 Пам'ятаєш бутилочку на шкільних вечірках?\nТепер вона в Telegram — і тут тебе можуть офіційно відштовхнути 👋😅\nЗаходь, крути, відповідай на дурнуваті питання і дари 🌹 тим, хто розсмішив. 18+\n👉 {link}",
    ru: "🍾 Помнишь бутылочку на школьных вечеринках?\nТеперь она в Telegram — и тут тебя могут официально оттолкнуть 👋😅\nЗаходи, крути, отвечай на дурацкие вопросы и дари 🌹 тем, кто рассмешил. 18+\n👉 {link}",
    en: "🍾 Remember Spin the Bottle at school parties?\nNow it's in Telegram — and you can get officially pushed away 👋😅\nJoin, spin, answer silly questions and give 🌹 to whoever made you laugh. 18+\n👉 {link}",
  },
  video: {
    uk: "🎬 На екрані: пляшка крутиться і зупиняється на тобі.\nТекст на відео: «Коли бутилочка в Telegram питає, хто тобі подобається 👀»\nДалі: завдання → відповідь → кнопки 💋 / 👋 / 🔒, реакція 😂\nПідпис: Гра в бутилочку в Telegram, анонімно. Посилання в профілі 👉 {link}",
    ru: "🎬 На экране: бутылочка крутится и останавливается на тебе.\nТекст на видео: «Когда бутылочка в Telegram спрашивает, кто тебе нравится 👀»\nДальше: задание → ответ → кнопки 💋 / 👋 / 🔒, реакция 😂\nПодпись: Игра в бутылочку в Telegram, анонимно. Ссылка в профиле 👉 {link}",
    en: "🎬 On screen: the bottle spins and stops on you.\nText on video: “When Spin the Bottle in Telegram asks who you like 👀”\nThen: dare → answer → 💋 / 👋 / 🔒 buttons, 😂 reaction\nCaption: Spin the Bottle in Telegram, anonymous. Link in bio 👉 {link}",
  },
  story: {
    uk: "🍾 Крутни пляшку — подивимось, на кого покаже 👀\n{link}",
    ru: "🍾 Крутни бутылочку — посмотрим, на кого укажет 👀\n{link}",
    en: "🍾 Spin the bottle — let's see who it picks 👀\n{link}",
  },
};

const OUTREACH_TEMPLATES = {
  swap: {
    uk: "Вітаю! Я власник Telegram-бота «Невідомий» — анонімний чат і гра в бутилочку 18+.\nМені дуже подобається ваш канал «{channel}», і, здається, наша аудиторія близька.\nПропоную взаємний піар: пост про ваш канал у нашій розсилці — пост про бота у вас. Текст і час підлаштую під вас.\nЯкщо цікаво — напишіть, будь ласка, умови. Дякую!",
    ru: "Здравствуйте! Я владелец Telegram-бота «Невідомий» — анонимный чат и игра в бутылочку 18+.\nМне очень нравится ваш канал «{channel}», и, кажется, наша аудитория близка.\nПредлагаю взаимный пиар: пост о вашем канале в нашей рассылке — пост о боте у вас. Текст и время подстрою под вас.\nЕсли интересно — напишите, пожалуйста, условия. Спасибо!",
    en: "Hi! I'm the owner of “Nevidomyi”, an anonymous chat and Spin the Bottle game bot in Telegram (18+).\nI really like your channel “{channel}”, and our audiences seem close.\nI'd like to offer a cross-promotion: a post about your channel in our broadcast in exchange for a post about the bot on yours. I'll adapt the text and timing to you.\nIf you're interested, please let me know your terms. Thank you!",
  },
  paid: {
    uk: "Вітаю! Я власник Telegram-бота «Невідомий» — анонімний чат і гра в бутилочку 18+.\nХочу розмістити рекламу у вашому каналі «{channel}». Підкажіть, будь ласка, вартість поста, вільні дати й вимоги до тексту.\nМожу одразу надіслати готовий пост. Дякую!",
    ru: "Здравствуйте! Я владелец Telegram-бота «Невідомий» — анонимный чат и игра в бутылочку 18+.\nХочу разместить рекламу в вашем канале «{channel}». Подскажите, пожалуйста, стоимость поста, свободные даты и требования к тексту.\nМогу сразу прислать готовый пост. Спасибо!",
    en: "Hi! I'm the owner of “Nevidomyi”, an anonymous chat and Spin the Bottle game bot in Telegram (18+).\nI'd like to advertise in your channel “{channel}”. Could you tell me the price of a post, available dates and any requirements for the text?\nI can send a ready-made post right away. Thank you!",
  },
};

// Додаткові варіанти: кожного разу береться випадковий, щоб тексти не повторювались.
const PROMO_MORE = {
  dating: [
    { uk: "🍾 Знайомства без нудних анкет\nУ Telegram є гра в бутилочку: до 10 людей за столом, завдання, реакції, подарунки. Сподобались одне одному — 🔒 переходите в приватний чат.\nАнонімно, 18+\n👉 {link}",
      ru: "🍾 Знакомства без скучных анкет\nВ Telegram есть игра в бутылочку: до 10 человек за столом, задания, реакции, подарки. Понравились друг другу — 🔒 переходите в приватный чат.\nАнонимно, 18+\n👉 {link}",
      en: "🍾 Dating without boring profiles\nThere's a Spin the Bottle game in Telegram: up to 10 people at a table, dares, reactions, gifts. Like each other? 🔒 move to a private chat.\nAnonymous, 18+\n👉 {link}" },
    { uk: "👀 Хто сьогодні опиниться з тобою в парі?\nКрути пляшку, відповідай на питання, даруй 🌹 і обирай: 💋 поцілувати чи 👋 відштовхнути.\nБез імен і номерів, поки сам не захочеш. 18+\n👉 {link}",
      ru: "👀 Кто сегодня окажется с тобой в паре?\nКрути бутылочку, отвечай на вопросы, дари 🌹 и выбирай: 💋 поцеловать или 👋 оттолкнуть.\nБез имён и номеров, пока сам не захочешь. 18+\n👉 {link}",
      en: "👀 Who'll end up paired with you tonight?\nSpin the bottle, answer questions, give 🌹 and choose: 💋 kiss or 👋 push away.\nNo names or numbers unless you want. 18+\n👉 {link}" },
  ],
  humor: [
    { uk: "😅 Нарешті місце, де відштовхнути людину — це кнопка, а не драма.\n🍾 Гра в бутилочку в Telegram: завдання, реакції, корона 👑 найпопулярнішому. 18+\n👉 {link}",
      ru: "😅 Наконец-то место, где оттолкнуть человека — это кнопка, а не драма.\n🍾 Игра в бутылочку в Telegram: задания, реакции, корона 👑 самому популярному. 18+\n👉 {link}",
      en: "😅 Finally, a place where pushing someone away is a button, not a drama.\n🍾 Spin the Bottle in Telegram: dares, reactions, a 👑 crown for the most popular. 18+\n👉 {link}" },
    { uk: "🍾 Завдання дня: напиши комплімент незнайомцю і не почервоній.\nЦе одна з карток у грі в бутилочку в Telegram. Решта — ще цікавіші 😏 18+\n👉 {link}",
      ru: "🍾 Задание дня: напиши комплимент незнакомцу и не покраснеть.\nЭто одна из карточек в игре в бутылочку в Telegram. Остальные — ещё интереснее 😏 18+\n👉 {link}",
      en: "🍾 Dare of the day: compliment a stranger without blushing.\nThat's one card from Spin the Bottle in Telegram. The rest are even better 😏 18+\n👉 {link}" },
  ],
  video: [
    { uk: "🎬 Формат «реакція»: ти дивишся в камеру, на екрані крутиться пляшка.\nТекст: «Пляшка обрала мене, а завдання — „Опиши себе трьома емоджі“» → показуєш відповідь 😂\nФінал: кнопки 💋 / 👋 / 🔒 і твоє обличчя.\nПідпис: Гра в бутилочку в Telegram 👉 {link}",
      ru: "🎬 Формат «реакция»: ты смотришь в камеру, на экране крутится бутылочка.\nТекст: «Бутылочка выбрала меня, а задание — „Опиши себя тремя эмодзи“» → показываешь ответ 😂\nФинал: кнопки 💋 / 👋 / 🔒 и твоё лицо.\nПодпись: Игра в бутылочку в Telegram 👉 {link}",
      en: "🎬 Reaction format: you look at the camera while the bottle spins on screen.\nText: “The bottle picked me, and the dare is ‘Describe yourself in three emojis’” → show your answer 😂\nEnding: 💋 / 👋 / 🔒 buttons and your face.\nCaption: Spin the Bottle in Telegram 👉 {link}" },
    { uk: "🎬 Формат «POV»: «POV: ти загадав бажання за 👑, а хтось написав тобі вірш» → показуєш відповідь на екрані.\nКадр 2: обираєш переможця, 👑 летить на аватарку.\nПідпис: Бажання й корони — в бутилочці в Telegram 👉 {link}",
      ru: "🎬 Формат «POV»: «POV: ты загадал желание за 👑, а кто-то написал тебе стих» → показываешь ответ на экране.\nКадр 2: выбираешь победителя, 👑 летит на аватарку.\nПодпись: Желания и короны — в бутылочке в Telegram 👉 {link}",
      en: "🎬 POV format: “POV: you made a wish for a 👑 and someone wrote you a poem” → show the answer on screen.\nShot 2: you pick the winner and the 👑 lands on their avatar.\nCaption: Wishes and crowns in Spin the Bottle on Telegram 👉 {link}" },
  ],
  story: [
    { uk: "💋 чи 👋? Вирішуй за столом 🍾\n{link}", ru: "💋 или 👋? Решай за столом 🍾\n{link}", en: "💋 or 👋? Decide at the table 🍾\n{link}" },
    { uk: "✨ Загадай бажання — хтось його виконає 👑\n{link}", ru: "✨ Загадай желание — кто-то его исполнит 👑\n{link}", en: "✨ Make a wish — someone will grant it 👑\n{link}" },
  ],
};
const OUTREACH_MORE = {
  swap: {
    uk: "Добрий день! Пишу щодо співпраці з каналом «{channel}».\nЯ розвиваю Telegram-бота «Невідомий»: анонімний чат і гра в бутилочку з подарунками, 18+. Думаю, вашим підписникам це може бути цікаво, а нашим — ваш канал.\nПропоную обмінятися постами в зручний для вас день. Готовий підлаштувати текст під стиль каналу.\nЯк вам така ідея?",
    ru: "Добрый день! Пишу по поводу сотрудничества с каналом «{channel}».\nЯ развиваю Telegram-бота «Невідомий»: анонимный чат и игра в бутылочку с подарками, 18+. Думаю, вашим подписчикам это может быть интересно, а нашим — ваш канал.\nПредлагаю обменяться постами в удобный для вас день. Готов подстроить текст под стиль канала.\nКак вам такая идея?",
    en: "Hello! I'm writing about a possible collaboration with “{channel}”.\nI run “Nevidomyi”, a Telegram bot with anonymous chat and a Spin the Bottle game with gifts (18+). I think your subscribers might enjoy it, and ours might enjoy your channel.\nWould you be up for swapping posts on a day that suits you? I'm happy to adapt the text to your channel's style.",
  },
  paid: {
    uk: "Добрий день! Цікавить реклама в каналі «{channel}».\nПродукт — Telegram-бот «Невідомий»: анонімний чат і гра в бутилочку, 18+. Пост короткий, з одним посиланням.\nПідкажіть, будь ласка, ціну, формат (з закріпом чи без, скільки годин у топі) і найближчі вільні дати.",
    ru: "Добрый день! Интересует реклама в канале «{channel}».\nПродукт — Telegram-бот «Невідомий»: анонимный чат и игра в бутылочку, 18+. Пост короткий, с одной ссылкой.\nПодскажите, пожалуйста, цену, формат (с закрепом или без, сколько часов в топе) и ближайшие свободные даты.",
    en: "Hello! I'm interested in advertising in “{channel}”.\nThe product is “Nevidomyi”, a Telegram bot with anonymous chat and a Spin the Bottle game (18+). The post is short, with a single link.\nCould you share the price, the format (pinned or not, hours at the top) and the nearest available dates?",
  },
};
const pickOne = (list) => list[Math.floor(Math.random() * list.length)];

const fill = (text, vars) => text.replace(/\{(\w+)\}/g, (_, k) => vars[k] ?? "");

async function ask(prompt, schema) {
  const client = new Anthropic();
  const request = {
    model: MODEL,
    max_tokens: 6000,
    output_config: { effort: "low", format: { type: "json_schema", schema } },
    messages: [{ role: "user", content: prompt }],
  };
  let response;
  try {
    response = await client.beta.messages.create({ ...request, betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" });
  } catch (err) {
    if (!(err instanceof Anthropic.BadRequestError)) throw err;
    response = await client.messages.create(request);
  }
  if (response.stop_reason === "refusal") throw new Error("refusal");
  return JSON.parse(response.content.find((b) => b.type === "text")?.text ?? "");
}

function logError(where, err) {
  if (err instanceof Anthropic.AuthenticationError) console.error(`[promo] ${where}: ключ ANTHROPIC_API_KEY не підходить`);
  else if (err instanceof Anthropic.APIConnectionError) console.error(`[promo] ${where}: немає з'єднання з API`);
  else if (err instanceof Anthropic.APIError) console.error(`[promo] ${where}: API ${err.status}: ${err.message}`);
  else console.error(`[promo] ${where}:`, err.message);
}

const LANG_SCHEMA = { type: "string" };
const PROMO_SCHEMA = {
  type: "object",
  properties: {
    items: {
      type: "array",
      items: {
        type: "object",
        properties: { format: { type: "string", enum: Object.keys(FORMATS) }, uk: LANG_SCHEMA, ru: LANG_SCHEMA, en: LANG_SCHEMA },
        required: ["format", "uk", "ru", "en"],
        additionalProperties: false,
      },
    },
  },
  required: ["items"],
  additionalProperties: false,
};

// Набір для реклами: по одному тексту на кожен формат, трьома мовами, з посиланням кампанії.
export async function promoKit(link, note) {
  if (process.env.ANTHROPIC_API_KEY) {
    try {
      const out = await ask(`Ти — маркетолог Telegram-бота «Невідомий». Що вміє бот: ${FEATURES}.
Напиши рекламні тексти — по одному на кожен формат:
${Object.entries(FORMATS).map(([k, v]) => `- ${k}: ${v}`).join("\n")}
${note ? `Побажання власника: ${note}\n` : ""}Вимоги:
- у кожному тексті рівно один раз посилання ${link} (саме таке, без змін);
- живо, з гачком у першому рядку, 1–4 емоджі; позначка 18+;
- лише правда про функції бота, без вигаданих цифр, знижок і обіцянок;
- без відвертого сексуального змісту, без натяків на неповнолітніх;
- uk — українською, ru — російською, en — англійською, однакові за змістом.`, PROMO_SCHEMA);
      const items = (out.items || []).filter((i) => FORMATS[i.format] && i.uk && i.ru && i.en);
      if (items.length) return { source: "claude", items: items.map((i) => ({ ...i, title: FORMATS[i.format] })) };
    } catch (err) {
      logError("набір для реклами", err);
    }
  }
  return {
    source: "templates",
    items: Object.entries(PROMO_TEMPLATES).map(([format, base]) => {
      const t = pickOne([base, ...(PROMO_MORE[format] || [])]);
      return { format, title: FORMATS[format], uk: fill(t.uk, { link }), ru: fill(t.ru, { link }), en: fill(t.en, { link }) };
    }),
  };
}

const LETTER_SCHEMA = { type: "object", properties: { text: { type: "string" } }, required: ["text"], additionalProperties: false };
const LANG_NAMES = { uk: "українською", ru: "російською", en: "англійською" };

// Лист адміну каналу.
export async function outreachLetter({ channel, topic, offer, lang, me }) {
  const vars = { channel: String(channel || "").slice(0, 80), me: String(me || "").slice(0, 40) || "—" };
  const kind = offer === "paid" ? "paid" : "swap";
  const l = LANG_NAMES[lang] ? lang : "uk";
  if (process.env.ANTHROPIC_API_KEY) {
    try {
      const out = await ask(`Напиши ${LANG_NAMES[l]} коротке ввічливе повідомлення адміну Telegram-каналу «${vars.channel}»${topic ? ` (тема каналу: ${String(topic).slice(0, 120)})` : ""}.
Від кого: ${vars.me !== "—" ? vars.me + ", " : ""}власник Telegram-бота «Невідомий» (${FEATURES}).
Мета: ${kind === "paid" ? "дізнатися вартість і умови платної реклами в каналі" : "запропонувати взаємний піар: пост про їхній канал у розсилці бота в обмін на пост про бота в каналі"}.
Вимоги: 4–7 рядків; звернення без лестощів, конкретно, з повагою до каналу; згадай, чому аудиторії канал і бот підходять одне одному${topic ? " (з огляду на тему каналу)" : ""}; без вигаданих цифр про бота; без тиску; закінчи запитанням про умови.`, LETTER_SCHEMA);
      if (out.text) return { source: "claude", text: out.text };
    } catch (err) {
      logError("лист адміну", err);
    }
  }
  const sign = vars.me !== "—" ? `\n— ${vars.me}` : "";
  return { source: "templates", text: fill(pickOne([OUTREACH_TEMPLATES[kind][l], OUTREACH_MORE[kind][l]]), vars) + sign };
}
