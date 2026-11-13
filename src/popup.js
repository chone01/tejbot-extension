// Okno po kliknutí na ikonu TejBot: Živě, Můj hrdina, Upozornění
const { t } = TBI;
const $app = document.getElementById("app");
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const ask = (m) => new Promise((res) => chrome.runtime.sendMessage(m, (r) => res(r)));
const call = (method, path, body, base = "api") => ask({ t: "api", base, method, path, body });
const SLOTS = ["sword", "helmet", "chest", "boots", "shield"];
const STATS = [
  ["str", "swords"],
  ["def", "shield"],
  ["sta", "heart"],
  ["agi", "wind"],
  ["luck", "clover"],
];
const DISMANTLE_XP = [1, 3, 8, 20, 50];

let S = { tab: "live", state: null, live: null, hero: null, mode: null, alloc: null, msg: "", err: false };
try {
  S.tab = localStorage.getItem("tb-tab") || "live";
} catch {
  /* nic */
}

function msg(text, err = false) {
  S.msg = text;
  S.err = err;
  render();
  if (text) setTimeout(() => S.msg === text && ((S.msg = ""), render()), 4000);
}
const codeText = (r) => t(TBI.has(`c_${r?.code}`) ? `c_${r.code}` : r?.error === "account" ? "c_account" : "c_failed");

// ------------------------------------------------------------------ data
async function init() {
  S.state = await ask({ t: "state" });
  TBI.setLang(S.state?.settings?.lang || "auto");
  render();
  if (!S.state?.connected) return;
  void loadTab();
}
async function activeChannel() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const u = new URL(tab?.url || "");
    const seg = u.pathname.split("/").filter(Boolean);
    const skip = new Set(["directory", "categories", "browse", "following", "search", "settings", "subscriptions", "popout", "moderator", "inventory", "wallet", "drops", "videos", "u"]);
    const slug = seg[0] === "popout" || seg[0] === "moderator" ? seg[1] : seg[0];
    if (/kick\.com$/.test(u.hostname) && slug && !skip.has(slug)) return { platform: "kick", slug };
    if (/twitch\.tv$/.test(u.hostname) && slug && !skip.has(slug)) return { platform: "twitch", slug };
  } catch {
    /* nic */
  }
  return null;
}
async function loadTab() {
  if (S.tab === "live") {
    const here = await activeChannel();
    S.live = await call("GET", `/ext/live${here ? `?platform=${here.platform}&slug=${encodeURIComponent(here.slug)}` : ""}`);
  }
  if (S.tab === "hero") S.hero = await call("GET", "/ext/hero");
  render();
}

// ------------------------------------------------------------------ vykreslení
function render() {
  const st = S.state;
  if (!st) return void ($app.innerHTML = `<div class="empty">…</div>`);
  if (!st.connected) {
    $app.innerHTML = `
      <div class="head">${TBLogo(28)}<div class="title">TejBot</div></div>
      <div class="body center" style="padding-top:34px">
        <div style="margin:0 auto 14px;width:56px">${TBLogo(56)}</div>
        <p style="font-weight:700;font-size:15px">${esc(t("notConnected"))}</p>
        <p class="soft small">${esc(t("connectHint"))}</p>
        <a class="btn primary" style="margin-top:14px" href="${esc(st.web)}/rozsireni" target="_blank">${TBIcon("external", 15)} ${esc(t("connect"))}</a>
      </div>`;
    return;
  }
  const me = st.me || {};
  const initial = esc(String(me.name || me.accounts?.[0]?.name || "?").slice(0, 1).toUpperCase());
  $app.innerHTML = `
    <div class="head">${TBLogo(28)}<div class="title">TejBot</div>
      <span class="user">${esc(me.accounts?.[0]?.name || me.name || "")}</span>
      <span class="av">${me.avatar ? `<img src="${esc(me.avatar)}" alt="">` : initial}</span>
    </div>
    <div class="tabs">
      ${[
        ["live", "radio", "live"],
        ["hero", "swords", "hero"],
        ["notif", "bell", "notif"],
      ]
        .map(([k, ic, lb]) => `<button class="tab ${S.tab === k ? "on" : ""}" data-tab="${k}">${TBIcon(ic, 15)} ${esc(t(lb))}</button>`)
        .join("")}
    </div>
    <div class="body">${S.tab === "live" ? liveView() : S.tab === "hero" ? heroView() : notifView()}
      <div class="msg ${S.err ? "err" : ""}">${esc(S.msg)}</div>
    </div>`;
}

