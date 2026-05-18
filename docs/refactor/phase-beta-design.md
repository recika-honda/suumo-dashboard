# Phase β Design — 03b feature-codes-resolve skeleton

**Date**: 2026-05-16  
**Status**: APPROVED — implementation can proceed (T002-T004)  
**Scope**: 既存 3 経路の behavior-preserving 抽出のみ。マイソク OCR (Phase γ-δ) は placeholder のみ。

---

## 1. 03b Output Schema

```js
/**
 * @typedef {Object} FeatureCodeEvidence
 * @property {"setsubi"|"building"|"default"|"maisoku"} source  - 経路識別子
 * @property {string} reason    - 人間可読な根拠 (e.g. "keyword '宅配ボックス' matched in 設備フリー")
 * @property {string} [matched] - マッチしたキーワード or フィールド値 (setsubi/maisoku のみ)
 */

/**
 * @typedef {Object} ResolveFeatureCodesResult
 * @property {string[]} checkedCodes  - 確定コード配列 (重複なし、順序不定)
 * @property {Object.<string, FeatureCodeEvidence[]>} evidence
 *   - key: コード ("0501" 等), value: エビデンス配列 (複数経路でヒットした場合は複数)
 * @property {string} generated_at   - ISO 8601 timestamp
 * @property {string[]} source_files  - 参照した config/入力ファイルのパス
 */
```

**マイソク経路の placeholder**: `source: "maisoku"` は Phase γ-δ で実装。Phase β では
`resolveFeatureCodes` の引数 `maisokuText` を受け取るが、`null` / `undefined` の場合は
スキップしてエビデンスに `{source:"maisoku", reason:"skipped — maisoku not yet available"}` を残す。
これにより Phase γ-δ での統合時に schema は変更不要。

---

## 2. 新モジュール: `skills/feature-codes-resolve.js`

**Path**: `code/suumo-dashboard/skills/feature-codes-resolve.js`

```js
/**
 * Resolve feature codes (特徴コード) from REINS data and optional maisoku text.
 *
 * Pure function: no I/O, no side effects. All inputs must be passed explicitly.
 * Config (150-code SSOT) is passed as featureCodesConfig to enable unit testing
 * without filesystem access.
 *
 * @param {object} opts
 * @param {object}   opts.reinsData          - Stage 01 output (REINS extracted data)
 * @param {object}   opts.featureCodesConfig - Parsed config/forrent-feature-codes.json
 * @param {string}  [opts.maisokuText]       - Stage 02c output (flat text from PDF). null = Phase γ-δ not yet run.
 * @returns {ResolveFeatureCodesResult}
 */
function resolveFeatureCodes({ reinsData, featureCodesConfig, maisokuText = null }) { ... }

module.exports = { resolveFeatureCodes };
```

**不変条件**:
- `async` なし。`require()` 時に env / FS を読まない (lazy-init ルール準拠)
- `SETSUBI_TO_TOKUCHO`, `inferTokuchoFromBuilding`, `DEFAULT_TOKUCHO_CODES` の 3 定数/関数を
  `fill-tokucho.js` からコピー移植し、同一ロジックで動作することを parity test で保証する
- **SSOT filter は maisoku 経路にのみ適用** (kento 判断 2026-05-16): 既存 3 経路 (setsubi / building / default) は filter なしで旧 `fillTokucho` 完全互換 (bitwise parity)。`featureCodesConfig` の 150 コードリストは maisoku-text 由来候補の絞り込み (OCR ノイズ除去) 専用とし、Phase γ-δ で実装する maisoku 経路にのみ通す。
- 例: `2201 (クロゼット)` は旧 `DEFAULT_TOKUCHO_CODES` に含まれ SSOT 外だが、Phase β では emit する (旧挙動保持)。
- Phase β では `maisokuText = null` で実質 maisoku 経路スキップ → `checkedCodes` は現行 `fillTokucho` と bitwise 同一出力。

---

