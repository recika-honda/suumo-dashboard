# daily-aggregate-phase-delta — Phase ε/ζ Step 5 framework

Phase ε/ζ 効果測定の Step 5 (daily aggregate)。`logs/runs/{ts}_*/` を 1 日分 (24h, JST) scan し、6 軸メトリクスを daily report (JSON + Markdown 1-pager) に集約する。

仕様参照: `code/suumo-dashboard/docs/refactor/phase-epsilon-design.md` §6 / §8 / §9 / §10

## 6 軸メトリクス

| Axis | 概要 | 実装状態 |
|------|------|---------|
| 1. 02b/02c chain | download / source (pdftotext\|vision-ocr) breakdown / OCR cost | pure 実装済 |
| 2. 03b source breakdown | maisoku_pure / overlap / legacy_only mean | pure 実装済 (T003 完成後は lib に統合) |
| 3. DOM 突合 (Step 1) | exact / missed / phantom rate | **T003 (lib-dom-match.js) 待ち** |
| 4. score (Step 4) | median / p25 / p75 / escalation rate | run.json#score 直接読みの暫定実装 (T005 で再生成) |
| 5. 否定語 FP (Step 3) | maisoku 経路の FP 率 | **T003 (lib-dom-match.js) 待ち** |
| 6. maisoku hit rate | maisoku 経路で 1 code 以上追加した run 率 | pure 実装済 |

T003 / T005 lib が未実装でも graceful fallback (`warnings` 配列に "placeholder, T003/T005 完成後に再生成" を追加して null で出力)。

## CLI 使い方

```bash
cd /Volumes/AgentSSD/04_FANGO/FNG26_AI入稿システム/code/suumo-dashboard

# 今日 (JST) の run を集計
node scripts/daily-aggregate-phase-delta.js

# 特定日を指定
node scripts/daily-aggregate-phase-delta.js --date=2026-05-17

# 出力先 / runs ディレクトリを指定
node scripts/daily-aggregate-phase-delta.js \
  --date=2026-05-17 \
  --out=logs/measure/daily \
  --runs=logs/runs
```

### 出力

- `logs/measure/daily/{YYYY-MM-DD}.json` — `DailyReport` (phase-epsilon-design.md §8 / §10.1 準拠)
- `logs/measure/daily/{YYYY-MM-DD}.md` — Markdown 1-pager (§6.4 テンプレート)

## launchd routine (com.recika.fango.daily-aggregate)

毎日 09:00 JST に前日分を集計する自動 routine。**ship 時は disabled state**。Phase ζ 開始合意までは kento が手動で有効化しない。

### plist 内容

```xml
<key>Disabled</key>
<true/>
```

この `Disabled` キーは launchctl load 前に削除する。

### 有効化手順 (Phase ζ 開始合意後)

> **CRITICAL**: 既存 launchd routine (`jp.fango.watch-nyuko` 等) を絶対に触らない。
> launchctl 操作は **新 plist (`com.recika.fango.daily-aggregate`) のみ** に限定。

