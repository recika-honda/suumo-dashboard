# scripts/legacy/

本番フローからは参照されない調査・診断・E2E・smoke test スクリプト群のアーカイブ。

本流パイプライン (`scripts/batch-nyuko.js` / `scripts/watch-nyuko.js` / `scripts/resume-nyuko.js` / `scripts/pipeline-statuses.js` / `scripts/stages/`) からは require/import されない。

## 動作状況

各ファイルは mv 時点で `__dirname` 基準の相対パス (`../skills/` → `../../skills/`、`__dirname, ".."` → `__dirname, "..", ".."`) を更新済み。全ファイル syntax check pass。

ただし以下 5 ファイルは過去の `skills/` 構造で書かれており、**現在の `skills/` と整合しない require が残っている** (syntax check は通るが require 評価時に `MODULE_NOT_FOUND` で落ちる):

| ファイル | 欠落モジュール | 現状 |
|----------|---------------|------|
| `batch-test.js` | `skills/bukaku-images` | `skills/bukaku` に統合済み |
| `e2e-test-15.js` | `skills/bukaku-images` | 同上 |
| `test-bukaku.js` | `skills/bukaku-images` | 同上 |
| `test-bukaku-batch.js` | `skills/bukaku-images` | 同上 |
| `test-atbb.js` | `skills/atbb` | `skills/atbb.js` は現存しない |

現在の `skills/` と整合し、起動可能性が高いファイル:
- `diagnose-nyuko.js`
- `dryrun-keisai-hoyu.js`
- `quick-test.js`
- `test-loop.js`

## 再利用時の注意

挙動を保証するものではない。再実行するときは:

1. 上記表で require 先が現存するか確認
2. 必要なら `skills/` 側の現在の API に合わせて require と関数名を書き換える
3. `.env.local` は project root にあり、`path.join(__dirname, "..", "..", ".env.local")` で参照される (mv 後対応済み)
