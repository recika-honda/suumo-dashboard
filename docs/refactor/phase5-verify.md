# Phase 5 動作確認結果

## 概要

Phase 4 完了後の cleanup pass。`scripts/` 直下に散らばっていた本流外スクリプト (調査/diagnose/E2E/smoke test) を `scripts/legacy/` に集約し、本番フロー (`batch-nyuko.js` / `watch-nyuko.js` / `resume-nyuko.js` / `pipeline-statuses.js` / `stages/`) との境界を物理的に分離した。

実施日: 2026-05 (Phase 4 完了直後)
ブランチ: `refactor/cleanup-2026-05` 系列

## 1. 移動対象

`scripts/legacy/` 直下に 9 スクリプト + README:

```
scripts/legacy/
├── README.md
├── batch-test.js
├── diagnose-nyuko.js
├── dryrun-keisai-hoyu.js
├── e2e-test-15.js
├── quick-test.js
├── test-atbb.js
├── test-bukaku-batch.js
├── test-bukaku.js
└── test-loop.js
```

## 2. 移動時の修正

- `__dirname` 基準の相対 require を 1 階層深くなった分だけ書き換え
  - `../skills/` → `../../skills/`
  - `path.join(__dirname, "..")` → `path.join(__dirname, "..", "..")`
- `.env.local` 参照も同様に補正
- 全ファイル syntax check pass (`node --check`)

## 3. 動作状況の分類

require 評価まで通せるかで 2 グループに分かれる:

### 整合 4 ファイル (require 解決可)
- `diagnose-nyuko.js`
- `dryrun-keisai-hoyu.js`
- `quick-test.js`
- `test-loop.js`

### 不整合 5 ファイル (require 評価で MODULE_NOT_FOUND)

| ファイル | 欠落モジュール | 原因 |
|---------|------------|------|
| `batch-test.js` | `skills/bukaku-images` | 現在は `skills/bukaku` に統合済 |
| `e2e-test-15.js` | `skills/bukaku-images` | 同上 |
| `test-bukaku.js` | `skills/bukaku-images` | 同上 |
| `test-bukaku-batch.js` | `skills/bukaku-images` | 同上 |
| `test-atbb.js` | `skills/atbb` | `skills/atbb.js` は現存しない (ATBB 対応削除に伴う) |

これらは挙動を保証しない。再実行する時は README の手順で require 先と関数名を現 API に合わせて書き換える前提。

## 4. 本流からの非参照確認

本番パイプラインのファイル群から `scripts/legacy/` への import/require は一切無し:

```bash
grep -rn "legacy/" scripts/*.js scripts/stages/*.js skills/*.js api-server.js runNyuko.js
# (no matches)
```

→ legacy/ が壊れていても本番フローには影響しない。

## 5. Acceptance Criteria 達成状況

| AC | 結果 |
|---|---|
| 1. 本流フローと legacy が物理的に分離されている | ✅ ディレクトリ分離 |
| 2. 本流から legacy/ への参照が無い | ✅ grep 確認済 |
| 3. legacy/ の状況を再利用者向けに記述 | ✅ `scripts/legacy/README.md` |

## 6. 残課題 (リリースブロッカーではない)

- 不整合 5 ファイルの修正 or 削除は保留 (本流に影響しないので優先度低)
- `scripts/legacy/` を ripgrep / lint / AI ignore に登録するかは別タスク (ノイズ削減目的)
- 完全削除して git log のみに残す選択肢もある (情報価値次第)

## 7. 結論

✅ **Phase 5 完了**。本流コード読解時のノイズを軽減し、Phase 6 (vanilla front 化) に進む土台を整えた。
