# Server-side learner records and password-free Profiles

LearnBuddy began as a device-local app: History, word states, rate/loop preferences and a device audio cache all lived in the browser, and only the TTS cache and the paste flow lived on the server. The family reads on a PC and a tablet, and issue #16 asked where book data and reading progress belong. The answer went past progress: **the server is the only store of learner records**, and the family is distinguished by a **password-free Profile**.

## Context

- Four family members (爸爸 / 妈妈 / 大女儿 / 小女儿) share the same devices and the same LAN-only server (claw). The effort explicitly excludes an account system: no login, no per-user isolation, no privacy boundary inside the family.
- Cross-device continuation is a main-line need (tablet in the evening, PC the next day), and two people reading the same book must not overwrite each other's place.
- The book library is already server-side (`/srv/learnbuddy/books/`); the earlier decision kept per-book reading positions out of the device.
- The device audio cache was kept alive by a reference count against History entry ids (`audio-ownership.js`). Once History moves to the server, that bookkeeping loses its local anchor.
- PWA and Tailscale are retired: the app is plain-HTTP LAN-only, so relying on the network for every read is acceptable.
- A real book's largest chapter measured 72k characters / 1,738 sentences / 44k tokens; a whole chapter renders in 70 ms, so the client can receive a chapter whole.

## Decisions

- **The server is the only store.** Reading positions, History, word states (我认识), rate preset, loop mode and the last opened book live under `/srv/learnbuddy/state/<profile>/` and `books/<sha256>/positions/<profile>.json`. The browser keeps exactly one key — `lb.profile`, the reader using this device — plus the Service Worker's static shell cache. No IndexedDB, no learner state in `localStorage`.
- **Profile (档案) is who is reading, not an account.** No password, no login, no authorization, no data isolation: anyone may switch to anyone. The list is a read-only server-side `profiles.json` whose structure does not assume exactly four profiles (stable slug ids, editable names). A new device must pick a Profile before entering; switching re-loads that Profile's book, position, preferences and History, and stops playback. The Profile travels per request (`?profile=<id>`), never in a session or cookie.
- **Position is per (Book, Profile)**, stored as a chapter plus sentence index, with the sentence's opening text for re-anchoring after a re-parse — cross-device for one person, collision-free between people. Writes are debounced 1–2 s, with an immediate write on chapter change or page unload.
- **Word states are per Profile and book-independent** — one vocabulary per person, keyed by language plus dictionary-normalized form, so a word marked 我认识 in one book is quiet in the next.
- **The device audio cache is retired.** The server's `text|voice|rate` cache is the only cache; the browser stores no audio, so offline replay is gone and replay needs the LAN.
- **No permission model.** Any Profile may upload or delete any book; each manifest records `uploadedBy` as a note only.
- **One file per record class**, written `.tmp` + atomic rename, no locks, last-write-wins within a class (so changing the rate never rewrites a person's History).

## Considered Options

- **Device-local records with a per-device position** — rejected: no cross-device continuation, which is the main-line scenario.
- **A single shared position per book** — rejected: two people reading the same book would fight over one bookmark.
- **Server-side records keyed by device id, no Profiles** — rejected: one person on two devices is the normal case, and a fresh browser profile would become a new person.
- **Keeping the browser audio cache with server-side ownership bookkeeping** — rejected: the most complex option for the least benefit; the LAN plus the server cache is already fast.
- **A real account system (passwords, per-user isolation)** — rejected: family LAN, and it contradicts the map's destination.

## Consequences

- With claw down the app renders nothing useful: no cached chapter, no last book, no audio. This is accepted, and acceptance checks that the app shows an empty shell rather than stale data.
- `web/js/core/audio-ownership.js`, `web/js/browser/ownership-store.js` and their tests retire; the Service Worker stops intercepting `/tts`.
- `web/js/browser/history-idb.js` is replaced by a fetch-backed store; the `history-store.js` / `history-repository.js` interfaces and their tests stay, and the 50-entry bound, text dedupe and Favorite-exempt trimming move to the server.
- `rate_preset` / `loop_mode` leave `localStorage` for the `/state` endpoint.
- The glossary gains **Profile**, **Word state** and **Library**; **Audio cache** and **Offline replay** are removed; **History** and **Reading position** become per-Profile and server-side.
- The implementation is split across two tickets (server, frontend) with final acceptance unchanged.
