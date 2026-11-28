// Клієнтський застосунок салону (PWA). Без збірки: звичайний ES-модуль.
const $ = (s, el = document) => el.querySelector(s);
const view = $("#view");
const top = $("#top");
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const money = (n) => `${Number(n).toLocaleString("uk-UA")} грн`;
const dur = (m) => (m >= 60 ? `${Math.floor(m / 60)} год${m % 60 ? " " + (m % 60) + " хв" : ""}` : `${m} хв`);
const stars = (n) => "★★★★★".slice(0, Math.round(n)) + "☆☆☆☆☆".slice(0, 5 - Math.round(n));
const priceLabel = (s) => (s.addon ? "+" : s.priceFrom ? "від " : "") + money(s.price);
// Текст з порожніми рядками → абзаци
const paras = (t, cls = "") => String(t || "").split(/\n\s*\n/).map((p) => `<p class="${cls}">${esc(p).replace(/\n/g, "<br>")}</p>`).join("");
const tgLink = (t) => (/^\+?\d[\d\s-]{6,}$/.test(t) ? `https://t.me/+${t.replace(/\D/g, "")}` : `https://t.me/${t.replace(/^@/, "")}`);
const isVideo = (f) => /\.(mp4|mov)$/i.test(f);
const poster = (f) => (/^v\d/.test(f) ? ` poster="${img(f.replace(/\.\w+$/, "-poster.jpg"))}"` : "");
// Фото або «живе» відео (без звуку, по колу)
const media = (f, alt = "", lazy = true) =>
  isVideo(f)
    ? `<video src="${img(f)}"${poster(f)} muted loop playsinline autoplay preload="metadata" aria-label="${esc(alt)}"></video>`
    : `<img ${lazy ? 'loading="lazy"' : ""} src="${img(f)}" alt="${esc(alt)}">`;
const img = (f) => `/uploads/${encodeURIComponent(f)}`;
const WD = ["Нд", "Пн", "Вт", "Ср", "Чт", "Пт", "Сб"];
const MONTHS = ["Січень", "Лютий", "Березень", "Квітень", "Травень", "Червень", "Липень", "Серпень", "Вересень", "Жовтень", "Листопад", "Грудень"];

const store = {
  get(k) {
    try { return localStorage.getItem(k); } catch { return null; }
  },
  set(k, v) {
    try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch {}
  },
};

// Реферальний код із посилання ?ref=XXXX — запамʼятовуємо, поки людина не запишеться.
const params = new URLSearchParams(location.search);
if (params.get("ref")) {
  store.set("ref", params.get("ref").toUpperCase().slice(0, 12));
  history.replaceState(null, "", location.pathname + location.hash);
}

// Мітка постера ?src=door — рахуємо сканування один раз на пристрій.
if (params.get("src")) {
  const src = params.get("src").slice(0, 40);
  if (!store.get("src")) {
    store.set("src", src);
    fetch("/api/scan", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ src }) }).catch(() => {});
  }
  history.replaceState(null, "", location.pathname + location.hash);
}

let info = null;
let meCache = null;
const token = () => store.get("token");

async function api(path, opts = {}) {
  const res = await fetch(path, {
    method: opts.body ? "POST" : opts.method || "GET",
    headers: { "content-type": "application/json", ...(token() ? { "x-client-token": token() } : {}) },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || "Немає звʼязку. Перевірте інтернет.");
  return data;
}

function toast(msg, ms = 2800) {
  const t = document.createElement("div");
  t.className = "toast";
  t.textContent = msg;
  document.body.append(t);
  setTimeout(() => t.remove(), ms);
}

function sheet(html, onMount) {
  const bg = document.createElement("div");
  bg.className = "sheet-bg";
  bg.innerHTML = `<div class="sheet">${html}</div>`;
  bg.addEventListener("click", (e) => e.target === bg && bg.remove());
  document.body.append(bg);
  onMount?.(bg.firstElementChild, () => bg.remove());
  return () => bg.remove();
}

function header(title, back) {
  top.innerHTML = back
    ? `<button class="back" aria-label="Назад">←</button><div class="title">${esc(title)}</div>`
    : `<div class="title">${esc(title)}</div>`;
  if (back) $(".back", top).onclick = typeof back === "function" ? back : () => (history.length > 1 ? history.back() : (location.hash = "#/"));
}

function setTab(tab) {
  document.querySelectorAll("nav.bar a").forEach((a) => a.classList.toggle("on", a.dataset.tab === tab));
}

const statusBadge = (s) =>
  ({
    request: '<span class="badge warn">Очікує підтвердження</span>',
    pending: '<span class="badge warn">Очікує оплати</span>',
    confirmed: '<span class="badge ok">Підтверджено</span>',
    done: '<span class="badge mute">Візит відбувся</span>',
    cancelled: '<span class="badge bad">Скасовано</span>',
    no_show: '<span class="badge bad">Пропущено</span>',
  })[s] || "";

async function loadMe(force) {
  if (!token()) return null;
  if (meCache && !force) return meCache;
  try {
    meCache = await api("/api/me");
  } catch (e) {
    if (/запишіться/.test(e.message)) store.set("token", null);
    meCache = null;
  }
  return meCache;
}

// ================= Головна =================
async function home() {
  setTab("home");
  const s = info.settings;
  top.innerHTML = "";
  const me = await loadMe();
  const next = me?.bookings.filter((b) => ["confirmed", "pending", "request"].includes(b.status) && b.startUtc > Date.now()).sort((a, b) => a.startUtc - b.startUtc)[0];
  const works = info.gallery.filter((g) => g.kind === "work").slice(0, 10);
  const certs = info.gallery.filter((g) => g.kind === "cert");
  const shots = info.gallery.filter((g) => g.kind === "review");
  const n = info.nearest;
  const todayStr = new Date().toLocaleDateString("sv-SE", { timeZone: "Europe/Kyiv" });
  const nearestLabel = n ? (n.date === todayStr ? `сьогодні о ${n.time}` : `${new Date(n.date + "T12:00").toLocaleDateString("uk-UA", { day: "numeric", month: "long", weekday: "short" })} о ${n.time}`) : null;

  view.innerHTML = `
    <section class="hero">
      <div class="tag">${esc(s.tagline)}</div>
      <h1>${esc(s.name)}</h1>
      ${info.rating.count ? `<a class="rating" href="#/reviews"><span class="stars">★</span> ${info.rating.avg} · ${info.rating.count} відгуків</a>` : ""}
      ${nearestLabel ? `<div class="nearest"><span class="dot"></span><div><b>Найближче вільне вікно</b><div class="muted small">${esc(nearestLabel)}</div></div></div>` : ""}
      <a class="btn block big" style="margin-top:16px" href="#/book">Записатись онлайн</a>
    </section>

    <div id="install"></div>

    ${next ? `
      <section class="section">
        <div class="card visit-card">
          <div class="row between"><b>Ваш запис</b>${statusBadge(next.status)}</div>
          <h3 style="margin-top:6px">${esc(next.service)}</h3>
          <div class="muted">${esc(next.when)}</div>
          <div class="row" style="margin-top:12px">
            ${next.status === "pending" ? `<a class="btn sm" href="#/me">Оплатити</a>` : `<a class="btn sm" href="#/visit/${next.id}">🧭 Як дійти</a>`}
            <a class="btn sm ghost" href="#/me">Деталі</a>
          </div>
        </div>
      </section>` : ""}

    <section class="section">
      <div class="tiles">
        <a class="tile" href="#/price"><span class="ic">📋</span>Прайс</a>
        <a class="tile" href="#/works"><span class="ic">🖼️</span>Роботи</a>
        <a class="tile" href="#/works?tab=cert"><span class="ic">🎓</span>Сертифікати</a>
        <a class="tile" href="#/map"><span class="ic">📍</span>Як знайти</a>
      </div>
    </section>

    ${works.length ? `
      <section class="section">
        <div class="section-head"><h2>Наші роботи</h2><a href="#/works">Усі →</a></div>
        <div class="scroller">${works.map((w) => `<a class="thumb" href="#/works">${media(w.file, w.caption)}</a>`).join("")}</div>
      </section>` : ""}

    <section class="section">
      <a class="card" href="#/gift" style="display:flex;gap:14px;align-items:center;text-decoration:none;color:inherit;background:linear-gradient(135deg,var(--accent-soft),var(--card))">
        <div style="font-size:38px">🎁</div>
        <div class="grow"><b>Подарунковий сертифікат</b>
          <div class="small muted">Найкращий подарунок для мами, подруги чи коханої — краса від «${esc(s.name)}». Гарна листівка з кодом — одразу в телефон.</div>
        </div>
        <div style="color:var(--accent);font-weight:800">→</div>
      </a>
    </section>

    ${info.reviews.length || shots.length ? `
      <section class="section">
        <div class="section-head"><h2>Що кажуть клієнтки</h2><a href="#/reviews">Усі →</a></div>
        <div class="scroller">${info.reviews.slice(0, 6).map(reviewCard).join("")}${shots.slice(0, 10).map((g) => `<a class="thumb shot" href="#/reviews">${media(g.file, g.caption)}</a>`).join("")}</div>
      </section>` : ""}

    ${info.masters.length ? `
      <section class="section">
        <h2>${info.masters.length > 1 ? "Майстри" : "Ваш майстер"}</h2>
        ${info.masters.map((m) => `
          <div class="card">
            <div class="row"><div class="avatar" style="margin:0;flex:none;width:96px;height:96px;border:2px solid var(--accent)">${m.photo ? `<img src="${img(m.photo)}" alt="">` : esc(m.name[0])}</div>
              <div><h3 style="margin:0">${esc(m.name)}</h3><div class="small" style="color:var(--accent);font-weight:700">${esc(m.role)}</div></div></div>
            <div style="margin-top:12px">${paras(m.about)}</div>
          </div>`).join("")}
        ${certs.length ? `<a class="btn line block" style="margin-top:10px" href="#/works?tab=cert">🎓 Сертифікати (${certs.length})</a>` : ""}
      </section>` : ""}

    <section class="section card">
      <h3>Про нас</h3>
      ${paras(s.about)}
      <p class="muted small">📍 ${esc([s.address, s.city].filter(Boolean).join(", "))}${s.cabinet ? ", " + esc(s.cabinet) : ""}</p>
      <div class="row wrap">
        <a class="btn sm ghost" href="tel:${esc(s.phone)}">📞 Подзвонити</a>
        ${s.instagram ? `<a class="btn sm ghost" target="_blank" rel="noopener" href="https://instagram.com/${esc(s.instagram.replace(/^@/, ""))}">Instagram</a>` : ""}
        ${s.telegram ? `<a class="btn sm ghost" target="_blank" rel="noopener" href="${esc(tgLink(s.telegram))}">Telegram</a>` : ""}
        ${s.viber ? `<a class="btn sm ghost" href="viber://chat?number=${esc(s.viber.replace(/[^\d+]/g, ""))}">Viber</a>` : ""}
      </div>
    </section>
  `;
  renderInstall($("#install"));
}

function reviewCard(r) {
  return `<div class="review">
    <div class="row between"><b>${esc(r.name)}</b><span class="stars">${stars(r.rating)}</span></div>
    ${r.service ? `<div class="small muted">${esc(r.service)}</div>` : ""}
    ${r.text ? `<p style="margin-top:6px">${esc(r.text)}</p>` : ""}
    ${r.reply ? `<div class="reply"><b>Відповідь майстра:</b> ${esc(r.reply)}</div>` : ""}
  </div>`;
}

// ================= Встановлення на телефон =================
let deferredPrompt = null;
window.addEventListener("beforeinstallprompt", (e) => {
  e.preventDefault();
  deferredPrompt = e;
  const box = $("#install");
  if (box) renderInstall(box);
});
const isStandalone = () => matchMedia("(display-mode: standalone)").matches || navigator.standalone;
const isIOS = () => /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);

