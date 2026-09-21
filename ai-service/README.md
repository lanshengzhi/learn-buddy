# learnbuddy-ai

AI context-explanation service behind LearnBuddy's `/ai` proxy (ADR 0008,
decision in #15). A thin Node wrapper around the **pi SDK**: it answers
`POST /explain {word, sentence, language, explanationLocale}` → `{text}` with whatever model the
pi agent dir is configured with — no LearnBuddy-owned keys or accounts. The
Python backend (`server/ai.py`) proxies to it, defaults `explanationLocale` to
`zh-CN`, owns the cache and the degrade
codes (`ai_not_configured` / `ai_upstream_error` / `ai_timeout`); the LAN
never reaches this service directly (it listens on 127.0.0.1 only).

## On claw (ADR 0010)

- Code + deps: `/opt/learnbuddy/ai/` (root-owned; rsynced and
  dependency-installed by `scripts/deploy.sh`; node_modules lives only on
  claw). The service runs as the `learnbuddy` system user with read access.
- pi agent dir: `/var/lib/learnbuddy/ai-agent/` — `auth.json` (provider
  OAuth / API keys), `settings.json` (`defaultProvider` / `defaultModel`),
  `models-store.json` (cached model catalog). **Never synced by deploy.sh**;
  seeded once by hand. Owned by the `learnbuddy` system user (`0700` dir,
  `0600` auth); a token refresh rewrites `auth.json` in place.
- Service: `systemd learnbuddy-ai.service` (unit lives in this directory,
  installed verbatim by the script), port 8123 on 127.0.0.1. The main
  service reaches it via `/etc/learnbuddy/learnbuddy.env`
  (`LEARNBUDDY_AI_URL=http://127.0.0.1:8123`, created once by deploy.sh).

## Changing the model

Edit `/var/lib/learnbuddy/ai-agent/settings.json` on claw
(`defaultProvider` + `defaultModel` — run `pi --list-models` on a signed-in
machine to see ids), then `sudo systemctl restart learnbuddy-ai`. Health
check with the resolved model: `curl http://127.0.0.1:8123/health`.
