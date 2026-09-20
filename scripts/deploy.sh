#!/usr/bin/env bash
# Deploy LearnBuddy to claw (home-srv).
# Usage: ./scripts/deploy.sh
# Requires: rsync (local + claw), ssh key to claw, passwordless sudo on claw.
set -euo pipefail

HOST=claw
DEST=/srv/learnbuddy

# No --delete here: removing old files before the service restarts creates a
# window where a freshly loaded page references JS that is already gone (the
# reader.js 404 incident). Stale files are harmless; restart makes the new
# code live atomically. server/data/ is the live learner-records/Library
# store on claw — never overwritten from a dev machine; dictionaries are
# synced separately below.
rsync -az --exclude 'cache/' --exclude 'data/' --exclude '__pycache__/' web/ "${HOST}:${DEST}/web/"
rsync -az --exclude 'cache/' --exclude 'data/' --exclude '__pycache__/' server/ "${HOST}:${DEST}/server/"

# Python backend deps (jieba joined with ADR 0009; sudachipy was already
# provisioned). The venv on claw is owned by the deploy user, so no sudo.
# Install only when something is missing — pip is slow offline.
ssh "${HOST}" "${DEST}/.venv/bin/python3 -c 'import jieba, sudachipy' 2>/dev/null || ${DEST}/.venv/bin/pip install -q -r ${DEST}/server/requirements.txt"

# Lookup dictionaries (~150 MB build artifacts, ADR 0008/0009). Synced once —
# rebuilt only when a local rebuild changes them; absent locally, the
# builder can run on claw (sudachipy lives in claw's venv).
if [ -f server/data/dicts/en.sqlite ]; then
  ssh "${HOST}" "mkdir -p ${DEST}/server/data"
  rsync -az server/data/dicts/ "${HOST}:${DEST}/server/data/dicts/"
else
  ssh "${HOST}" "test -f ${DEST}/server/data/dicts/en.sqlite || sudo -u learnbuddy ${DEST}/.venv/bin/python3 ${DEST}/server/tools/build_dicts.py --only en,ja,kanji,zh" || true
fi

# Stamp the deployed sw.js with a fresh value so the browser detects a new
# Service Worker on every deploy (byte change -> re-install -> fresh shell
# precache + purge of old caches). Without this, cache-first static serving
# keeps serving stale JS/CSS and family devices need a manual cache clear.
STAMP="$(date +%s)"
ssh "${HOST}" "sudo sed -i \"s/^const DEPLOY_STAMP = '[^']*';/const DEPLOY_STAMP = '${STAMP}';/\" ${DEST}/web/sw.js"

# --- learnbuddy-ai (Node + pi SDK explainer behind the /ai proxy, #20) ---
# agent/ holds pi auth (auth.json, settings.json, models-store.json) and is
# never synced from a dev machine; node_modules is installed on claw only.
rsync -az --delete --exclude 'node_modules/' --exclude 'agent/' ai-service/ "${HOST}:${DEST}/ai/"
# (Re)install deps when node_modules is missing or the lockfile changed.
ssh "${HOST}" "cd ${DEST}/ai && if [ ! -d node_modules/@earendil-works/pi-coding-agent ] || ! cmp -s package-lock.json .lock-installed; then npm install --omit=dev --no-audit --no-fund && cp package-lock.json .lock-installed; fi"
# Unit file is managed from the repo; enable once, restart every deploy.
ssh "${HOST}" "sudo cp ${DEST}/ai/learnbuddy-ai.service /etc/systemd/system/learnbuddy-ai.service"
ssh "${HOST}" "systemctl is-enabled --quiet learnbuddy-ai 2>/dev/null || sudo systemctl enable --now learnbuddy-ai"
ssh "${HOST}" "sudo systemctl restart learnbuddy-ai"
# Point the Python backend at it (idempotent); it reads the env at startup.
ssh "${HOST}" "grep -q '^Environment=LEARNBUDDY_AI_URL=' /etc/systemd/system/learnbuddy.service || sudo sed -i '/^ExecStart=/a Environment=LEARNBUDDY_AI_URL=http://127.0.0.1:8123' /etc/systemd/system/learnbuddy.service"
ssh "${HOST}" "sudo systemctl daemon-reload"
# The AI service must answer before learnbuddy restarts so the tab lights up.
ssh "${HOST}" "for i in \$(seq 1 20); do curl -sf http://127.0.0.1:8123/health >/dev/null 2>&1 && break || sleep 1; done; curl -sf http://127.0.0.1:8123/health"

ssh "${HOST}" "sudo systemctl restart learnbuddy"

echo "Deployed."
echo "  LAN:     http://192.168.3.28/"
echo "  Tailnet: https://home-srv.tailf905b5.ts.net/"
