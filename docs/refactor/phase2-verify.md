# Phase 2 動作確認結果

## 概要

Phase 2 (T2.1〜T2.8) 完了後の検証。stage 分割と orchestrator 薄化が完了。

実施日時: 2026-05-12
ブランチ: `refactor/cleanup-2026-05`
比較対象: main (commit `28245ff` = pre-refactor snapshot)

## 1. stage モジュール load 検証

```
$ node -e "require('./scripts/batch-nyuko'); ['01-reins-extract','02-images-download','03-images-classify','04-texts-generate','05-forrent-fill','06-forrent-register'].forEach(s => require('./scripts/stages/'+s));"
all 6 stages load OK
```

✅ 6 stage すべて require 成功。注意: stages を直接 require する前に batch-nyuko.js (dotenv をロード) を先に require する必要がある (image-ai が module-load 時に API key を要求する pre-existing な性質)。

## 2. dry-run 実行

```
$ bun run scripts/batch-nyuko.js --dry-run
  Notion「広告待ち」: 2件

  [dry-run] 物件一覧:
    - 100139101936
    - 100139101479
{"processed":0,"succeeded":0,"failed":0,"dryRun":true,"pending":2,"results":[]}

(exit code: 0)
```

✅ dryRun branch (`{processed, succeeded, failed, dryRun, pending, results}`) が pre-refactor と同形で動作。

## 3. processProperty 行数

```
$ awk '/^async function processProperty/,/^async function main/' scripts/batch-nyuko.js | wc -l
71
```

✅ **目標 < 80 行 達成** (T2.8 の DoD)。

## 4. ファイル構成と行数

| File | 行数 | 役割 |
|---|---|---|
| `scripts/batch-nyuko.js` | 419 | orchestrator (main loop / Notion / Slack / processProperty) |
| `scripts/pipeline-statuses.js` | 48 | result status → Notion 遷移マッピング (Phase 1) |
| `scripts/stages/01-reins-extract.js` | 95 | REINS 検索 + 抽出 + 早期 validation |
| `scripts/stages/02-images-download.js` | 28 | REINS 画像取得 |
| `scripts/stages/03-images-classify.js` | 107 | AI 分類 + bukaku 補完 + shuhen |
| `scripts/stages/04-texts-generate.js` | 26 | キャッチコピー + フリーコメント生成 |
| `scripts/stages/05-forrent-fill.js` | 118 | forrent ログイン + フォーム入力 |
| `scripts/stages/06-forrent-register.js` | 67 | forrent 登録 + スコア検証 |
| **合計** | **908** | |

## 5. 行数比較 (Pre-refactor vs Post-refactor)

| | Pre (main) | Post | Delta |
|---|---|---|---|
| `scripts/batch-nyuko.js` | 620 | 419 | **-201 (-32%)** |
| processProperty 関数本体 | 278 | 71 | **-207 (-74%)** |

Note: T2.9 当初目標 < 350 行は未達 (419 行)。残る大きさは `main()` ループ + helpers (`createRunLog` / `loginReins` / `fetchPendingProperties` / `updateNotionStatus`) で構成される。これらはリファクタの直接スコープ外 (Notion driver / run logging) で、processProperty 自体の薄化は十分達成 (-74%)。`main()` の更なる分解は Phase 3 (artifact 化) や将来の別タスクで吸収。

## 6. Acceptance Criteria 達成状況

| AC | 結果 |
|---|---|
| 1. dry-run exit 0 | ✅ |
| 2. 全 stage ファイル (01〜06) が node -e で require できる | ✅ |
| 3. processProperty 行数 < 80 行 | ✅ (71) |
| 4. batch-nyuko.js < 350 行 | ⚠ 未達 (419 行)。理由 §5 参照。<br>processProperty 自体は十分薄化 (74% 削減) |
| 5. 実物件 1 件 smoke test | ⏸ kento トリガー保留 (TF.1 にて実施予定) |

## 7. semantic 等価性まとめ

各 T2.x の reviewer 判定で確認済:
- **T2.2 (Stage 01)**: NOT_FOUND / REG_FAIL 早期、reins-data.json artifact、logStep イベント全て一致
- **T2.3 (Stage 02)**: extractImageData → screenshotAllImages 順序維持
- **T2.4 (Stage 03)**: bukaku 並列 fetch、5pt 不足判定、shuhen 別ブラウザ finally close 維持
- **T2.5 (Stage 04)**: generateTexts 呼び出し等価
- **T2.6 (Stage 05)**: forrent ログイン + 全フォーム fill ops 順序、mainFrame 再取得 2 回、allErrors merge 順序維持
- **T2.7 (Stage 06)**: registerProperty 呼び出し、3 logStep イベント、register 内部例外の REG_FAIL 化 (ERROR 昇格防止) 維持
- **T2.8 (orchestrator)**: 戻り値 6 status 全て contract.md §3 と一致、try-catch 範囲が contract.md §8 と整合

## 8. 結論

✅ **Phase 2 完了**。Phase 3 (artifact 化 + resume コマンド) に進んでよい。

実物件 smoke test (TF.1) は Phase 4 完了後にまとめて実施予定。

## 9. 残課題

- batch-nyuko.js < 350 行未達 → main loop と helpers を別ファイルに分けるか、現状で許容するか別途判断 (Phase 3 で artifact ヘルパー追加時に再評価)
- T2.8 reviewer Minor 指摘: Stage 05 status を positive-check (`if (r5.status !== "OK")`) に切り替える件は未来の status 拡張時に併せて対応
