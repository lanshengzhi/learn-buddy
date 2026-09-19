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

# Lookup dictionaries (~130 MB build artifacts, ADR 0008). Synced once —
# rebuilt only when a local rebuild changes them; absent locally, the
# builder can run on claw (sudachipy lives in claw's venv).
if [ -f server/data/dicts/en.sqlite ]; then
  ssh "${HOST}" "mkdir -p ${DEST}/server/data"
  rsync -az server/data/dicts/ "${HOST}:${DEST}/server/data/dicts/"
else
  ssh "${HOST}" "test -f ${DEST}/server/data/dicts/en.sqlite || sudo -u learnbuddy ${DEST}/.venv/bin/python3 ${DEST}/server/tools/build_dicts.py --only en,ja,kanji" || true
fi

# Stamp the deployed sw.js with a fresh value so the browser detects a new
# Service Worker on every deploy (byte change -> re-install -> fresh shell
# precache + purge of old caches). Without this, cache-first static serving
# keeps serving stale JS/CSS and family devices need a manual cache clear.
STAMP="$(date +%s)"
ssh "${HOST}" "sudo sed -i \"s/^const DEPLOY_STAMP = '[^']*';/const DEPLOY_STAMP = '${STAMP}';/\" ${DEST}/web/sw.js"

ssh "${HOST}" "sudo systemctl restart learnbuddy"

echo "Deployed."
echo "  LAN:     http://192.168.3.28/"
echo "  Tailnet: https://home-srv.tailf905b5.ts.net/"