## 3. 新 Stage: `scripts/stages/03b-feature-codes-resolve.js`

**Path**: `code/suumo-dashboard/scripts/stages/03b-feature-codes-resolve.js`

```js
/**
 * Stage 03b: Feature code resolution (SSOT)
 *
 * Reads reinsData + featureCodesConfig, calls resolveFeatureCodes(),
 * and writes the result to logs/runs/{runDir}/03b-feature-codes-resolve/{output}.json.
 *
 * @param {object} opts
 * @param {object}   opts.reinsData
 * @param {string}  [opts.maisokuText]     - null until Phase γ-δ
 * @param {(name: string, extra?: object) => void} opts.logStep
 * @param {string}  [opts.runDir]
 * @returns {Promise<ResolveFeatureCodesResult>}
 */
async function runFeatureCodesResolve({ reinsData, maisokuText = null, logStep, runDir }) { ... }

module.exports = { runFeatureCodesResolve };
```

**I/O パス**:
- Input (stage artifact): `logs/runs/{ts}_{reinsId}/03b-feature-codes-resolve/input.json`
  - 内容: `{ reinsData, hasMaisokuText: boolean }`
- Output: `logs/runs/{ts}_{reinsId}/03b-feature-codes-resolve/output.json`
  - 内容: `ResolveFeatureCodesResult` (checkedCodes + evidence + generated_at + source_files)
- Config: `config/forrent-feature-codes.json` を `require()` で読み込む (変更頻度低、process 起動時 1 回)

---

## 4. Pipeline placement / 配線: 03b は 03 の後 / 04 の前

**READ による根拠**: `04-texts-generate.js` line 19 の signature `async function runTextsGenerate({ reinsData, logStep, runDir })` と line 23 の `generateTexts(reinsData)` 呼び出しから、stage 04 は `checkedCodes` に依存しない。よって **03b は 04 と独立**。

配線順序 (pipeline placement):
```
03 → 03b (feature-codes-resolve) → 04 → 05
```

`batch-nyuko.js / processProperty` への変更:
```js
const r3b = await runFeatureCodesResolve({ reinsData, maisokuText: null, logStep, runDir });
const texts = await runTextsGenerate({ reinsData, logStep, runDir });
// r3b.checkedCodes は Stage 05 に渡す (T004 で対応)
```

---

## 5. Migration Order (T002 → T003 → T004)

各 Task 完了後に `npm test` (163 cases) 全 green を確認する (migration order の検証ゲート)。

**T002**: `skills/feature-codes-resolve.js` 新規作成。`fill-tokucho.js` から 3 定数/関数をコピー (削除は T004 まで行わない)。`resolveFeatureCodes` を pure function で実装。`test-feature-codes-resolve.js` を作成: 3 経路 parity test (DOM なし)・schema test・maisoku-null test。検証: `npm test` green、`fill-tokucho.js` 無変更。

**T003**: `scripts/stages/03b-feature-codes-resolve.js` 新規作成。`batch-nyuko.js` に配線 (r3b 取得のみ、stage 05 への受け渡しは T004)。`writeStageInput/Output` で artifact 永続化。検証: `npm test` green + smoke 1 件で `03b-feature-codes-resolve/output.json` 生成確認。

**T004**: stage 05 を `r3b.checkedCodes` consumer に縮退。`runForrentFill` に `checkedCodes` 追加引数。`fillTokucho(mainFrame, reinsData)` → `fillTokuchoFromCodes(mainFrame, checkedCodes)` に置換 (thin wrapper を `fill-tokucho.js` に追加)。parity smoke 後に `fill-tokucho.js` 内の 3 経路 inline ロジックを削除 (thin wrapper のみ残す)。検証: `npm test` green + smoke 2 件以上で score が T003 前と同等以上。

---

## 6. Test impact / Test 影響

**既存 163 cases のうち 3 経路ロジックを直接テストしているもの**:

