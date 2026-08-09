# LearnBuddy web architecture: thick Python backend, vanilla TS frontend

> **Partially superseded by [ADR 0003](0003-unified-single-page-layout.md)** — the ≥1024px breakpoint and the mobile Paste view ⇄ Reader view are gone; the single-page layout is the one layout at every width. The architecture decisions below stand.

Recorded from the resolution of the wayfinder ticket 「LearnBuddy Web 架构与全量移植决策」(issue #3): LearnBuddy is a full-feature Web/PWA language reader, deployed on claw; claw **is** the backend.

## Decisions

- **Backend is thick, on claw**: an HTTP TTS API `GET /tts?text&voice&rate` returns MP3 bytes (`fetch → blob → <audio>`); a server-side audio cache keyed by SHA-256 of `text|voice|rate` is shared by the whole family; the backend statically hosts the frontend. Edge TTS upstream concerns — User-Agent gating, one retry, ~3s connection pacing, clock-skew retry on 403 — are maintained in exactly one place (see 「浏览器直连 Edge TTS 可行性验证」 issue #2: only current Edge-family UAs pass the handshake; Chrome/Safari/Firefox/curl are 403).
- **Frontend is vanilla TS (ES modules) + Service Worker, no build step**: static files are the source; the backend serves them as-is. Zero toolchain on claw.
- **Offline replay is device-level**: the Service Worker caches played audio (`text|voice|rate` request URL), so a sentence is replayable offline. Cleanup follows the ownership rule: audio lives exactly as long as at least one History entry references it; deleting or trimming an entry purges audio that no other entry references. The server cache is a speed layer only, never an offline promise.
- **Segmentation sits behind a `SegmentationService` interface**: today the local implementation is `Intl.Segmenter` (sentence granularity, zh/ja/en locales) with a fixed-length fallback (250 chars); the seam exists so a future AI segmentation backend can replace it without touching the Reading area.
- **500-character text limit is enforced server-side**; the six Rate presets map linearly to SSML rates (`-50%` … `+100%`); voice defaults per detected language (en-US-AriaNeural / ja-JP-KeitaNeural / zh-CN-YunxiNeural).
- **Test strategy**: pure logic (segmentation, language detection, history, rate mapping, loop state machines, error mapping) with `node --test` on the dev machine; backend logic with Python `unittest` (stdlib only, no network); browser behavior on real devices belongs to 「家庭设备真机验收」 (issue #6). zh/ja/en segmentation parity cases lock Intl.Segmenter vs ICU4J expectations.

## Consequences

- Deployment is "copy repo to claw, run one Python server" — runtime details (uv vs system python) are decided by 「claw 部署与运行」 (issue #5).
- The Edge TTS protocol constants (Sec-MS-GEC algorithm, UA, version) live in one Python file; upstream changes are a single-point fix.
- Server-side synthesis is serialized and paced (~3s between upstream connections) to avoid upstream 403 throttling; cache hits bypass the gate.
- Offline replay only covers sentences fetched while their history entry was alive, at the rate they were fetched at.
- PWA install path (Tailscale HTTPS origin) and iOS specifics belong to 「PWA 策略与手机安装路径」 (issue #4); on plain-HTTP LAN origins the app works without SW features.