function liveView() {
  const L = S.live;
  if (!L) return `<div class="empty">…</div>`;
  if (L.ok === false && L.code === "offline") return `<div class="empty">${esc(t("c_offline"))}</div>`;
  const list = L.list || [];
  const liveN = list.filter((c) => c.live).length;
  const rows = list.length
    ? list
        .map(
          (c) => `<a class="chan ${c.live ? "" : "off"}" href="${c.platform === "twitch" ? "https://www.twitch.tv/" : "https://kick.com/"}${esc(c.slug)}" target="_blank">
          <span class="av" style="background:${color(c.name)}">${esc(c.name.slice(0, 1).toUpperCase())}</span>
          <span class="grow"><span class="n">${esc(c.name)}</span><span class="plat ${c.platform}">${c.platform === "twitch" ? "Twitch" : "Kick"}</span>
          <div class="s">${c.live ? esc([c.category, c.viewers != null ? t("viewers", { n: TBI.num(c.viewers) }) : ""].filter(Boolean).join(" · ")) : esc(t("offline"))}</div></span>
          ${c.live ? `<span class="dot"></span>` : ""}</a>`
        )
        .join("")
    : `<div class="empty small">${esc(t("noFollow"))}</div>`;
  const here = L.here && L.here.points != null ? `<span class="small muted">${esc(t("pointsOn", { ch: L.here.name }))} <b style="color:var(--brand-300)">${TBI.num(L.here.points)}</b></span>` : `<span></span>`;
  return `<div class="small muted">${esc(t("following", { n: liveN }))}</div><div class="list">${rows}</div>
    <div class="foot">${here}<a class="btn" href="${esc(S.state.web)}" target="_blank">${TBIcon("external", 15)} ${esc(t("openWeb"))}</a></div>`;
}

function color(s) {
  let h = 0;
  for (const ch of String(s)) h = (h * 31 + ch.charCodeAt(0)) % 360;
  return `hsl(${h} 70% 60%)`;
}

const rarColor = (r) => TB_RARITY[r] ?? "#3f4350";
function slotTile(item, slot, act = "") {
  if (!item) return `<span class="slot empty" title="${esc(t(`slot_${slot}`))}">${TBIcon(slot, 20)}</span>`;
  const c = rarColor(item.rarity);
  return `<button class="slot" ${act} title="${esc(itemName(item))}" style="border-color:${c};color:${c};background:color-mix(in srgb, ${c} 14%, transparent);${item.rarity === 4 ? `box-shadow:0 0 12px ${c}` : ""}">${TBIcon(item.slot, 20)}</button>`;
}
const itemName = (i) => (["cs", "sk"].includes(TBI.lang()) ? i.cs : i.en);
const itemStats = (i) =>
  STATS.filter(([k]) => i.stats?.[k])
    .map(([k]) => `+${i.stats[k]} ${t(`stat_${k}`)}`)
    .join(" · ");

