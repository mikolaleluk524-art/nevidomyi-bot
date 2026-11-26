// Пошукова оптимізація: Google бачить готовий текст сторінки (послуги, ціни, адреса, графік)
// і структуровані дані schema.org про салон — ще до запуску застосунку в браузері.
import { readFileSync } from "node:fs";
import { all, getSettings, one } from "./db.js";

const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const DAYS_UA = ["Нд", "Пн", "Вт", "Ср", "Чт", "Пт", "Сб"];

function hours() {
  const m = one("SELECT schedule FROM masters WHERE active = 1 ORDER BY sort, id LIMIT 1");
  const sch = m ? JSON.parse(m.schedule || "{}") : {};
  return [1, 2, 3, 4, 5, 6, 0].filter((d) => sch[d]).map((d) => ({ d, from: sch[d][0], to: sch[d][1] }));
}

// Короткий графік для людей: «Пн–Сб 09:00–19:00»
function hoursText(h) {
  if (!h.length) return "";
  const groups = [];
  for (const x of h) {
    const g = groups[groups.length - 1];
    if (g && g.from === x.from && g.to === x.to) g.days.push(x.d);
    else groups.push({ ...x, days: [x.d] });
  }
  return groups.map((g) => `${DAYS_UA[g.days[0]]}${g.days.length > 1 ? "–" + DAYS_UA[g.days[g.days.length - 1]] : ""} ${g.from}–${g.to}`).join(", ");
}

