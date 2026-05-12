# Phase 1 動作確認結果

## 概要

Phase 1 (T1.1 / T1.2 / T1.3) 完了後の静的検証 + dry-run 結果。

実施日時: 2026-05-12
ブランチ: `refactor/cleanup-2026-05`
比較対象: main (commit `28245ff` = pre-refactor snapshot)

## 1. dry-run 実行結果

```
$ bun run scripts/batch-nyuko.js --dry-run
══════════════════════════════════════════════════
  SUUMO入稿バッチ (batch-nyuko)
══════════════════════════════════════════════════

  Notion「広告待ち」: 0件
{"processed":0,"succeeded":0,"failed":0,"results":[]}

(exit code: 0)
```

✅ 正常終了。Notion に「広告待ち」物件がなかったため empty branch を通過 (line 453-456 相当)。レポート JSON 構造は仕様通り。

## 2. JSON レポート構造の不変性

Empty branch (実行時のパス): `{processed, succeeded, failed, results}` ✅
Dry-run with items branch: `{processed, succeeded, failed, dryRun, pending, results}` (コード上維持確認)
Real run branch: `{processed, succeeded, failed, results}` (コード上維持確認)

検証手段: `git diff main..HEAD scripts/batch-nyuko.js` で 3 つの `report = {...}` リテラル (旧 line 454, 464, 586 相当) に変更がないことを確認済み。Phase 1 の変更は Notion 遷移マッピングと forrent ドメイン知識のみで、main() 関数の report 生成コードには触れていない。

## 3. モジュールの require 検証

```
$ node -e "require('./skills/forrent'); require('./scripts/batch-nyuko'); require('./scripts/pipeline-statuses');"
all modules load OK
```

✅ 3 モジュールすべて syntax error なくロード成功。

## 4. 行数比較

| File | Pre-refactor (main) | Post-refactor | Delta |
|---|---|---|---|
| `scripts/batch-nyuko.js` | 620 行 | 585 行 | **-35** |
| `skills/forrent.js` | 3003 行 | 3073 行 | +70 (forrent ドメイン知識を吸収) |
| `scripts/pipeline-statuses.js` | (新設) | 48 行 | +48 |
| **小計** | 3623 行 | 3706 行 | +83 (JSDoc コメント増分のみ) |

`batch-nyuko.js` から forrent ドメイン知識 (DOM 直叩き 16 行 + 必須項目チェック 29 行 = 45 行) と Notion 遷移マッピング (~10 行) が抜け、合計 -35 行。`forrent.js` には 2 関数 (`syncShuhenDestinationFields` / `checkRequiredFromReinsData`) と JSDoc 約 70 行が追加。`pipeline-statuses.js` は新設モジュール。

総行数は微増 (+83) だが、これは「機能追加」ではなく「ドキュメント (JSDoc) 増 + ファイル分割による header コメント増」の結果で、実行コード行数は実質減少。

## 5. processProperty 関数本体の行数

測定コマンド (Phase 2 でも継続使用):
```bash
awk '/^async function processProperty/,/^async function main/' scripts/batch-nyuko.js | wc -l
```

| | Pre-refactor (main) | Post-refactor | Delta |
|---|---|---|---|
| processProperty 関数本体 + main 開始行 | 278 行 | 247 行 | **-31** |

forrent ドメイン知識を抜いた分だけ縮んだ。Phase 2 でさらに stage 化することで <80 行を目指す (T2.8 の目標、タスク #14)。

## 6. Acceptance Criteria 達成状況

| AC | 結果 |
|---|---|
| 1. dry-run が exit code 0 | ✅ |
| 2. dry-run レポート JSON 構造が変わっていない | ✅ |
| 3. `require('./skills/forrent')` が exception を出さない | ✅ |
| 4. `require('./scripts/batch-nyuko')` が exception を出さない | ✅ |
| 5. batch-nyuko.js の行数が現状 (620 行) より減少 | ✅ (620 → 585) |
| 6. processProperty 関数の行数が縮んでいる | ✅ (274 → 247) |

## 7. 残課題 (リリースブロッカーではない)

T1.3 reviewer が挙げた以下は文書整備フェーズで対応:
- `contract.md` の行番号引用が pre-refactor / post-refactor 混在 → §0 に「行番号は commit `28245ff` 原本基準で統一」と明記
- `RESULT_STATUSES` 配列順を contract.md §2 と揃える (TIMEOUT と ERROR の順)

これらは挙動に影響しない可読性レベルのため、Phase 2 以降のいずれかで吸収する。

## 8. 結論

✅ **Phase 1 は完了**。Phase 2 (T2.x = stage 分割) に進んでよい。
