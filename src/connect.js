// Běží jen na tejbot.eu/rozsireni: převezme přihlášení z webu a předá ho rozšíření.
// Token se nikde nezobrazuje, jde jen sem do rozšíření v tomhle prohlížeči.
document.documentElement.dataset.tejbotExt = chrome.runtime.getManifest().version;
window.addEventListener("message", (e) => {
  if (e.source !== window || e.origin !== location.origin) return;
  const d = e.data;
  if (!d || d.type !== "tejbot-ext-token") return;
  chrome.runtime.sendMessage({ t: "token", auth: { token: d.token, api: d.api, web: d.web, realtime: d.realtime } }, (r) => {
    window.postMessage({ type: "tejbot-ext-saved", ok: !!r?.ok }, location.origin);
  });
});