export function renderIndex(template, base) {
  const s = getSettings();
  const city = s.city || "";
  const services = all("SELECT name, description, price, price_from, category, addon FROM services WHERE active = 1 ORDER BY sort, id");
  const photo = one("SELECT file FROM gallery WHERE kind = 'work' AND file LIKE '%.jpg' ORDER BY sort, id DESC LIMIT 1");
  const rating = one("SELECT AVG(rating) a, COUNT(*) n FROM reviews WHERE status = 'approved'");
  const h = hours();
  const cats = [...new Set(services.filter((x) => !x.addon).map((x) => x.category.toLowerCase()))];
  const what = cats.length ? cats.join(" та ") : "манікюр та педикюр";

  const title = `${s.name} — ${what} у ${city ? cityLocative(city) : "салоні"} · онлайн-запис`;
  const desc = `${s.name} — ${what}${city ? ` у ${cityLocative(city)}` : ""}. ${s.address}${s.cabinet ? ", " + s.cabinet : ""}. Вільні вікна та запис онлайн 24/7, ціни від ${Math.min(...services.filter((x) => !x.addon).map((x) => x.price)) || ""} грн. ☎ ${s.phone}`;
  const image = photo ? `${base}/uploads/${photo.file}` : `${base}/icon-512.png`;

  const ld = {
    "@context": "https://schema.org",
    "@type": ["NailSalon", "BeautySalon"],
    name: s.name,
    description: s.tagline,
    url: base,
    image,
    telephone: s.phone,
    priceRange: "₴₴",
    address: { "@type": "PostalAddress", streetAddress: `${s.address}${s.cabinet ? ", " + s.cabinet : ""}`, addressLocality: city, addressCountry: "UA" },
    ...(Number(s.lat) && Number(s.lng) ? { geo: { "@type": "GeoCoordinates", latitude: Number(s.lat), longitude: Number(s.lng) } } : {}),
    ...(h.length ? { openingHoursSpecification: h.map((x) => ({ "@type": "OpeningHoursSpecification", dayOfWeek: DAYS[x.d], opens: x.from, closes: x.to })) } : {}),
    ...(s.instagram ? { sameAs: [`https://instagram.com/${s.instagram.replace(/^@/, "")}`] } : {}),
    ...(rating?.n ? { aggregateRating: { "@type": "AggregateRating", ratingValue: Math.round(rating.a * 10) / 10, reviewCount: rating.n } } : {}),
    hasOfferCatalog: {
      "@type": "OfferCatalog",
      name: "Послуги",
      itemListElement: services
        .filter((x) => !x.addon)
        .map((x) => ({ "@type": "Offer", itemOffered: { "@type": "Service", name: x.name, description: x.description }, price: x.price, priceCurrency: "UAH" })),
    },
  };

  const head = `
  <title>${esc(title)}</title>
  <meta name="description" content="${esc(desc)}" />
  <link rel="canonical" href="${esc(base)}/" />
  <meta property="og:type" content="website" />
  <meta property="og:locale" content="uk_UA" />
  <meta property="og:site_name" content="${esc(s.name)}" />
  <meta property="og:title" content="${esc(title)}" />
  <meta property="og:description" content="${esc(desc)}" />
  <meta property="og:url" content="${esc(base)}/" />
  <meta property="og:image" content="${esc(image)}" />
  <meta name="twitter:card" content="summary_large_image" />
  ${s.googleVerify ? `<meta name="google-site-verification" content="${esc(s.googleVerify)}" />` : ""}
  <script type="application/ld+json">${JSON.stringify(ld).replace(/</g, "\\u003c")}</script>`;

  // Текст сторінки для пошуковиків (і для тих, у кого застосунок ще вантажиться)
  const byCat = {};
  for (const x of services) (byCat[x.category || "Послуги"] ||= []).push(x);
  const body = `
    <section class="hero"><div class="tag">${esc(s.tagline)}</div><h1>${esc(s.name)}</h1>
      <p>${esc(what[0].toUpperCase() + what.slice(1))}${city ? ` у ${esc(cityLocative(city))}` : ""}. Онлайн-запис у зручний час.</p>
      <a class="btn block big" href="#/book">Записатись онлайн</a></section>
    <section class="section"><h2>Ціни на послуги</h2>
      ${Object.entries(byCat)
        .map(([c, list]) => `<h3>${esc(c)}</h3><ul>${list.map((x) => `<li>${esc(x.name)} — ${x.addon ? "+" : x.price_from ? "від " : ""}${x.price} грн${x.description ? `. ${esc(x.description)}` : ""}</li>`).join("")}</ul>`)
        .join("")}</section>
    <section class="section"><h2>Контакти</h2>
      <p>📍 ${esc(s.address)}${city ? ", " + esc(city) : ""}${s.cabinet ? ", " + esc(s.cabinet) : ""}</p>
      ${h.length ? `<p>🕘 ${esc(hoursText(h))}, за попереднім записом</p>` : ""}
      <p>☎ <a href="tel:${esc(s.phone)}">${esc(s.phone)}</a>${s.instagram ? ` · Instagram <a href="https://instagram.com/${esc(s.instagram.replace(/^@/, ""))}">@${esc(s.instagram.replace(/^@/, ""))}</a>` : ""}</p></section>
    <section class="section"><h2>Про майстра</h2>${all("SELECT name, role, about FROM masters WHERE active = 1").map((m) => `<h3>${esc(m.name)}</h3><p>${esc(m.role)}</p><p>${esc(m.about).replace(/\n\n/g, "</p><p>")}</p>`).join("")}</section>`;

  return template
    .replace(/<title>[^<]*<\/title>\s*/, "")
    .replace(/<meta name="description"[^>]*>\s*/, "")
    .replace("</head>", `${head}\n</head>`)
    .replace('<main id="view"><div class="spinner"></div></main>', `<main id="view">${body}</main>`);
}

// «Чернівці» → «Чернівцях», «Київ» → «Києві» (місцевий відмінок для фраз «у …»)
export function cityLocative(c) {
  const map = { Чернівці: "Чернівцях", Київ: "Києві", Львів: "Львові", Одеса: "Одесі", Харків: "Харкові", Дніпро: "Дніпрі", Вінниця: "Вінниці", "Івано-Франківськ": "Івано-Франківську", Тернопіль: "Тернополі", Хмельницький: "Хмельницькому" };
  return map[c] || c;
}

export function sitemap(base) {
  const d = new Date().toISOString().slice(0, 10);
  const urls = ["/"]; // застосунок — одна сторінка, розділи всередині
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${urls
    .map((u) => `<url><loc>${base}${u}</loc><lastmod>${d}</lastmod><changefreq>weekly</changefreq><priority>1.0</priority></url>`)
    .join("")}</urlset>`;
}

export const robots = (base) => `User-agent: *\nAllow: /\nDisallow: /admin\nDisallow: /api/\nDisallow: /poster\n\nSitemap: ${base}/sitemap.xml\n`;

export const readTemplate = (path) => readFileSync(path, "utf8");
