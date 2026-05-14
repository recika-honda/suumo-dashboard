# Phase 7.5 — TIMEOUT auto-resume / Notion feedback / archive automation

Phase 7 の forrent.js 分割と同セッションで実施した周辺改善のまとめ。

実施日: 2026-05-14

## 1. TIMEOUT 自動 resume

### 背景
現状の watch-nyuko → batch-nyuko フローは、TIMEOUT (15 分超過) になった物件を Notion
「広告待ち」のまま維持し、次のサイクルで Stage 01 から再実行していた。stage artifact
(`logs/runs/{ts}_{reinsId}/{stage}/output.json`) はあるのに、それを使わずに毎回 15 分
の作業を捨てていた。

### 変更
- `scripts/lib/run-inspect.js` 新規 — `findResumeStage(runDir)` で「次に再実行すべき
  stage」を判定 (`{stage}/output.json` の存在から導出、05 完了でも 06 単独不可なので 05 から)
- `scripts/watch-nyuko.js` — batch 終了後の report.results を走査し、TIMEOUT を検出したら
  `resume-nyuko.js` を spawn して 1 回だけリトライ。結果に応じて Notion を「掲載保留」
  or「入稿失敗」に書き戻す
- `logs/retries.jsonl` — retry 履歴を append。同一 reinsId + originalRunDir で未終了
  retry が記録されていたら skip (loop 防止)
- `scripts/batch-nyuko.js` — result に `pageId` を追加 (watch-nyuko が Notion 更新で必要)

### テスト
- `scripts/test/test-run-inspect.js` (11 cases) — findResumeStage / readRetryHistory / hasOpenRetry

## 2. Notion フィードバック (A+B+C, D は対象外)

### 背景
REG_FAIL / TIMEOUT が Notion で「入稿失敗」に倒れるとき、**なぜ失敗したか** が Notion から
読み取れず、後藤さん / 大木さんは `logs/runs/.../06-forrent-register/output.json` を
開かないと理由が分からなかった。

### 変更
- `scripts/lib/notion-feedback.js` 新規 — `categorizeError` / `buildReasonText` /
  `buildFeedbackProperties` の純粋関数群
- `scripts/batch-nyuko.js` / `scripts/watch-nyuko.js` — `updateNotionStatus(pageId, status, result)`
  に拡張。"入稿失敗" のときは feedback プロパティも同送

### Notion 側の手動セットアップ (kento タスク)
NOTION_DATABASE_ID の DB に以下 2 プロパティを追加:
- **入稿失敗理由** (Rich text)
- **失敗カテゴリ** (Select with options: `データ不備` / `forrent 検証失敗` / `想定外エラー` / `タイムアウト`)

これらが未追加でも `updateNotionStatus` は Status のみで再試行する graceful フォールバックを
持つので、本流は止めない。

### カテゴリの判定ロジック
| result.status | errors[] | reason | → カテゴリ |
|---|---|---|---|
| `NOT_FOUND` | - | - | データ不備 |
| `REG_FAIL` | 空 | あり | データ不備 |
| `REG_FAIL` | 非空 | - | forrent 検証失敗 |
| `TIMEOUT` | - | - | タイムアウト |
| `ERROR` | - | - | 想定外エラー |
| `SUCCESS` / `FORRENT_LOGIN_FAIL` | - | - | null (書き戻さない) |

### スコープ外 (D 案: 要修正 Status)
- 「データ不備」だけを「要修正」Status に分類して、大木さんが REINS データを補完したら
  Notion で「広告待ち」に戻して自動再エントリさせる構想 — 今回は実装しない
- 必要なら別 phase で。`pipeline-statuses.js` の `resolveNotionStatus` を拡張するだけ

### テスト
- `scripts/test/test-notion-feedback.js` (17 cases)

## 3. アーカイブ自動化

### 背景
- `logs/runs/` = 170 MB / 475 run dir (1 run 平均 ~360 KB、内訳は主に PNG)
- 推移予測: 月 ~300 MB、年 ~3.6 GB
- `_diag` 系の調査用 run と production run が混在

### 変更

#### 5-A: `_diag` 隔離 (即時)
- `logs/runs/*_diag` (4 件) を `logs/diag/` に手動 mv
- `logs/diag/README.md` に方針を明示
- `.gitignore` の `logs/` 配下なので追加対応不要

#### 5-B: アーカイブスクリプト
- `scripts/archive-runs.js` 新規 — 3 段ポリシー:
  1. SUCCESS が 7 日超 → tar.gz 化して元 dir 削除
  2. 失敗系 (REG_FAIL / TIMEOUT / ERROR / NOT_FOUND / FORRENT_LOGIN_FAIL) が 30 日超 → 同様
  3. tar.gz が 90 日超 → `logs/runs/archive/yyyy-mm/` に移送
- `--dry-run` / `--success-days N` / `--fail-days N` / `--archive-days N` のフラグ対応

実測 (2026-05-14 dry-run): compressed=281, skipped=190, freed=94.1 MB
→ 170 MB → ~76 MB + tar.gz の効果

#### 5-C: launchd 自動化
- `scripts/run-archive-runs.sh` — launchd ラッパー (stdout/stderr を `logs/archive-runs.log` に追記)
- `scripts/com.recika.fango.archive-runs.plist` — 毎日 03:00 ローカル時間 (= REINS 営業時間外)
- インストール手順は plist 内コメント参照

## 4. 検証コマンド

```bash
cd /Volumes/AgentSSD/04_FANGO/FNG26_AI入稿システム/code/suumo-dashboard
npm test                                  # 70 cases pass
node scripts/archive-runs.js --dry-run    # 安全に挙動確認
```

## 5. テスト合計 (Phase 7 + 7.5)

| ファイル | cases |
|---|---|
| test-sanitize-for-length.js | 14 |
| test-spec-validator.js | 11 |
| test-run-inspect.js | 11 |
| test-validate.js | 17 |
| test-notion-feedback.js | 17 |
| **合計** | **70** |

## 6. 未実施 (kento 確認後の最終ステップ)

- 実物件 1 件で smoke test (forrent.js 分割の最終検証)
- Notion DB に「入稿失敗理由」「失敗カテゴリ」プロパティを追加
- `~/Library/LaunchAgents/com.recika.fango.archive-runs.plist` の設置 + launchctl load
