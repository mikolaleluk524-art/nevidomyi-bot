// Кабінет майстра: записи, розклад, послуги, фото, відгуки, клієнти, налаштування, QR-постери.
const $ = (s, el = document) => el.querySelector(s);
const view = $("#view");
const top = $("#top");
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const money = (n) => `${Number(n).toLocaleString("uk-UA")} грн`;
const img = (f) => `/uploads/${encodeURIComponent(f)}`;
const WD = ["Нд", "Пн", "Вт", "Ср", "Чт", "Пт", "Сб"];
const WEEK = [1, 2, 3, 4, 5, 6, 0];
const today = () => new Date().toLocaleDateString("sv-SE", { timeZone: "Europe/Kyiv" });
const addDays = (d, n) => {
  const t = new Date(d + "T12:00Z");
  t.setUTCDate(t.getUTCDate() + n);
  return t.toISOString().slice(0, 10);
};
const hm = (m) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
const dayLabel = (d) => new Date(d + "T12:00").toLocaleDateString("uk-UA", { weekday: "long", day: "numeric", month: "long" });

const store = {
  get: (k) => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k, v) => { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch {} },
};

async function api(path, opts = {}) {
  const res = await fetch(path, {
    method: opts.method || (opts.body !== undefined ? "POST" : "GET"),
    headers: { "x-admin-token": store.get("adminToken") || "", ...(opts.raw ? { "content-type": opts.type } : { "content-type": "application/json" }) },
    body: opts.raw ? opts.raw : opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && !path.includes("login")) {
    store.set("adminToken", null);
    login();
    throw new Error("Увійдіть знову");
  }
  if (!res.ok) throw new Error(data.error || "Помилка звʼязку");
  return data;
}

function toast(msg, ms = 2600) {
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
}

// ---------- вхід ----------
async function login() {
  top.innerHTML = '<div class="title">Кабінет майстра</div>';
  const st = await api("/api/admin/state");
  view.innerHTML = `<div class="card" style="margin-top:30px">
    <h2>${st.needsSetup ? "Перший вхід" : "Вхід"}</h2>
    <p class="muted small">${st.needsSetup ? "Придумайте пароль для кабінету (від 6 символів). Запамʼятайте його — він знадобиться на інших пристроях." : "Введіть пароль кабінету."}</p>
    <label class="f"><span>Пароль</span><input id="pw" type="password" autocomplete="${st.needsSetup ? "new-password" : "current-password"}"></label>
    <div class="err" id="err"></div>
    <button class="btn block" id="go" style="margin-top:14px">${st.needsSetup ? "Створити і увійти" : "Увійти"}</button></div>`;
  const go = async () => {
    try {
      const r = await api("/api/admin/login", { body: { password: $("#pw").value } });
      store.set("adminToken", r.token);
      boot();
    } catch (e) {
      $("#err").textContent = e.message;
    }
  };
  $("#go").onclick = go;
  $("#pw").onkeydown = (e) => e.key === "Enter" && go();
}

// ---------- каркас ----------
const TABS = [
  ["bookings", "📅 Записи"],
  ["schedule", "🕘 Розклад"],
  ["services", "💅 Послуги"],
  ["photos", "🖼️ Фото"],
  ["reviews", "⭐ Відгуки"],
  ["clients", "👥 Клієнти"],
  ["qr", "🔳 QR-постери"],
  ["settings", "⚙️ Салон"],
];
let services = [];
let masters = [];

function shell(tab) {
  top.innerHTML = `<div class="title">Кабінет майстра</div><a class="btn sm ghost" href="/" target="_blank">Як бачать клієнти ↗</a>`;
  return `<div class="admin-tabs">${TABS.map(([k, n]) => `<button class="${k === tab ? "on" : ""}" data-t="${k}">${n}</button>`).join("")}</div><div id="tab"></div>`;
}

async function route() {
  const tab = location.hash.slice(1) || "bookings";
  view.innerHTML = shell(tab);
  view.querySelectorAll(".admin-tabs button").forEach((b) => (b.onclick = () => (location.hash = b.dataset.t)));
  $(".admin-tabs .on")?.scrollIntoView({ inline: "center", block: "nearest" });
  const box = $("#tab");
  box.innerHTML = '<div class="spinner"></div>';
  try {
    await ({ bookings, schedule, services: servicesTab, photos, reviews, clients, qr, settings }[tab] || bookings)(box);
  } catch (e) {
    box.innerHTML = `<div class="empty">${esc(e.message)}</div>`;
  }
}

// ---------- записи ----------
let curDay = today();
const STATUS = { pending: "очікує оплати", confirmed: "підтверджено", done: "прийшла ✓", cancelled: "скасовано", no_show: "не прийшла" };

async function bookings(box) {
  const [stats, data] = await Promise.all([api("/api/admin/stats"), api(`/api/admin/bookings?from=${addDays(curDay, -3)}&to=${addDays(curDay, 10)}`)]);
  const day = data.bookings.filter((b) => b.date === curDay);
  const blocks = data.blocks.filter((b) => b.date === curDay);
  const count = (d) => data.bookings.filter((b) => b.date === d && ["confirmed", "pending", "done"].includes(b.status)).length;
  const strip = Array.from({ length: 14 }, (_, i) => addDays(curDay, i - 3));
  const items = [...day.map((b) => ({ t: Number(b.time.replace(":", "").slice(0, 2)) * 60 + Number(b.time.slice(3)), b })), ...blocks.map((k) => ({ t: k.start, k }))].sort((a, b) => a.t - b.t);
  box.innerHTML = `
    ${stats.payments === "demo" ? `<div class="card small" style="background:var(--accent-soft)">💳 Оплата працює в <b>тестовому режимі</b>. Щоб приймати справжню передоплату — підключіть monobank-еквайринг (див. «Салон»).</div>` : ""}
    <div class="stats" style="margin-top:10px">
      <div class="stat"><b>${stats.today}</b><span>сьогодні</span></div>
      <div class="stat"><b>${stats.upcoming}</b><span>майбутніх</span></div>
      <div class="stat"><b>${money(stats.monthRevenue)}</b><span>за місяць</span></div>
      <div class="stat"><b>${stats.monthVisits}</b><span>візитів/міс</span></div>
      <div class="stat"><b>${stats.clients}</b><span>клієнток</span></div>
      <div class="stat"><b>+${stats.newClients}</b><span>нових за 30 дн</span></div>
    </div>
    ${stats.pendingReviews ? `<a class="card row" href="#reviews" style="margin-top:10px;text-decoration:none;color:inherit">⭐ <b class="grow">Нові відгуки: ${stats.pendingReviews}</b> →</a>` : ""}
    <div class="days" style="margin-top:14px">${strip.map((d) => {
      const dt = new Date(d + "T12:00");
      const n = count(d);
      return `<div class="day ${d === curDay ? "sel" : ""}" data-d="${d}"><div class="wd">${WD[dt.getDay()]}</div><div class="dn">${dt.getDate()}</div><div class="fr">${n ? n + " зап." : "·"}</div></div>`;
    }).join("")}</div>
    <div class="row between" style="margin:8px 0">
      <h3 style="margin:0">${dayLabel(curDay)}</h3>
      <input type="date" id="pick" value="${curDay}" style="width:auto;padding:6px 8px">
    </div>
    <div class="row"><button class="btn grow" id="add">＋ Записати клієнтку</button><button class="btn ghost" id="close">⛔ Закрити час</button></div>
    <div class="stack" style="margin-top:12px">
      ${items.length ? items.map(({ b, k }) => b ? `
        <div class="card bk ${b.status}">
          <div class="t">${b.time}<small>${b.duration} хв</small></div>
          <div class="grow">
            <b>${esc(b.clientName)}</b> ${b.visits ? `<span class="badge mute">${b.visits} віз.</span>` : '<span class="badge">нова</span>'}
            <div class="small">${esc(b.service)}${masters.length > 1 ? " · " + esc(b.master) : ""}</div>
            <div class="small muted">${money(b.price - b.discount - b.bonusUsed)}${b.paid ? ` · передоплата ${money(b.paid)} ✓` : ""}${b.bonusUsed ? ` · бонуси −${b.bonusUsed}` : ""}${b.discount ? ` · знижка −${b.discount}` : ""} · ${STATUS[b.status]}</div>
            ${b.comment ? `<div class="small" style="margin-top:4px">💬 ${esc(b.comment)}</div>` : ""}
            ${b.clientNote ? `<div class="small muted">📝 ${esc(b.clientNote)}</div>` : ""}
            <div class="row wrap" style="margin-top:8px">
              <a class="btn sm line" href="tel:${esc(b.clientPhone)}">📞</a>
              <a class="btn sm line" href="viber://chat?number=${esc(b.clientPhone.replace("+", "%2B"))}">Viber</a>
              ${["confirmed", "pending"].includes(b.status) ? `
                <button class="btn sm" data-st="done" data-id="${b.id}">✓ Прийшла</button>
                <button class="btn sm ghost" data-st="no_show" data-id="${b.id}">Не прийшла</button>
                <button class="btn sm line" data-st="cancelled" data-id="${b.id}">Скасувати</button>` : ""}
            </div>
          </div>
        </div>` : `
        <div class="card bk blk"><div class="t">${hm(k.start)}<small>до ${hm(Math.min(k.end, 1439))}</small></div><div class="grow"><b>⛔ Закрито</b><div class="small muted">${esc(k.note || "")}</div></div><button class="btn sm line" data-unblock="${k.id}">Відкрити</button></div>`).join("")
        : `<div class="empty"><div class="ic">☕</div>Записів на цей день немає</div>`}
    </div>`;
  box.querySelectorAll(".day").forEach((el) => (el.onclick = () => { curDay = el.dataset.d; route(); }));
  $("#pick").onchange = (e) => { curDay = e.target.value || today(); route(); };
  $("#add").onclick = () => manualBooking();
  $("#close").onclick = () => blockForm(curDay);
  box.querySelectorAll("[data-st]").forEach((b) => (b.onclick = async () => {
    const st = b.dataset.st;
    let body = { status: st };
    if (st === "cancelled") {
      if (!confirm("Скасувати запис? Клієнтка отримає сповіщення, а передоплата повернеться автоматично (якщо вона була через monobank).")) return;
    }
    await api(`/api/admin/bookings/${b.dataset.id}`, { body });
    toast(st === "done" ? "Візит зараховано, бонуси нараховано 💎" : "Готово");
    route();
  }));
  box.querySelectorAll("[data-unblock]").forEach((b) => (b.onclick = async () => {
    await api(`/api/admin/blocks/${b.dataset.unblock}`, { method: "DELETE" });
    route();
  }));
}

function manualBooking() {
  sheet(`<h2>Записати клієнтку</h2><p class="small muted">Для тих, хто записався по телефону чи в Instagram. Передоплата не потрібна.</p>
    <label class="f"><span>Послуга</span><select id="ms">${services.filter((s) => s.active).map((s) => `<option value="${s.id}">${esc(s.name)} · ${s.duration} хв · ${money(s.price)}</option>`).join("")}</select></label>
    ${masters.length > 1 ? `<label class="f"><span>Майстер</span><select id="mm">${masters.map((m) => `<option value="${m.id}">${esc(m.name)}</option>`).join("")}</select></label>` : ""}
    <div class="two"><label class="f"><span>Дата</span><input type="date" id="md" value="${curDay}"></label><label class="f"><span>Час</span><input type="time" id="mt" value="10:00" step="300"></label></div>
    <label class="f"><span>Імʼя</span><input id="mn"></label>
    <label class="f"><span>Телефон</span><input id="mp" type="tel" value="+380"></label>
    <label class="f"><span>Коментар</span><input id="mc"></label>
    <div class="err" id="merr"></div>
    <button class="btn block" style="margin-top:14px" id="msave">Записати</button>`, (el, close) => {
    $("#msave", el).onclick = async () => {
      try {
        await api("/api/admin/bookings", { body: { serviceId: $("#ms", el).value, masterId: $("#mm", el)?.value, date: $("#md", el).value, time: $("#mt", el).value, name: $("#mn", el).value, phone: $("#mp", el).value, comment: $("#mc", el).value } });
        close();
        curDay = $("#md", el).value;
        toast("Записано ✓");
        route();
      } catch (e) {
        $("#merr", el).textContent = e.message;
      }
    };
  });
}

function blockForm(date) {
  sheet(`<h2>Закрити час</h2><p class="small muted">Вихідний, відпустка, перерва чи особисті справи — у цей час клієнтки не зможуть записатися.</p>
    <label class="check"><input type="checkbox" id="ball" checked> Увесь день</label>
    <div class="two"><label class="f"><span>З дати</span><input type="date" id="bd" value="${date}"></label><label class="f"><span>По дату (для відпустки)</span><input type="date" id="bd2"></label></div>
    <div class="two" id="btimes" style="display:none"><label class="f"><span>З</span><input type="time" id="bs" value="13:00"></label><label class="f"><span>До</span><input type="time" id="be" value="14:00"></label></div>
    ${masters.length > 1 ? `<label class="f"><span>Кому</span><select id="bm"><option value="">Увесь салон</option>${masters.map((m) => `<option value="${m.id}">${esc(m.name)}</option>`).join("")}</select></label>` : ""}
    <label class="f"><span>Примітка (бачите лише ви)</span><input id="bn" placeholder="Напр.: відпустка"></label>
    <button class="btn block" style="margin-top:14px" id="bsave">Закрити</button>`, (el, close) => {
    $("#ball", el).onchange = (e) => ($("#btimes", el).style.display = e.target.checked ? "none" : "grid");
    $("#bsave", el).onclick = async () => {
      await api("/api/admin/blocks", { body: { date: $("#bd", el).value, dateTo: $("#bd2", el).value, allDay: $("#ball", el).checked, start: $("#bs", el).value, end: $("#be", el).value, masterId: $("#bm", el)?.value, note: $("#bn", el).value } });
      close();
      toast("Час закрито");
      route();
    };
  });
}

// ---------- розклад ----------
async function schedule(box) {
  masters = await api("/api/admin/masters");
  const blocks = await api("/api/admin/blocks");
  box.innerHTML = `
    <p class="small muted">Робочі години для кожного дня тижня. Клієнтки бачать лише вільні вікна в цих межах.</p>
    ${masters.map((m) => {
      const sch = JSON.parse(m.schedule || "{}");
      const ms = JSON.parse(m.services || "[]");
      return `<div class="card" data-m="${m.id}">
        <div class="row"><div class="avatar" style="margin:0;flex:none;width:52px;height:52px">${m.photo ? `<img src="${img(m.photo)}">` : esc(m.name[0])}</div>
          <div class="grow"><input data-f="name" value="${esc(m.name)}" placeholder="Імʼя"><input data-f="role" value="${esc(m.role)}" placeholder="Напр.: майстер манікюру" style="margin-top:6px"></div></div>
        <label class="f"><span>Фото майстра</span><input type="file" accept="image/*" data-photo></label>
        <label class="f"><span>Про майстра</span><textarea data-f="about">${esc(m.about)}</textarea></label>
        <h3 style="margin-top:14px">Графік</h3>
        ${WEEK.map((d) => `<div class="sched-row"><label class="check" style="margin:0"><input type="checkbox" data-day="${d}" ${sch[d] ? "checked" : ""}> ${WD[d]}</label>
          <input type="time" data-from="${d}" value="${sch[d]?.[0] || "09:00"}" step="900"><input type="time" data-to="${d}" value="${sch[d]?.[1] || "19:00"}" step="900"></div>`).join("")}
        ${masters.length > 1 || services.length ? `<h3 style="margin-top:14px">Послуги майстра</h3><p class="small muted">Нічого не обрано = усі послуги</p>
          ${services.map((s) => `<label class="check" style="margin-top:4px;font-weight:500"><input type="checkbox" data-svc="${s.id}" ${ms.includes(s.id) ? "checked" : ""}> ${esc(s.name)}</label>`).join("")}` : ""}
        <label class="check"><input type="checkbox" data-f="active" ${m.active ? "checked" : ""}> Приймає записи</label>
        <button class="btn block" style="margin-top:12px" data-save>Зберегти</button>
      </div>`;
    }).join("")}
    <button class="btn line block" style="margin-top:12px" id="addm">＋ Додати майстра</button>

    <section class="section"><div class="row between"><h2>Вихідні та відпустки</h2><button class="btn sm" id="addb">＋</button></div>
      <div class="card">${blocks.length ? blocks.map((b) => `<div class="row between" style="padding:6px 0;border-bottom:1px solid var(--line)"><div><b>${dayLabel(b.date)}</b><div class="small muted">${b.start === 0 && b.end >= 1440 ? "увесь день" : hm(b.start) + "–" + hm(Math.min(b.end, 1439))} ${esc(b.note)}</div></div><button class="btn sm line" data-del="${b.id}">✕</button></div>`).join("") : '<p class="muted small">Немає</p>'}</div>
    </section>`;
  box.querySelectorAll("[data-m]").forEach((card) => {
    let photo = masters.find((m) => m.id === Number(card.dataset.m)).photo;
    $("[data-photo]", card).onchange = async (e) => {
      const f = e.target.files[0];
      if (!f) return;
      const r = await upload(f, "master", "", 800);
      photo = r.file;
      toast("Фото завантажено — натисніть «Зберегти»");
    };
    $("[data-save]", card).onclick = async () => {
      const schedule = {};
      card.querySelectorAll("[data-day]").forEach((c) => {
        const d = c.dataset.day;
        if (c.checked) schedule[d] = [$(`[data-from="${d}"]`, card).value, $(`[data-to="${d}"]`, card).value];
      });
      await api("/api/admin/masters", {
        body: {
          id: Number(card.dataset.m),
          name: $('[data-f="name"]', card).value,
          role: $('[data-f="role"]', card).value,
          about: $('[data-f="about"]', card).value,
          active: $('[data-f="active"]', card).checked,
          photo,
          schedule,
          services: [...card.querySelectorAll("[data-svc]:checked")].map((c) => Number(c.dataset.svc)),
        },
      });
      toast("Збережено ✓");
      route();
    };
  });
  $("#addm").onclick = async () => {
    const name = prompt("Імʼя майстра");
    if (!name) return;
    await api("/api/admin/masters", { body: { name, schedule: { 1: ["09:00", "18:00"], 2: ["09:00", "18:00"], 3: ["09:00", "18:00"], 4: ["09:00", "18:00"], 5: ["09:00", "18:00"] } } });
    route();
  };
  $("#addb").onclick = () => blockForm(today());
  box.querySelectorAll("[data-del]").forEach((b) => (b.onclick = async () => {
    await api(`/api/admin/blocks/${b.dataset.del}`, { method: "DELETE" });
    route();
  }));
}

// ---------- послуги ----------
async function servicesTab(box) {
  services = await api("/api/admin/services");
  const row = (s = {}) => `<div class="card" data-s="${s.id || ""}">
    <div class="two"><label class="f" style="margin:0"><span>Категорія</span><input data-f="category" value="${esc(s.category || "")}" placeholder="Манікюр"></label>
      <label class="f" style="margin:0"><span>Порядок</span><input data-f="sort" type="number" value="${s.sort ?? 0}"></label></div>
    <label class="f"><span>Назва</span><input data-f="name" value="${esc(s.name || "")}"></label>
    <label class="f"><span>Опис</span><input data-f="description" value="${esc(s.description || "")}"></label>
    <div class="two"><label class="f"><span>Ціна, грн</span><input data-f="price" type="number" inputmode="numeric" value="${s.price ?? ""}"></label>
      <label class="f"><span>Тривалість, хв</span><input data-f="duration" type="number" inputmode="numeric" step="5" value="${s.duration ?? 60}"></label></div>
    <label class="check"><input type="checkbox" data-f="active" ${s.active !== 0 ? "checked" : ""}> Показувати в прайсі</label>
    <div class="row" style="margin-top:10px"><button class="btn grow" data-save>Зберегти</button>${s.id ? '<button class="btn line" data-del>Видалити</button>' : ""}</div></div>`;
  box.innerHTML = `<button class="btn block" id="adds">＋ Нова послуга</button><div id="new"></div><div class="stack" style="margin-top:12px">${services.map(row).join("")}</div>`;
  const bind = (card) => {
    $("[data-save]", card).onclick = async () => {
      const v = (f) => $(`[data-f="${f}"]`, card);
      try {
        await api("/api/admin/services", { body: { id: Number(card.dataset.s) || undefined, category: v("category").value, sort: v("sort").value, name: v("name").value, description: v("description").value, price: v("price").value, duration: v("duration").value, active: v("active").checked } });
        toast("Збережено ✓");
        route();
      } catch (e) {
        toast(e.message);
      }
    };
    $("[data-del]", card)?.addEventListener("click", async () => {
      if (!confirm("Видалити послугу?")) return;
      await api(`/api/admin/services/${card.dataset.s}`, { method: "DELETE" });
      route();
    });
  };
  box.querySelectorAll("[data-s]").forEach(bind);
  $("#adds").onclick = () => {
    $("#new").innerHTML = row();
    bind($("#new [data-s]"));
    $("#new input[data-f=name]").focus();
  };
}

// ---------- фото ----------
async function resize(file, max) {
  const bmp = await createImageBitmap(file).catch(() => null);
  if (!bmp) return file;
  const k = Math.min(1, max / Math.max(bmp.width, bmp.height));
  const c = document.createElement("canvas");
  c.width = Math.round(bmp.width * k);
  c.height = Math.round(bmp.height * k);
  c.getContext("2d").drawImage(bmp, 0, 0, c.width, c.height);
  return new Promise((r) => c.toBlob(r, "image/jpeg", 0.85));
}

async function upload(file, kind, caption = "", max = 1600) {
  const blob = await resize(file, max);
  return api(`/api/admin/upload?kind=${kind}&caption=${encodeURIComponent(caption)}`, { raw: blob, type: "image/jpeg", method: "POST" });
}

async function photos(box) {
  const info = await fetch("/api/public").then((r) => r.json());
  const sections = [
    ["work", "Роботи", "Фото ваших робіт — їх бачать у розділі «Роботи» та на головній."],
    ["cert", "Сертифікати", "Дипломи і сертифікати про навчання."],
    ["salon", "Кабінет", "Як виглядає ваш кабінет усередині."],
    ["route", "Маршрут до кабінету", "Покрокові фото: арка → вхід → поверх → двері. Підпишіть кожен крок — клієнтки побачать їх на карті перед візитом."],
  ];
  box.innerHTML = sections.map(([k, n, d]) => {
    const list = info.gallery.filter((g) => g.kind === k);
    return `<section class="card" style="margin-top:12px"><h3>${n}</h3><p class="small muted">${d}</p>
      <div class="gal">${list.map((g) => `<div class="it"><img src="${img(g.file)}"><button class="x" data-del="${g.id}">✕</button><input data-cap="${g.id}" value="${esc(g.caption)}" placeholder="${k === "route" ? "Крок: …" : "Підпис"}"></div>`).join("")}</div>
      <label class="btn ghost block" style="margin-top:10px">＋ Додати фото<input type="file" accept="image/*" multiple data-up="${k}" hidden></label></section>`;
  }).join("");
  box.querySelectorAll("[data-up]").forEach((inp) => (inp.onchange = async () => {
    const files = [...inp.files];
    for (const [i, f] of files.entries()) {
      toast(`Завантажую ${i + 1} з ${files.length}…`, 1500);
      await upload(f, inp.dataset.up);
    }
    route();
  }));
  box.querySelectorAll("[data-del]").forEach((b) => (b.onclick = async () => {
    if (!confirm("Видалити фото?")) return;
    await api(`/api/admin/gallery/${b.dataset.del}`, { method: "DELETE" });
    route();
  }));
  box.querySelectorAll("[data-cap]").forEach((inp) => (inp.onchange = async () => {
    await api(`/api/admin/gallery/${inp.dataset.cap}`, { body: { caption: inp.value } });
    toast("Підпис збережено");
  }));
}

// ---------- відгуки ----------
async function reviews(box) {
  const list = await api("/api/admin/reviews");
  box.innerHTML = list.length ? list.map((r) => `<div class="card" style="margin-top:10px">
    <div class="row between"><b>${esc(r.name)} · <span class="stars">${"★".repeat(r.rating)}</span></b><span class="badge ${r.status === "approved" ? "ok" : r.status === "pending" ? "warn" : "mute"}">${{ approved: "опубліковано", pending: "новий", hidden: "приховано" }[r.status]}</span></div>
    <div class="small muted">${esc(r.service)} · ${new Date(r.created_at).toLocaleDateString("uk-UA")}</div>
    <p style="margin-top:6px">${esc(r.text) || "<i class='muted'>без тексту</i>"}</p>
    <label class="f"><span>Ваша відповідь (видно всім)</span><input data-reply="${r.id}" value="${esc(r.reply)}"></label>
    <div class="row" style="margin-top:8px">
      ${r.status !== "approved" ? `<button class="btn sm" data-st="approved" data-id="${r.id}">Опублікувати</button>` : ""}
      ${r.status !== "hidden" ? `<button class="btn sm line" data-st="hidden" data-id="${r.id}">Приховати</button>` : ""}
      <button class="btn sm ghost" data-st="" data-id="${r.id}">Зберегти відповідь</button>
    </div></div>`).join("") : '<div class="empty"><div class="ic">⭐</div>Відгуків поки немає. Клієнтки отримають прохання залишити відгук через кілька годин після візиту.</div>';
  box.querySelectorAll("[data-id]").forEach((b) => (b.onclick = async () => {
    await api(`/api/admin/reviews/${b.dataset.id}`, { body: { status: b.dataset.st || undefined, reply: $(`[data-reply="${b.dataset.id}"]`).value } });
    toast("Готово");
    route();
  }));
}

// ---------- клієнти ----------
async function clients(box, q = "") {
  const list = await api(`/api/admin/clients?q=${encodeURIComponent(q)}`);
  box.innerHTML = `<input id="cq" placeholder="🔍 Імʼя або телефон" value="${esc(q)}">
    <div class="stack" style="margin-top:12px">${list.map((c) => `<div class="card">
      <div class="row between"><b>${esc(c.name)}</b><span class="badge">💎 ${c.bonus}</span></div>
      <div class="small"><a href="tel:${esc(c.phone)}">${esc(c.phone)}</a> · візитів: ${c.visits}${c.last_visit ? ` · останній ${c.last_visit}` : ""}</div>
      <div class="small muted">${c.referred_by_name ? `привела: ${esc(c.referred_by_name)} · ` : ""}${c.invited ? `запросила: ${c.invited} · ` : ""}${c.birthday ? `🎂 ${c.birthday.slice(5)} · ` : ""}${c.src ? `QR: ${esc(c.src)}` : ""}</div>
      <label class="f"><span>Нотатка (бачите лише ви)</span><input data-note="${c.id}" value="${esc(c.note)}" placeholder="Алергія, улюблений колір…"></label>
      <div class="row" style="margin-top:8px"><button class="btn sm ghost" data-bonus="${c.id}">± Бонуси</button></div>
    </div>`).join("") || '<div class="empty">Нікого не знайдено</div>'}</div>`;
  let t;
  $("#cq").oninput = (e) => {
    clearTimeout(t);
    t = setTimeout(() => clients(box, e.target.value).then(() => $("#cq").focus()), 400);
  };
  box.querySelectorAll("[data-note]").forEach((inp) => (inp.onchange = async () => {
    await api(`/api/admin/clients/${inp.dataset.note}`, { body: { note: inp.value } });
    toast("Нотатку збережено");
  }));
  box.querySelectorAll("[data-bonus]").forEach((b) => (b.onclick = async () => {
    const v = prompt("Скільки бонусів додати? (мінус — списати, напр. -50)");
    if (!v || !Number(v)) return;
    const reason = prompt("Причина (побачить клієнтка)", Number(v) > 0 ? "Подарунок від майстра" : "Списання") || "";
    await api(`/api/admin/clients/${b.dataset.bonus}`, { body: { bonusDelta: Number(v), reason } });
    clients(box, $("#cq").value);
  }));
}

// ---------- QR-постери ----------
async function qr(box) {
  const sources = await api("/api/admin/sources");
  const places = [["door", "Двері кабінету"], ["entrance", "Підʼїзд"], ["stop", "Зупинка"], ["flyer", "Флаєр / візитка"], ["insta", "Instagram"]];
  box.innerHTML = `<div class="card"><h3>Постер з QR-кодом</h3>
      <p class="small muted">Оберіть, де висітиме постер — кожен отримає свій QR, і тут буде видно, звідки приходять клієнтки.</p>
      <label class="f"><span>Де висітиме</span><select id="src">${places.map(([k, n]) => `<option value="${k}">${n}</option>`).join("")}<option value="custom">Інше…</option></select></label>
      <label class="f hidden" id="cwrap"><span>Назва місця латиницею (напр. stop-sadova)</span><input id="custom"></label>
      <label class="f"><span>Заголовок</span><input id="ttl" value="Записуйтесь онлайн"></label>
      <label class="f"><span>Підзаголовок</span><input id="sub" value="Вільні вікна, передоплата і нагадування — в телефоні"></label>
      <button class="btn block" style="margin-top:14px" id="open">🖨️ Відкрити постер для друку</button></div>
    <section class="section"><h3>Звідки приходять</h3><div class="card">${sources.length ? `<table><tr><th>Місце</th><th>Сканів</th><th>Клієнток</th><th>Візитів</th></tr>${sources.map((s) => `<tr><td>${esc((places.find((p) => p[0] === s.src) || [0, s.src])[1])}</td><td>${s.scans}</td><td>${s.clients}</td><td>${s.visits}</td></tr>`).join("")}</table>` : '<p class="muted small">Щойно хтось відсканує QR — тут зʼявиться статистика.</p>'}</div></section>`;
  $("#src").onchange = (e) => $("#cwrap").classList.toggle("hidden", e.target.value !== "custom");
  $("#open").onclick = () => {
    const src = $("#src").value === "custom" ? $("#custom").value.replace(/[^\w-]/g, "") || "poster" : $("#src").value;
    open(`/poster?src=${encodeURIComponent(src)}&t=${encodeURIComponent($("#ttl").value)}&s=${encodeURIComponent($("#sub").value)}`, "_blank");
  };
}

// ---------- налаштування ----------
async function settings(box) {
  const [s, stats] = await Promise.all([api("/api/admin/settings"), api("/api/admin/stats")]);
  const f = (k, label, type = "text", extra = "") => `<label class="f"><span>${label}</span>${type === "area" ? `<textarea data-k="${k}">${esc(s[k])}</textarea>` : `<input data-k="${k}" type="${type}" value="${esc(s[k])}" ${extra}>`}</label>`;
  box.innerHTML = `
    <div class="card"><h3>Салон</h3>
      ${f("name", "Назва")}${f("tagline", "Коротко про послуги")}${f("about", "Про салон", "area")}
      ${f("phone", "Телефон", "tel")}${f("instagram", "Instagram (без @)")}${f("telegram", "Telegram (без @)")}${f("viber", "Viber (номер)")}
      ${f("rules", "Правила для клієнток", "area")}</div>
    <div class="card"><h3>Адреса і маршрут</h3>
      ${f("address", "Адреса")}${f("cabinet", "Поверх / кабінет")}${f("howToFind", "Як знайти вхід і кабінет", "area")}
      <p class="small muted" style="margin-top:10px">Натисніть на карті точно на вхід у будівлю:</p>
      <div id="map" style="height:260px"></div>
      <div class="two">${f("lat", "Широта", "number", 'step="any"')}${f("lng", "Довгота", "number", 'step="any"')}</div>
      <button class="btn sm ghost" id="geo" style="margin-top:8px">📍 Я зараз біля входу — взяти мою геолокацію</button></div>
    <div class="card"><h3>Запис і оплата</h3>
      <div class="two">${f("prepayPercent", "Передоплата, %", "number")}${f("cancelHours", "Безкошт. скасування, год", "number")}</div>
      <div class="two">${f("slotStep", "Крок запису, хв", "number")}${f("minNoticeHours", "Запис мінімум за, год", "number")}</div>
      ${f("bookingDays", "Запис наперед, днів", "number")}
      <p class="small" style="margin-top:10px">Оплата: <b>${stats.payments === "mono" ? "monobank підключено ✓" : "тестовий режим"}</b>${stats.payments === "mono" ? "" : ". Щоб увімкнути справжню передоплату: у web.monobank.ua → «Еквайринг» отримайте токен і додайте його в Railway як змінну <code>MONO_TOKEN</code>."}</p></div>
    <div class="card"><h3>Бонуси і рефералка</h3>
      <div class="two">${f("refBonus", "Бонус тій, що привела", "number")}${f("refDiscount", "Знижка подрузі, грн", "number")}</div>
      <div class="two">${f("cashbackPercent", "Кешбек з візиту, %", "number")}${f("maxBonusPercent", "Макс. оплата бонусами, %", "number")}</div>
      ${f("birthdayDiscount", "Знижка в тиждень дня народження, %", "number")}</div>
    <button class="btn block big" id="save" style="margin-top:14px">Зберегти</button>

    <section class="section card"><h3>Сповіщення для вас</h3>
      <p class="small muted">Отримуйте push на цей телефон про кожен новий запис, скасування і відгук.${stats.telegram ? " Telegram також підключено ✓" : ""}</p>
      <button class="btn ghost block" id="push">🔔 Увімкнути на цьому пристрої</button></section>

    <section class="section card"><h3>Розсилка клієнткам</h3>
      <p class="small muted">Push усім, хто увімкнув сповіщення: акції, «вікно на завтра звільнилося» тощо.</p>
      <label class="f"><span>Заголовок</span><input id="bt" placeholder="Звільнилося вікно завтра о 15:00 ✨"></label>
      <label class="f"><span>Текст</span><input id="bb" placeholder="Встигніть записатися!"></label>
      <button class="btn block" style="margin-top:10px" id="bsend">Надіслати</button></section>

    <button class="btn line block" style="margin-top:20px" id="logout">Вийти з кабінету</button>`;

  $("#save").onclick = async () => {
    const body = {};
    box.querySelectorAll("[data-k]").forEach((i) => (body[i.dataset.k] = i.value));
    await api("/api/admin/settings", { body });
    toast("Збережено ✓");
  };
  $("#logout").onclick = () => {
    store.set("adminToken", null);
    location.reload();
  };
  $("#push").onclick = adminPush;
  $("#bsend").onclick = async () => {
    if (!$("#bt").value.trim()) return toast("Вкажіть заголовок");
    if (!confirm("Надіслати всім клієнткам?")) return;
    const r = await api("/api/admin/broadcast", { body: { title: $("#bt").value, body: $("#bb").value } });
    toast(`Надіслано: ${r.sent}`);
  };
  const latI = $('[data-k="lat"]');
  const lngI = $('[data-k="lng"]');
  $("#geo").onclick = () => navigator.geolocation.getCurrentPosition((p) => {
    latI.value = p.coords.latitude.toFixed(6);
    lngI.value = p.coords.longitude.toFixed(6);
    setPin();
  }, () => toast("Немає доступу до геолокації"), { enableHighAccuracy: true });

  let map, marker;
  const setPin = () => {
    if (!map) return;
    const ll = [Number(latI.value), Number(lngI.value)];
    marker.setLatLng(ll);
    map.setView(ll, 17);
  };
  try {
    await new Promise((res, rej) => {
      if (window.L) return res();
      const css = document.createElement("link");
      css.rel = "stylesheet";
      css.href = "/vendor/leaflet.css";
      document.head.append(css);
      const sc = document.createElement("script");
      sc.src = "/vendor/leaflet.js";
      sc.onload = res;
      sc.onerror = rej;
      document.head.append(sc);
    });
    const L = window.L;
    map = L.map("map").setView([s.lat, s.lng], 16);
    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 19, attribution: "© OpenStreetMap" }).addTo(map);
    marker = L.marker([s.lat, s.lng]).addTo(map);
    map.on("click", (e) => {
      latI.value = e.latlng.lat.toFixed(6);
      lngI.value = e.latlng.lng.toFixed(6);
      marker.setLatLng(e.latlng);
    });
    latI.onchange = lngI.onchange = setPin;
  } catch {
    $("#map").remove();
  }
}

function b64ToBytes(b64) {
  const pad = "=".repeat((4 - (b64.length % 4)) % 4);
  return Uint8Array.from(atob((b64 + pad).replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));
}

async function adminPush() {
  if (!("serviceWorker" in navigator) || !("PushManager" in window)) return toast("На iPhone спершу додайте кабінет на головний екран (Поділитися → На початковий екран)", 5000);
  if ((await Notification.requestPermission()) !== "granted") return toast("Сповіщення заборонені в налаштуваннях");
  const { vapidPublicKey } = await fetch("/api/public").then((r) => r.json());
  const reg = await navigator.serviceWorker.ready;
  const sub = (await reg.pushManager.getSubscription()) || (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToBytes(vapidPublicKey) }));
  await api("/api/push/subscribe", { body: { subscription: sub.toJSON() } });
  toast("Готово! Нові записи приходитимуть сюди 🔔");
}

async function boot() {
  if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js").catch(() => {});
  if (!store.get("adminToken")) return login();
  try {
    [services, masters] = await Promise.all([api("/api/admin/services"), api("/api/admin/masters")]);
  } catch {
    return;
  }
  addEventListener("hashchange", route);
  route();
}
boot();