function renderInstall(box) {
  if (!box || isStandalone() || store.get("installDismissed")) return;
  if (!deferredPrompt && !isIOS()) return;
  box.innerHTML = `<div class="install"><div style="font-size:28px">📲</div><div class="grow"><b>Додайте на головний екран</b><div class="small" style="opacity:.75">Нагадування про запис і маршрут — в один дотик</div></div><button class="btn sm" id="inst">Додати</button></div>`;
  $("#inst", box).onclick = async () => {
    if (deferredPrompt) {
      deferredPrompt.prompt();
      await deferredPrompt.userChoice;
      deferredPrompt = null;
      box.innerHTML = "";
    } else iosInstallHelp();
  };
}

function iosInstallHelp() {
  sheet(`<h2>Встановити на iPhone</h2>
    <div class="stack" style="margin-top:12px">
      <div class="route-step"><div class="n">1</div><div>Натисніть кнопку <b>«Поділитися»</b> <span style="font-size:20px">⬆️</span> внизу Safari</div></div>
      <div class="route-step"><div class="n">2</div><div>Оберіть <b>«На початковий екран»</b> ➕</div></div>
      <div class="route-step"><div class="n">3</div><div>Відкрийте застосунок з іконки — і увімкніть нагадування</div></div>
    </div>
    <button class="btn block" style="margin-top:18px" data-close>Зрозуміло</button>
    <button class="btn line block" style="margin-top:8px" data-never>Не показувати</button>`, (el, close) => {
    $("[data-close]", el).onclick = close;
    $("[data-never]", el).onclick = () => {
      store.set("installDismissed", "1");
      $("#install")?.replaceChildren();
      close();
    };
  });
}

// ================= Сповіщення =================
function b64ToBytes(b64) {
  const pad = "=".repeat((4 - (b64.length % 4)) % 4);
  const raw = atob((b64 + pad).replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}

async function enablePush() {
  if (!("serviceWorker" in navigator) || !("PushManager" in window)) {
    if (isIOS() && !isStandalone()) return iosInstallHelp();
    toast("Цей браузер не підтримує сповіщення. Додайте запис у календар 📅");
    return false;
  }
  const perm = await Notification.requestPermission();
  if (perm !== "granted") {
    toast("Сповіщення вимкнені в налаштуваннях телефону");
    return false;
  }
  const reg = await navigator.serviceWorker.ready;
  const sub = (await reg.pushManager.getSubscription()) || (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToBytes(info.vapidPublicKey) }));
  await api("/api/push/subscribe", { body: { subscription: sub.toJSON() } });
  store.set("push", "1");
  toast("Готово! Нагадаємо за добу і за 2 години 🔔");
  return true;
}

const pushOn = () => typeof Notification !== "undefined" && Notification.permission === "granted" && store.get("push");

// ================= Прайс =================
function groupByCat(list) {
  const map = new Map();
  for (const s of list) {
    const k = s.category || "Послуги";
    if (!map.has(k)) map.set(k, []);
    map.get(k).push(s);
  }
  return [...map.entries()];
}

function price() {
  setTab("price");
  header("Прайс");
  view.innerHTML = groupByCat(info.services).map(([cat, list]) => `
    <div class="cat"><h3>${esc(cat)}</h3>
      ${list.map((s) => `
        <a class="svc" href="${s.addon ? "#/book" : `#/book?service=${s.id}`}" style="text-decoration:none;color:inherit">
          <div class="grow"><div class="name">${esc(s.name)}</div>
            ${s.description ? `<div class="small muted">${esc(s.description)}</div>` : ""}
            <div class="small muted">${s.addon ? "✨ Додається до основної послуги при записі" : `⏱ ${dur(s.duration)}`}</div></div>
          <div class="price">${priceLabel(s)}${s.addon ? "" : '<div class="small" style="color:var(--accent);font-weight:700">Записатись →</div>'}</div>
        </a>`).join("")}
    </div>`).join("") + `<p class="small muted center" style="margin-top:18px">${info.settings.onlinePay && info.settings.prepayPercent > 0 ? `Для підтвердження запису — передоплата ${info.settings.prepayPercent}%. Решта — на місці.` : "Оплата на місці."}</p>`;
}

