Research ticket **浏览器直连 Edge TTS 可行性验证** (issue #2) resolved and closed. 

**Verdict: 有条件可行 — 直连只对"当前版本 Microsoft Edge 系浏览器"成立；家庭设备需要一个小 WS 中继。**

Evidence chain: (1) read dasan's `EdgeTtsProtocol.kt` and edge-tts Python source — protocol is 100% query-string driven, no custom headers; (2) empirical handshake matrix against the real endpoint — `Edg/143`/`EdgA/143`/`EdgiOS/143` → 101, while Chrome/143, iPhone Safari, Firefox, curl → 403; Origin is not checked; (3) full end-to-end synthesis via a dependency-free Node WS client produced 49 frames / 34,848 bytes of valid MP3; (4) documented rate-limit noise and upstream instability.

**Architecture impact (for issue #3):** the "zero-backend static SPA" premise is dead — iPhone Safari (the user's main phone), Android/desktop Chrome all get 403 on direct connection. Recommended: a single-purpose WS relay on claw (browser → claw → Edge TTS with legal Edge UA), which also centralizes future token/version constant bumps.