# System service layout and runtime user

claw runs LearnBuddy as two system services (`learnbuddy.service` on `:80`,
`learnbuddy-ai.service` on loopback `:8123`). This ADR fixes where code,
state, cache, config and secrets live, and **who** the services run as.

## Context

- claw's login owner is `lansy` (uid 1000), who also deploys over ssh plus
  sudo. `lansy` holds `(ALL : ALL) NOPASSWD: ALL`.
- The old layout piled everything into `/srv/learnbuddy`: code (`web/`,
  `server/`, `ai/`), mutable state (`server/data/`: books, profiles, state,
  ai-cache, 157M of dicts), disposable cache (`server/cache`), the toolchain
  (`.venv`) and pi credentials (`ai/agent/auth.json`) — owned by a mix of
  `lansy`, `root` and `learnbuddy`, with stale top-level dirs from earlier
  layouts still lying around.
- The main service had no `User=` and ran as **root** (to bind `:80`);
  everything it wrote (`profiles.json`, `ai-cache/`, `state/`, `server/cache/`)
  is `root`-owned. The AI service already ran as `learnbuddy`.
- The `learnbuddy` system user's HOME pointed at `/srv/learnbuddy/ai` — a
  code directory doubling as a home directory.
- XDG Base Directory is written for user sessions, not for system daemons;
  the correct mapping here is the FHS/systemd equivalent
  (`/var/lib`, `/var/cache`, `/etc`, `/run`).

## Decisions

- **Three roles, no overlap.** `lansy` owns and deploys but never runs the
  service (a network-facing process as `lansy` could `sudo -n` straight to
  root). `learnbuddy` (nologin system user) is the only runtime identity.
  `root` exists only as PID 1 launching units.
- **Code is immutable and root-owned:** `/opt/learnbuddy`
  (`web/`, `server/`, `ai/*.mjs`, `.venv/`). The service user gets read and
  execute only.
- **State is the service user's:** `/var/lib/learnbuddy`
  (`books/`, `profiles.json`, `state/`, `ai-cache/`, `dicts/`,
  `ai-agent/`), `learnbuddy:learnbuddy`. Created by systemd's
  `StateDirectory=` (auto-created with correct ownership); deploy never
  overwrites it. `learnbuddy`'s HOME moves here too
  (`usermod -d /var/lib/learnbuddy learnbuddy`).
- **Cache is disposable:** `/var/cache/learnbuddy/tts` (`CacheDirectory=`).
  Loss is a refetch, never data loss.
- **Config is explicit:** `/etc/learnbuddy/learnbuddy.env`
  (`EnvironmentFile=`, required — the service fails fast when missing).
  Deploy creates it once and never overwrites it.
- **Port 80 without root:** `AmbientCapabilities=CAP_NET_BIND_SERVICE`
  (plus matching `CapabilityBoundingSet`) with `User=learnbuddy` and
  `NoNewPrivileges=true`. Ambient caps are already possessed, not gained at
  exec, so the bind survives NNP; the deploy health check gates on `:80`
  answering, so a regression fails loud, not silent.
- **Home directories are hidden from the services:** `ProtectHome=true` on
  both units, so `/home/lansy` (SSH keys, shell history) is unreachable
  from either process. `/opt` is read-only at runtime
  (`ProtectSystem=strict`); `PYTHONDONTWRITEBYTECODE=1` keeps `__pycache__`
  out of it.
- **Secrets stay hand-seeded:** `ai-agent/auth.json` (`0600`) is created
  once on claw, never rsynced, never committed. Deploy sets `0700`/`0600`
  but fails stopped (non-fatal warning) rather than overwriting when the
  files already exist.
- **Both units live in the repo** (`deploy/learnbuddy.service`,
  `ai-service/learnbuddy-ai.service`); deploy installs them verbatim. No
  more `sed`-patching units in `/etc`.

## Considered Options

- **Run the service as `lansy` (system unit `User=lansy`)** — rejected: the
  process could read all of `/home/lansy` including `.ssh/`, and with
  `NOPASSWD: ALL` any compromise is immediately root. Worse than root in
  blast radius, not better.
- **`systemd --user` under `lansy` (literal XDG paths)** — rejected: ties a
  family-shared service to one person's login lifecycle, orders weakly
  against system-level `tailscaled.service`, and still cannot bind `:80`
  without extra plumbing. (`Linger=yes` is already set, so this stays
  available if claw ever stops being multi-user infrastructure.)
- **Reverse proxy (Caddy/nginx) in front of a high-port backend** —
  deferred: no proxy runs on claw today (`:443` is tailscaled itself) and
  the ambient-capability unit solves `:80` in one line. Revisit if TLS
  termination on claw is ever wanted.
- **`setcap` on the venv python** — rejected: the venv is rebuilt by
  deploy, which would silently drop the capability; ambient caps on the
  unit travel with the unit instead.
- **Keeping `/srv/learnbuddy`** — rejected: the mixed-ownership pile plus
  stale dirs is exactly the drift this ADR removes. `/srv/learnbuddy` is
  kept untouched as the rollback source until the new layout is verified,
  then retired.

## Consequences

- `scripts/deploy.sh` targets the new paths; the old `LEARNBUDDY_AI_URL`
  `sed`-injection is gone (the env file owns it).
- One-time migration on claw: stop services, `rsync -a` state and cache to
  the new paths, `chown -R learnbuddy:learnbuddy /var/lib/learnbuddy`,
  `usermod -d`, install units, start, verify `:80`, `/lookup` and `/ai`
  health before declaring success.
- `ai-service/README.md` "On claw" paths follow this ADR.
- `sudoers` stays `NOPASSWD: ALL` for now (out of scope for this change;
  scoping it to the deploy commands is recorded future work, not done here
  to avoid any lockout risk during the migration).