// ================= Запис =================
const book = { serviceId: null, addons: [], masterId: 0, date: null, start: null, time: null, step: 1 };
const addonsFor = (id) => {
  const main = info.services.find((s) => s.id === id);
  return info.services.filter((a) => a.addon && (!a.category || a.category === main?.category));
};
const addonQs = () => (book.addons.length ? `&addons=${book.addons.join(",")}` : "");

function bookStart(q) {
  setTab("book");
  if (q.get("service")) {
    book.serviceId = Number(q.get("service"));
    book.addons = [];
    book.masterId = Number(q.get("master")) || 0;
    book.date = q.get("date") || null;
    book.start = null;
    book.step = eligibleMasters().length > 1 && !book.masterId ? 2 : 3;
    history.replaceState(null, "", "#/book");
  } else if (!book.serviceId) book.step = 1;
  renderBook();
}

const eligibleMasters = () => info.masters.filter((m) => !m.services.length || m.services.includes(book.serviceId));
// Обрана послуга разом із доповненнями (ціна і час сумуються)
const svc = () => {
  const main = info.services.find((s) => s.id === book.serviceId);
  const add = info.services.filter((a) => book.addons.includes(a.id));
  return { ...main, name: [main.name, ...add.map((a) => a.name)].join(" + "), price: main.price + add.reduce((x, a) => x + a.price, 0), duration: main.duration + add.reduce((x, a) => x + a.duration, 0) };
};

function stepsBar() {
  return `<div class="steps">${[1, 2, 3, 4].map((i) => `<i class="${i <= book.step ? "on" : ""}"></i>`).join("")}</div>`;
}

function goStep(n) {
  book.step = n;
  renderBook();
  scrollTo(0, 0);
}

function renderBook() {
  const back = book.step > 1 ? () => goStep(book.step === 3 && eligibleMasters().length <= 1 ? 1 : book.step - 1) : null;
  if (book.step === 1) {
    header("Оберіть послугу", null);
    view.innerHTML = stepsBar() + groupByCat(info.services.filter((s) => !s.addon)).map(([cat, list]) => `
      <div class="cat"><h3>${esc(cat)}</h3>
        ${list.map((s) => `<div class="svc ${s.id === book.serviceId ? "sel" : ""}" data-id="${s.id}">
          <div class="grow"><div class="name">${esc(s.name)}</div><div class="small muted">⏱ ${dur(s.duration)}</div></div>
          <div class="price">${priceLabel(s)}</div></div>`).join("")}
      </div>`).join("");
    const next = () => goStep(eligibleMasters().length > 1 ? 2 : 3);
    view.querySelectorAll(".svc").forEach((el) => (el.onclick = () => {
      book.serviceId = Number(el.dataset.id);
      book.addons = [];
      book.start = null;
      book.masterId = 0;
      const extra = addonsFor(book.serviceId);
      if (!extra.length) return next();
      const main = info.services.find((s) => s.id === book.serviceId);
      sheet(`<h2>${esc(main.name)}</h2><p class="muted">Додати щось до послуги?</p>
        ${extra.map((a) => `<label class="check"><input type="checkbox" value="${a.id}"> <span class="grow">${esc(a.name)}<div class="small muted">${esc(a.description || "")}</div></span><b>${priceLabel(a)}</b></label>`).join("")}
        <button class="btn block big" style="margin-top:18px" id="addNext">Далі</button>`, (el2, close) => {
        $("#addNext", el2).onclick = () => {
          book.addons = [...el2.querySelectorAll("input:checked")].map((i) => Number(i.value));
          close();
          next();
        };
      });
    }));
    return;
  }
  if (book.step === 2) {
    header("Оберіть майстра", back);
    const ms = eligibleMasters();
    view.innerHTML = stepsBar() + `<div class="masters">
      <div class="master ${!book.masterId ? "sel" : ""}" data-id="0"><div class="avatar">✨</div><b>Будь-який</b><div class="small muted">Найбільше вільних вікон</div></div>
      ${ms.map((m) => `<div class="master ${book.masterId === m.id ? "sel" : ""}" data-id="${m.id}"><div class="avatar">${m.photo ? `<img src="${img(m.photo)}" alt="">` : esc(m.name[0])}</div><b>${esc(m.name)}</b><div class="small muted">${esc(m.role)}</div></div>`).join("")}
    </div>`;
    view.querySelectorAll(".master").forEach((el) => (el.onclick = () => {
      book.masterId = Number(el.dataset.id);
      book.start = null;
      goStep(3);
    }));
    return;
  }
  if (book.step === 3) return renderDates(back);
  if (book.step === 4) return renderConfirm(back);
}

async function renderDates(back) {
  header("Дата і час", back);
  const s = svc();
  view.innerHTML = stepsBar() + `<div class="card row between" style="padding:12px 14px"><div><b>${esc(s.name)}</b><div class="small muted">⏱ ${dur(s.duration)}</div></div><b>${s.priceFrom ? "від " : ""}${money(s.price)}</b></div>
    <div id="days"><div class="spinner"></div></div><div id="slots"></div>`;
  const qs = `service=${book.serviceId}&master=${book.masterId}${addonQs()}`;
  // Якщо обрана дата далеко (напр. «Записатись знову»), календар починається з неї
  const { days } = await api(`/api/availability?${qs}`);
  if (!book.date || !days.find((d) => d.date === book.date && d.free)) book.date = days.find((d) => d.free)?.date || days[0]?.date;
  let lastMonth = null;
  const dayHtml = (d) => {
    const dt = new Date(d.date + "T12:00");
    return `<div class="day ${d.free ? "" : "full"} ${d.date === book.date ? "sel" : ""}" data-date="${d.date}">
      <div class="wd">${WD[dt.getDay()]}</div><div class="dn">${dt.getDate()}</div><div class="fr">${d.free ? d.free + " вікон" : "немає"}</div></div>`;
  };
  const more = `<div class="day" id="moreDays" style="display:grid;place-items:center;font-weight:800;color:var(--accent)">Ще<br>дні →</div>`;
  $("#days").innerHTML = `<div class="month" id="monthLbl"></div><div class="days">${days.map((d) => {
    const dt = new Date(d.date + "T12:00");
    const m = dt.getMonth();
    const mark = m !== lastMonth ? `data-month="${MONTHS[m]}"` : "";
    lastMonth = m;
    return `<div class="day ${d.free ? "" : "full"} ${d.date === book.date ? "sel" : ""}" data-date="${d.date}" ${mark}>
      <div class="wd">${WD[dt.getDay()]}</div><div class="dn">${dt.getDate()}</div><div class="fr">${d.free ? d.free + " вікон" : "немає"}</div></div>`;
  }).join("")}${days.length >= 30 ? more : ""}</div>`;
  const setMonth = () => ($("#monthLbl").textContent = MONTHS[new Date(book.date + "T12:00").getMonth()]);
  setMonth();
  const bindDay = (el) => (el.onclick = () => {
    book.date = el.dataset.date;
    book.start = null;
    $("#days").querySelectorAll(".day").forEach((x) => x.classList.toggle("sel", x === el));
    setMonth();
    loadSlots();
  });
  $("#days").querySelectorAll(".day[data-date]").forEach(bindDay);
  // «Ще дні →» — підвантажуємо наступні 30 днів, скільки завгодно далеко
  const bindMore = () => {
    const btn = $("#moreDays");
    if (!btn) return;
    btn.onclick = async () => {
      const lastDate = [...$("#days").querySelectorAll(".day[data-date]")].pop().dataset.date;
      const next = new Date(lastDate + "T12:00Z");
      next.setUTCDate(next.getUTCDate() + 1);
      btn.textContent = "…";
      const r = await api(`/api/availability?${qs}&from=${next.toISOString().slice(0, 10)}`);
      btn.insertAdjacentHTML("beforebegin", r.days.map(dayHtml).join(""));
      btn.parentElement.querySelectorAll(".day[data-date]").forEach(bindDay);
      if (r.days.length < 30) btn.remove();
      else btn.innerHTML = "Ще<br>дні →";
    };
  };
  bindMore();
  $("#days .day.sel")?.scrollIntoView({ inline: "center", block: "nearest" });
  loadSlots();
}

