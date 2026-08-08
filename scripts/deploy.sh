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
# code live atomically.
rsync -az --exclude 'cache/' --exclude '__pycache__/' web/ "${HOST}:${DEST}/web/"
rsync -az --exclude 'cache/' --exclude '__pycache__/' server/ "${HOST}:${DEST}/server/"
ssh "${HOST}" "sudo systemctl restart learnbuddy"

echo "Deployed."
echo "  LAN:     http://192.168.3.28/"
echo "  Tailnet: https://home-srv.tailf905b5.ts.net/"
