# TejBot – rozšíření do prohlížeče

Rozšíření pro Chrome a Edge (Manifest V3). Doplňuje web [tejbot.eu](https://tejbot.eu) a bota, nic nepřidává do streamu ani do OBS.

## Co umí
- **Okno rozšíření:** Živě (sledovaní streameři s TejBotem a body na otevřeném kanálu), Můj hrdina (level, statistiky, výbava, rozdělení bodů, rozebrání), Upozornění.
- **V chatu na kick.com a twitch.tv:** odznak s levelem hrdiny (rámeček v barvě nejlepší výbavy), karta hrdiny po najetí na jméno, výzva na duel jedním klikem s odhadem šance, výsledek a drop, obchod kanálu.
- **Moderátoři:** tlačítko Spam (jen streamer a TejBot pomocníci), info o divákovi a poznámky, rychlé timeouty s důvodem, mazání a bany, fronta TTS a videí, moderátorský log, rychlé akce a přepínače. Co smí moderátoři z Kicku a Twitche, nastavuje streamer v Moderaci na nástěnce.

## Jak to funguje
- Přihlášení: na tejbot.eu/rozsireni se divák přihlásí přes Kick nebo Twitch a klikne na „Připojit rozšíření“. Rozšíření dostane vlastní token (na serveru je jen jeho otisk). Odhlásit jde v okně rozšíření i na webu.
- Data pro diváky (živé kanály, hrdina, odznaky, karta, duel, obchod) jdou ze serveru bota: `https://api.tejbot.eu/ext/...`.
- Moderátorské akce jdou přes web: `https://tejbot.eu/api/ext/mod`. Každá akce se na serveru znovu ověří (role a oprávnění).
- Výzvy, výsledky a fronta chodí živě přes Supabase Realtime na soukromé téma diváka / moderátorů.
- Kde rozšíření na stránkách Kicku a Twitche hledá chat, je v `bot/src/ext-selectors.js` v hlavním repozitáři. Když Kick nebo Twitch změní vzhled, stačí opravit ten soubor a nahrát bota, rozšíření si opravu stáhne samo.

## Vydání
Každý push do `main` sestaví `TejBot-rozsireni.zip` (GitHub Actions) a vydá ho jako novou verzi. Před vydáním zvyš `version` v `manifest.json`. Stejný zip se nahrává do Chrome Web Store a Edge Add-ons.

## Ruční instalace (vývoj)
`chrome://extensions` → Režim pro vývojáře → Načíst rozbalené → vybrat tuhle složku.