async function loadSlots() {
  const box = $("#slots");
  box.innerHTML = '<div class="spinner"></div>';
  const { slots } = await api(`/api/slots?service=${book.serviceId}&master=${book.masterId}&date=${book.date}${addonQs()}`);
  if (!slots.length) {
    box.innerHTML = `<div class="card center" style="margin-top:12px"><div style="font-size:34px">🗓️</div><b>На цей день усе зайнято</b>
      <p class="small muted">Оберіть інший день або попросіть повідомити, якщо хтось скасує запис.</p>
      <button class="btn ghost" id="wait">🔔 Повідомити, якщо звільниться</button></div>`;
    $("#wait").onclick = async () => {
      if (!token()) return toast("Спершу запишіться хоча б раз — тоді зможемо повідомляти вас");
      await api("/api/waitlist", { body: { serviceId: book.serviceId, masterId: book.masterId, date: book.date } });
      if (!pushOn()) await enablePush();
      toast("Повідомимо, щойно звільниться місце 💌");
    };
    return;
  }
  const groups = [["Ранок", (t) => t < 720], ["День", (t) => t >= 720 && t < 1020], ["Вечір", (t) => t >= 1020]];
  box.innerHTML = groups.map(([name, f]) => {
    const list = slots.filter((x) => f(x.start));
    return list.length ? `<h3 style="margin-top:16px">${name}</h3><div class="times">${list.map((x) => `<div class="time" data-start="${x.start}" data-time="${x.time}">${x.time}</div>`).join("")}</div>` : "";
  }).join("");
  box.querySelectorAll(".time").forEach((el) => (el.onclick = () => {
    book.start = Number(el.dataset.start);
    book.time = el.dataset.time;
    goStep(4);
  }));
}

async function renderConfirm(back) {
  header("Підтвердження", back);
  const s = svc();
  const me = await loadMe();
  const st = info.settings;
  const master = info.masters.find((m) => m.id === book.masterId);
  const dateLbl = new Date(book.date + "T12:00").toLocaleDateString("uk-UA", { weekday: "long", day: "numeric", month: "long" });
  view.innerHTML = stepsBar() + `
    <div class="card">
      <h3>${esc(s.name)}</h3>
      <div>📅 <b>${esc(dateLbl)}</b> о <b>${book.time}</b></div>
      <div class="muted small">⏱ ${dur(s.duration)}${master ? ` · майстер ${esc(master.name)}` : ""}</div>
      <div class="muted small">📍 ${esc(st.address)}${st.cabinet ? ", " + esc(st.cabinet) : ""}</div>
    </div>
    <div class="card">
      <label class="f"><span>Ваше імʼя</span><input id="name" autocomplete="name" value="${esc(me?.name || store.get("name") || "")}" placeholder="Олена"></label>
      <label class="f"><span>Телефон</span><input id="phone" type="tel" autocomplete="tel" inputmode="tel" value="${esc(me?.phone || store.get("phone") || "+380")}"></label>
      <label class="f"><span>Побажання (необовʼязково)</span><textarea id="comment" placeholder="Напр.: хочу нюдовий відтінок"></textarea></label>
    </div>
    <div class="card"><div class="sum" id="sum"><div class="spinner"></div></div></div>
    <p class="small muted" style="margin-top:12px">${esc(st.rules)} Безкоштовне скасування — не пізніше ніж за ${st.cancelHours} год.</p>
    <div id="err" class="err"></div>
    <button class="btn block big" id="go" style="margin-top:8px">Записатись</button>
  `;
  let q = null;
  const refresh = async () => {
    q = await api("/api/quote", { body: { serviceId: book.serviceId, addons: book.addons, date: book.date, useBonus: $("#useBonus")?.checked, ref: store.get("ref") } });
    $("#sum").innerHTML = `
      <div>Вартість${svc().priceFrom ? " (від)" : ""}</div><div>${money(q.price)}</div>
      ${q.discount ? `<div>${esc(q.discountReason)}</div><div style="color:var(--ok)">−${money(q.discount)}</div>` : ""}
      ${q.bonusUse ? `<div>Бонусами</div><div style="color:var(--ok)">−${money(q.bonusUse)}</div>` : ""}
      <div class="tot">До сплати</div><div class="tot">${money(q.total)}</div>
      ${q.prepay ? `<div class="tot" style="color:var(--accent)">Передоплата зараз</div><div class="tot" style="color:var(--accent)">${money(q.prepay)}</div>` : ""}`;
    if (svc().priceFrom) $("#sum").insertAdjacentHTML("beforeend", `<div class="small muted" style="grid-column:1/-1">Остаточна ціна залежить від довжини й дизайну — майстер уточнить на місці.</div>`);
    if (q.prepayMode === "ask") $("#sum").insertAdjacentHTML("beforeend", `<div class="small" style="grid-column:1/-1;margin-top:6px">✨ Ви в нас уперше — майстер підтвердить запис найближчим часом. Можливо, попросить передоплату ${money(q.prepayAmount)}, щоб закріпити час. Постійні клієнтки записуються без передоплати.</div>`);
    $("#go").textContent = q.prepay ? `Записатись і сплатити ${money(q.prepay)}` : q.prepayMode === "ask" ? "Надіслати заявку" : "Записатись";
  };
  $("#useBonus")?.addEventListener("change", refresh);
  refresh();
  $("#go").onclick = async () => {
    const btn = $("#go");
    btn.disabled = true;
    $("#err").textContent = "";
    try {
      const name = $("#name").value.trim();
      const phone = $("#phone").value.trim();
      store.set("name", name);
      store.set("phone", phone);
      const r = await api("/api/book", {
        body: { serviceId: book.serviceId, addons: book.addons, masterId: book.masterId, date: book.date, start: book.start, name, phone, comment: $("#comment").value, useBonus: $("#useBonus")?.checked, ref: store.get("ref"), src: store.get("src") },
      });
      store.set("token", r.token);
      store.set("ref", null);
      meCache = null;
      book.serviceId = null;
      book.step = 1;
      if (r.payUrl) return (location.href = r.payUrl);
      if (r.demoPay) return demoPay(r.booking);
      if (r.payError) toast(r.payError, 5000);
      location.hash = `#/done/${r.booking.id}`;
    } catch (e) {
      $("#err").textContent = e.message;
      btn.disabled = false;
      if (/зайняли/.test(e.message)) setTimeout(() => goStep(3), 1500);
    }
  };
}

function demoPay(b) {
  sheet(`<div class="center"><div style="font-size:44px">💳</div><h2>Передоплата ${money(b.prepay)}</h2>
    <p class="muted small">Тестовий режим: справжня оплата увімкнеться, щойно салон підключить LiqPay. Зараз гроші не списуються.</p></div>
    <button class="btn block big" id="dp">Сплатити (тест)</button>
    <button class="btn line block" style="margin-top:8px" id="later">Пізніше</button>`, (el, close) => {
    $("#dp", el).onclick = async () => {
      await api(`/api/bookings/${b.id}/demo-pay`, { body: {} });
      close();
      location.hash = `#/done/${b.id}`;
    };
    $("#later", el).onclick = () => {
      close();
      location.hash = "#/me";
    };
  });
}

// Повернення зі сторінки оплати (LiqPay / monobank)
async function paid(id) {
  header("Оплата");
  view.innerHTML = '<div class="spinner"></div><p class="center muted">Перевіряємо оплату…</p>';
  for (let i = 0; i < 8; i++) {
    try {
      const { booking } = await api(`/api/bookings/${id}/status`);
      if (booking.paid || booking.status === "confirmed") return (location.hash = `#/done/${id}`);
    } catch {}
    await new Promise((r) => setTimeout(r, 2000));
  }
  view.innerHTML = `<div class="card center"><div style="font-size:40px">⏳</div><h3>Оплата ще обробляється</h3><p class="muted">Щойно банк підтвердить — запис зʼявиться в «Мої записи». Якщо оплата не пройшла, її можна повторити там же.</p><a class="btn" href="#/me">Мої записи</a></div>`;
}

