#!/bin/bash
# run-archive-runs.sh — launchd から呼ばれるラッパー
# logs/archive-runs.log に stdout / stderr を append。

set -u
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$SCRIPT_DIR"

LOG_FILE="$SCRIPT_DIR/logs/archive-runs.log"
mkdir -p "$SCRIPT_DIR/logs"

{
  echo "════════════════════════════════════════════════════════"
  echo "[archive] $(date '+%Y-%m-%d %H:%M:%S %Z') start"
  /usr/local/bin/node scripts/archive-runs.js
  echo "[archive] $(date '+%Y-%m-%d %H:%M:%S %Z') end (exit=$?)"
} >> "$LOG_FILE" 2>&1
