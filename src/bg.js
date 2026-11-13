// Pozadí rozšíření: přihlášení, dotazy na TejBot, živé spojení (výzvy na duel, výsledky, fronta)
// a upozornění prohlížeče. Okno rozšíření i chat na Kicku / Twitchi se ptají sem.
importScripts("i18n.js", "icons.js");

const DEF_SETTINGS = { nChallenge: true, nResult: true, nDrop: true, badges: true, lang: "auto" };
const DEF_API = "https://api.tejbot.eu";
const DEF_WEB = "https://tejbot.eu";

// ------------------------------------------------------------------ úložiště
async function load() {
  const s = await chrome.storage.local.get(["auth", "me", "settings"]);
  const settings = { ...DEF_SETTINGS, ...(s.settings || {}) };
  TBI.setLang(settings.lang);
  return { auth: s.auth || null, me: s.me || null, settings };
}
async function saveSettings(patch) {
  const { settings } = await load();
  const next = { ...settings, ...patch };
  await chrome.storage.local.set({ settings: next });
  TBI.setLang(next.lang);
  return next;
}

// ------------------------------------------------------------------ dotazy
async function api(base, method, path, body) {
  const { auth } = await load();
  const root = base === "web" ? auth?.web || DEF_WEB : auth?.api || DEF_API;
  const headers = { "Content-Type": "application/json" };
  if (auth?.token) headers.Authorization = `Bearer ${auth.token}`;
  let r;
  try {
    r = await fetch(`${root}${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined, cache: "no-store" });
  } catch {
    return { ok: false, code: "offline", status: 0 };
  }
  const json = await r.json().catch(() => ({}));
  // token už neplatí (odhlášeno na webu) -> rozšíření se odhlásí
  if (r.status === 401 && auth?.token) await logout(false);
  return { status: r.status, ...(json && typeof json === "object" ? json : {}), ok: r.ok && json?.ok !== false };
}

async function getMe(force = false) {
  const { auth, me } = await load();
  if (!auth?.token) return null;
  if (!force && me && Date.now() - (me.at || 0) < 10 * 60 * 1000) return me;
  const r = await api("api", "GET", "/ext/me");
  if (!r.ok) return me;
  const next = { ...r, at: Date.now() };
  await chrome.storage.local.set({ me: next });
  return next;
}

async function logout(callServer = true) {
  if (callServer) await api("api", "POST", "/ext/logout", {}).catch(() => null);
  await chrome.storage.local.remove(["auth", "me"]);
  rt.close();
  broadcastPorts({ type: "auth", connected: false });
}

// výběry prvků na stránkách (Kick / Twitch mění vzhled, oprava přijde ze serveru bez nové verze)
let cfgCache = null;
async function config() {
  if (cfgCache && Date.now() - cfgCache.at < 60 * 60 * 1000) return cfgCache.v;
  const st = await chrome.storage.local.get(["cfg"]);
  const r = await api("api", "GET", "/ext/config");
  if (r.selectors) {
    cfgCache = { at: Date.now(), v: r.selectors };
    await chrome.storage.local.set({ cfg: r.selectors });
  } else if (st.cfg) cfgCache = { at: Date.now() - 50 * 60 * 1000, v: st.cfg };
  return cfgCache?.v ?? null;
}

// odznaky: dotazy z chatu se slučují a pamatují
const badgeMem = new Map(); // platform:name -> { v, at }
async function badges(platform, names) {
  const out = {};
  const need = [];
  for (const n of names) {
    const k = `${platform}:${n}`;
    const hit = badgeMem.get(k);
    if (hit && Date.now() - hit.at < 5 * 60 * 1000) {
      if (hit.v) out[n] = hit.v;
    } else need.push(n);
  }
  for (let i = 0; i < need.length; i += 60) {
    const part = need.slice(i, i + 60);
    const r = await api("api", "GET", `/ext/badges?p=${platform}&n=${encodeURIComponent(part.join(","))}`);
    if (r.status !== 200) continue;
    if (badgeMem.size > 20000) badgeMem.clear();
    for (const n of part) {
      const v = r[n] || null;
      badgeMem.set(`${platform}:${n}`, { v, at: Date.now() });
      if (v) out[n] = v;
    }
  }
  return out;
}

// ------------------------------------------------------------------ živé spojení (Supabase Realtime)
const rt = {
  ws: null,
  ref: 0,
  topics: new Set(), // aktuálně připojená témata
  want: new Set(),
  beat: null,
  retry: 0,
  timer: null,
  async ensure() {
    const { auth, me } = await load();
    if (!auth?.token || !auth.realtime?.url || !auth.realtime?.key) return;
    const m = me || (await getMe());
    this.want = new Set([...(m?.topics || []), ...modTopics()]);
    if (!this.want.size) return;
    if (this.ws && this.ws.readyState <= 1) return this.sync();
    this.open(auth.realtime);
  },
  open(conf) {
    clearTimeout(this.timer);
    const url = `${conf.url.replace(/^http/, "ws").replace(/\/+$/, "")}/realtime/v1/websocket?apikey=${encodeURIComponent(conf.key)}&vsn=1.0.0`;
    let ws;
    try {
      ws = new WebSocket(url);
    } catch {
      return this.later();
    }
    this.ws = ws;
    this.topics = new Set();
    this.key = conf.key;
    ws.onopen = () => {
      this.retry = 0;
      this.sync();
      clearInterval(this.beat);
      // srdeční tep každých 25 s drží spojení i pozadí rozšíření naživu
      this.beat = setInterval(() => this.send({ topic: "phoenix", event: "heartbeat", payload: {} }), 25000);
    };
    ws.onmessage = (e) => {
      let m;
      try {
        m = JSON.parse(e.data);
      } catch {
        return;
      }
      if (m.event === "broadcast" && m.payload?.event === "ext") onEvent(String(m.topic).replace(/^realtime:tejbot:/, ""), m.payload.payload || {});
    };
    ws.onclose = () => {
      clearInterval(this.beat);
      if (this.ws === ws) {
        this.ws = null;
        this.later();
      }
    };
    ws.onerror = () => {};
  },
  later() {
    clearTimeout(this.timer);
    this.retry = Math.min(this.retry + 1, 6);
    this.timer = setTimeout(() => this.ensure(), Math.min(60000, 1000 * 2 ** this.retry));
  },
  send(msg) {
    if (this.ws?.readyState !== 1) return false;
    const ref = String(++this.ref);
    this.ws.send(JSON.stringify({ ...msg, ref, join_ref: msg.join_ref }));
    return true;
  },
  sync() {
    if (this.ws?.readyState !== 1) return;
    for (const t of this.want) {
      if (this.topics.has(t)) continue;
      const ref = String(++this.ref);
      const cfg = { config: { broadcast: { self: false, ack: false }, presence: { key: "" }, postgres_changes: [], private: false } };
      if (/^eyJ/.test(this.key || "")) cfg.access_token = this.key;
      this.ws.send(JSON.stringify({ topic: `realtime:tejbot:${t}`, event: "phx_join", payload: cfg, ref, join_ref: ref }));
      this.topics.add(t);
    }
    for (const t of [...this.topics]) {
      if (this.want.has(t)) continue;
      this.send({ topic: `realtime:tejbot:${t}`, event: "phx_leave", payload: {} });
      this.topics.delete(t);
    }
  },
  broadcast(topic, payload) {
    if (!this.topics.has(topic)) return;
    this.send({ topic: `realtime:tejbot:${topic}`, event: "broadcast", payload: { type: "broadcast", event: "ext", payload } });
  },
  close() {
    clearInterval(this.beat);
    clearTimeout(this.timer);
    const ws = this.ws;
    this.ws = null;
    try {
      ws?.close();
    } catch {
      /* nic */
    }
  },
};

// ------------------------------------------------------------------ chat na Kicku / Twitchi (spojení se záložkami)
const ports = new Map(); // port -> { platform, slug, visible, modTopic }
const modTopics = () => [...new Set([...ports.values()].map((p) => p.modTopic).filter(Boolean))];
function broadcastPorts(msg, filter = () => true) {
  for (const [port, info] of ports) if (filter(info)) port.postMessage(msg);
}

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== "tb-chat") return;
  ports.set(port, { platform: null, slug: null, visible: false, modTopic: null });
  port.onMessage.addListener((m) => {
    const info = ports.get(port);
    if (!info) return;
    if (m.type === "hello") Object.assign(info, { platform: m.platform, slug: String(m.slug || "").toLowerCase(), visible: !!m.visible });
    if (m.type === "visible") info.visible = !!m.visible;
    if (m.type === "mod") {
      info.modTopic = m.topic || null;
      void rt.ensure();
    }
    // moderátor otevřel kartu diváka -> ostatní moderátoři uvidí „X právě řeší…“
    if (m.type === "viewing" && info.modTopic) rt.broadcast(info.modTopic, { type: "viewing", viewer: m.viewer, by: m.by, at: Date.now() });
  });
  port.onDisconnect.addListener(() => {
    ports.delete(port);
    void rt.ensure();
  });
});

const seenOnChannel = (ev) => [...ports.values()].some((p) => p.visible && p.platform === ev.platform && p.slug === String(ev.slug || "").toLowerCase());
const channelUrl = (platform, slug) => (platform === "twitch" ? `https://www.twitch.tv/${slug}` : `https://kick.com/${slug}`);

/** Událost z živého spojení */
async function onEvent(topic, ev) {
  if (topic.startsWith("extmod-")) {
    broadcastPorts({ type: "mod", event: ev }, (p) => p.modTopic === topic);
    return;
  }
  // osobní upozornění diváka
  const { settings, me } = await load();
  const platform = ev.platform || guessPlatform(topic, me);
  const full = { ...ev, platform };
  broadcastPorts({ type: "ext", event: full });
  if (seenOnChannel(full)) return; // divák má chat otevřený a vidí ho -> stačí box v chatu
  if (ev.type === "challenge" && settings.nChallenge) {
    const stake = ev.amount > 0 ? TBI.t("stake", { amount: TBI.num(ev.amount), cur: ev.currency }) : TBI.t("friendly");
    const id = `ch:${ev.ch}:${platform}:${ev.slug}:${Date.now()}`;
    chrome.notifications.create(id, {
      type: "basic",
      iconUrl: chrome.runtime.getURL("icons/128.png"),
      title: TBI.t("challengeTitle", { from: ev.from }),
      message: `${TBI.t("onChannel", { ch: ev.channel })} · ${stake}${typeof ev.chance === "number" ? ` · ${TBI.t("chance", { n: ev.chance })}` : ""}`,
      buttons: [{ title: TBI.t("accept") }, { title: TBI.t("deny") }],
      requireInteraction: true,
      priority: 2,
    });
    setTimeout(() => chrome.notifications.clear(id), Math.max(5000, (ev.expires || Date.now() + 60000) - Date.now()));
  }
  if (ev.type === "challenge_end") {
    const all = await chrome.notifications.getAll();
    for (const id of Object.keys(all)) if (id.startsWith(`ch:${ev.ch}:`)) chrome.notifications.clear(id);
  }
  if (ev.type === "result") {
    const parts = [];
    if (ev.win && ev.bet > 0) parts.push(TBI.t("gainedPts", { n: TBI.num(ev.bet * 2), cur: ev.currency }));
    if (ev.xp > 0) parts.push(TBI.t("gainedXp", { n: TBI.num(ev.xp) }));
    if (ev.levelUp) parts.push(TBI.t("levelUp", { n: ev.levelUp }));
    if (settings.nResult) {
      chrome.notifications.create(`res:${Date.now()}`, {
        type: "basic",
        iconUrl: chrome.runtime.getURL("icons/128.png"),
        title: ev.win ? TBI.t("won", { opp: ev.opponent }) : TBI.t("lost", { opp: ev.opponent }),
        message: parts.join(" · ") || TBI.t("onChannel", { ch: ev.channel }),
      });
    }
    if (ev.drop && settings.nDrop) {
      const id = `drop:${ev.drop.id || "full"}:${Date.now()}`;
      chrome.notifications.create(id, {
        type: "basic",
        iconUrl: chrome.runtime.getURL("icons/128.png"),
        title: ev.drop.full ? TBI.t("bagFull") : TBI.t("dropGot", { item: ev.drop.name }),
        message: ev.drop.full ? "" : `${TBI.t(`rar${ev.drop.rarity}`)} · ${TBI.t("lvl", { n: ev.drop.level })} · ${TBI.t("quality", { n: ev.drop.quality })}`,
        buttons: ev.drop.full || !ev.drop.id ? [] : [{ title: TBI.t("equip") }, { title: TBI.t("later") }],
      });
    }
  }
}
function guessPlatform(topic, me) {
  const i = (me?.topics || []).indexOf(topic);
  return i >= 0 ? me.accounts?.[i]?.platform : "kick";
}

chrome.notifications.onButtonClicked.addListener(async (id, btn) => {
  chrome.notifications.clear(id);
  if (id.startsWith("ch:")) {
    const [, , platform, slug] = id.split(":");
    await api("api", "POST", "/ext/duel", { platform, slug, op: btn === 0 ? "accept" : "deny" });
  } else if (id.startsWith("drop:") && btn === 0) {
    const item = id.split(":")[1];
    await api("api", "POST", "/ext/hero", { op: "equip", item });
  }
});
chrome.notifications.onClicked.addListener((id) => {
  if (id.startsWith("ch:")) {
    const [, , platform, slug] = id.split(":");
    chrome.tabs.create({ url: channelUrl(platform, slug) });
  }
  chrome.notifications.clear(id);
});

// ------------------------------------------------------------------ zprávy z okna a z chatu
chrome.runtime.onMessage.addListener((m, sender, reply) => {
  (async () => {
    switch (m?.t) {
      case "state": {
        const s = await load();
        return { connected: !!s.auth?.token, me: s.auth?.token ? await getMe() : null, settings: s.settings, web: s.auth?.web || DEF_WEB };
      }
      case "api":
        return api(m.base === "web" ? "web" : "api", m.method || "GET", String(m.path || "/"), m.body);
      case "config":
        return config();
      case "badges":
        return badges(m.platform, (m.names || []).slice(0, 200));
      case "settings":
        return saveSettings(m.patch || {});
      case "logout":
        await logout(true);
        return { ok: true };
      case "token": {
        // z tejbot.eu/rozsireni (skript connect.js běží jen na téhle stránce)
        if (!sender.url || !/^https:\/\/(www\.)?tejbot\.eu\/rozsireni/.test(sender.url)) return { ok: false };
        const a = m.auth || {};
        if (!/^[A-Za-z0-9_-]{30,90}$/.test(String(a.token || ""))) return { ok: false };
        const safe = (u, def) => (/^https:\/\/[a-z0-9.-]+(:\d+)?$/i.test(String(u || "").replace(/\/+$/, "")) ? String(u).replace(/\/+$/, "") : def);
        await chrome.storage.local.set({
          auth: { token: a.token, api: safe(a.api, DEF_API), web: safe(a.web, DEF_WEB), realtime: { url: safe(a.realtime?.url, ""), key: String(a.realtime?.key || "").slice(0, 300) } },
          me: null,
        });
        const me = await getMe(true);
        rt.close();
        void rt.ensure();
        broadcastPorts({ type: "auth", connected: true });
        return { ok: !!me };
      }
    }
    return null;
  })().then(reply, () => reply(null));
  return true;
});

// ------------------------------------------------------------------ start
chrome.alarms.create("tick", { periodInMinutes: 1 });
chrome.alarms.onAlarm.addListener((a) => {
  if (a.name === "tick") void rt.ensure();
});
chrome.runtime.onStartup.addListener(() => void rt.ensure());
chrome.runtime.onInstalled.addListener(async (d) => {
  const { auth } = await load();
  if (d.reason === "install" && !auth?.token) chrome.tabs.create({ url: `${DEF_WEB}/rozsireni` });
  void rt.ensure();
});
void load().then(() => rt.ensure());