async function done(id) {
  setTab("book");
  header("Готово!");
  const me = await loadMe(true);
  const b = me?.bookings.find((x) => x.id === Number(id));
  if (!b) return (location.hash = "#/me");
  const isReq = b.status === "request";
  view.innerHTML = `
    <div class="center" style="padding:20px 0 6px"><div style="font-size:56px">${isReq ? "📩" : "🎉"}</div><h1>${isReq ? "Заявку надіслано!" : "Ви записані!"}</h1>
      <p class="muted">${esc(b.service)}<br><b style="color:var(--ink)">${esc(b.when)}</b></p>
      ${isReq ? `<p class="small">Час уже заброньовано за вами. Майстер підтвердить запис найближчим часом — ми одразу повідомимо.</p>` : ""}
      ${b.paid ? `<span class="badge ok">Передоплата ${money(b.paid)} отримана</span>` : ""}</div>
    <div class="card stack">
      ${pushOn() ? `<div class="row"><span style="font-size:24px">🔔</span><div>${isReq ? "Повідомимо, щойно майстер підтвердить запис, а потім нагадаємо перед візитом." : "Нагадаємо за добу і за 2 години до візиту, а перед виходом відкриємо карту."}</div></div>`
        : `<div><b>Увімкніть сповіщення</b><p class="small muted">${isReq ? "Так ви одразу дізнаєтесь, що запис підтверджено, і отримаєте нагадування перед візитом." : "Надішлемо сповіщення за добу і за 2 години, а натиснувши на нього — побачите карту, як дійти до кабінету."}</p><button class="btn block" id="push">🔔 Увімкнути сповіщення</button></div>`}
      ${me.viber?.link && !me.viber.linked ? `<a class="btn block" style="background:#7360f2;color:#fff" href="${esc(me.viber.link)}">💜 Нагадування у Viber</a>` : ""}
      <a class="btn line block" href="/api/bookings/${b.id}/ics?token=${encodeURIComponent(token())}">📅 Додати в календар</a>
      <a class="btn line block" href="#/visit/${b.id}">🧭 Як нас знайти</a>
    </div>
    <a class="btn block" style="margin-top:14px" href="#/">На головну</a>`;
  $("#push")?.addEventListener("click", async () => (await enablePush()) && done(id));
}

// ================= Роботи та сертифікати =================
function works(q) {
  setTab("works");
  header("Роботи");
  const tab = q.get("tab") || "work";
  const kinds = [["work", "Роботи"], ["cert", "Сертифікати"], ["salon", "Кабінет"]].filter(([k]) => k === "work" || info.gallery.some((g) => g.kind === k));
  const list = info.gallery.filter((g) => g.kind === tab);
  view.innerHTML = `
    ${kinds.length > 1 ? `<div class="tabs">${kinds.map(([k, n]) => `<button class="${k === tab ? "on" : ""}" data-k="${k}">${n}</button>`).join("")}</div>` : ""}
    ${list.length ? `<div class="grid ${tab === "cert" ? "certs" : ""}">${list.map((g, i) => `<div class="ph" data-i="${i}">${media(g.file, g.caption)}${g.caption ? `<div class="cap">${esc(g.caption)}</div>` : ""}</div>`).join("")}</div>`
      : `<div class="empty"><div class="ic">🖼️</div>Скоро тут зʼявляться фото</div>`}
    ${info.settings.instagram ? `<a class="btn line block" style="margin-top:16px" target="_blank" rel="noopener" href="https://instagram.com/${esc(info.settings.instagram.replace(/^@/, ""))}">📸 Ще більше робіт в Instagram @${esc(info.settings.instagram.replace(/^@/, ""))}</a>` : ""}
    <a class="btn block big" style="margin-top:10px" href="#/book">Хочу так само — записатись</a>`;
  view.querySelectorAll(".tabs button").forEach((b) => (b.onclick = () => (location.hash = `#/works?tab=${b.dataset.k}`)));
  view.querySelectorAll(".ph").forEach((el) => (el.onclick = () => lightbox(list, Number(el.dataset.i))));
}

function lightbox(list, i) {
  const lb = document.createElement("div");
  lb.className = "lightbox";
  const show = () => (lb.innerHTML = `<div>${isVideo(list[i].file) ? `<video src="${img(list[i].file)}" muted loop playsinline autoplay controls></video>` : `<img src="${img(list[i].file)}" alt="">`}<div class="cap">${esc(list[i].caption)}</div><div class="cap small" style="opacity:.6">${i + 1} / ${list.length} · торкніться, щоб закрити</div></div>`);
  show();
  let x0 = null;
  lb.addEventListener("touchstart", (e) => (x0 = e.touches[0].clientX), { passive: true });
  lb.addEventListener("touchend", (e) => {
    const dx = e.changedTouches[0].clientX - x0;
    if (Math.abs(dx) > 50) {
      i = (i + (dx < 0 ? 1 : -1) + list.length) % list.length;
      show();
      x0 = "swiped";
    }
  });
  lb.addEventListener("click", () => (x0 === "swiped" ? (x0 = null) : lb.remove()));
  document.body.append(lb);
}

// ================= Відгуки =================
function reviews() {
  setTab("home");
  header("Відгуки", true);
  const r = info.rating;
  const shots = info.gallery.filter((g) => g.kind === "review");
  setTimeout(() => view.querySelectorAll(".grid .ph").forEach((el) => (el.onclick = () => lightbox(shots, Number(el.dataset.i)))));
  view.innerHTML = `
    ${r.count ? `<div class="card center"><div class="dist">${r.avg}</div><div class="stars" style="font-size:22px">${stars(r.avg)}</div><div class="muted small">${r.count} відгуків</div></div>` : ""}
    <div class="stack" style="margin-top:14px">${info.reviews.map(reviewCard).join("")}</div>
    ${shots.length ? `<h3 style="margin-top:18px">Що пишуть клієнтки в Instagram</h3><div class="grid shots">${shots.map((g, i) => `<div class="ph" data-i="${i}">${media(g.file, g.caption)}${g.caption ? `<div class="cap">${esc(g.caption)}</div>` : ""}</div>`).join("")}</div>` : ""}
    ${!info.reviews.length && !shots.length ? `<div class="empty"><div class="ic">💬</div>Поки що немає відгуків. Будьте першою!</div>` : ""}
    <p class="small muted center" style="margin-top:16px">Залишити відгук можна після візиту в розділі «Мої».</p>`;
}

function reviewForm(id) {
  let rating = 5;
  sheet(`<h2 class="center">Як вам візит?</h2>
    <div class="rate" id="rate">${[1, 2, 3, 4, 5].map((n) => `<button data-n="${n}" class="on">★</button>`).join("")}</div>
    <label class="f"><span>Кілька слів (необовʼязково)</span><textarea id="rtext" placeholder="Що сподобалося?"></textarea></label>
    <button class="btn block big" id="rsend" style="margin-top:14px">Надіслати</button>`, (el, close) => {
    el.querySelectorAll("#rate button").forEach((b) => (b.onclick = () => {
      rating = Number(b.dataset.n);
      el.querySelectorAll("#rate button").forEach((x) => x.classList.toggle("on", Number(x.dataset.n) <= rating));
    }));
    $("#rsend", el).onclick = async () => {
      try {
        await api("/api/reviews", { body: { bookingId: Number(id), rating, text: $("#rtext", el).value } });
        close();
        meCache = null;
        toast("Дякуємо за відгук! 💖 Він зʼявиться після перевірки.");
        if (location.hash.startsWith("#/me")) me();
      } catch (e) {
        toast(e.message);
      }
    };
  });
}

// ================= Мій кабінет =================
let qrLib = null;
async function qrSvg(text) {
  if (!qrLib) {
    await new Promise((res, rej) => {
      const s = document.createElement("script");
      s.src = "/vendor/qrcode.js";
      s.onload = res;
      s.onerror = rej;
      document.head.append(s);
    });
    qrLib = window.qrcode;
  }
  const q = qrLib(0, "M");
  q.addData(text);
  q.make();
  return q.createSvgTag({ cellSize: 4, margin: 0, scalable: true });
}

