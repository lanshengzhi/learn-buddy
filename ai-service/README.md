# learnbuddy-ai

AI context-explanation and Chat service behind LearnBuddy's `/ai` and
`/conversations` proxies (ADR 0008, decision in #15; Chat per ticket #47 /
ADR 0015). A thin Node wrapper around the **pi SDK**: it answers
`POST /explain {word, sentence, language, explanationLocale}` → `{text}` and
`POST /chat {messages: [{role, content}]}` → `{text}` with whatever model the
pi agent dir is configured with — no LearnBuddy-owned keys or accounts. The
Python backend (`server/ai.py`) proxies to it, defaults `explanationLocale` to
`zh-CN`, owns the cache (explanations only — Chat turns are never cached),
assembles each Chat turn's context from its own stored Conversation, and owns
the degrade codes (`ai_not_configured` / `ai_upstream_error` / `ai_timeout` /
`ai_usage_limit`); the LAN never reaches this service directly (it listens on
127.0.0.1 only). This service knows nothing about Persons or family data
(ADR 0012).

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