function heroView() {
  const H = S.hero;
  if (!H) return `<div class="empty">…</div>`;
  if (H.ok === false && H.code === "offline") return `<div class="empty">${esc(t("c_offline"))}</div>`;
  if (!H.hero) return `<div class="empty">${TBIcon("swords", 32)}<p>${esc(t("noHero"))}</p></div>`;
  const h = H.hero;
  const items = H.items || [];
  const eq = Object.fromEntries(items.filter((i) => i.equipped).map((i) => [i.slot, i]));
  const bag = items.filter((i) => !i.equipped);
  const pct = h.xpTo > h.xpFrom ? Math.min(100, Math.max(0, ((h.xp - h.xpFrom) / (h.xpTo - h.xpFrom)) * 100)) : 100;

  if (S.mode === "alloc") return allocView(h);
  if (S.mode === "bag") {
    return `<button class="btn small" data-act="mode" data-v="">${esc(t("back"))}</button>
      <h3>${esc(t("backpack", { n: bag.length }))}</h3>
      ${bag.length ? bag.map((i) => bagRow(i, true)).join("") : `<div class="empty small">${esc(t("bagEmpty"))}</div>`}`;
  }
  const fresh = bag.filter((i) => Date.now() - new Date(i.at).getTime() < 3 * 86400000).slice(0, 2);
  return `
    <div class="card">
      <div class="hero-top"><span class="av">${esc(h.name.slice(0, 1).toUpperCase())}</span>
        <div><div class="name">${esc(h.name)}</div><div class="small muted">${esc(t("level", { n: h.level }))} · ${esc(t("winsLosses", { w: TBI.num(h.wins), l: TBI.num(h.losses) }))}</div></div>
        ${h.unspent > 0 ? `<span class="pill">${esc(t("freePoints", { n: h.unspent }))}</span>` : ""}
      </div>
      <div class="xp"><div class="row small muted"><span style="flex:1">XP</span><span>${TBI.num(h.xp - h.xpFrom)} / ${TBI.num(h.xpTo - h.xpFrom)}</span></div><div class="bar"><i style="width:${pct}%"></i></div></div>
      <div class="stats">
        ${STATS.map(([k]) => `<div class="stat"><b>${TBI.num(h.stats[k])}</b><span>${esc(t(`stat_${k}`))}</span></div>`).join("")}
        <div class="stat"><b>${TBI.num(h.hp)}</b><span>${esc(t("hp"))}</span></div>
      </div>
      <div class="slots">${SLOTS.map((s) => slotTile(eq[s], s, eq[s] ? `data-act="unequip" data-id="${eq[s].id}"` : "")).join("")}</div>
    </div>
    ${fresh.length ? `<div class="card" style="margin-top:10px"><div class="small muted">${esc(t("newGear", { n: bag.length }))}</div>${fresh.map((i) => bagRow(i, false)).join("")}</div>` : ""}
    <div class="grid2" style="margin-top:10px">
      <button class="btn" data-act="mode" data-v="alloc">${esc(t("spendPoints"))}</button>
      <button class="btn" data-act="mode" data-v="bag">${esc(t("dismantleGear"))}</button>
    </div>
    <div class="center" style="margin-top:10px"><a class="small" href="${esc(H.url)}" target="_blank">${esc(t("profile"))}</a></div>`;
}

function bagRow(i, withDismantle) {
  const c = rarColor(i.rarity);
  return `<div class="item">${slotTile(i, i.slot)}
    <div class="grow"><div class="nm" style="color:${c}">${esc(itemName(i))}</div><div class="small muted">${esc(t(`rar${i.rarity}`))} · ${esc(t("lvl", { n: i.level }))} · ${esc(itemStats(i))}</div></div>
    <button class="btn small primary" data-act="equip" data-id="${i.id}">${esc(t("equip"))}</button>
    ${withDismantle ? `<button class="icon-btn" title="${esc(t("dismantle"))}" data-act="dismantle" data-id="${i.id}">${TBIcon("hammer", 14)}</button>` : ""}
  </div>`;
}

function allocView(h) {
  S.alloc = S.alloc || { str: 0, def: 0, sta: 0, agi: 0, luck: 0 };
  const used = Object.values(S.alloc).reduce((a, b) => a + b, 0);
  const left = h.unspent - used;
  return `<button class="btn small" data-act="mode" data-v="">${esc(t("back"))}</button>
    <div class="toggle"><span>${esc(t("autoPoints"))}</span><label class="sw"><input type="checkbox" data-act="auto" ${h.manual ? "" : "checked"}><span></span></label></div>
    <p class="small muted">${esc(t("freeLeft", { n: left }))}</p>
    <div class="alloc">${STATS.map(
      ([k, ic]) => `<div class="r"><span class="l">${TBIcon(ic, 14)} ${esc(t(`stat_${k}`))} <span class="muted">${TBI.num(h.stats[k])}</span></span>
      <button class="icon-btn" data-act="minus" data-k="${k}" ${S.alloc[k] ? "" : "disabled"}>${TBIcon("minus", 14)}</button><b>+${S.alloc[k]}</b>
      <button class="icon-btn" data-act="plus" data-k="${k}" ${left > 0 ? "" : "disabled"}>${TBIcon("plus", 14)}</button></div>`
    ).join("")}</div>
    <button class="btn primary block" style="margin-top:12px" data-act="spend" ${used ? "" : "disabled"}>${esc(t("save"))}</button>`;
}

