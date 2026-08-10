# Cache & update strategy: network-first static serving with a deploy-stamped Service Worker

Deploys were invisible to the family: after shipping new code, wife/kids'
devices kept showing the old build, and the only fix was "clear the browser
cache" — an operation they cannot be expected to know or perform. This ADR
records why, and locks the strategy that makes every deploy just work.

## Context

LearnBuddy is a no-build-step static frontend (ADR 0001): `/index.html`,
`/js/app.js`, `/css/style.css` are the source of truth, served as-is by the
Python backend. On the Tailscale **HTTPS** origin (`home-srv.tailf905b5.ts.net`)
the Service Worker registers and controls the page; on the plain-HTTP LAN
origin (`192.168.3.28`) there is no SW and the backend's `Cache-Control:
no-cache` on every static response keeps the HTTP cache honest. That split is
why staleness was intermittent.

On the SW origin, two properties combined into the bug:

1. **Static assets were served cache-first** (`serveStatic` → cache hit wins).
   Fresh HTML is network-first, but the JS/CSS it references came from the SW
   cache — a deploy changed the HTML, not the bytes the browser actually ran.
2. **The SW only re-installs when `/sw.js` itself changes bytes.** `/sw.js` was
   bumped by hand (the `learnbuddy-shell-v4` comment said "bumped whenever the
   shell list changes"). Editing the *contents* of `app.js` without touching
   the shell list left `/sw.js` byte-identical → no re-install → stale
   cache-first assets **until a manual cache clear**.

## Decisions

- **Static assets are network-first in the SW** (`serveStatic`): every load
  fetches JS/CSS from the server, and only on network failure falls back to
  the precached shell. Online access can therefore never be stale, regardless
  of SW update timing. The precached shell remains the offline fallback.
- **`scripts/deploy.sh` stamps `/sw.js` on every deploy.** It rewrites
  `const DEPLOY_STAMP = 'dev';` in the deployed copy with `date +%s` (matching
  any previous stamp, so re-deploys are idempotent). `/sw.js` changes bytes on
  every deploy → the browser always detects a new SW → `skipWaiting` +
  `clients.claim` re-precache the fresh shell and the `activate` handler purges
  old caches. Manual version bumps are gone; the stamp is the version.
- **Shell cache bumped to `learnbuddy-shell-v5` once** (both `web/sw.js` and
  `js/core/sw-config.js`) to transition devices off v4 and prove the purge
  path. The audio cache `learnbuddy-audio-v1` is deliberately **not** bumped:
  it is content-addressed (`text|voice|rate` URL), survives SW updates, and
  is the offline-replay store (audio-ownership semantics, ADR 0001).
- **No auto-reload of open pages.** `skipWaiting` + `clients.claim` stay;
  a page already loaded before the deploy keeps running its old JS until the
  next load, and the next load is fresh (network-first). Family usage is
  "open the app" per session, so this is a non-issue; an injected reload would
  interrupt in-progress playback.

## Considered Options

- **Cache-first + `registration.update()` on page load** — rejected: the
  transitional load is still stale until the update round-trips; doesn't fix
  the cache-first serving.
- **Manual cache-version bump per release** — rejected: this *was* the bug; a
  human remembering to bump is the failure mode.
- **Hashed/versioned filenames** (`app.abc123.js`) — rejected: requires a
  build step, which ADR 0001 explicitly forbids (zero toolchain on claw).
- **Auto-reload on `controllerchange`** — rejected: interrupts audio playback;
  unnecessary given network-first + fresh-open usage.
- **Server-side `no-store` on `/sw.js`** — redundant: the backend already sends
  `Cache-Control: no-cache` for all static files, so the SW check is
  unconditional on every navigation.

## Consequences

- Family devices never need a manual cache clear; every deploy is live on the
  next page open.
- Each deploy now also refreshes the *offline* shell (SW re-installs and
  re-precaches), so even offline mode eventually serves the current build.
- Cost: every static asset is re-fetched per load on the LAN (network-first,
  `no-cache`). Negligible for a family-sized LAN app.
- The stamp lives in `scripts/deploy.sh` — deploys that bypass the script
  (manual rsync) skip the stamp and fall back to network-first-only freshness
  (online still correct; offline shell may lag until a scripted deploy).
- `sw.js` and `js/core/sw-config.js` remain manually in sync for cache names
  and the shell list — unchanged, low-risk duplication.
