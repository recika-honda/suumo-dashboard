#!/bin/bash
# Wrapper for launchd on the 園田PC (recika user, Apple Silicon — no AgentSSD, no brew node).
# node is provided by a per-user fnm install (brew is owned by another user `sonoda`).
set -e

PROJECT="$HOME/dev/suumo-dashboard"
NODE="$HOME/.fnm/aliases/default/bin/node"

if [ ! -d "$PROJECT" ]; then
  echo "[wrapper] $(date): project not found at $PROJECT — exit"
  exit 1
fi
if [ ! -x "$NODE" ]; then
  echo "[wrapper] $(date): node not executable at $NODE — exit"
  exit 1
fi

cd "$PROJECT"
exec "$NODE" scripts/watch-nyuko.js