```bash
# 1. 既存 routine の現状を記録 (touch 前のスナップショット)
launchctl list | grep -E "fango|recika|watch-nyuko" > /tmp/launchd-before.txt
WATCH_NYUKO_PID_BEFORE=$(launchctl list | grep watch-nyuko | awk '{print $1}')
echo "watch-nyuko PID before: $WATCH_NYUKO_PID_BEFORE"

# 2. plist を ~/Library/LaunchAgents/ にコピー
cp scripts/com.recika.fango.daily-aggregate.plist ~/Library/LaunchAgents/

# 3. Disabled キーを削除 (有効化)
#    (sed で <key>Disabled</key> + 直後の <true/> を削除する2行マッチ)
/usr/bin/python3 -c "
import re, sys
p = '$HOME/Library/LaunchAgents/com.recika.fango.daily-aggregate.plist'
with open(p, 'r') as f: s = f.read()
s = re.sub(r'\s*<key>Disabled</key>\s*<true/>\s*\n', '\n', s)
with open(p, 'w') as f: f.write(s)
print('Disabled key removed')
"

# 4. try/finally で load + verify (必須 — gotchas.md 2026-05-16 incident 教訓)
load_and_verify() {
  set -e
  trap 'echo "[ABORT] load 中に exit、状態確認: launchctl list | grep daily-aggregate"' ERR

  launchctl load ~/Library/LaunchAgents/com.recika.fango.daily-aggregate.plist
  echo "launchctl load OK"

  # verify
  if ! launchctl list | grep -q "com.recika.fango.daily-aggregate"; then
    echo "[ERROR] load 後の launchctl list で daily-aggregate が見つからない"
    exit 1
  fi
  echo "launchctl list verify: daily-aggregate FOUND"

  # 既存 routine が無傷であることも verify
  WATCH_NYUKO_PID_AFTER=$(launchctl list | grep watch-nyuko | awk '{print $1}')
  if [ "$WATCH_NYUKO_PID_BEFORE" != "$WATCH_NYUKO_PID_AFTER" ]; then
    echo "[WARN] watch-nyuko PID changed: $WATCH_NYUKO_PID_BEFORE -> $WATCH_NYUKO_PID_AFTER"
    echo "新 plist の load で既存 routine に影響が出ている可能性。即調査"
    exit 1
  fi
  echo "watch-nyuko PID unchanged: $WATCH_NYUKO_PID_AFTER"
}

load_and_verify
```

### 一時停止 (例: smoke 中に hourly cycle と競合させたくない、または OCR cost spike 中)

```bash
# unload (try/finally で load を必ず復旧)
unload_and_finally_load() {
  local unloaded=0
  trap '
    if [ $unloaded -eq 1 ]; then
      echo "[FINALLY] launchctl load 復旧中..."
      launchctl load ~/Library/LaunchAgents/com.recika.fango.daily-aggregate.plist
      launchctl list | grep -q daily-aggregate || echo "[ERROR] load 復旧失敗"
    fi
  ' EXIT

  launchctl unload ~/Library/LaunchAgents/com.recika.fango.daily-aggregate.plist
  unloaded=1
  echo "unloaded"
  # ... 必要な作業をここで実施 ...

  # 明示的に load (trap でも保証されるが、明示が safer)
  launchctl load ~/Library/LaunchAgents/com.recika.fango.daily-aggregate.plist
  unloaded=0
  echo "loaded back"
}
```

### 無効化 (完全停止)

```bash
launchctl unload ~/Library/LaunchAgents/com.recika.fango.daily-aggregate.plist
rm ~/Library/LaunchAgents/com.recika.fango.daily-aggregate.plist
launchctl list | grep daily-aggregate  # 空行なら OK
```

## 関連ファイル

| Path | 役割 |
|------|------|
| `scripts/daily-aggregate-phase-delta.js` | CLI entry (250-450 LOC) |
| `scripts/com.recika.fango.daily-aggregate.plist` | launchd 雛形 (disabled state) |
| `scripts/measure/lib-dom-match.js` | T003 (未実装) — DOM 突合 / source breakdown / 否定語 FP |
| `scripts/measure/lib-score-extract.js` | T005 (未実装) — score 抽出 (run.json + confirm-attempt1 + validation-after-escalate の 3 段 fallback) |
| `logs/measure/daily/{YYYY-MM-DD}.json` | DailyReport JSON 出力 |
| `logs/measure/daily/{YYYY-MM-DD}.md` | Markdown 1-pager 出力 |
| `logs/measure/daily/2026-05-17-baseline.md` | Day 1 baseline (T007 で生成) |
| `docs/refactor/phase-epsilon-design.md` | 仕様 SSOT (724 行、12 sections) |

## 依存ルール

- **`~/.claude/rules/atbb-session-management.md`** Rule 6: launchctl unload を含む operation は try/finally で load を保証 + load 後 `launchctl list | grep <label>` で existence verify
- **`.claude/gotchas.md` 2026-05-16: smoke script で watch-nyuko を unload したまま load し忘れ** — 同パターンの再発を防ぐため、本 plist の有効化スクリプトでは load 後の verify を必須化
- **既存 launchd 管理 routine は無触り**: `jp.fango.watch-nyuko` / `com.recika.fango.archive-runs` の plist / 状態は本作業で一切変更しない (新 plist の load のみ実施)
