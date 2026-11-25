import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

export const DATA_DIR = process.env.DATA_DIR || join(process.cwd(), "data");
export const UPLOAD_DIR = join(DATA_DIR, "uploads");
mkdirSync(UPLOAD_DIR, { recursive: true });

export const db = new DatabaseSync(join(DATA_DIR, "salon.sqlite"));
db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");

db.exec(`
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT);

CREATE TABLE IF NOT EXISTS masters (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  role TEXT DEFAULT '',
  photo TEXT DEFAULT '',
  about TEXT DEFAULT '',
  schedule TEXT NOT NULL DEFAULT '{}',   -- {"1":["09:00","19:00"], ...} 0 = неділя
  services TEXT NOT NULL DEFAULT '[]',   -- id послуг; порожньо = усі
  active INTEGER DEFAULT 1,
  sort INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS services (
  id INTEGER PRIMARY KEY,
  category TEXT DEFAULT '',
  name TEXT NOT NULL,
  description TEXT DEFAULT '',
  price INTEGER NOT NULL,                -- грн
  duration INTEGER NOT NULL,             -- хв
  active INTEGER DEFAULT 1,
  sort INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS clients (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  phone TEXT UNIQUE NOT NULL,
  token TEXT UNIQUE NOT NULL,
  ref_code TEXT UNIQUE NOT NULL,
  referred_by INTEGER REFERENCES clients(id),
  ref_rewarded INTEGER DEFAULT 0,
  bonus INTEGER DEFAULT 0,
  birthday TEXT DEFAULT '',
  note TEXT DEFAULT '',
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS bookings (
  id INTEGER PRIMARY KEY,
  client_id INTEGER NOT NULL REFERENCES clients(id),
  master_id INTEGER NOT NULL REFERENCES masters(id),
  service_id INTEGER NOT NULL REFERENCES services(id),
  service_name TEXT NOT NULL,
  date TEXT NOT NULL,
  start INTEGER NOT NULL,
  duration INTEGER NOT NULL,
  start_utc INTEGER NOT NULL,
  price INTEGER NOT NULL,
  discount INTEGER DEFAULT 0,
  bonus_used INTEGER DEFAULT 0,
  prepay INTEGER DEFAULT 0,
  paid INTEGER DEFAULT 0,
  invoice_id TEXT,
  status TEXT NOT NULL,                  -- pending | confirmed | done | cancelled | no_show | expired
  comment TEXT DEFAULT '',
  source TEXT DEFAULT 'app',
  reminded24 INTEGER DEFAULT 0,
  reminded2 INTEGER DEFAULT 0,
  asked_review INTEGER DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS bookings_day ON bookings(date, master_id);
CREATE INDEX IF NOT EXISTS bookings_client ON bookings(client_id);

CREATE TABLE IF NOT EXISTS blocks (
  id INTEGER PRIMARY KEY,
  master_id INTEGER,                     -- NULL = увесь салон
  date TEXT NOT NULL,
  start INTEGER NOT NULL,
  end INTEGER NOT NULL,
  note TEXT DEFAULT ''
);

CREATE TABLE IF NOT EXISTS gallery (
  id INTEGER PRIMARY KEY,
  kind TEXT NOT NULL,                    -- work | cert | route | salon
  file TEXT NOT NULL,
  caption TEXT DEFAULT '',
  sort INTEGER DEFAULT 0,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS reviews (
  id INTEGER PRIMARY KEY,
  client_id INTEGER REFERENCES clients(id),
  booking_id INTEGER UNIQUE REFERENCES bookings(id),
  name TEXT NOT NULL,
  service TEXT DEFAULT '',
  rating INTEGER NOT NULL,
  text TEXT DEFAULT '',
  status TEXT DEFAULT 'pending',         -- pending | approved | hidden
  reply TEXT DEFAULT '',
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS push_subs (
  id INTEGER PRIMARY KEY,
  client_id INTEGER,
  is_admin INTEGER DEFAULT 0,
  endpoint TEXT UNIQUE NOT NULL,
  data TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS waitlist (
  id INTEGER PRIMARY KEY,
  client_id INTEGER NOT NULL,
  service_id INTEGER NOT NULL,
  master_id INTEGER,
  date TEXT NOT NULL,
  notified INTEGER DEFAULT 0,
  created_at INTEGER NOT NULL,
  UNIQUE(client_id, service_id, date)
);

CREATE TABLE IF NOT EXISTS scans (
  src TEXT PRIMARY KEY,                  -- звідки прийшли: door, entrance, stop...
  scans INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS bonus_log (
  id INTEGER PRIMARY KEY,
  client_id INTEGER NOT NULL,
  delta INTEGER NOT NULL,
  reason TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
`);

