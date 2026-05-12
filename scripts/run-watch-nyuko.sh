#!/bin/bash
# Wrapper for launchd: cd into project and run watch-nyuko.js
set -e

SSD="/Volumes/AgentSSD"
PROJECT="$SSD/04_FANGO/FNG26_AI入稿システム/code/suumo-dashboard"
NODE="/Users/kentohonda/.fnm/aliases/default/bin/node"

# Wait for AgentSSD to be mounted (up to 2 min)
for i in $(seq 1 24); do
  [ -d "$PROJECT" ] && break
  sleep 5
done

if [ ! -d "$PROJECT" ]; then
  echo "[wrapper] $(date): AgentSSD not mounted — exit"
  exit 1
fi

cd "$PROJECT"
exec "$NODE" scripts/watch-nyuko.js