async function me() {
  setTab("me");
  header("Мій кабінет");
  const m = await loadMe(true);
  if (!m) {
    view.innerHTML = `<div class="empty"><div class="ic">💅</div><h2>Тут будуть ваші записи</h2><p>Запишіться вперше — і застосунок запамʼятає вас: записи, бонуси й нагадування будуть тут.</p><a class="btn big" href="#/book">Записатись</a></div>`;
    return;
  }
  const s = info.settings;
  const upcoming = m.bookings.filter((b) => ["confirmed", "pending", "request"].includes(b.status) && b.startUtc > Date.now() - 3600_000).reverse();
  const past = m.bookings.filter((b) => !upcoming.includes(b));
  view.innerHTML = `
    <h2 style="margin-top:6px">Вітаємо, ${esc(m.name.split(" ")[0])} 💛</h2>

    ${m.viber?.link ? (m.viber.linked
      ? `<div class="card row" style="margin-top:14px"><span style="font-size:26px">💜</span><div class="grow"><b>Нагадування у Viber увімкнені</b><div class="small muted">Напередодні візиту напишемо вам у Viber</div></div></div>`
      : `<a class="card row" href="${esc(m.viber.link)}" style="margin-top:14px;text-decoration:none;color:inherit"><span style="font-size:26px">💜</span><div class="grow"><b>Нагадування у Viber</b><div class="small muted">Натисніть і в боті «Отримувати нагадування»</div></div><b style="color:var(--accent)">→</b></a>`) : ""}
    ${pushOn() ? "" : `<div class="card row" style="margin-top:14px"><span style="font-size:26px">🔔</span><div class="grow"><b>Нагадування вимкнені</b><div class="small muted">Увімкніть, щоб не пропустити запис</div></div><button class="btn sm" id="push">Увімкнути</button></div>`}

    <section class="section">
      <h2>Мої записи</h2>
      ${upcoming.length ? upcoming.map((b) => `
        <div class="card">
          <div class="row between"><b>${esc(b.service)}</b>${statusBadge(b.status)}</div>
          <div class="muted">${esc(b.when)}</div>
          ${b.paid ? `<div class="small" style="color:var(--ok)">Передоплата ${money(b.paid)} ✓</div>` : ""}
          ${b.status === "request" ? `<div class="small muted">Майстер підтвердить запис найближчим часом</div>` : ""}
          ${b.status === "pending" && b.payUntil ? `<div class="small" style="color:var(--warn);font-weight:700">Сплатіть передоплату до ${new Date(b.payUntil).toLocaleString("uk-UA", { timeZone: "Europe/Kyiv", day: "numeric", month: "long", hour: "2-digit", minute: "2-digit" })}, щоб закріпити час</div>` : ""}
          <div class="row wrap" style="margin-top:10px">
            ${b.status === "pending" ? `<button class="btn sm" data-pay="${b.id}">Сплатити ${money(b.prepay)}</button>` : `<a class="btn sm" href="#/visit/${b.id}">🧭 Маршрут</a>`}
            <a class="btn sm ghost" href="/api/bookings/${b.id}/ics?token=${encodeURIComponent(token())}">📅</a>
            <button class="btn sm line" data-cancel="${b.id}">Скасувати</button>
          </div>
        </div>`).join("") : `<div class="card center"><p class="muted">Немає майбутніх записів</p><a class="btn" href="#/book">Записатись</a></div>`}
    </section>

    <a class="card row" href="#/gift" style="margin-top:14px;text-decoration:none;color:inherit"><span style="font-size:28px">🎁</span><div class="grow"><b>Подарунковий сертифікат</b><div class="small muted">Подаруйте красу близькій людині</div></div><b style="color:var(--accent)">→</b></a>

    ${past.length ? `<section class="section"><h2>Історія</h2>${past.map((b) => `
      <div class="card">
        <div class="row between"><b>${esc(b.service)}</b>${statusBadge(b.status)}</div>
        <div class="muted small">${esc(b.when)}</div>
        <div class="row wrap" style="margin-top:8px">
          <a class="btn sm ghost" href="#/book?service=${b.serviceId}&master=${b.masterId}">🔁 Записатись знову</a>
          ${b.status === "done" && !b.reviewed ? `<button class="btn sm line" data-review="${b.id}">⭐ Відгук</button>` : ""}
        </div>
      </div>`).join("")}</section>` : ""}

    <section class="section card">
      <h3>Мої дані</h3>
      <label class="f"><span>Імʼя</span><input id="pname" value="${esc(m.name)}"></label>
      <label class="f"><span>Телефон</span><input value="${esc(m.phone)}" disabled></label>
      <button class="btn ghost block" style="margin-top:12px" id="psave">Зберегти</button>
    </section>

  `;
  $("#push")?.addEventListener("click", async () => (await enablePush()) && me());
  $("#psave").onclick = async () => {
    try {
      await api("/api/me", { body: { name: $("#pname").value, birthday: ($("#pbd")?.value || "") } });
      toast("Збережено");
      me();
    } catch (e) {
      toast(e.message);
    }
  };
  view.querySelectorAll("[data-review]").forEach((b) => (b.onclick = () => reviewForm(b.dataset.review)));
  view.querySelectorAll("[data-pay]").forEach((b) => (b.onclick = async () => {
    const id = b.dataset.pay;
    try {
      const r = await api(`/api/bookings/${id}/pay`, { body: {} });
      if (r.payUrl) location.href = r.payUrl;
      else if (r.demoPay) demoPay(m.bookings.find((x) => x.id === Number(id)));
    } catch (e) {
      toast(e.message);
    }
  }));
  view.querySelectorAll("[data-cancel]").forEach((b) => (b.onclick = () => {
    sheet(`<h2>Скасувати запис?</h2><p class="muted">Час звільниться для інших. ${s.cancelHours ? `Передоплата повертається, якщо до візиту більше ${s.cancelHours} год.` : ""}</p>
      <button class="btn block" id="yes" style="background:var(--bad)">Так, скасувати</button><button class="btn line block" style="margin-top:8px" id="no">Ні, залишити</button>`, (el, close) => {
      $("#no", el).onclick = close;
      $("#yes", el).onclick = async () => {
        try {
          const r = await api(`/api/bookings/${b.dataset.cancel}/cancel`, { body: {} });
          close();
          toast(r.refunded ? "Скасовано. Гроші повернуться на картку протягом 1–3 днів." : "Запис скасовано");
          me();
        } catch (e) {
          close();
          toast(e.message, 5000);
        }
      };
    });
  }));
}

// ================= Карта і маршрут до кабінету =================
let leafletReady = null;
function loadLeaflet() {
  if (leafletReady) return leafletReady;
  leafletReady = new Promise((res, rej) => {
    const css = document.createElement("link");
    css.rel = "stylesheet";
    css.href = "/vendor/leaflet.css";
    document.head.append(css);
    const s = document.createElement("script");
    s.src = "/vendor/leaflet.js";
    s.onload = () => res(window.L);
    s.onerror = rej;
    document.head.append(s);
  });
  return leafletReady;
}