function notifView() {
  const s = S.state.settings;
  const me = S.state.me || {};
  const sw = (key, label) => `<div class="toggle"><span>${esc(label)}</span><label class="sw"><input type="checkbox" data-set="${key}" ${s[key] ? "checked" : ""}><span></span></label></div>`;
  return `<div class="card">
      ${sw("nChallenge", t("notifChallenge"))}${sw("nResult", t("notifResult"))}${sw("nDrop", t("notifDrop"))}${sw("badges", t("badges"))}
      <div class="toggle"><span>${esc(t("language"))}</span>
        <select data-set="lang">${["auto", ...TBI.LANGS].map((l) => `<option value="${l}" ${s.lang === l ? "selected" : ""}>${l === "auto" ? esc(t("langAuto")) : { cs: "Čeština", sk: "Slovenčina", en: "English", de: "Deutsch", pl: "Polski" }[l]}</option>`).join("")}</select></div>
    </div>
    <p class="small muted">${esc(t("notifHint"))}</p>
    <h3>${esc(t("accounts"))}</h3>
    <div>${(me.accounts || []).map((a) => `<span class="acc"><span class="plat ${a.platform}" style="margin:0">${a.platform === "twitch" ? "Twitch" : a.platform === "youtube" ? "YouTube" : "Kick"}</span>${esc(a.name)}</span>`).join("")}</div>
    <div class="foot"><a class="small" href="${esc(S.state.web)}/rozsireni" target="_blank">tejbot.eu/rozsireni</a>
      <button class="btn danger small" data-act="logout">${TBIcon("logout", 14)} ${esc(t("logout"))}</button></div>`;
}

// ------------------------------------------------------------------ kliknutí
$app.addEventListener("click", async (e) => {
  const el = e.target.closest("[data-tab],[data-act]");
  if (!el || el.tagName === "INPUT") return;
  if (el.dataset.tab) {
    S.tab = el.dataset.tab;
    S.mode = null;
    try {
      localStorage.setItem("tb-tab", S.tab);
    } catch {
      /* nic */
    }
    render();
    return void loadTab();
  }
  const act = el.dataset.act;
  const h = S.hero?.hero;
  if (act === "mode") {
    S.mode = el.dataset.v || null;
    S.alloc = null;
    return render();
  }
  if (act === "plus" || act === "minus") {
    S.alloc[el.dataset.k] = Math.max(0, S.alloc[el.dataset.k] + (act === "plus" ? 1 : -1));
    return render();
  }
  if (act === "logout") {
    await ask({ t: "logout" });
    return init();
  }
  if (act === "dismantle") {
    const it = S.hero.items.find((i) => i.id === el.dataset.id);
    if (!it || !confirm(t("confirmDismantle", { item: itemName(it), xp: it.level * DISMANTLE_XP[it.rarity] }))) return;
  }
  if (["equip", "unequip", "dismantle", "spend"].includes(act) && h) {
    el.disabled = true;
    const body = act === "spend" ? { op: "points", add: S.alloc } : { op: act, item: el.dataset.id };
    const r = await call("POST", "/ext/hero", body);
    if (r?.ok) {
      S.hero = r;
      if (act === "spend") S.mode = null;
      S.alloc = null;
      S.msg = "";
    } else msg(codeText(r), true);
    render();
  }
});
$app.addEventListener("change", async (e) => {
  const el = e.target;
  if (el.dataset.set) {
    const v = el.type === "checkbox" ? el.checked : el.value;
    S.state.settings = await ask({ t: "settings", patch: { [el.dataset.set]: v } });
    TBI.setLang(S.state.settings.lang);
    return render();
  }
  if (el.dataset.act === "auto") {
    const r = await call("POST", "/ext/hero", { op: "auto", manual: !el.checked });
    if (r?.ok) S.hero = r;
    else msg(codeText(r), true);
    render();
  }
});

init();
