#!/usr/bin/env bash
# Deploy LearnBuddy to claw (home-srv).
# Layout (ADR 0010): immutable code in /opt/learnbuddy (root-owned),
# mutable state in /var/lib/learnbuddy, disposable TTS cache in
# /var/cache/learnbuddy, config in /etc/learnbuddy. Both services run as
# the unprivileged `learnbuddy` system user; `lansy` deploys but never runs.
# Usage: ./scripts/deploy.sh
# Requires: rsync (local + claw), ssh key to claw, passwordless sudo on claw.
set -euo pipefail

HOST=claw
APP=/opt/learnbuddy
STATE=/var/lib/learnbuddy
CACHE=/var/cache/learnbuddy/tts
ENV_FILE=/etc/learnbuddy/learnbuddy.env
STAGE=/home/lansy/.learnbuddy-stage

# The pre-0010 main unit lived only on claw (/etc, hand-maintained). Keep one
# rollback copy; thereafter this is a no-op.
ssh "${HOST}" "test -f /root/learnbuddy.service.pre-adr0010.bak || test ! -f /etc/systemd/system/learnbuddy.service || sudo cp /etc/systemd/system/learnbuddy.service /root/learnbuddy.service.pre-adr0010.bak"

# Stage as the deploy user, then privileged-copy into /opt: /opt stays
# root-owned and immutable to the service at runtime.
ssh "${HOST}" "mkdir -p ${STAGE}/web ${STAGE}/server ${STAGE}/ai ${STAGE}/deploy ${STAGE}-dicts"
rsync -az --exclude '__pycache__/' web/ "${HOST}:${STAGE}/web/"
rsync -az --exclude 'cache/' --exclude 'data/' --exclude '__pycache__/' server/ "${HOST}:${STAGE}/server/"
rsync -az --exclude 'node_modules/' --exclude 'agent/' ai-service/ "${HOST}:${STAGE}/ai/"
rsync -az deploy/ "${HOST}:${STAGE}/deploy/"
ssh "${HOST}" "sudo mkdir -p ${APP} && sudo rsync -a ${STAGE}/web/ ${APP}/web/ && sudo rsync -a ${STAGE}/server/ ${APP}/server/ && sudo rsync -a ${STAGE}/ai/ ${APP}/ai/ && sudo rsync -a ${STAGE}/deploy/ ${APP}/deploy/ && sudo chown -R root:root ${APP}/web ${APP}/server ${APP}/ai ${APP}/deploy && rm -rf ${STAGE}"

# No --delete on the code copy: removing old files before the service
# restarts creates a window where a freshly loaded page references JS that
# is already gone (the reader.js 404 incident). Stale files are harmless;
# restart makes the new code live atomically. State is never synced from a
# dev machine — it lives only on claw; dictionaries go separately below.
# (The pre-0010 stale top-level dirs cannot recur: /opt is a fresh root
# populated only by the four rsyncs above.)

# Python backend deps (jieba joined with ADR 0009; sudachipy was already
# provisioned). The venv is root-owned under /opt; the service only
# executes it. Install only when something is missing — pip is slow offline.
ssh "${HOST}" "test -x ${APP}/.venv/bin/python3 || sudo python3 -m venv ${APP}/.venv"
ssh "${HOST}" "sudo ${APP}/.venv/bin/python3 -c 'import jieba, sudachipy, notebooklm' 2>/dev/null || sudo ${APP}/.venv/bin/pip install -q -r ${APP}/server/requirements.txt"

# Lookup dictionaries (~150 MB build artifacts, ADR 0008/0009). Synced once —
# rebuilt only when a local rebuild changes them; absent locally, the
# builder can run on claw (sudachipy lives in claw's venv). Dicts are
# reference data under state (read by the service, never written).
if [ -f server/data/dicts/en.sqlite ]; then
  rsync -az server/data/dicts/ "${HOST}:${STAGE}-dicts/"
  ssh "${HOST}" "sudo mkdir -p ${STATE}/dicts && sudo rsync -a ${STAGE}-dicts/ ${STATE}/dicts/ && sudo chown -R learnbuddy:learnbuddy ${STATE}/dicts && rm -rf ${STAGE}-dicts"
else
  ssh "${HOST}" "test -f ${STATE}/dicts/en.sqlite || sudo -u learnbuddy ${APP}/.venv/bin/python3 ${APP}/server/tools/build_dicts.py --only en,ja,kanji,zh" || true