function distance(a, b) {
  const R = 6371e3;
  const r = (x) => (x * Math.PI) / 180;
  const dLat = r(b.lat - a.lat);
  const dLng = r(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(r(a.lat)) * Math.cos(r(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

let geoWatch = null;
async function visit(id) {
  setTab(id ? "me" : "home");
  header(id ? "Ваш візит" : "Як нас знайти", true);
  const s = info.settings;
  let b = null;
  if (id) {
    const m = await loadMe();
    b = m?.bookings.find((x) => x.id === Number(id));
  }
  const dest = { lat: Number(s.lat), lng: Number(s.lng) };
  const steps = info.gallery.filter((g) => g.kind === "route");
  // Поки майстер не поставила точку на карті — ведемо за адресою.
  const hasPin = Boolean(dest.lat && dest.lng);
  const fullAddr = [s.address, s.city].filter(Boolean).join(", ");
  const target = hasPin ? `${dest.lat},${dest.lng}` : encodeURIComponent(fullAddr);
  const gmaps = (mode) => `https://www.google.com/maps/dir/?api=1&destination=${target}&travelmode=${mode}`;
  const apple = `https://maps.apple.com/?daddr=${target}&dirflg=w`;
  view.innerHTML = `
    ${b ? `<div class="card visit-card"><div class="row between"><b>${esc(b.service)}</b>${statusBadge(b.status)}</div><div class="muted">${esc(b.when)}</div><div id="countdown" class="small" style="margin-top:4px;color:var(--accent);font-weight:700"></div></div>` : ""}
    <div class="card" style="margin-top:14px;padding:0;overflow:hidden"><div id="map"></div>
      <div style="padding:14px"><div class="row between"><div><b>${esc(s.address)}</b><div class="small muted">${esc(s.cabinet)}</div></div><div class="center"><div class="dist" id="dist">—</div><div class="small muted" id="eta"></div></div></div></div>
    </div>
    <div class="row" style="margin-top:12px">
      <a class="btn grow" target="_blank" rel="noopener" href="${isIOS() ? apple : gmaps("walking")}">🚶 Вести пішки</a>
      <a class="btn ghost grow" target="_blank" rel="noopener" href="${gmaps("driving")}">🚗 Авто</a>
    </div>
    <section class="section card">
      <h3>Як знайти кабінет</h3>
      <p>${esc(s.howToFind)}</p>
      ${steps.length ? `<div class="stack" style="margin-top:14px">${steps.map((g, i) => `<div class="route-step"><div class="n">${i + 1}</div><div class="grow">${esc(g.caption)}<img loading="lazy" src="${img(g.file)}" alt=""></div></div>`).join("")}</div>` : ""}
      <a class="btn line block" style="margin-top:14px" href="tel:${esc(s.phone)}">📞 Не можу знайти — подзвонити</a>
    </section>`;

  if (b) {
    const cd = () => {
      const el = $("#countdown");
      if (!el) return clearInterval(t);
      const mins = Math.round((b.startUtc - Date.now()) / 60000);
      el.textContent = mins > 0 ? (mins >= 60 ? `Через ${Math.floor(mins / 60)} год ${mins % 60} хв` : `Через ${mins} хв`) : mins > -b.duration ? "Зараз ваш час 💖" : "";
    };
    const t = setInterval(cd, 30000);
    cd();
  }

  if (!hasPin) {
    $("#map").innerHTML = `<iframe title="Карта" src="https://www.google.com/maps?q=${encodeURIComponent(fullAddr)}&z=16&output=embed" style="width:100%;height:100%;border:0" loading="lazy"></iframe>`;
    $("#dist").parentElement.remove();
    return;
  }
  try {
    const L = await loadLeaflet();
    const map = L.map("map", { zoomControl: false, attributionControl: true }).setView([dest.lat, dest.lng], 16);
    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 19, attribution: "© OpenStreetMap" }).addTo(map);
    const pin = L.divIcon({ className: "", html: '<div style="font-size:34px;transform:translate(-50%,-100%)">📍</div>', iconSize: [0, 0] });
    L.marker([dest.lat, dest.lng], { icon: pin }).addTo(map).bindPopup(`<b>${esc(s.name)}</b><br>${esc(s.cabinet)}`);
    let meMarker = null;
    let fitted = false;
    if (navigator.geolocation) {
      if (geoWatch) navigator.geolocation.clearWatch(geoWatch);
      geoWatch = navigator.geolocation.watchPosition(
        (pos) => {
          if (!document.getElementById("map")) return navigator.geolocation.clearWatch(geoWatch);
          const p = { lat: pos.coords.latitude, lng: pos.coords.longitude };
          if (!meMarker) meMarker = L.circleMarker([p.lat, p.lng], { radius: 8, color: "#fff", weight: 3, fillColor: "#3b82f6", fillOpacity: 1 }).addTo(map);
          else meMarker.setLatLng([p.lat, p.lng]);
          const d = distance(p, dest);
          $("#dist").textContent = d < 1000 ? `${Math.round(d)} м` : `${(d / 1000).toFixed(1)} км`;
          $("#eta").textContent = d < 60 ? "ви на місці!" : d < 4000 ? `~${Math.max(1, Math.round(d / 80))} хв пішки` : `~${Math.max(1, Math.round(d / 400))} хв авто`;
          if (!fitted && d < 30000) {
            map.fitBounds([[p.lat, p.lng], [dest.lat, dest.lng]], { padding: [40, 40], maxZoom: 17 });
            fitted = true;
          }
        },
        () => ($("#eta").textContent = "увімкніть геолокацію"),
        { enableHighAccuracy: true, maximumAge: 10000 }
      );
    }
  } catch {
    $("#map").innerHTML = '<div class="empty">Карта недоступна без інтернету</div>';
  }
}

// ================= Подарункові сертифікати =================
function giftBuy() {
  setTab("home");
  header("Подарунковий сертифікат", true);
  const s = info.settings;
  if (!s.onlinePay) return giftOrder(s);
  const amounts = String(s.giftAmounts || "").split(/[,\s]+/).map(Number).filter((n) => n >= 200);
  let amount = amounts[1] || amounts[0] || 1000;
  view.innerHTML = `
    <div class="gift-card"><div class="gift-top">Подарунковий сертифікат</div><div class="gift-name">${esc(s.name)}</div>
      <div class="gift-sum" id="gsum">${money(amount)}</div><div class="gift-sub">манікюр · педикюр · догляд</div></div>
    <div class="card" style="margin-top:14px">
      <b>Сума</b>
      <div class="chips" id="chips">${amounts.map((a) => `<button class="chip ${a === amount ? "on" : ""}" data-a="${a}">${money(a)}</button>`).join("")}<button class="chip" data-a="other">Інша</button></div>
      <label class="f hidden" id="otherWrap"><span>Своя сума, грн (від 200)</span><input id="other" type="number" inputmode="numeric" min="200" step="50"></label>
      <p class="small muted" style="margin-top:8px">Сертифікатом можна оплатити будь-які послуги. Діє ${s.giftMonths || 6} міс. з дня покупки.</p>
    </div>
    <div class="card">
      <label class="f" style="margin-top:0"><span>Для кого (імʼя на сертифікаті)</span><input id="grec" placeholder="Для мами"></label>
      <label class="f"><span>Побажання (необовʼязково)</span><textarea id="gmsg" maxlength="300" placeholder="З днем народження! Нехай кожен день буде красивим 💛"></textarea></label>
      <label class="f"><span>Ваше імʼя</span><input id="gname" autocomplete="name" value="${esc(store.get("name") || "")}"></label>
      <label class="f"><span>Ваш телефон</span><input id="gphone" type="tel" inputmode="tel" value="${esc(store.get("phone") || "+380")}"></label>
    </div>
    <div class="err" id="gerr"></div>
    <button class="btn block big" id="gbuy" style="margin-top:12px">Оплатити ${money(amount)}</button>`;
  const setAmount = (a) => {
    amount = a;
    $("#gsum").textContent = money(a || 0);
    $("#gbuy").textContent = `Оплатити ${money(a || 0)}`;
  };
  view.querySelectorAll(".chip").forEach((c) => (c.onclick = () => {
    view.querySelectorAll(".chip").forEach((x) => x.classList.toggle("on", x === c));
    const other = c.dataset.a === "other";
    $("#otherWrap").classList.toggle("hidden", !other);
    if (other) $("#other").focus();
    else setAmount(Number(c.dataset.a));
  }));
  $("#other").oninput = (e) => setAmount(Number(e.target.value) || 0);
  $("#gbuy").onclick = async () => {
    $("#gerr").textContent = "";
    $("#gbuy").disabled = true;
    try {
      const r = await api("/api/gifts", { body: { amount, recipient: $("#grec").value, message: $("#gmsg").value, name: $("#gname").value, phone: $("#gphone").value } });
      store.set("name", $("#gname").value);
      store.set("phone", $("#gphone").value);
      const mine = JSON.parse(store.get("gifts") || "[]");
      store.set("gifts", JSON.stringify([r.code, ...mine].slice(0, 20)));
      if (r.payUrl) return (location.href = r.payUrl);
      sheet(`<div class="center"><div style="font-size:44px">💳</div><h2>Оплата ${money(amount)}</h2>
        <p class="muted small">Тестовий режим: справжня оплата увімкнеться, щойно салон підключить LiqPay. Зараз гроші не списуються.</p></div>
        <button class="btn block big" id="gdp">Сплатити (тест)</button>`, (el, close) => {
        $("#gdp", el).onclick = async () => {
          await api(`/api/gifts/${r.code}/demo-pay`, { body: {} });
          close();
          location.hash = `#/gift/${r.code}`;
        };
      });
    } catch (e) {
      $("#gerr").textContent = e.message;
    } finally {
      $("#gbuy").disabled = false;
    }
  };
}

// Поки онлайн-оплата вимкнена: сертифікат замовляють у майстра, а вона надсилає листівку
function giftOrder(s) {
  const amounts = String(s.giftAmounts || "").split(/[,\s]+/).map(Number).filter((n) => n >= 200);
  const text = encodeURIComponent("Добрий день! Хочу замовити подарунковий сертифікат");
  const num = s.phone.replace(/[^\d+]/g, "");
  view.innerHTML = `
    <div class="gift-card"><div class="gift-top">Подарунковий сертифікат</div><div class="gift-name">${esc(s.name)}</div>
      <div class="gift-sum">${amounts.length ? `від ${money(Math.min(...amounts))}` : "🎁"}</div><div class="gift-sub">манікюр · педикюр · догляд</div></div>
    <div class="card stack" style="margin-top:14px">
      <p>Найкращий подарунок — краса й турбота. Сертифікат можна використати на будь-які послуги протягом ${s.giftMonths || 6} міс.</p>
      ${amounts.length ? `<div class="chips">${amounts.map((a) => `<span class="chip">${money(a)}</span>`).join("")}<span class="chip">або своя сума</span></div>` : ""}
      <p class="small muted">Напишіть або зателефонуйте майстру — оберемо суму, а гарну листівку з кодом надішлемо вам у телефон, щоб ви переслали її отримувачці.</p>
      ${s.viber ? `<a class="btn block" href="viber://chat?number=${esc(num.replace("+", "%2B"))}&draft=${text}">Замовити у Viber</a>` : ""}
      ${s.telegram ? `<a class="btn ghost block" target="_blank" rel="noopener" href="${esc(tgLink(s.telegram))}">Замовити в Telegram</a>` : ""}
      <a class="btn line block" href="tel:${esc(s.phone)}">📞 Подзвонити</a>
    </div>`;
}

async function giftView(code) {
  setTab("home");
  header("Ваш сертифікат", () => (location.hash = "#/"));
  const s = info.settings;
  let g = null;
  for (let i = 0; i < 6; i++) {
    g = await api(`/api/gifts/${encodeURIComponent(code)}`);
    if (g.status !== "pending") break;
    view.innerHTML = '<div class="spinner"></div><p class="center muted">Перевіряємо оплату…</p>';
    await new Promise((r) => setTimeout(r, 2000));
  }
  if (g.status === "pending") {
    view.innerHTML = `<div class="card center"><div style="font-size:40px">⏳</div><h3>Оплата ще обробляється</h3><p class="muted">Оновіть сторінку за хвилину. Якщо оплата не пройшла — спробуйте купити сертифікат ще раз.</p><button class="btn" onclick="location.reload()">Оновити</button></div>`;
    return;
  }
  const until = g.expiresAt ? new Date(g.expiresAt).toLocaleDateString("uk-UA", { day: "numeric", month: "long", year: "numeric" }) : "";
  const label = { active: "", used: "Використано", expired: "Термін дії минув" }[g.status] || "";
  const url = `${location.origin}/#/gift/${g.code}`;
  view.innerHTML = `
    <div class="gift-card big">
      <div class="gift-top">Подарунковий сертифікат</div>
      <div class="gift-name">${esc(s.name)}</div>
      ${g.recipient ? `<div class="gift-for">${esc(g.recipient)}</div>` : ""}
      <div class="gift-sum">${money(g.amount)}</div>
      ${g.message ? `<div class="gift-msg">«${esc(g.message)}»</div>` : ""}
      <div class="gift-from">від ${esc(g.from)}</div>
      <div class="gift-code">${esc(g.code)}</div>
      <div class="gift-sub">${until ? `Діє до ${until}` : ""}${label ? ` · ${label}` : ""}</div>
      <div class="gift-sub">📍 ${esc(s.address)} · ☎ ${esc(s.phone)}</div>
    </div>
    ${g.status === "active" && g.balance < g.amount ? `<p class="center" style="margin-top:10px">Залишок: <b>${money(g.balance)}</b></p>` : ""}
    <div class="card stack" style="margin-top:14px">
      <button class="btn block" id="gshare">💌 Надіслати отримувачці</button>
      <p class="small muted">Або зробіть скріншот листівки. Щоб скористатися — запишіться і назвіть майстру код сертифіката.</p>
      <a class="btn line block" href="#/book">Записатись</a>
    </div>`;
  $("#gshare").onclick = async () => {
    const text = `${g.recipient ? g.recipient + ", для тебе" : "Для тебе"} подарунковий сертифікат «${s.name}» на ${money(g.amount)} 💛 Код: ${g.code}`;
    if (navigator.share) {
      try {
        await navigator.share({ title: "Подарунковий сертифікат", text, url });
      } catch {}
    } else {
      await navigator.clipboard?.writeText(`${text}\n${url}`);
      toast("Посилання скопійовано");
    }
  };
}

// ================= Роутер =================
const routes = [
  [/^\/?$/, home],
  [/^\/price$/, price],
  [/^\/book$/, (m, q) => bookStart(q)],
  [/^\/works$/, (m, q) => works(q)],
  [/^\/reviews$/, reviews],
  [/^\/me$/, me],
  [/^\/map$/, () => visit(null)],
  [/^\/gift$/, giftBuy],
  [/^\/gift\/([A-Za-z0-9-]+)$/, (m) => giftView(m[1])],
  [/^\/visit\/(\d+)$/, (m) => visit(m[1])],
  [/^\/paid\/(\d+)$/, (m) => paid(m[1])],
  [/^\/done\/(\d+)$/, (m) => done(m[1])],
  [/^\/review\/(\d+)$/, async (m) => {
    await me();
    reviewForm(m[1]);
  }],
];

async function route() {
  const [path, qs] = location.hash.slice(1).split("?");
  const q = new URLSearchParams(qs || "");
  document.querySelectorAll(".sheet-bg,.lightbox").forEach((x) => x.remove());
  for (const [re, fn] of routes) {
    const m = (path || "/").match(re);
    if (m) {
      try {
        await fn(m, q);
      } catch (e) {
        view.innerHTML = `<div class="empty"><div class="ic">😕</div><p>${esc(e.message)}</p><button class="btn" onclick="location.reload()">Оновити</button></div>`;
      }
      if (!path?.startsWith("/book")) scrollTo(0, 0);
      return;
    }
  }
  location.hash = "#/";
}

function applyTheme(t) {
  document.documentElement.dataset.theme = t || "rose";
  store.set("theme", t);
  const bg = getComputedStyle(document.documentElement).getPropertyValue("--bg").trim();
  document.querySelectorAll('meta[name="theme-color"]').forEach((m) => m.setAttribute("content", bg));
}
applyTheme(store.get("theme")); // одразу, щоб не блимало при запуску

async function boot() {
  if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js").catch(() => {});
  try {
    info = await api("/api/public");
    store.set("info", JSON.stringify(info));
  } catch (e) {
    const cached = store.get("info");
    if (!cached) {
      view.innerHTML = `<div class="empty"><div class="ic">📡</div><p>${esc(e.message)}</p><button class="btn" onclick="location.reload()">Спробувати ще</button></div>`;
      return;
    }
    info = JSON.parse(cached);
  }
  // Заголовок вкладки лишаємо той, що дав сервер (для Google), лише якщо його немає — ставимо свій
  if (!document.title || document.title === "Онлайн-запис") document.title = `${info.settings.name} — онлайн-запис`;
  applyTheme(info.settings.theme);
  addEventListener("hashchange", route);
  route();
}
boot();