`scripts/test/` を調査した結果、`SETSUBI_TO_TOKUCHO` / `inferTokuchoFromBuilding` /
`DEFAULT_TOKUCHO_CODES` を直接 `require` するテストファイルは **存在しない**。
(`grep` で確認: `test-*.js` に `fill-tokucho` / `inferTokucho` / `SETSUBI_TO_TOKUCHO` /
`DEFAULT_TOKUCHO` への参照なし)

よって T002 の新規 unit test が 3 経路の最初の直接テストになる。

**新規 unit test 宣言** (T002 で作成):

| テスト名 | 内容 | Cases 目安 |
|----------|------|-----------|
| parity-setsubi | 既知 reinsData で `resolveFeatureCodes` の setsubi 経路コードが `fillTokucho` 内部 Set と一致 | 5 |
| parity-building | 既知 reinsData で building 経路コードが `inferTokuchoFromBuilding` と一致 | 5 |
| parity-default | DEFAULT_TOKUCHO_CODES 全 6 件が `checkedCodes` に含まれること | 1 |
| schema-valid | `checkedCodes` 配列、`evidence` object、`generated_at` ISO string | 3 |
| maisoku-null | `maisokuText=null` で通常動作、evidence に placeholder entry | 1 |
| ssot-filter | `featureCodesConfig` の 150 コード外のコードは `checkedCodes` から除外 | 2 |
| total | | ~17 |

---

## 7. Risk & Rollback

| Risk | Severity | Mitigation |
|------|----------|------------|
| parity 不一致: `resolveFeatureCodes` が既存 `fillTokucho` と異なる codes を返す | High | T002 で parity test を green にするまで T003 に進まない。不一致は `fill-tokucho.js` の inline ロジックとの diff を出して個別修正 |
| stage 05 縮退 (T004) で score が下がる | Medium | smoke run 2 件で score を比較。下がった場合は `git revert T004 commit` して T003 の状態に戻す (`env PHASE_BETA_05_CONSUMER=0` フラグで旧 path に切り替える実装も選択肢) |
| 03b stage の artifact 書き込み失敗で batch が止まる | Low | `writeStageInput/Output` は現行と同じ `artifact.js` を使用。既存 stage と同等のエラー耐性 |
| `config/forrent-feature-codes.json` の read error | Low | require() 時に try-catch し、失敗したら警告のみで 3 経路のみで継続 (SSOT filter スキップ) |

**Rollback コマンド** (各 Task ごと):
- T002 失敗: `git revert <T002 commit>` — `skills/feature-codes-resolve.js` と `test-feature-codes-resolve.js` を削除
- T003 失敗: `git revert <T003 commit>` — stage 03b と `batch-nyuko.js` 配線変更を削除。`npm test` で green 確認
- T004 失敗: `git revert <T004 commit>` — `05-forrent-fill.js` と `fill-tokucho.js` の変更を差し戻し。旧 `fillTokucho(mainFrame, reinsData)` call に戻る

---

## 8. Deletion timing / 旧 Inline ロジック削除タイミング

**T004 (stage 05 縮退時) に削除する**。T002 では削除しない。

理由: T002 〜 T003 の期間は `fill-tokucho.js` の旧実装と `feature-codes-resolve.js` の新実装が
**並存する**。この二重持ち期間が parity test の前提条件であり、`fillTokucho` を残すことで
smoke run で新旧の出力を並べて比較できる。T003 完了後の smoke で parity が確認でき次第、
T004 で旧 inline ロジック (`SETSUBI_TO_TOKUCHO` への直接参照、`inferTokuchoFromBuilding` の
直接呼び出し、`DEFAULT_TOKUCHO_CODES` の直接 union) を `fill-tokucho.js` から削除し、
`fillTokucho` は `fillTokuchoFromCodes(mainFrame, codes)` のみに縮退させる。

`fill-tokucho.js` 自体は facade として残す (export の後方互換を維持するため)。
削除するのは `fillTokucho` 内の 3 経路 inline ロジックのみ。