fi

# Runtime config: created once, never overwritten — hand edits survive.
ssh "${HOST}" "sudo mkdir -p /etc/learnbuddy && test -f ${ENV_FILE} || sudo cp ${APP}/deploy/learnbuddy.env.example ${ENV_FILE}"

# NotebookLM profile/cookie/token storage is service-user-only. It is seeded
# by hand (never synced or committed) and the worker is the only reader.
ssh "${HOST}" "sudo -u learnbuddy mkdir -p ${STATE}/notebooklm && sudo chmod 0700 ${STATE}/notebooklm"

# pi agent dir (auth.json, settings.json, models-store.json): hand-seeded,
# never synced. Ensure the dir exists with 0700 and the key with 0600 when
# present; warn (don't fail) when auth is absent — /ai then degrades to
# ai_not_configured and the 词条 tab keeps working.
# NOTE: the existence test runs via sudo — the dir is 0700 learnbuddy and
# the ssh user cannot stat inside it (a failed test here is a false alarm).
ssh "${HOST}" "sudo -u learnbuddy mkdir -p ${STATE}/ai-agent && sudo chmod 0700 ${STATE}/ai-agent && sudo test -f ${STATE}/ai-agent/auth.json && sudo chmod 0600 ${STATE}/ai-agent/auth.json || echo 'WARN: ${STATE}/ai-agent/auth.json absent — seed it by hand; /ai will report ai_not_configured'"

# Stamp the deployed sw.js with a fresh value so the browser detects a new
# Service Worker on every deploy (byte change -> re-install -> fresh shell
# precache + purge of old caches). Without this, cache-first static serving
# keeps serving stale JS/CSS and family devices need a manual cache clear.
STAMP="$(date +%s)"
ssh "${HOST}" "sudo sed -i \"s/^const DEPLOY_STAMP = '[^']*';/const DEPLOY_STAMP = '${STAMP}';/\" ${APP}/web/sw.js"

# --- learnbuddy-ai (Node + pi SDK explainer behind the /ai proxy, #20) ---
# node_modules is installed on claw only.
ssh "${HOST}" "cd ${APP}/ai && if [ ! -d node_modules/@earendil-works/pi-coding-agent ] || ! cmp -s package-lock.json .lock-installed; then sudo npm install --omit=dev --no-audit --no-fund && sudo cp package-lock.json .lock-installed; fi"
# Units are managed from the repo and installed verbatim — never sed-patched.
ssh "${HOST}" "sudo cp ${APP}/ai/learnbuddy-ai.service /etc/systemd/system/learnbuddy-ai.service && sudo cp ${APP}/deploy/learnbuddy.service /etc/systemd/system/learnbuddy.service && sudo cp ${APP}/deploy/learnbuddy-notebooklm.service /etc/systemd/system/learnbuddy-notebooklm.service"
ssh "${HOST}" "sudo systemctl daemon-reload"
ssh "${HOST}" "sudo systemctl enable --quiet learnbuddy-notebooklm 2>/dev/null || sudo systemctl enable learnbuddy-notebooklm >/dev/null"
ssh "${HOST}" "sudo systemctl enable --quiet learnbuddy-ai 2>/dev/null || sudo systemctl enable learnbuddy-ai >/dev/null"
ssh "${HOST}" "sudo systemctl enable --quiet learnbuddy 2>/dev/null || sudo systemctl enable learnbuddy >/dev/null"
ssh "${HOST}" "sudo systemctl restart learnbuddy-notebooklm"
ssh "${HOST}" "sudo systemctl restart learnbuddy-ai"
# The AI service must answer before learnbuddy restarts so the tab lights up.
ssh "${HOST}" "for i in \$(seq 1 20); do curl -sf http://127.0.0.1:8123/health >/dev/null 2>&1 && break || sleep 1; done; curl -sf http://127.0.0.1:8123/health"

ssh "${HOST}" "sudo systemctl restart learnbuddy"
# :80 must answer as the learnbuddy user (ambient CAP_NET_BIND_SERVICE).
ssh "${HOST}" "for i in \$(seq 1 20); do curl -sf http://127.0.0.1/ >/dev/null 2>&1 && break || sleep 1; done; curl -sf -o /dev/null -w 'main=%{http_code}\n' http://127.0.0.1/"

echo "Deployed."
echo "  LAN:     http://192.168.3.28/"
echo "  Tailnet: https://home-srv.tailf905b5.ts.net/"
