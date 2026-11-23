// TejBot v chatu na Kicku a Twitchi: odznaky s levelem hrdiny, karta hrdiny po najetí na jméno,
// výzva na duel jedním klikem, výsledek a drop, obchod kanálu a nástroje pro moderátory.
// Všechno, co rozšíření kreslí, je ve vlastním „stínovém“ prvku, aby se to nepletlo se stránkou.
// Když Kick nebo Twitch změní vzhled a něco se nenajde, okno rozšíření a upozornění fungují dál.
(() => {
  if (window.__tejbotExt) return;
  window.__tejbotExt = true;

  const PLATFORM = /(^|\.)kick\.com$/.test(location.hostname) ? "kick" : "twitch";
  const { t } = TBI;
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const alive = () => {
    try {
      return !!chrome.runtime?.id;
    } catch {
      return false;
    }
  };
  const ask = (m) =>
    new Promise((res) => {
      if (!alive()) return res(null);
      try {
        chrome.runtime.sendMessage(m, (r) => res(chrome.runtime.lastError ? null : r));
      } catch {
        res(null);
      }
    });
  const call = (method, path, body, base = "api") => ask({ t: "api", base, method, path, body });
  const codeText = (r) => t(TBI.has(`c_${r?.code}`) ? `c_${r.code}` : r?.error && TBI.has(`c_${r.error}`) ? `c_${r.error}` : "c_failed");

  // výchozí výběry prvků (aktuální verze přijde ze serveru, viz bot/src/ext-selectors.js)
  let SEL = {
    kick: {
      row: ["#chatroom-messages [data-index]", "#chatroom-messages .chat-entry", "[data-chat-entry]", "div.chat-entry"],
      user: ["button[title][data-prevent-expand]", "button.inline.font-bold", ".chat-entry-username"],
      text: [".chat-entry-content", "span.font-normal", "span[class*='break-words']"],
      input: ["div[data-input='true']", "div[contenteditable='true'][data-lexical-editor='true']", "#message-input", "div[contenteditable='true']"],
      inputBox: ["#chat-input-wrapper", "[data-testid='chat-input-wrapper']", "#chatroom-footer"],
      chat: ["#chatroom-messages", "#chatroom"],
    },
    twitch: {
      row: [".chat-line__message", "[data-a-target='chat-line-message']"],
      user: ["[data-a-target='chat-message-username']", ".chat-author__display-name"],
      text: ["[data-a-target='chat-line-message-body']", ".text-fragment"],
      input: ["[data-a-target='chat-input']", "div[contenteditable='true'][role='textbox']"],
      inputBox: [".chat-input__buttons-container", ".chat-input"],
      chat: [".chat-scrollable-area__message-container", ".chat-list--default"],
    },
  }[PLATFORM];

  const first = (root, list) => {
    for (const s of list || []) {
      try {
        const el = root.querySelector(s);
        if (el) return el;
      } catch {
        /* neplatný výběr */
      }
    }
    return null;
  };
  const all = (root, list) => {
    for (const s of list || []) {
      try {
        const els = root.querySelectorAll(s);
        if (els.length) return [...els];
      } catch {
        /* neplatný výběr */
      }
    }
    return [];
  };

  // ------------------------------------------------------------------ stav
  const S = {
    connected: false,
    me: null,
    settings: { badges: true },
    slug: null,
    mod: null, // stav moderátora z webu (role, oprávnění, téma…)
    badges: new Map(), // jméno -> { lv, r, ext } | null
    cards: new Map(), // jméno -> { at, v }
    handling: new Map(), // divák -> { by, at }
    challenge: null,
    panel: null, // otevřený panel: "shop" | "actions" | "queue" | "log"
    logFilter: "all",
  };

  function currentSlug() {
    const seg = location.pathname.split("/").filter(Boolean);
    const skip = new Set(["directory", "categories", "browse", "following", "search", "settings", "subscriptions", "inventory", "wallet", "drops", "videos", "u", "clips", "category", "dashboard", "popout", "moderator", "embed", "turbo", "friends", "messages", "p", "privacy", "terms"]);
    let s = seg[0];
    if ((seg[0] === "popout" || seg[0] === "moderator" || seg[0] === "embed") && seg[1]) s = seg[1];
    if (location.hostname.startsWith("dashboard.") && seg[0] === "popout" && seg[2]) s = seg[2];
    if (!s || (skip.has(s) && s === seg[0] && !["popout", "moderator", "embed"].includes(seg[0]))) return null;
    return /^[A-Za-z0-9_.-]{2,40}$/.test(s) ? s.toLowerCase() : null;
  }

  // ------------------------------------------------------------------ spojení s pozadím rozšíření
  let port = null;
  function connectPort() {
    if (!alive()) return;
    try {
      port = chrome.runtime.connect({ name: "tb-chat" });
    } catch {
      return;
    }
    port.onMessage.addListener(onPortMessage);
    port.onDisconnect.addListener(() => {
      port = null;
      // pozadí se uspalo nebo se rozšíření aktualizovalo -> zkusit znovu
      setTimeout(connectPort, 1500);
    });
    hello();
  }
  const post = (m) => {
    try {
      port?.postMessage(m);
    } catch {
      /* nic */
    }
  };
  const hello = () => {
    post({ type: "hello", platform: PLATFORM, slug: S.slug, visible: document.visibilityState === "visible" });
    if (S.mod?.topic) post({ type: "mod", topic: S.mod.topic });
  };
  document.addEventListener("visibilitychange", () => post({ type: "visible", visible: document.visibilityState === "visible" }));

  function onPortMessage(m) {
    if (m.type === "auth") return void boot();
    if (m.type === "ext") return onPersonal(m.event || {});
    if (m.type === "mod") return onModEvent(m.event || {});
  }

  // ------------------------------------------------------------------ vzhled (stínový prvek)
  const CSS = `
  :host { all: initial; }
  * { box-sizing: border-box; }
  .root { position: fixed; inset: 0; pointer-events: none; z-index: 2147483000; font: 13px/1.4 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; color: #f4f4f6; }
  .root > * { pointer-events: auto; }
  button { font: inherit; color: inherit; cursor: pointer; }
  button:disabled { opacity: .5; cursor: default; }
  .box { position: fixed; background: #111116; border: 1px solid #2a2a33; border-radius: 14px; box-shadow: 0 18px 50px rgba(0,0,0,.55); }
  .launch { position: fixed; width: 30px; height: 30px; border-radius: 9px; border: 0; padding: 0; display: grid; place-items: center; background: transparent; }
  .launch:hover { filter: brightness(1.15); }
  .launch .dotn { position: absolute; top: -3px; right: -3px; min-width: 15px; height: 15px; padding: 0 3px; border-radius: 8px; background: #ef4444; color: #fff; font-size: 10px; font-weight: 800; display: grid; place-items: center; }
  .card { width: 320px; padding: 14px; }
  .panel { width: 340px; max-height: min(560px, 70vh); display: flex; flex-direction: column; overflow: hidden; }
  .phead { display: flex; align-items: center; gap: 8px; padding: 10px 12px; border-bottom: 1px solid #23232a; }
  .phead .ttl { font-weight: 800; flex: 1; }
  .ptabs { display: flex; gap: 2px; padding: 0 8px; border-bottom: 1px solid #23232a; }
  .ptab { border: 0; background: none; color: #9a9aa5; padding: 8px 8px; font-weight: 600; border-bottom: 2px solid transparent; display: inline-flex; align-items: center; gap: 5px; }
  .ptab.on { color: #f4f4f6; border-bottom-color: #a4d450; }
  .pbody { padding: 12px; overflow: auto; }
  .row { display: flex; align-items: center; gap: 8px; }
  .grow { flex: 1; min-width: 0; }
  .muted { color: #9a9aa5; }
  .soft { color: #c7c7cf; }
  .small { font-size: 12px; }
  .tiny { font-size: 11px; }
  .b { font-weight: 700; }
  .av { width: 40px; height: 40px; border-radius: 50%; display: grid; place-items: center; font-weight: 800; color: #0a0a0f; flex-shrink: 0; font-size: 17px; }
  .plat { font-size: 10px; font-weight: 700; padding: 1px 6px; border-radius: 6px; background: #23232a; color: #c7c7cf; }
  .stats { display: grid; grid-template-columns: repeat(3, 1fr); gap: 5px; margin-top: 10px; }
  .stat { background: #0a0a0f; border-radius: 9px; padding: 6px 3px; text-align: center; }
  .stat b { display: block; font-size: 15px; }
  .stat span { font-size: 10px; color: #9a9aa5; }
  .slots { display: grid; grid-template-columns: repeat(5, minmax(0, 1fr)); gap: 6px; margin-top: 10px; }
  .slot { aspect-ratio: 1; border-radius: 10px; border: 2px solid #3f4350; display: grid; place-items: center; }
  .slot.empty { border-style: dashed; color: #3f4350; }
  .btn { display: inline-flex; align-items: center; justify-content: center; gap: 6px; padding: 7px 10px; border-radius: 9px; border: 1px solid #2a2a33; background: #17171f; font-weight: 600; text-decoration: none; color: #f4f4f6; }
  .btn:hover:not(:disabled) { border-color: #44444f; }
  .btn.primary { background: #a4d450; border-color: #a4d450; color: #0a0a0f; }
  .btn.red { background: #e05252; border-color: #e05252; color: #fff; }
  .btn.ghostred { color: #fca5a5; }
  .btn.sm { padding: 4px 8px; font-size: 12px; }
  .grid2 { display: grid; grid-template-columns: 1fr 1fr; gap: 6px; }
  .sep { height: 1px; background: #23232a; margin: 12px 0; }
  .h { font-size: 12px; color: #9a9aa5; margin: 10px 0 6px; }
  .note { background: #0a0a0f; border-radius: 9px; padding: 7px 9px; margin-bottom: 6px; }
  .field { width: 100%; background: #0a0a0f; border: 1px dashed #3a3a44; border-radius: 9px; padding: 7px 9px; color: #f4f4f6; font: inherit; }
  .field:focus { outline: none; border-style: solid; border-color: #a4d450; }
  .reason { display: flex; justify-content: space-between; width: 100%; padding: 7px 10px; border-radius: 9px; border: 1px solid transparent; background: #17171f; margin-bottom: 4px; text-align: left; }
  .reason:hover { border-color: #fb923c; background: #2a1e14; }
  .reason b { color: #f4f4f6; }
  .warn { background: #2a1e14; border: 1px solid #7c4a1e; color: #fdba74; border-radius: 9px; padding: 6px 9px; margin-top: 8px; font-size: 12px; }
  .qa { display: flex; align-items: center; gap: 8px; padding: 9px 10px; border-radius: 10px; border: 1px solid #2a2a33; background: #17171f; font-weight: 600; text-align: left; }
  .qa:hover { border-color: #44444f; }
  .qa i { display: grid; place-items: center; width: 24px; height: 24px; border-radius: 7px; background: #0a0a0f; color: #a4d450; font-style: normal; }
  .tg { display: flex; align-items: center; gap: 8px; padding: 7px 0; }
  .sw { position: relative; width: 34px; height: 20px; flex-shrink: 0; }
  .sw input { opacity: 0; width: 0; height: 0; position: absolute; }
  .sw span { position: absolute; inset: 0; background: #3f4350; border-radius: 20px; transition: .15s; cursor: pointer; }
  .sw span::after { content: ""; position: absolute; width: 14px; height: 14px; left: 3px; top: 3px; border-radius: 50%; background: #fff; transition: .15s; }
  .sw input:checked + span { background: #a4d450; }
  .sw input:checked + span::after { transform: translateX(14px); background: #0a0a0f; }
  .pill { font-size: 11px; font-weight: 700; padding: 2px 7px; border-radius: 999px; display: inline-flex; align-items: center; gap: 5px; }
  .pill.on { background: rgba(164,212,80,.14); color: #c4e282; }
  .pill.off { background: rgba(239,68,68,.14); color: #fca5a5; }
  .pill i { width: 7px; height: 7px; border-radius: 50%; background: currentColor; }
  .qitem { padding: 8px 9px; border: 1px solid #23232a; border-radius: 10px; margin-bottom: 6px; }
  .qitem .txt { margin: 3px 0 6px; word-break: break-word; }
  .lrow { padding: 6px 0; border-bottom: 1px solid #1d1d24; font-size: 12px; }
  .chips { display: flex; gap: 4px; flex-wrap: wrap; margin-bottom: 8px; }
  .chip { border: 1px solid #2a2a33; background: #17171f; border-radius: 999px; padding: 3px 9px; font-size: 12px; }
  .chip.on { border-color: #a4d450; color: #c4e282; }
  .shopi { display: flex; gap: 9px; padding: 8px; border: 1px solid #23232a; border-radius: 11px; margin-bottom: 7px; }
  .shopi .img { width: 54px; height: 40px; border-radius: 7px; background: #0a0a0f; object-fit: cover; flex-shrink: 0; display: grid; place-items: center; color: #9a9aa5; }
  .shopi.sold { opacity: .5; }
  .duel { width: 330px; padding: 12px; border-color: #a4d450; }
  .duel .cd { font-variant-numeric: tabular-nums; color: #c4e282; font-weight: 800; }
  .chancebar { height: 6px; border-radius: 4px; background: #23232a; overflow: hidden; margin-top: 6px; }
  .chancebar i { display: block; height: 100%; background: #a4d450; }
  .toasts { position: fixed; display: flex; flex-direction: column; gap: 6px; width: 330px; }
  .toast { padding: 10px 12px; border-radius: 12px; background: #111116; border: 1px solid #2a2a33; box-shadow: 0 10px 30px rgba(0,0,0,.5); }
  .toast.good { border-color: #4d6b23; background: #121a0b; }
  .toast.bad { border-color: #6b2323; }
  .toast a, .link { color: #c4e282; text-decoration: underline; cursor: pointer; background: none; border: 0; padding: 0; }
  .mtool { position: fixed; display: flex; gap: 2px; padding: 3px; border-radius: 10px; }
  .mtool button { border: 0; background: transparent; padding: 5px 7px; border-radius: 7px; display: inline-flex; align-items: center; gap: 4px; color: #c7c7cf; font-weight: 600; font-size: 12px; }
  .mtool button:hover { background: #23232a; color: #fff; }
  .mtool .spam { color: #fca5a5; background: rgba(239,68,68,.12); }
  .x { border: 0; background: none; color: #9a9aa5; padding: 2px; display: grid; place-items: center; }
  .x:hover { color: #fff; }
  `;

  const hostEl = document.createElement("div");
  hostEl.id = "tejbot-ext-root";
  const shadow = hostEl.attachShadow({ mode: "closed" });
  shadow.innerHTML = `<style>${CSS}</style><div class="root"></div>`;
  const ROOT = shadow.querySelector(".root");
  const mount = () => {
    if (!hostEl.isConnected) document.documentElement.appendChild(hostEl);
  };

  // odznaky jsou přímo v chatu stránky -> malý styl do stránky
  const pageStyle = document.createElement("style");
  pageStyle.id = "tejbot-ext-style";
  pageStyle.textContent = `
  .tbx-b{display:inline-flex;align-items:center;gap:2px;vertical-align:middle;margin-right:4px;font:700 10px/1 system-ui,sans-serif;cursor:default}
  .tbx-b .tbx-t{display:inline-grid;place-items:center;width:15px;height:15px;border-radius:4px;background:#a4d450;color:#0a0a0f;font-size:10px}
  .tbx-b .tbx-l{display:inline-grid;place-items:center;min-width:17px;height:15px;padding:0 3px;border-radius:4px;border:1.5px solid var(--tbx-c,#6b6f7b);color:var(--tbx-c,#c7c7cf)}
  `;
  const mountStyle = () => {
    if (!pageStyle.isConnected) (document.head || document.documentElement).appendChild(pageStyle);
  };

  const el = (html) => {
    const d = document.createElement("div");
    d.innerHTML = html.trim();
    return d.firstElementChild;
  };
  const color = (s) => {
    let h = 0;
    for (const ch of String(s)) h = (h * 31 + ch.charCodeAt(0)) % 360;
    return `hsl(${h} 70% 62%)`;
  };
  const rar = (r) => (r >= 0 ? TB_RARITY[r] : null);

  // ------------------------------------------------------------------ chat: řádky, jména, odznaky
  function nameOf(row, u) {
    if (PLATFORM === "twitch") {
      const login = row.getAttribute("data-a-user") || row.querySelector("[data-a-user]")?.getAttribute("data-a-user");
      if (login) return login.toLowerCase();
    }
    const raw = (u?.getAttribute("title") || u?.textContent || "").replace(/[:\s]+$/, "").trim();
    const m = /[A-Za-z0-9_.-]{2,40}/.exec(raw);
    return m ? m[0].toLowerCase() : null;
  }
  function textOf(row, u) {
    const tx = first(row, SEL.text);
    let s = tx ? tx.textContent : row.textContent;
    if (!tx && u) {
      const i = s.indexOf(u.textContent);
      if (i >= 0) s = s.slice(i + u.textContent.length);
    }
    return s.replace(/^[\s:]+/, "").replace(/\s+/g, " ").trim().slice(0, 500);
  }

  const queued = new Set();
  let badgeTimer = null;
  function scan() {
    if (!S.slug) return;
    const rows = all(document, SEL.row).slice(-150);
    for (const row of rows) {
      if (row.dataset.tbx) {
        if (row.dataset.tbx !== "b") applyBadge(row);
        continue;
      }
      const u = first(row, SEL.user);
      const name = u && nameOf(row, u);
      if (!name) continue;
      row.dataset.tbx = "1";
      row.dataset.tbxName = name;
      u.dataset.tbxUser = name;
      u.addEventListener("mouseenter", () => hoverStart(name, u, row));
      u.addEventListener("mouseleave", hoverEnd);
      row.addEventListener("mouseenter", () => showTools(row));
      row.addEventListener("mouseleave", () => hideToolsSoon());
      if (!S.badges.has(name)) queued.add(name);
      applyBadge(row);
    }
    if (queued.size && !badgeTimer && S.settings.badges !== false) badgeTimer = setTimeout(fetchBadges, 800);
  }
  async function fetchBadges() {
    badgeTimer = null;
    const names = [...queued].slice(0, 120);
    names.forEach((n) => queued.delete(n));
    const r = (await ask({ t: "badges", platform: PLATFORM, names })) || {};
    for (const n of names) S.badges.set(n, r[n] || null);
    for (const row of all(document, SEL.row).slice(-150)) if (row.dataset.tbx === "1") applyBadge(row);
    if (queued.size) badgeTimer = setTimeout(fetchBadges, 800);
  }
  function applyBadge(row) {
    if (S.settings.badges === false) return;
    const name = row.dataset.tbxName;
    const b = name && S.badges.get(name);
    if (!b) return;
    const u = row.querySelector(`[data-tbx-user]`);
    if (!u || u.previousElementSibling?.classList?.contains("tbx-b")) return void (row.dataset.tbx = "b");
    const c = rar(b.r);
    const span = document.createElement("span");
    span.className = "tbx-b";
    span.title = `TejBot · ${t("level", { n: b.lv })}`;
    if (c) span.style.setProperty("--tbx-c", c);
    span.innerHTML = `${b.ext ? '<span class="tbx-t">T</span>' : ""}<span class="tbx-l">${Number(b.lv) || 1}</span>`;
    u.parentNode.insertBefore(span, u);
    row.dataset.tbx = "b";
  }

  // ------------------------------------------------------------------ karta hrdiny / diváka
  let hoverT = null;
  let hideT = null;
  let cardEl = null;
  function hoverStart(name, anchor, row) {
    clearTimeout(hideT);
    clearTimeout(hoverT);
    if (S.settings.badges === false && !S.mod) return;
    hoverT = setTimeout(() => openCard(name, anchor.getBoundingClientRect(), row), 450);
  }
  function hoverEnd() {
    clearTimeout(hoverT);
    hideT = setTimeout(closeCard, 350);
  }
  function closeCard() {
    cardEl?.remove();
    cardEl = null;
  }
  function place(node, rect, w, h) {
    // vedle jména: vlevo od chatu, když je chat vpravo
    let x = rect.left - w - 12;
    if (x < 8) x = Math.min(window.innerWidth - w - 8, rect.right + 12);
    let y = Math.min(Math.max(8, rect.top - 40), window.innerHeight - h - 8);
    node.style.left = `${Math.max(8, x)}px`;
    node.style.top = `${Math.max(8, y)}px`;
  }

  async function openCard(name, rect, row, focus = null) {
    closeCard();
    mount();
    cardEl = el(`<div class="box card"><div class="muted small">…</div></div>`);
    cardEl.addEventListener("mouseenter", () => clearTimeout(hideT));
    cardEl.addEventListener("mouseleave", () => (hideT = setTimeout(closeCard, 350)));
    ROOT.appendChild(cardEl);
    place(cardEl, rect, 320, 200);
    const me = cardEl;
    const text = row ? textOf(row, row.querySelector("[data-tbx-user]")) : "";
    const [card, info] = await Promise.all([heroCard(name), S.mod ? call("GET", `/api/ext/mod?op=viewer&platform=${PLATFORM}&slug=${encodeURIComponent(S.slug)}&name=${encodeURIComponent(name)}`, null, "web") : null]);
    if (cardEl !== me) return;
    renderCard(name, card, info, text, focus);
    place(cardEl, rect, 320, cardEl.offsetHeight || 300);
    if (S.mod) post({ type: "viewing", viewer: name, by: myName() });
  }
  async function heroCard(name) {
    const hit = S.cards.get(name);
    if (hit && Date.now() - hit.at < 60 * 1000) return hit.v;
    const v = await call("GET", `/ext/card?p=${PLATFORM}&n=${encodeURIComponent(name)}&slug=${encodeURIComponent(S.slug || "")}`);
    S.cards.set(name, { at: Date.now(), v });
    return v;
  }
  const myName = () => S.me?.accounts?.find((a) => a.platform === PLATFORM)?.name || S.me?.name || "?";
  const STATS = ["str", "def", "sta", "agi", "luck"];

  function renderCard(name, card, info, text, focus) {
    const h = card?.hero;
    const gear = Object.fromEntries((card?.gear || []).map((g) => [g.slot, g]));
    const iname = (i) => (["cs", "sk"].includes(TBI.lang()) ? i.cs : i.en);
    const m = S.mod;
    const perms = new Set(m?.perms || []);
    const handling = S.handling.get(name);
    let html = `<div class="row"><span class="av" style="background:${color(name)}">${esc(name.slice(0, 1).toUpperCase())}</span>
      <div class="grow"><div class="row"><span class="b" style="font-size:15px">${esc(name)}</span><span class="plat">${PLATFORM === "twitch" ? "Twitch" : "Kick"}</span></div>
      <div class="small muted">${
        info?.found
          ? esc([info.created ? t("accountAge", { age: TBI.age(info.created) }) : "", info.firstSeen ? t("firstSeen", { when: TBI.ago(info.firstSeen) }) : t("newHere")].filter(Boolean).join(" · "))
          : h
            ? esc(`${t("level", { n: h.level })} · ${t("winsLosses", { w: TBI.num(h.wins), l: TBI.num(h.losses) })}`)
            : ""
      }</div></div>
      <button class="x" data-a="close">${TBIcon("x", 16)}</button></div>`;
    if (h) {
      if (info?.found) html += `<div class="small muted" style="margin-top:8px">${esc(`TDuel · ${t("level", { n: h.level })} · ${t("winsLosses", { w: TBI.num(h.wins), l: TBI.num(h.losses) })}`)}</div>`;
      html += `<div class="stats">${STATS.map((k) => `<div class="stat"><b>${TBI.num(h.stats[k])}</b><span>${esc(t(`stat_${k}`))}</span></div>`).join("")}<div class="stat"><b>${TBI.num(h.hp)}</b><span>${esc(t("hp"))}</span></div></div>
        <div class="slots">${["sword", "helmet", "chest", "boots", "shield"]
          .map((s) => {
            const g = gear[s];
            if (!g) return `<span class="slot empty">${TBIcon(s, 16)}</span>`;
            const c = rar(g.rarity);
            return `<span class="slot" title="${esc(`${iname(g)} · ${t(`rar${g.rarity}`)} · ${t("lvl", { n: g.level })}`)}" style="border-color:${c};color:${c};background:color-mix(in srgb, ${c} 14%, transparent)">${TBIcon(s, 16)}</span>`;
          })
          .join("")}</div>`;
    } else if (!info?.found) html += `<p class="small muted" style="margin:10px 0 0">${esc(t("noHeroCard"))}</p>`;
    if (card?.points != null) html += `<div class="small" style="margin-top:8px;color:#c4e282">${esc(t("pointsHere", { n: TBI.num(card.points), cur: card.currency || "" }))}</div>`;
    html += `<div class="grid2" style="margin-top:10px"><button class="btn primary" data-a="challenge">${TBIcon("swords", 14)} ${esc(t("challenge"))}</button>${card?.url ? `<a class="btn" href="${esc(card.url)}" target="_blank">${TBIcon("external", 14)} ${esc(t("profile"))}</a>` : `<span></span>`}</div>`;

    // moderátor
    if (m && info?.found !== undefined) {
      html += `<div class="sep"></div>`;
      if (handling && handling.by !== myName() && Date.now() - handling.at < 90 * 1000) html += `<div class="warn">${esc(t("handling", { by: handling.by, viewer: name }))}</div>`;
      if (info?.found) html += `<div class="stats" style="grid-template-columns:repeat(3,1fr)"><div class="stat"><b style="color:#fb923c">${info.timeouts}</b><span>${esc(t("timeouts"))}</span></div><div class="stat"><b>${info.bans}</b><span>${esc(t("bans"))}</span></div><div class="stat"><b>${info.messages != null ? TBI.num(info.messages) : "–"}</b><span>${esc(t("messages"))}</span></div></div>`;
      if (perms.has("notes") && info?.found) {
        html += `<div class="h">${esc(t("notes"))}</div>${(info.notes || [])
          .slice(0, 4)
          .map((n) => `<div class="note"><div class="small"><b>${esc(n.by)}</b> <span class="muted">· ${esc(TBI.ago(n.at))}</span></div><div>${esc(n.text)}</div></div>`)
          .join("")}<input class="field" data-a="note" maxlength="500" placeholder="${esc(t("addNote"))}">`;
      }
      if (perms.has("timeout") && (m.reasons || []).length) {
        html += `<div class="h" ${focus === "timeout" ? 'style="color:#fb923c"' : ""}>${esc(t("quickTimeout"))}</div>${m.reasons
          .map((r, i) => `<button class="reason" data-a="to" data-i="${i}"><span>${esc(["cs", "sk"].includes(TBI.lang()) ? r.cs : r.en || r.cs)}</span><b>${esc(TBI.dur(r.minutes))}</b></button>`)
          .join("")}`;
      }
      const btns = [];
      if (perms.has("delete") && text) btns.push(`<button class="btn" data-a="del">${TBIcon("trash", 14)} ${esc(t("deleteMsg"))}</button>`);
      if (perms.has("ban")) btns.push(`<button class="btn red" data-a="ban">${TBIcon("ban", 14)} ${esc(t("ban"))}</button>`);
      if (btns.length) html += `<div class="grid2" style="margin-top:8px">${btns.join("")}</div>`;
      if (perms.has("ban") && info?.bans > 0) html += `<div style="margin-top:6px;text-align:center"><button class="link small" data-a="unban">${esc(t("unban"))}</button></div>`;
    }
    cardEl.innerHTML = html;
    cardEl.onclick = async (e) => {
      const b = e.target.closest("[data-a]");
      if (!b || b.tagName === "INPUT") return;
      const a = b.dataset.a;
      if (a === "close") return closeCard();
      if (a === "challenge") {
        closeCard();
        return typeIntoChat(`!duel ${name} `);
      }
      if (a === "to") {
        const r = m.reasons[Number(b.dataset.i)];
        return modAct({ op: "timeout", username: name, minutes: r.minutes, reason: ["cs", "sk"].includes(TBI.lang()) ? r.cs : r.en || r.cs, text, userId: info?.userId }, b);
      }
      if (a === "del") return modAct({ op: "delete", username: name, text }, b);
      if (a === "ban") {
        if (!confirm(t("confirmBan", { name }))) return;
        return modAct({ op: "ban", username: name, reason: "", text, userId: info?.userId }, b);
      }
      if (a === "unban") return modAct({ op: "unban", username: name, userId: info?.userId }, b);
    };
    const noteIn = cardEl.querySelector("[data-a=note]");
    noteIn?.addEventListener("keydown", async (e) => {
      e.stopPropagation();
      if (e.key !== "Enter" || !noteIn.value.trim()) return;
      noteIn.disabled = true;
      const r = await call("POST", "/api/ext/mod", { platform: PLATFORM, slug: S.slug, op: "note", username: name, note: noteIn.value.trim() }, "web");
      toast(codeText(r), r?.ok ? "good" : "bad");
      if (r?.ok) openCard(name, cardEl.getBoundingClientRect(), null);
      else noteIn.disabled = false;
    });
  }

  async function modAct(body, btn) {
    if (btn) btn.disabled = true;
    const r = await call("POST", "/api/ext/mod", { platform: PLATFORM, slug: S.slug, ...body }, "web");
    if (btn) btn.disabled = false;
    toast(r?.ok && body.op === "timeout" ? `${body.username}: ${TBI.dur(body.minutes)} · ${body.reason}` : codeText(r), r?.ok ? "good" : "bad");
    if (r?.ok && ["timeout", "ban", "delete"].includes(body.op)) closeCard();
    if (r?.ok && S.panel === "log") renderPanel();
    return r;
  }

  /** Vloží text do pole pro zprávu (divák ho jen odešle Enterem) */
  function typeIntoChat(text) {
    const input = first(document, SEL.input);
    if (!input) return void toast(text, "");
    input.focus();
    if (input.tagName === "TEXTAREA" || input.tagName === "INPUT") {
      const set = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), "value")?.set;
      set ? set.call(input, text) : (input.value = text);
      input.dispatchEvent(new Event("input", { bubbles: true }));
      return;
    }
    const sel = window.getSelection();
    sel.selectAllChildren(input);
    document.execCommand("insertText", false, text);
  }

  // ------------------------------------------------------------------ nástroje u zprávy (moderátor)
  let toolEl = null;
  let toolRow = null;
  let toolT = null;
  function showTools(row) {
    clearTimeout(toolT);
    const perms = new Set(S.mod?.perms || []);
    if (!S.mod || !(perms.has("spam") || perms.has("delete") || perms.has("timeout") || perms.has("ban"))) return;
    toolRow = row;
    mount();
    if (!toolEl) {
      toolEl = el(`<div class="box mtool"></div>`);
      toolEl.addEventListener("mouseenter", () => clearTimeout(toolT));
      toolEl.addEventListener("mouseleave", () => hideToolsSoon());
      toolEl.addEventListener("click", onTool);
      ROOT.appendChild(toolEl);
    }
    toolEl.innerHTML = [
      perms.has("spam") ? `<button class="spam" data-a="spam" title="${esc(t("spam"))}">${TBIcon("flag", 14)} ${esc(t("spam"))}</button>` : "",
      perms.has("delete") ? `<button data-a="del" title="${esc(t("deleteMsg"))}">${TBIcon("trash", 14)}</button>` : "",
      perms.has("timeout") ? `<button data-a="to" title="${esc(t("quickTimeout"))}">${TBIcon("clock", 14)}</button>` : "",
      perms.has("ban") ? `<button data-a="ban" title="${esc(t("ban"))}">${TBIcon("ban", 14)}</button>` : "",
    ].join("");
    const r = row.getBoundingClientRect();
    toolEl.style.display = "flex";
    const w = toolEl.offsetWidth || 160;
    toolEl.style.left = `${Math.max(8, r.right - w - 6)}px`;
    toolEl.style.top = `${Math.max(8, r.top - 30)}px`;
  }
  function hideToolsSoon() {
    clearTimeout(toolT);
    toolT = setTimeout(() => toolEl && (toolEl.style.display = "none"), 250);
  }
  async function onTool(e) {
    const b = e.target.closest("[data-a]");
    if (!b || !toolRow) return;
    const row = toolRow;
    const name = row.dataset.tbxName;
    const text = textOf(row, row.querySelector("[data-tbx-user]"));
    const a = b.dataset.a;
    if (a === "spam") {
      b.disabled = true;
      const r = await call("POST", "/api/ext/mod", { platform: PLATFORM, slug: S.slug, op: "spam", username: name, text }, "web");
      b.disabled = false;
      if (!r?.ok) return void toast(codeText(r), "bad");
      toolEl.style.display = "none";
      row.style.opacity = "0.35";
      toast(`<b style="color:#c4e282">TejBot:</b> ${esc(t("spamDone"))} <button class="link" data-undo="1">${esc(t("undo"))}</button>`, "good", 9000, async (box) => {
        box.innerHTML = esc(codeText(await call("POST", "/api/ext/mod", { platform: PLATFORM, slug: S.slug, op: "unspam", username: name, text }, "web")));
        row.style.opacity = "";
      }, true);
      return;
    }
    if (a === "del") {
      const r = await modAct({ op: "delete", username: name, text }, b);
      if (r?.ok) row.style.opacity = "0.35";
      return;
    }
    if (a === "to") return openCard(name, row.getBoundingClientRect(), row, "timeout");
    if (a === "ban") {
      if (!confirm(t("confirmBan", { name }))) return;
      return modAct({ op: "ban", username: name, reason: "", text }, b);
    }
  }

  // ------------------------------------------------------------------ oznámení (toasty)
  let toastsEl = null;
  function toast(html, kind = "", ms = 4500, onUndo = null, raw = false) {
    mount();
    if (!toastsEl) {
      toastsEl = el(`<div class="toasts"></div>`);
      ROOT.appendChild(toastsEl);
    }
    placeAbove(toastsEl, 330, 12);
    const box = el(`<div class="toast ${kind}">${raw ? html : esc(html)}</div>`);
    toastsEl.appendChild(box);
    if (onUndo) box.querySelector("[data-undo]")?.addEventListener("click", () => onUndo(box));
    setTimeout(() => box.remove(), ms);
    return box;
  }

  /** Umístí prvek nad pole pro zprávu (nebo do rohu, když pole není) */
  function anchorRect() {
    const box = first(document, SEL.inputBox) || first(document, SEL.input)?.parentElement || first(document, SEL.chat);
    const r = box?.getBoundingClientRect();
    if (r && r.width > 50 && r.bottom > 0) return r;
    return { left: window.innerWidth - 360, right: window.innerWidth - 10, top: window.innerHeight - 70, bottom: window.innerHeight - 10, width: 350 };
  }
  function placeAbove(node, w, gap = 46) {
    const r = anchorRect();
    node.style.left = `${Math.max(8, Math.min(window.innerWidth - w - 8, r.right - w))}px`;
    node.style.bottom = `${Math.max(8, window.innerHeight - r.top + gap)}px`;
    node.style.top = "";
  }

  // ------------------------------------------------------------------ tlačítko TejBot a panel
  let launchEl = null;
  function placeLauncher() {
    if (!S.slug || !document.body) {
      launchEl?.remove();
      launchEl = null;
      return;
    }
    mount();
    if (!launchEl) {
      launchEl = el(`<button class="launch" title="TejBot">${TBLogo(28)}</button>`);
      launchEl.addEventListener("click", () => togglePanel());
      ROOT.appendChild(launchEl);
    }
    const r = anchorRect();
    launchEl.style.left = `${Math.max(4, r.right - 34)}px`;
    launchEl.style.top = `${Math.max(4, r.top - 36)}px`;
    if (panelEl) placeAbove(panelEl, 340, 44);
    if (duelEl) placeAbove(duelEl, 330, panelEl ? 60 + panelEl.offsetHeight : 44);
    if (toastsEl) placeAbove(toastsEl, 330, (duelEl ? duelEl.offsetHeight + 56 : 44) + (panelEl ? panelEl.offsetHeight + 8 : 0));
  }

  let panelEl = null;
  function togglePanel(tab) {
    if (panelEl && !tab) {
      panelEl.remove();
      panelEl = null;
      S.panel = null;
      return;
    }
    S.panel = tab || (S.mod ? "actions" : "shop");
    if (!panelEl) {
      panelEl = el(`<div class="box panel"></div>`);
      ROOT.appendChild(panelEl);
      panelEl.addEventListener("click", onPanelClick);
      panelEl.addEventListener("change", onPanelChange);
      panelEl.addEventListener("keydown", (e) => e.stopPropagation());
    }
    placeAbove(panelEl, 340, 44);
    renderPanel();
  }

  async function renderPanel() {
    if (!panelEl) return;
    const m = S.mod;
    const perms = new Set(m?.perms || []);
    const tabs = [["shop", "bag", t("shop")]];
    if (m) tabs.unshift(["actions", "zap", t("actions")]);
    if (perms.has("queue")) tabs.push(["queue", "list", t("queue")]);
    if (perms.has("log")) tabs.push(["log", "file", t("log")]);
    if (!tabs.some((x) => x[0] === S.panel)) S.panel = tabs[0][0];
    panelEl.innerHTML = `<div class="phead">${TBLogo(22)}<span class="ttl">TejBot</span>${m ? `<span class="pill ${m.bot === "online" ? "on" : "off"}"><i></i>${esc(m.bot === "online" ? t("botOn") : t("botOff"))}</span>` : ""}<button class="x" data-a="close">${TBIcon("x", 16)}</button></div>
      ${tabs.length > 1 ? `<div class="ptabs">${tabs.map(([k, ic, lb]) => `<button class="ptab ${S.panel === k ? "on" : ""}" data-tab="${k}">${TBIcon(ic, 14)} ${esc(lb)}</button>`).join("")}</div>` : ""}
      <div class="pbody"><div class="muted small">…</div></div>`;
    const body = panelEl.querySelector(".pbody");
    const which = S.panel;
    let html = "";
    if (which === "actions") html = await actionsView();
    else if (which === "queue") html = await queueView();
    else if (which === "log") html = await logView();
    else html = await shopView();
    if (!panelEl || S.panel !== which) return;
    body.innerHTML = html;
    placeLauncher();
  }

  async function actionsView() {
    const fresh = await call("GET", `/api/ext/mod?op=state&platform=${PLATFORM}&slug=${encodeURIComponent(S.slug)}`, null, "web");
    if (fresh?.ok) S.mod = fresh;
    const m = S.mod;
    if (!m) return "";
    const perms = new Set(m.perms || []);
    const Q = [
      ["alert_skip", "skip", t("q_alert_skip")],
      ["tts_skip", "mute", t("q_tts_skip")],
      ["countdown", "timer", t("q_countdown")],
      ["song_skip", "music", t("q_song_skip")],
      ["minigame", "game", t("q_minigame")],
      ["rain", "gift", t("q_rain")],
    ].filter(([k]) => perms.has(k));
    const TG = [
      ["timers", "clock", t("t_timers")],
      ["replies", "message", t("t_replies")],
      ["spam", "shield", t("t_spam")],
      ["tduel", "swords", t("t_tduel")],
    ];
    let html = `<div class="small muted">${esc(t("roleAs", { role: t(`role_${m.role}`) }))}</div>`;
    if (Q.length) html += `<div class="grid2" style="margin-top:8px">${Q.map(([k, ic, lb]) => `<button class="qa" data-q="${k}"><i>${TBIcon(ic, 14)}</i>${esc(lb)}</button>`).join("")}</div>`;
    if (perms.has("rain")) html += `<div data-rain style="display:none;margin-top:8px"><div class="small muted">${esc(t("rainAmount"))}</div><div class="row" style="margin-top:5px"><input class="field" type="number" min="1" max="100000" value="100" data-rainv style="border-style:solid"><button class="btn primary sm" data-q="rain_go">${esc(t("give"))}</button></div></div>`;
    if (perms.has("toggles")) html += `<div class="sep"></div>${TG.map(([k, ic, lb]) => `<div class="tg">${TBIcon(ic, 15)}<span class="grow">${esc(lb)}</span><label class="sw"><input type="checkbox" data-tg="${k}" ${m.toggles[k] ? "checked" : ""}><span></span></label></div>`).join("")}`;
    if (m.role !== "mod" || perms.has("log")) html += `<div class="sep"></div><div class="row"><div class="grow"><div class="small muted">${esc(t("spamToday"))}</div><div class="b" style="font-size:18px">${esc(t("spamCount", { n: TBI.num(m.spamToday) }))}</div></div><span class="small muted">${esc(t("rules", { n: m.rules }))}</span></div>`;
    if (m.role !== "mod") html += `<a class="btn" style="width:100%;margin-top:12px" target="_blank" href="${esc((await webBase()) + m.dashboard)}">${TBIcon("external", 14)} ${esc(t("openDash"))}</a>`;
    return html;
  }
  let webCache = null;
  async function webBase() {
    if (!webCache) webCache = (await ask({ t: "state" }))?.web || "https://tejbot.eu";
    return webCache;
  }

  async function queueView() {
    const r = await call("GET", `/api/ext/mod?op=queue&platform=${PLATFORM}&slug=${encodeURIComponent(S.slug)}`, null, "web");
    if (!r?.ok) return `<div class="small muted">${esc(codeText(r))}</div>`;
    const m = S.mod;
    let html = "";
    if (m?.queue && !m.queue.ttsManual) html += `<div class="small muted" style="margin-bottom:8px">${esc(t("manualOff"))}</div>`;
    const items = [...r.tts.map((x) => ({ ...x, kind: "tts" })), ...r.media.map((x) => ({ ...x, kind: "media" }))];
    if (!items.length) return html + `<div class="small muted">${esc(t("queueEmpty"))}</div>`;
    html += items
      .map(
        (x) => `<div class="qitem"><div class="row small"><span class="plat">${x.kind === "tts" ? "TTS" : esc(t("video"))}</span><b>${esc(x.user)}</b><span class="muted grow">${x.kind === "media" ? esc(x.status === "playing" ? t("playing") : x.status === "approved" ? t("approved") : t("waiting")) : ""}</span></div>
        <div class="txt">${esc(x.kind === "tts" ? x.text : x.title)}</div>
        <div class="row">${x.status === "playing" ? `<button class="btn sm" data-qk="${x.kind}" data-qw="skip" data-id="${x.id}">${TBIcon("skip", 12)} ${esc(t("skip"))}</button>` : `${x.kind === "tts" || x.status === "pending" ? `<button class="btn sm primary" data-qk="${x.kind}" data-qw="approve" data-id="${x.id}">${TBIcon("check", 12)} ${esc(t("approve"))}</button>` : ""}<button class="btn sm ghostred" data-qk="${x.kind}" data-qw="reject" data-id="${x.id}">${TBIcon("trash", 12)} ${esc(t("reject"))}</button>`}
        ${x.cost > 0 && x.status !== "playing" ? `<span class="tiny muted">${esc(t("refundHint", { n: TBI.num(x.cost) }))}</span>` : ""}</div></div>`
      )
      .join("");
    return html;
  }

  async function logView() {
    const r = await call("GET", `/api/ext/mod?op=log&filter=${S.logFilter}&platform=${PLATFORM}&slug=${encodeURIComponent(S.slug)}`, null, "web");
    const chips = `<div class="chips">${["all", "timeouts", "bans", "queue"].map((f) => `<button class="chip ${S.logFilter === f ? "on" : ""}" data-lf="${f}">${esc(t(`f_${f}`))}</button>`).join("")}</div>`;
    if (!r?.ok) return chips + `<div class="small muted">${esc(codeText(r))}</div>`;
    if (!r.rows.length) return chips + `<div class="small muted">${esc(t("logEmpty"))}</div>`;
    return (
      chips +
      r.rows
        .map((x) => {
          const act = TBI.has(`act_${x.action}`) ? t(`act_${x.action}`) : x.by === "TejBot" ? t("act_delete_auto") : x.action;
          const time = new Date(x.at).toLocaleTimeString(TBI.lang() === "en" ? "en-GB" : TBI.lang(), { hour: "2-digit", minute: "2-digit" });
          return `<div class="lrow"><span class="muted">${esc(time)}</span> <b>${esc(x.by)}</b> → <b>${esc(x.user)}</b> · ${esc(act)}${x.minutes ? ` ${esc(TBI.dur(x.minutes))}` : ""}${x.reason ? ` <span class="muted">· ${esc(x.reason)}</span>` : ""}</div>`;
        })
        .join("")
    );
  }

  async function shopView() {
    if (!S.connected) return `<div class="small soft">${esc(t("notConnected"))}</div><a class="btn primary" style="margin-top:10px" target="_blank" href="${esc(await webBase())}/rozsireni">${esc(t("connect"))}</a>`;
    const r = await call("GET", `/ext/shop?platform=${PLATFORM}&slug=${encodeURIComponent(S.slug)}`);
    if (!r?.ok) return `<div class="small muted">${esc(r?.error === "channel" ? t("noTejbot") : codeText(r))}</div>`;
    S.shop = r;
    let html = r.points != null ? `<div class="small" style="margin-bottom:8px">${esc(t("have", { n: TBI.num(r.points), cur: r.currency }))}</div>` : !r.account ? `<div class="small muted" style="margin-bottom:8px">${esc(t("needAccount"))}</div>` : "";
    if (!r.items.length) return html + `<div class="small muted">${esc(t("shopEmpty"))}</div>`;
    html += r.items
      .map((it) => {
        const sold = it.stock !== null && it.stock <= 0;
        const miss = r.points != null && it.currency === "points" ? Math.max(0, it.cost - r.points) : 0;
        const img = it.image && !/\.(mp4|webm)(\?|$)/i.test(it.image) ? `<img class="img" src="${esc(it.image)}" alt="">` : `<span class="img">${TBIcon("bag", 18)}</span>`;
        return `<div class="shopi ${sold ? "sold" : ""}">${img}<div class="grow"><div class="b">${esc(it.name)}</div>${it.description ? `<div class="tiny muted">${esc(it.description)}</div>` : ""}
          <div class="row" style="margin-top:4px"><span class="b" style="color:#c4e282">${TBI.num(it.cost)}</span><span class="tiny muted grow">${it.currency === "kick" ? "" : esc(r.currency)}${sold ? ` · ${esc(t("soldOut"))}` : it.stock !== null ? ` · ${esc(t("left", { n: it.stock }))}` : ""}${miss ? ` · ${esc(t("missing", { n: TBI.num(miss) }))}` : ""}</span>
          ${it.currency === "kick" ? "" : `<button class="btn sm primary" data-buy="${it.number}" ${sold || miss || !r.account ? "disabled" : ""}>${esc(t("buy"))}</button>`}</div>
          ${it.currency === "kick" ? `<div class="tiny muted">${esc(t("kickOnly"))}</div>` : ""}
          ${it.needsInput ? `<div data-in="${it.number}" style="display:none;margin-top:6px" class="row"><input class="field" style="border-style:solid" maxlength="200" placeholder="${esc(it.kind === "timeout" ? t("targetPh") : t("inputPh"))}"><button class="btn sm primary" data-buygo="${it.number}">${esc(t("buy"))}</button></div>` : ""}
          </div></div>`;
      })
      .join("");
    return html;
  }

  async function onPanelClick(e) {
    const b = e.target.closest("button");
    if (!b) return;
    if (b.dataset.a === "close") return togglePanel();
    if (b.dataset.tab) {
      S.panel = b.dataset.tab;
      return renderPanel();
    }
    if (b.dataset.lf) {
      S.logFilter = b.dataset.lf;
      return renderPanel();
    }
    const q = b.dataset.q;
    if (q === "rain") {
      const box = panelEl.querySelector("[data-rain]");
      if (box) box.style.display = box.style.display === "none" ? "block" : "none";
      return;
    }
    if (q) {
      b.disabled = true;
      const body = q === "rain_go" ? { op: "rain", amount: Number(panelEl.querySelector("[data-rainv]")?.value) || 0 } : q === "countdown" ? { op: "countdown", minutes: 5 } : { op: q };
      const r = await call("POST", "/api/ext/mod", { platform: PLATFORM, slug: S.slug, ...body }, "web");
      b.disabled = false;
      toast(r?.code === "rain_done" ? t("c_rain_done", { n: r.count }) : codeText(r), r?.ok ? "good" : "bad");
      return;
    }
    if (b.dataset.qk) {
      b.disabled = true;
      const r = await call("POST", "/api/ext/mod", { platform: PLATFORM, slug: S.slug, op: "queue", kind: b.dataset.qk, what: b.dataset.qw, id: Number(b.dataset.id) }, "web");
      toast(codeText(r), r?.ok ? "good" : "bad");
      return renderPanel();
    }
    const num = b.dataset.buy || b.dataset.buygo;
    if (num) {
      const it = S.shop?.items.find((x) => String(x.number) === String(num));
      const inBox = panelEl.querySelector(`[data-in="${num}"]`);
      if (b.dataset.buy && it?.needsInput && inBox) {
        inBox.style.display = "flex";
        inBox.querySelector("input")?.focus();
        return;
      }
      const input = inBox?.querySelector("input")?.value?.trim() || "";
      if (it?.needsInput && !input) return inBox?.querySelector("input")?.focus();
      b.disabled = true;
      const r = await call("POST", "/ext/shop/buy", { platform: PLATFORM, slug: S.slug, number: Number(num), input });
      toast(r?.ok ? t("bought") : r?.error ? codeText(r) : t("buyFailed"), r?.ok ? "good" : "bad");
      return renderPanel();
    }
  }
  async function onPanelChange(e) {
    const k = e.target.dataset?.tg;
    if (!k) return;
    e.target.disabled = true;
    const r = await call("POST", "/api/ext/mod", { platform: PLATFORM, slug: S.slug, op: "toggle", key: k, on: e.target.checked }, "web");
    e.target.disabled = false;
    if (!r?.ok) e.target.checked = !e.target.checked;
    else if (S.mod) S.mod.toggles[k] = e.target.checked;
    toast(codeText(r), r?.ok ? "good" : "bad");
  }

  // ------------------------------------------------------------------ výzva na duel a výsledek
  let duelEl = null;
  let duelTick = null;
  const sameChannel = (ev) => (ev.platform || PLATFORM) === PLATFORM && String(ev.slug || "").toLowerCase() === S.slug;

  function onPersonal(ev) {
    if (ev.type === "challenge" && sameChannel(ev)) return showChallenge(ev);
    if (ev.type === "challenge_end" && S.challenge && ev.ch === S.challenge.ch) return hideChallenge();
    if (ev.type === "result" && sameChannel(ev)) return showResult(ev);
  }
  function showChallenge(ev) {
    S.challenge = ev;
    mount();
    // výzva je důležitější než otevřený panel
    if (panelEl) togglePanel();
    hideChallenge(true);
    duelEl = el(`<div class="box duel"></div>`);
    ROOT.appendChild(duelEl);
    const draw = () => {
      const left = Math.max(0, Math.ceil((ev.expires - Date.now()) / 1000));
      if (!left) return hideChallenge();
      duelEl.innerHTML = `<div class="row">${TBIcon("swords", 18, 'style="color:#a4d450"')}<span class="b grow">${esc(t("challengeTitle", { from: ev.from }))}</span><span class="cd">${left} s</span></div>
        <div class="small soft" style="margin-top:4px">${esc(ev.amount > 0 ? t("stake", { amount: TBI.num(ev.amount), cur: ev.currency }) : t("friendly"))}${ev.fromLevel ? ` · ${esc(ev.from)} ${esc(t("lvl", { n: ev.fromLevel }))}` : ""}</div>
        ${typeof ev.chance === "number" ? `<div class="small muted" style="margin-top:6px">${esc(t("chance", { n: ev.chance }))}</div><div class="chancebar"><i style="width:${Math.max(3, Math.min(97, ev.chance))}%"></i></div>` : ""}
        <div class="grid2" style="margin-top:10px"><button class="btn primary" data-d="accept">${TBIcon("check", 14)} ${esc(t("accept"))}</button><button class="btn" data-d="deny">${TBIcon("x", 14)} ${esc(t("deny"))}</button></div>`;
    };
    draw();
    duelTick = setInterval(draw, 1000);
    duelEl.addEventListener("click", async (e) => {
      const b = e.target.closest("[data-d]");
      if (!b) return;
      duelEl.querySelectorAll("button").forEach((x) => (x.disabled = true));
      const op = b.dataset.d;
      const r = await call("POST", "/ext/duel", { platform: PLATFORM, slug: S.slug, op });
      hideChallenge();
      toast(r?.ok ? t(op === "accept" ? "duelAccepted" : "duelDenied") : r?.error ? codeText(r) : t("duelFailed"), r?.ok ? "good" : "bad");
    });
    placeLauncher();
  }
  function hideChallenge(keep = false) {
    clearInterval(duelTick);
    duelEl?.remove();
    duelEl = null;
    if (!keep) S.challenge = null;
  }
  function showResult(ev) {
    const gains = [];
    if (ev.win && ev.bet > 0) gains.push(t("gainedPts", { n: TBI.num(ev.bet * 2), cur: ev.currency }));
    if (ev.xp > 0) gains.push(t("gainedXp", { n: TBI.num(ev.xp) }));
    if (ev.levelUp) gains.push(t("levelUp", { n: ev.levelUp }));
    let html = `<div class="b" style="color:${ev.win ? "#c4e282" : "#fca5a5"}">${esc(ev.win ? t("won", { opp: ev.opponent }) : t("lost", { opp: ev.opponent }))}</div>${gains.length ? `<div class="small soft">${esc(gains.join(" · "))}</div>` : ""}`;
    const d = ev.drop;
    if (d && d.full) html += `<div class="small" style="margin-top:6px">${esc(t("bagFull"))}</div>`;
    else if (d) {
      const c = rar(d.rarity);
      html += `<div class="row" style="margin-top:8px"><span class="slot" style="width:34px;border-color:${c};color:${c}">${TBIcon("gift", 16)}</span><div class="grow"><div class="b" style="color:${c}">${esc(d.name)}</div><div class="tiny muted">${esc(`${t(`rar${d.rarity}`)} · ${t("lvl", { n: d.level })} · ${t("quality", { n: d.quality })}`)}</div></div></div>
        <div class="grid2" style="margin-top:8px"><button class="btn primary sm" data-undo="1">${esc(t("equip"))}</button><button class="btn sm" data-later="1">${esc(t("later"))}</button></div>`;
    }
    const box = toast(html, ev.win ? "good" : "", d && !d.full ? 20000 : 7000, d && !d.full ? async (b) => {
      const r = await call("POST", "/ext/hero", { op: "equip", item: d.id });
      b.innerHTML = esc(r?.ok ? t("equipped") : codeText(r));
      setTimeout(() => b.remove(), 1500);
    } : null, true);
    box.querySelector("[data-later]")?.addEventListener("click", () => box.remove());
  }

  // ------------------------------------------------------------------ moderátoři: živé události
  function onModEvent(ev) {
    if (ev.type === "viewing" && ev.viewer && ev.by && ev.by !== myName()) {
      S.handling.set(String(ev.viewer).toLowerCase(), { by: ev.by, at: Date.now() });
    }
    if (ev.type === "queue" && S.panel === "queue") renderPanel();
    if (ev.type === "log" && S.panel === "log") renderPanel();
    if (ev.type === "queue" && launchEl && S.panel !== "queue" && new Set(S.mod?.perms || []).has("queue")) {
      launchEl.querySelector(".dotn")?.remove();
      launchEl.insertAdjacentHTML("beforeend", `<span class="dotn">!</span>`);
    }
  }

  // ------------------------------------------------------------------ start a hlídání stránky
  async function loadMod() {
    S.mod = null;
    if (!S.connected || !S.slug) return;
    const r = await call("GET", `/api/ext/mod?op=state&platform=${PLATFORM}&slug=${encodeURIComponent(S.slug)}`, null, "web");
    if (r?.ok) {
      S.mod = r;
      post({ type: "mod", topic: r.topic });
    } else post({ type: "mod", topic: null });
  }

  async function boot() {
    const st = await ask({ t: "state" });
    if (!st) return;
    S.connected = !!st.connected;
    S.me = st.me;
    S.settings = st.settings || S.settings;
    TBI.setLang(S.settings.lang || "auto");
    const cfg = await ask({ t: "config" });
    if (cfg?.[PLATFORM]) SEL = { ...SEL, ...cfg[PLATFORM] };
    S.slug = currentSlug();
    hello();
    await loadMod();
    if (panelEl) renderPanel();
  }

  let lastPath = location.pathname;
  setInterval(() => {
    if (!alive()) return;
    mountStyle();
    if (location.pathname !== lastPath) {
      lastPath = location.pathname;
      S.slug = currentSlug();
      hideChallenge();
      if (panelEl) togglePanel();
      hello();
      void loadMod();
    }
    placeLauncher();
  }, 1000);
  // moderátorský kanál se pravidelně mění (odebraný moderátor ho nemůže poslouchat napořád) -> obnovit každých 30 min
  setInterval(() => {
    if (alive() && S.mod) void loadMod();
  }, 30 * 60 * 1000);
  // nové zprávy: kontrola nejvýš 4× za vteřinu
  let scanQueued = false;
  new MutationObserver(() => {
    if (scanQueued) return;
    scanQueued = true;
    setTimeout(() => {
      scanQueued = false;
      if (alive()) scan();
    }, 250);
  }).observe(document.documentElement, { childList: true, subtree: true });
  chrome.storage?.onChanged?.addListener((ch) => {
    if (ch.settings || ch.auth) void boot();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closeCard();
  });

  mountStyle();
  connectPort();
  void boot().then(scan);
})();