// Міграції для вже створених баз
for (const [table, col, def] of [
  ["clients", "src", "TEXT DEFAULT ''"],
  ["services", "addon", "INTEGER DEFAULT 0"], // 1 = доповнення до основної послуги (френч, ремонт)
  ["services", "price_from", "INTEGER DEFAULT 0"], // 1 = показувати ціну як «від …»
  ["clients", "prepay_rule", "TEXT DEFAULT ''"], // '' = автоматично, never = без передоплати, always = завжди з передоплатою
  ["bookings", "pay_until", "INTEGER DEFAULT 0"], // до коли треба сплатити передоплату (після рішення майстра)
]) {
  if (!db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === col)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${def}`);
}

export const one = (sql, ...a) => db.prepare(sql).get(...a);
export const all = (sql, ...a) => db.prepare(sql).all(...a);
export const run = (sql, ...a) => db.prepare(sql).run(...a);

export function tx(fn) {
  db.exec("BEGIN IMMEDIATE");
  try {
    const r = fn();
    db.exec("COMMIT");
    return r;
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}

// ---- Налаштування салону ----
export const DEFAULT_SETTINGS = {
  name: "Магія краси",
  theme: "gold", // rose | lavender | gold | nude | mint
  tagline: "Чарівниця манікюру та педикюру",
  about:
    "«Магія краси» — місце, де звичайний візит до майстра перетворюється на маленьке диво. Стерильні інструменти, якісні матеріали й увага до кожної деталі — а результат тішить вас тижнями.\n\nОбирайте зручний час онлайн — без дзвінків і очікувань.",
  phone: "+380666230824",
  instagram: "m.nail_cv",
  telegram: "+380666230824",
  viber: "+380666230824",
  address: "вул. Кушніренка, 7а",
  cabinet: "Бізнес-центр, 5 поверх, офіс 507",
  howToFind: "Заходьте в бізнес-центр за адресою Кушніренка, 7а. Підніміться на 5 поверх — шукайте офіс 507. Якщо загубитесь — телефонуйте, зустрінемо!",
  lat: 0, // 0 = точку на карті ще не поставлено: маршрут будується за адресою
  lng: 0,
  prepayPercent: 30, // передоплата у % від вартості; 0 = без передоплати
  prepayMode: "manual", // manual = нові клієнтки надсилають заявку, майстер вирішує; new = лише нові платять одразу; all = всі
  prepayHours: 3, // скільки годин має клієнтка на передоплату після рішення майстра
  slotStep: 30, // крок сітки запису, хв
  bookingDays: 30, // на скільки днів вперед можна записатися
  minNoticeHours: 2, // мінімум годин до запису
  cancelHours: 24, // безкоштовне скасування не пізніше ніж за N годин
  refBonus: 100, // бонусів тому, хто привів подругу (після її візиту)
  refDiscount: 100, // знижка подрузі на перший візит, грн
  cashbackPercent: 5, // кешбек бонусами з кожного візиту
  maxBonusPercent: 50, // якою частиною вартості можна оплатити бонусами
  birthdayDiscount: 10, // % знижки в тиждень дня народження
  rules: "Будь ласка, приходьте за 5 хвилин до початку. Якщо запізнюєтесь більше ніж на 15 хвилин — запис може бути перенесено.",
};

export function getSettings() {
  const rows = all("SELECT key, value FROM settings WHERE key NOT LIKE '\\_%' ESCAPE '\\'");
  const s = { ...DEFAULT_SETTINGS };
  for (const r of rows) {
    try {
      s[r.key] = JSON.parse(r.value);
    } catch {}
  }
  return s;
}

export function setSettings(obj) {
  for (const [k, v] of Object.entries(obj)) {
    if (!(k in DEFAULT_SETTINGS)) continue;
    const def = DEFAULT_SETTINGS[k];
    const val = typeof def === "number" ? Number(v) || 0 : String(v ?? "").slice(0, 4000);
    run("INSERT INTO settings(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", k, JSON.stringify(val));
  }
}

// Службові значення (ключі з підкресленням) — не показуються клієнтам.
export function getSecret(key) {
  const r = one("SELECT value FROM settings WHERE key = ?", "_" + key);
  return r ? r.value : null;
}
export function setSecret(key, value) {
  run("INSERT INTO settings(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", "_" + key, value);
}

// ---- Стартові дані, щоб застосунок одразу виглядав живим ----
if (!one("SELECT id FROM masters LIMIT 1")) {
  const week = { 1: ["09:00", "19:00"], 2: ["09:00", "19:00"], 3: ["09:00", "19:00"], 4: ["09:00", "19:00"], 5: ["09:00", "19:00"], 6: ["09:00", "19:00"] };
  const about = [
    "Ось уже 12 років Марина Олександрівна творить красу. Колись вона чаклувала над волоссям, та з часом у ній прокинувся справжній дар — перетворювати й зцілювати нігті.",
    "За її плечима — десятки сертифікатів, сотні рекомендацій, тисячі неймовірних робіт і, здається, мільйони щасливих пальчиків.",
    "Салон не раз змінював адресу, але клієнтки щоразу знаходили дорогу: їм байдуже, де саме, — головне, що там, де Марина, відбувається та сама «Магія краси».",
    "У цій родині кожен робить світ кращим по-своєму: поки чоловік Марини на фронті боронить Україну від ворожої нечисті, вона тут, удома, зі звичайних речей створює прекрасне — і дарує жінкам упевненість, красу та радість щодня. 💛💙",
  ].join("\n\n");
  run("INSERT INTO masters(name, role, about, schedule) VALUES(?, ?, ?, ?)", "Марина Олександрівна", "Майстер манікюру та педикюру · 12 років досвіду", about, JSON.stringify(week));
  // [категорія, назва, опис, ціна, тривалість хв, доповнення?, ціна «від»?]
  const seed = [
    ["Манікюр", "Манікюр жіночий", "Охайна форма, обробка кутикули і догляд", 500, 40, 0, 0],
    ["Манікюр", "Манікюр чоловічий", "Акуратні доглянуті руки без зайвого блиску", 600, 60, 0, 0],
    ["Манікюр", "Покриття гель-лаком", "Манікюр + стійке покриття гель-лаком", 800, 80, 0, 0],
    ["Манікюр", "Укріплення гелем", "Міцні рівні нігті, що не ламаються. Ціна залежить від довжини", 900, 120, 0, 1],
    ["Манікюр", "Нарощення нігтів", "Бажана довжина і форма. Ціна залежить від довжини і дизайну", 1100, 180, 0, 1],
    ["Манікюр", "Френч", "Класичний або кольоровий — додається до покриття", 100, 15, 1, 0],
    ["Манікюр", "Ремонт 1 нігтя", "Якщо ноготь зламався — відновимо", 50, 10, 1, 0],
    ["Педикюр", "Чистка пальчиків", "Обробка пальчиків, форма, кутикула", 500, 40, 0, 0],
    ["Педикюр", "Пальчики + стопа", "Повний догляд: пальчики й обробка стопи", 700, 60, 0, 0],
    ["Педикюр", "Пальчики + стопа + гель-лак", "Повний педикюр зі стійким покриттям", 900, 120, 0, 0],
    ["Педикюр", "Чоловічий педикюр", "Повний догляд для чоловіків", 900, 90, 0, 0],
  ];
  seed.forEach((s, i) => run("INSERT INTO services(category, name, description, price, duration, addon, price_from, sort) VALUES(?, ?, ?, ?, ?, ?, ?, ?)", ...s, i));
}
