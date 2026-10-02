## Agent skills

### Issue tracker

Issues live in this repo's GitHub Issues, driven through the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

Five canonical roles mapped to the labels `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: one `CONTEXT.md` plus `docs/adr/` at the repo root. See `docs/agents/domain.md`.

### Exploration notes
Exploration notes live outside the repo, one directory per effort: `~/Work/learnbuddy-<spec>-notes/` (e.g. `~/Work/learnbuddy-spec45-notes/`). They are time snapshots — code has moved on; check the current code before relying on them.

## Cursor Cloud specific instructions

The boot script serves the app at http://127.0.0.1:8000 (`server/tts_server.py`). Learner records land in gitignored `server/data/`. First boot seeds profiles `dad`, `mom`, `d1`, and `d2`.

- Python 3.14 venv: `/workspace/.venv`. From `server/`, run `/workspace/.venv/bin/python -m unittest discover -s tests -p 'test_*.py'`.
- Node 26 lives at `/usr/local/lib/node-v26/bin`. Prepend that directory before `npm test`. The default `node` on `PATH` is the agent runtime.
- Browser smoke expects the server on port 8123 (or `LEARNBUDDY_BASE`). Run `PLAYWRIGHT_MODULE=/opt/learnbuddy-dev/node_modules/playwright node scripts/browser-smoke.mjs`. Chrome is `/usr/bin/google-chrome-stable`. Paste text segments after clicking 更新; 输入时自动分段 is off until checked.
- `server/tools/build_dicts.py` raises `AttributeError` for en/ja/kanji (those builders receive the source list). A missing `server/data/dicts/` is the current script behavior; lookup stays unavailable until that builder is fixed.
- `ai-service/` dependencies are installed and the process is not started. It needs `LEARNBUDDY_AI_AGENT_DIR` with pi credentials and listens on 127.0.0.1:8123, the same port browser smoke uses.
