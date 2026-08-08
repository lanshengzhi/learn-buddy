#!/usr/bin/env bash
# Deploy LearnBuddy to claw (home-srv).
# Usage: ./scripts/deploy.sh
# Requires: rsync (local + claw), ssh key to claw, passwordless sudo on claw.
set -euo pipefail

HOST=claw
DEST=/srv/learnbuddy

rsync -az --delete --exclude 'cache/' --exclude '__pycache__/' web/ "${HOST}:${DEST}/web/"
rsync -az --delete --exclude 'cache/' --exclude '__pycache__/' server/ "${HOST}:${DEST}/server/"
ssh "${HOST}" "sudo systemctl restart learnbuddy"

echo "Deployed."
echo "  LAN:     http://192.168.3.28/"
echo "  Tailnet: https://home-srv.tailf905b5.ts.net/"
