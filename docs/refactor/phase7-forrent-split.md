# Phase 7 — skills/forrent.js 分割

## 概要

3,136 LOC の monolith `skills/forrent.js` を 11 ファイルに分割し、`skills/forrent.js`
を 67 LOC の thin facade に縮減。public API (module.exports) は完全互換。

実施日: 2026-05-14
ブランチ: (TBD)

## 1. 動機

Phase 6 で stages を綺麗に切ったが、`skills/forrent.js` は 3,136 LOC のまま残っていた:
- skills 合計 6,739 LOC の **46%** がこの 1 ファイル
- `try/catch` 108 箇所 = DOM scraping の脆さを物量で抑えている状態
- テストもこのファイルには無く、Phase 7 でも E2E smoke test しか守れない領域だが、
  少なくとも純粋関数 (validate, sanitize, norm 系) は単体テスト可能だった

→ 機能単位で分割し、純粋関数群は単体テスト追加で守る。

## 2. ファイル構成

| 新ファイル | LOC | 内容 |
|---|---|---|
| `skills/forrent.js` | 67 | facade。public API を re-export するだけ |
| `skills/forrent/constants.js` | 78 | URLs / Selectors / S (Struts) / STRUCTURE_CODE / MADORI_TYPE_CODE / SHUHEN_CATEGORY_CODES |
| `skills/forrent/validate.js` | 123 | resolvePropertyTypeCode / validateBySpec / appliesToMatches / checkRequiredFromReinsData |
| `skills/forrent/form-helpers.js` | 164 | fillById / fillByName / selectByName / selectById / setCheckbox / selectRadioByIndex / waitForCascade |
| `skills/forrent/session.js` | 71 | login / navigateToNewProperty |
| `skills/forrent/fill-texts.js` | 201 | norm / toFullWidth / sanitizeForLength / fillTexts |
| `skills/forrent/fill-tokucho.js` | 425 | SETSUBI_TO_TOKUCHO / inferTokuchoFromBuilding / fillTokucho |
| `skills/forrent/fill-transport.js` | 468 | fillTransportViaMap / fillTransportCascade / fillTransportRakuraku |
| `skills/forrent/fill-form.js` | 848 | fillPropertyForm + fillMoneyFields + fillDeposit + fillConditionRadios |
| `skills/forrent/fill-images.js` | 380 | setFileInput / setImageCategory / uploadImages |
| `skills/forrent/fill-shuhen.js` | 287 | fillShuhenKankyo / syncShuhenDestinationFields |
| `skills/forrent/register.js` | 296 | scrapeValidation / saveFrameArtifacts / registerProperty |
| **合計** | **3,408** | (元 3,136 + 約 270 行のヘッダ/docblock) |

## 3. 設計原則

### 関数を verbatim 移動 (semantic 等価)
- すべての関数本体は元コードから **完全にコピー**。内部実装の改変は無し
- workflow.md の "Tested code is frozen" 規範に従う

### facade パターンで public API 維持
- `skills/forrent.js` は require + re-export のみ
- 既存呼び出し側 (`scripts/stages/*`, `api-server.js`, `runNyuko.js`,
  `scripts/test/test-spec-validator.js`, `scripts/test/test-sanitize-for-length.js`)
  は **無変更**
- 各 stage / test の import 文 `require("../../skills/forrent")` 経由でアクセス可

### 依存グラフ
```
constants.js          (純粋データ、依存なし)
  ↑
validate.js           (依存: constants)
  ↑
form-helpers.js       (純粋関数、Playwright Frame 渡し)
  ↑
session.js            (依存: constants)
  ↑
fill-texts.js         (純粋関数 + fillTexts)
  ↑
fill-tokucho.js       (依存: fill-texts.norm)
fill-transport.js     (依存: fill-texts.norm)
fill-images.js        (依存: constants, sharp, path)
fill-shuhen.js        (依存: constants)
fill-form.js          (依存: form-helpers, fill-texts.norm, validate, constants)
register.js           (依存: fs, path のみ。内部で scrapeValidation/saveFrameArtifacts を相互参照)

forrent.js (facade)   (上記 11 モジュールを re-export)
```

サイクル無し。fill-form.js が一番依存先が多いが、その下流はすべて純粋関数または低レベル
ヘルパーで深さ 1 段。

## 4. テスト追加

### 既存テスト (Phase 7 以前)
- `test-sanitize-for-length.js` (14 cases) — sanitizeForLength の CRLF anti-pattern 検証
- `test-spec-validator.js` (11 cases) — validateBySpec + checkRequiredFromReinsData
- 計 25 cases

### Phase 7 で追加
- `test-validate.js` (17 cases) — resolvePropertyTypeCode + appliesToMatches
  - 純粋関数を切り出した結果テスト可能になった
  - 1 の分割の中で task 4 (テスト追加) を吸収

### Phase 7 で別系統で追加 (関連)
- `test-run-inspect.js` (11 cases) — TIMEOUT auto-resume 用ヘルパー
  - 本 phase の forrent 分割とは独立だが同セッションで作業したため記載

### 合計
- **53 tests pass** (全て node スクリプト経由、`npm test` で実行)

## 5. 検証

### 静的チェック
- 全 12 ファイル (facade + 11 modules) が `node --check` 通過
- 各 step で `npm test` を実行し、25 → 53 tests pass の範囲で常に green

### 動的チェック (要 kento smoke test)
- 実物件 1 件の入稿で全 stage が SUCCESS することを確認 **(未実施 — Phase 7 完了の最終条件)**
- watch-nyuko 経由でも同様に動くことを確認 **(未実施)**

### 後戻り基準
- 任意の stage で REG_FAIL がリリース前より増えていたら revert
- forrent.js のサイズが元より増えていない (確認済: 67 LOC)
- public API (module.exports の keys) が変わっていない (確認済)

## 6. 既知の留意点

- `skills/forrent.js` を直接編集していた既存ワークフローがあれば、対応モジュールに変更先を移す必要あり
- 新規 forrent 必須項目を追加するときは `config/forrent-required.spec.json` の編集のみで OK
  (Phase 6 の `docs/refactor/adding-required-field.md` の手順そのまま)
- 朝のコールドスタート 25s リトライ (session.js#login) や CRLF +1 char 予防
  (fill-texts.js#sanitizeForLength) は元コードの semantic を完全保持

## 7. 関連

- 元 monolith のリビジョン: 分割直前の commit (各 stage の require 削除後)
- 次の改善候補:
  - fill-form.js 内部の fillPropertyForm (700 LOC) のさらなる分割
  - 個別モジュールの単体テスト拡充 (現状は validate + sanitize のみ)
  - storageState 化による forrent ログインの堅牢化 (ATBB 教訓の応用)
