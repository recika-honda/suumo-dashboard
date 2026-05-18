# Phase ε/ζ 効果測定 — 方法論設計 doc

**Date**: 2026-05-17
**Status**: approved (T001 inventory + T021 smoke 反映済)
**Anchor phrases**: DOM ground truth / chain integrity / source breakdown / negation false positive / score delta

---

## 1. 背景と KPI 構造

### 1.1 本 Phase が解決する問いと証拠連鎖

Phase β〜δ で 9-stage pipeline に 3 つの新ステージ (02b maisoku-fetch / 02c maisoku-text-extract / 03b feature-codes-resolve) を挿入し、forrent 特徴コード選択を 4 経路 (setsubi / building / default / **maisoku**) で行う設計が完成した。

ただし T010 root cause 調査により、Phase γ/δ 本番投入後も **622/622 run で `reinsData.zmnFlmi` が KEY_MISSING** だったことが判明した (T010, 2026-05-16)。原因は `skills/reins.js` の `extractPropertyData()` が `getInitData` XHR レスポンスを intercept しておらず、`zmnFlmi` を reinsData に注入していなかった実装上の gap。T020 でこの修正を完了 (`page.waitForResponse` を `page.click(detailBtn)` 前に設置、+71 LOC、278 test ok)。T021 smoke (2026-05-17 09:25) で修正後の本番経路が **初めて** maisoku 経路を発火させ、14 maisoku evidence entries を生成したことを確認した。

**証拠連鎖 (chain integrity)**: pipeline が「信濃町Ⅱ番館 100139151756」において
```
stage 01: reinsData.zmnFlmi = "6983027882XX.pdf"
stage 02b: maisoku.pdf downloaded (593,331 bytes)
stage 02c: vision-ocr, 712 chars extracted, $0.0050
stage 03b: 14 maisoku-sourced evidence entries, checkedCodes 28 total
```
という完全な chain が成立している (T021 all 6 items PASS)。

Phase ε/ζ の目的は、この chain が **forrent DOM に正しく反映されるか** を定量的に検証し、Phase δ の効果を「中間 output ではなく最終 DOM の checked 状態」で評価することである。

### 1.2 評価対象 KPI と 5 Step 対応

| Step | 測定対象 | KPI target | 参照 |
|------|---------|-----------|------|
| Step 1 | 全 code DOM exact 率 (03b checkedCodes vs confirm DOM) | ≥ 95% | Section 2 |
| Step 2 | maisoku source exact 率 (source breakdownの純粋寄与) | ≥ 90% | Section 3 |
| Step 3 | 否定語 FP 率 (maisoku 経路で誤って emit された code 率) | ≤ 10% | Section 4 |
| Step 4 | score median delta (Phase β baseline vs Phase δ 期間) | ≥ 0 | Section 5 |
| Step 5 | daily aggregate framework 動作 (Day 1 baseline 出力) | 正常稼働 | Section 6 |

---

## 2. DOM 突合ロジック (Step 1-3 共通基盤)

### 2.1 「actually-checked」の唯一の真のソース

T001 inventory (2026-05-16) により以下が確定した:

| HTML artifact | checkbox 状態を含むか | 根拠 |
|-------------|------|------|
| `confirm-attempt1.html` | **含む** — 「特徴項目」セルにラベル名スラッシュ区切り | T001 Section 4, 2 run で検証済 |
| `edit-after-teisei.html` | 含まない — categoryTokuchoCd に `checked` 属性なし | T001 Section 4, grep 実測: checked 属性 0件 |
| `edit-after-modify.html` | 含まない — 同上 | forrent.jp は Java/Struts 系 server-side binding |

**設計原則**: DOM 突合は必ず `confirm-attempt1.html` の「特徴項目」セルを対象とする。edit 系 HTML は使用禁止。

### 2.2 confirm-attempt1.html からのラベル抽出仕様

```
抽出手順:
1. confirm-attempt1.html を fs.readFileSync で読み込む
2. 正規表現で id="tokucho" ブロックを特定する:
   /id="tokucho"[\s\S]*?class="itemName"[^>]*>特徴項目[\s\S]*?class="inputItem"[^>]*>([\s\S]*?)<\/td>/
3. capture group 1 の innerText 相当テキストを取得
4. HTML タグを strip: .replace(/<[^>]+>/g, "")
5. "/" で split → trim → 空文字除去 → dom_label_set (Set<string>)
```

**selector 仕様** (T001 Section 4 実観察結果を採用):
```html
<!-- confirm-attempt1.html の実 DOM 構造 -->
<td nowrap="" class="itemName">特徴項目
</td>
<td class="inputItem">
2駅利用可/2沿線利用可/3駅以上利用可/駅徒歩5分以内/...
</td>
```

スラッシュ区切りラベルリストを取得し、`dom_label_set` とする。改行・前後空白・全半角揺れへの対策として正規表現は lookahead/lookbehind を用いず素直な greedy match を使う。

### 2.3 code-label 辞書 (491 entries) の構築

```
構築手順:
1. edit-after-teisei.html (escalation run のみ存在、T001 では 65/642 run)
   から以下の regex で code→label ペアを全量抽出:
   /id="([0-9]{4})"[^>]*>[^<]*<\/.*?<label[^>]*for="\1"[^>]*>([^<]+)</gms
2. 491 entries を code_label_map: Map<string, string> として保持
3. reverse_label_map: Map<string, string[]> も生成
   (ラベルが複数 code に紐づくケースに対応。実態は 1:1 だが安全のため多対一を許容)
4. キャッシュ: 同一 session 内で一度生成した辞書を再利用
   (forrent 仕様変更検知のため、md5 check を daily で実行)
```

**[NEEDS VERIFICATION]**: code→label 辞書の安定性。forrent 仕様変更で新 code が追加された場合、辞書が stale になる。週次で `extract-feature-codes.js` を再実行し、md5 変化を監視する。

### 2.4 3-class 判定 (DOM ground truth との突合)

```
input:
  A = 03b output.json#checkedCodes  (Set<string>)
  B = confirm dom_label_set から reverse lookup した codes (Set<string>)

3-class 分類:
  exact   = A ∩ B  (03b が emit し、DOM にも存在する)
  missed  = B \ A  (DOM に存在するが 03b が emit していない)
  phantom = A \ B  (03b が emit したが DOM に存在しない)

指標:
  exact_rate = |exact| / |B|  (target ≥ 95%)
  miss_rate  = |missed| / |B|
  phantom_rate = |phantom| / |A|
```

**検証済**: T001 Section 7, 2 run で `sorted(resolved_labels) == sorted(confirm_labels)` = True (run 20260516-194655: N=16, run 20260516-185832: N=24)。Phase δ 以前の 3 経路のみ run でも exact_rate は 100% であることが実測で確認済み。

### 2.5 エッジケース処理

| ケース | 処理 |
|------|------|
| 03b output.json が欠落 | `checkedCodes = []` として phantom_rate を 0 / exact_rate も 0 扱い。reason: `03b_missing` でログ |
| confirm-attempt1.html が欠落 | DOM 突合スキップ。status=`no_confirm_html` で記録。IMAGE_INSUFFICIENT / NOT_FOUND run はこのケース |
| validation エラーで confirm 未到達 | 同上 |
| REG_FAIL run | confirm-attempt1.html が生成済みなら突合可能 (T001 Section 9 確認: 4件の REG_FAIL run は全て confirm あり) |
| IMAGE_INSUFFICIENT | pipeline 早期 exit。03b も confirm も不在。突合対象外とし reason: `image_insufficient` でログ |
| label が dom_label_set に存在するが辞書に code なし | `UNKNOWN_LABEL` として別集計。辞書 staleness のシグナル |

---

## 3. Source Breakdown 仕様 (Step 2)

### 3.1 evidence structure の recap

`03b output.json#evidence` は `{[code]: FeatureCodeEvidence[]}` の構造:

```js
/**
 * @typedef {Object} FeatureCodeEvidence
 * @property {"setsubi"|"building"|"default"|"maisoku"} source
 * @property {string} reason
 * @property {string} [matched]
 * @property {string} [snippet] - maisoku source のみ, ~50-char context
 */
```

1 つの code に複数 source が evidence を持つ場合がある。T021 smoke の実例 (code 1001 「南向き」):
```json
"1001": [
  { "source": "building", "reason": "バルコニー方向=南", "matched": "南" },
  { "source": "maisoku",  "reason": "label '南向き' found in maisoku-text",
    "matched": "南向き",
    "snippet": "クインクローゼット・シューズボックス・バルコニー・南向き・最上階角部屋・宅配ボックス・駐輪場 ※原則として" }
]
```
code 0501 (エレベーター) も building + maisoku 両方から evidence を持つ。

### 3.2 複数 source が同 code を支える場合の breakdown 方針

**方針**: code の primary source を決定し、secondary source は evidence 強化として記録する。

```
primary source 決定ルール (優先度順):
  1. maisoku のみ  → primary = "maisoku_only"
  2. maisoku + 他  → primary = "maisoku_also" (他経路でも確認されたが maisoku も貢献)
  3. 3 経路のみ    → primary = source[0] (setsubi / building / default)

分類:
  maisoku_pure    = evidence に maisoku のみ (他 source なし)
  maisoku_overlap = evidence に maisoku + 他 source が両方存在
  legacy_only     = evidence に maisoku なし (setsubi / building / default のみ)
```

**Phase δ KPI の分離**:
- `maisoku_pure` exact 率: maisoku 経路だけで check された code が DOM に反映されている率 (target ≥ 90%)
- `maisoku_overlap` exact 率: 参考値 (legacy が先に担保しているので高くて当然)
- `maisoku_net_gain`: `maisoku_pure + maisoku_overlap` で 03b が増やした code の純増数 (Phase δ smoke: 5件平均 +7.2 codes)

### 3.3 JSDoc typedef

```js
/**
 * @typedef {Object} SourceBreakdown
 * @property {string[]} maisoku_pure    - maisoku evidence のみの checkedCodes
 * @property {string[]} maisoku_overlap - maisoku + 他 source が重複する checkedCodes
 * @property {string[]} legacy_only     - maisoku evidence なしの checkedCodes
 * @property {number}   maisoku_net_gain - maisoku_pure.length + maisoku_overlap.length
 */

/**
 * @param {Object} evidenceMap - 03b output.json#evidence
 * @returns {SourceBreakdown}
 */
function buildSourceBreakdown(evidenceMap) { ... }
```

### 3.4 T021 実測値からの期待値

T021 smoke (run: 20260517-092515_100139151756):
- `checkedCodes` 合計: 28
- maisoku source evidence を持つ code: 1001, 1201, 1211, 1401, 1414, 1505, 1701, 2001, 2101, 2207, 2705, 0305, 0517, 0501 (14 codes)
- うち maisoku_only: 1201(オートロック), 1211(防犯カメラ), 1401(システムキッチン), 1414(2口コンロ), 1505(追焚機能浴室), 1701(洗面所独立), 2001(バルコニー), 2101(フローリング), 2705(ペット相談), 0305(最上階), 0517(宅配ボックス) = 11
- maisoku_overlap: 1001(南向き, building も), 2207(シューズボックス, default も), 0501(エレベーター, building も) = 3
- legacy_only: 残り 14 codes

本番で maisoku 経路が発火する物件では `maisoku_pure ≈ 8〜12 codes` の増加を期待する。

---

## 4. 否定語 FP 検証仕様 (Step 3)

### 4.1 否定語フィルタの仕様 recap

`skills/negation-filter.js` の `isNegated(text, label, options)`:
```js
const NEGATION_PATTERNS = Object.freeze([
  "なし", "不可", "未", "無", "別途", "要確認", "撤去"
]);
const NEG_WINDOW_BEFORE = 0;  // look-behind なし (日本語は後置)
const NEG_WINDOW_AFTER  = 15; // ラベル直後 15 文字以内に否定語
```

- `maisoku-text.txt` を NFC + half-width fold で normalize してから match
- ラベル直後の 15 文字以内に `NEGATION_PATTERNS` のいずれかが存在すれば `negated = true`
- 否定語ありの code は 03b が emit しない (FP 抑止)

### 4.2 否定語 FP 判定ロジック

```
FP の定義:
  03b が maisoku 経路で emit した code X が、
  maisoku-text.txt 上でラベル X のマッチを含む negation context に囲まれている場合 → FP
  (否定語フィルタが機能していれば emit されないはずなのに emit された)

FP 検出手順:
1. maisoku-text.txt と 150 SSOT (config/forrent-feature-codes.json) を input とする
2. 各 SSOT label に対し:
   a. maisoku text に label が存在するか (isNegated(...) の内部論理と同じ norm 処理)
   b. ラベル直後 NEG_WINDOW_AFTER=15 文字以内に NEGATION_PATTERNS のいずれかが存在するか
   c. b が true の code を "negation_suppressed_candidates" とする
3. 03b output.json#checkedCodes のうち negation_suppressed_candidates に含まれる code を FP とする

FP 率 = |FP| / (|maisoku_pure| + |maisoku_overlap|)
target: ≤ 10% (smoke 実測 0.0%、Phase δ T005)
```

### 4.3 T021 実例「バイク不可 → 0207 skip」の形式検証

T021 の maisoku-text.txt には以下が存在する (行 33):
```
※原則としてバイク不可
```

SSOT 上の label 0207「バイク置場」が「バイク」部分にマッチし、直後 15 文字以内に「不可」が含まれるため `isNegated(...) = true` → 03b は 0207 を emit しない。

本検証フレームワークでは:
- `negation_suppressed_candidates` に 0207 が含まれることを確認
- `checkedCodes` に 0207 が **含まれない**ことを確認
- → 「フィルタ正常動作」として記録 (FP なし)

同様に「駐輪場無料」の「無料」が `"無"` パターンにマッチしないことを確認する (「駐輪場無料」は「駐輪場あり」であり、「無料」= negation ではない)。この境界ケースは `NEG_WINDOW_AFTER=15` の範囲内に「料」が続くため `"無"` pattern が「無料」の「無」に誤ってマッチする可能性がある。**[NEEDS VERIFICATION]**: `isNegated("駐輪場無料", "駐輪場", ...)` の戻り値を unit test で確認すること。

### 4.4 JSDoc typedef

```js
/**
 * @typedef {Object} NegationAnalysis
 * @property {string[]} negation_suppressed_candidates - フィルタが抑制すべき candidates
 * @property {string[]} false_positives               - emit されてしまった FP codes
 * @property {string[]} true_negatives                - 正しく emit されなかった codes
 * @property {number}   fp_rate                       - FP / (maisoku_pure + maisoku_overlap)
 */

/**
 * @param {string}   maisokuText   - 02c output, raw text
 * @param {Object[]} featureCodesConfig - 150 SSOT array [{code, label}]
 * @param {string[]} emittedMaisokuCodes - 03b から maisoku source で emit された codes
 * @returns {NegationAnalysis}
 */
function analyzeNegationFP(maisokuText, featureCodesConfig, emittedMaisokuCodes) { ... }
```

---

## 5. Score A/B 仕様 (Step 4 — score delta)

### 5.1 ペア比較不可の理由と群間比較採用

T001 Section 6 確認: Phase β (〜2026-05-16 17:43 JST) と Phase δ (2026-05-16 17:43 JST 以降) の間で **同一 reinsId の overlap = 0**。REINS 物件プールは日次更新であり、同一物件の再入稿は発生しない運用のため。

したがって **ペア比較 (paired t-test 等) は不可**。群間クロス比較を採用する。

### 5.2 比較群の定義

| 群 | 期間 | N | 備考 |
|----|------|---|------|
| **Group A (beta baseline)** | 〜2026-05-16 17:43 JST | 41 (同日) | SUCCESS のみ、confirm あり (T001 Section 8 より) |
| **Group B (delta, pre-T020)** | 2026-05-16 17:43〜 | 12 | maisoku 経路 0 発火 (zmnFlmi KEY_MISSING) |
| **Group C (delta, post-T020)** | 2026-05-17 以降 | 増加中 | maisoku 経路 initial fire (T021 確認済) |

**主比較**: Group A vs Group C (T020 修正後の本番 run が N≥20 件溜まった後)。Group B は「T020 修正前 delta」として参考値扱い。

### 5.3 score 取得 field

`run.json#score` が最終スコア (SUCCESS / REG_FAIL 両方で存在)。T001 Section 10 より:

```
score 取得優先順:
  1. run.json#score (全 run で存在率 高)
  2. confirm-attempt1.html の名寄せスコア表示 (テキストパース、fallback)
  3. validation-after-escalate.json#score (17/642 run のみ存在、escalation REG_FAIL)
```

### 5.4 統計設計

```
記述統計:
  Group A: N=41, min=8, max=41, median=32, mean=31.6 (T001 Section 8)
  Group C: N増加中 (N≥20 で暫定集計、N≥50 で本集計)

指標:
  median_delta = median(Group C) - median(Group A)
  escalation_delta = escalation_rate(C) - escalation_rate(A)

escalation_rate = (score ≥ 34 の run 数) / (全 run 数)
```

**統計的有意性**: N_C < 50 の段階では effect size 中心の報告とし、p値は参考値扱い。Phase δ smoke の +7.2 codes 純増が score に与える影響は 1 code ≈ 0.3-0.5pt の換算が仮定 (score formula は非公開)。

### 5.5 Confounders の明示

以下の交絡因子を報告に明記する:
- **REINS 物件特性差**: 築年数・間取り・地域が Group A と C で異なる (同日物件でないため)
- **季節差**: 入稿時期による REINS 掲載物件プールの差
- **元付業者分布**: maisoku 所持率がランダムでない可能性 (Phase α T003: REINS-resolved 100%、ただし母集団は新着物件に限定)
- **maisoku 所持率の不確実性**: T021 は 1 件のみ、本番 N≥20 での実測 hit 率が必要
- **Group B (12 runs) の maisoku 0 発火**: Group B のスコアは「T020 修正前」のため、純粋な Phase δ 効果を示していない

### 5.6 JSDoc typedef

```js
/**
 * @typedef {Object} ScoreStats
 * @property {number}   n
 * @property {number}   min
 * @property {number}   max
 * @property {number}   median
 * @property {number}   mean
 * @property {number}   escalation_rate  - score >= 34 の比率
 * @property {number[]} scores           - raw scores list
 */

/**
 * @typedef {Object} ScoreABResult
 * @property {ScoreStats} group_a    - Phase β baseline
 * @property {ScoreStats} group_c    - Phase δ post-T020
 * @property {number}     median_delta
 * @property {number}     escalation_delta
 * @property {string[]}   confounders
 */

/**
 * @param {string} logsRunDir - logs/runs/ 絶対パス
 * @param {string} cutoffIso  - Group A/C の境界 ISO timestamp ("2026-05-17T00:00:00Z")
 * @returns {ScoreABResult}
 */
async function computeScoreAB(logsRunDir, cutoffIso) { ... }
```

---

## 6. Daily Aggregate Framework 仕様 (Step 5)

### 6.1 設計思想

1 日分 (24h) の `logs/runs/{ts}/` を scan し、Step 1-4 の全ロジックを aggregate して daily report を生成する。T003 (DOM 突合) と T005 (score A/B) の関数をそのまま import して再利用する。watch-nyuko hourly cycle が自然に生成する artifacts を input とするため、追加の instrument は不要。

### 6.2 Input 仕様

```
scan 対象: logs/runs/{ts}_{reinsId}/
           ただし ts が指定日の 00:00:00 〜 23:59:59 JST に収まる run

必要 artifact (欠落時は該当指標を null で記録):
  - run.json                           (必須: status / score)
  - 03b-feature-codes-resolve/output.json  (DOM 突合・source breakdown)
  - 02c-maisoku-text-extract/output.json  (source / charsExtracted / visionCostUSD)
  - confirm-attempt1.html              (DOM 突合のターゲット)
  - 02b-maisoku-fetch/output.json      (downloadEvent)
```

### 6.3 Daily report JSON schema

```js
/**
 * @typedef {Object} DailyMaisokuMetrics
 * @property {number} total_runs          - 当日の全 run 数
 * @property {number} runs_with_03b       - 03b artifact あり run 数
 * @property {number} runs_with_confirm   - confirm-attempt1.html あり run 数
 * @property {number} maisoku_download_rate  - 02b downloadEvent="download" / runs_with_03b
 * @property {number} pdftotext_rate      - 02c source="pdftotext" / runs_with_03b
 * @property {number} vision_ocr_rate     - 02c source="vision-ocr" / runs_with_03b
 * @property {number} ocr_cost_total_usd  - 当日の 02c visionCostUSD 合計
 * @property {number} ocr_cost_per_run    - 平均 1 物件 OCR cost
 * @property {Object} source_breakdown_agg  - source 別 code 数の集計 (mean / median)
 * @property {number} maisoku_net_gain_mean  - maisoku_pure + overlap の平均 code 増加数
 */

/**
 * @typedef {Object} DailyDomMetrics
 * @property {number} runs_matched     - DOM 突合実施 run 数 (03b + confirm 両方あり)
 * @property {number} exact_rate_mean  - exact_rate の平均
 * @property {number} phantom_rate_mean
 * @property {number} miss_rate_mean
 * @property {number} fp_rate_mean     - 否定語 FP 率の平均
 */

/**
 * @typedef {Object} DailyScoreMetrics
 * @property {ScoreStats} all_runs
 * @property {number}     escalation_rate
 * @property {number}     maisoku_hit_runs  - maisoku 経路が発火した run 数
 * @property {number}     maisoku_hit_rate  - maisoku_hit_runs / runs_with_03b
 */

/**
 * @typedef {Object} DailyReport
 * @property {string}              date           - "2026-05-17"
 * @property {DailyMaisokuMetrics} maisoku
 * @property {DailyDomMetrics}     dom
 * @property {DailyScoreMetrics}   score
 * @property {string[]}            warnings       - WARN_USD threshold 超過 run 等
 */
```

### 6.4 Markdown 1-pager テンプレート

```markdown
# Phase ε/ζ Daily Report — {date}

## Maisoku Chain
| Metric | Value | Target |
|--------|-------|--------|
| 02b download rate | {pct}% | ≥ 60% (REINS-resolved 限定) |
| 02c pdftotext rate | {pct}% | (参考: smoke 67%) |
| 02c vision-ocr rate | {pct}% | (参考: smoke 33%) |
| OCR cost / run | ${usd} | ≤ $0.05 WARN |
| maisoku 経路 hit 率 | {pct}% | 増加傾向を確認 |
| maisoku net gain (mean codes) | {n} | ≥ 5 (smoke +7.2) |

## DOM Ground Truth (Step 1-3)
| Metric | Value | Target |
|--------|-------|--------|
| DOM 突合実施 run 数 | {n} | ≥ 10 / day |
| exact_rate (mean) | {pct}% | ≥ 95% |
| phantom_rate (mean) | {pct}% | ≤ 5% |
| negation FP rate (mean) | {pct}% | ≤ 10% |

## Score Delta (Step 4)
| Metric | Today | Baseline (Group A) |
|--------|-------|--------------------|
| median score | {n} | 32 |
| escalation rate (≥34) | {pct}% | 24% (5/21) |

## Warnings
{warnings list}
```

### 6.5 実行仕様

```
実行方法:
  node scripts/measure/daily-aggregate.js [--date YYYY-MM-DD]
  デフォルト: 昨日 JST

出力:
  logs/reports/{date}-daily.json  (DailyReport JSON)
  logs/reports/{date}-daily.md    (Markdown 1-pager)

依存 Step 関数:
  buildDomMatchResult(run03bOutput, confirmHtml, codeLabelMap) → DomMatchResult
  buildSourceBreakdown(evidenceMap) → SourceBreakdown
  analyzeNegationFP(maisokuText, featureCodesConfig, emittedMaisokuCodes) → NegationAnalysis
  computeRunScore(runJson) → number | null
```

---

## 7. 数値 Target 一覧

| Step | 指標 | Target | 根拠 |
|------|------|--------|------|
| Step 1 | 全 code DOM exact 率 | ≥ 95% | T001: 2 run で 100%、3 経路のみ。Phase δ で maisoku 追加後も維持必要 |
| Step 2 | maisoku source exact 率 (maisoku_pure) | ≥ 90% | Phase δ T005 smoke: Run B FP 0.0%、+7.2 codes / 物件 |
| Step 3 | 否定語 FP 率 | ≤ 10% | Phase δ T005 smoke: 0.0%、target は本番での degradation 許容 |
| Step 4 | score median delta | ≥ 0 | T001 Group B (N=12): +2.5 mean (confounders あり)。Phase γ/δ 本番初発火で真値を計測 |
| Step 5 | daily aggregate 正常稼働 | Day 1 出力 | 2026-05-17 を Day 1 として baseline を確立 |
| (追加) | maisoku download rate | ≥ 60% | Phase α T003: REINS-resolved 100%、本番 zmnFlmi 非所持物件も一定数あり |
| (追加) | OCR cost / run | ≤ $0.05 | WARN threshold (02c cost policy より) |
| (追加) | maisoku 経路 hit rate | 増加傾向 | Phase δ smoke: 5/5 run で hit、本番初計測は T021 (1/1) |

---

## 8. JSDoc Typedefs 全関数まとめ

```js
// ── Step 1: DOM 突合 ──────────────────────────────────────────

/**
 * @typedef {Object} DomMatchResult
 * @property {string[]} exact    - 03b emit かつ DOM confirm に存在
 * @property {string[]} missed   - DOM に存在するが 03b が emit していない
 * @property {string[]} phantom  - 03b が emit したが DOM に存在しない
 * @property {number}   exact_rate
 * @property {number}   miss_rate
 * @property {number}   phantom_rate
 * @property {string}   status   - "ok" | "no_confirm_html" | "no_03b_output" | "image_insufficient"
 */

/**
 * @param {Object} run03bOutput   - 03b output.json の parsed object
 * @param {string} confirmHtmlStr - confirm-attempt1.html の文字列
 * @param {Map<string,string>} codeLabelMap - 491 entries (code → label)
 * @returns {DomMatchResult}
 */
function buildDomMatchResult(run03bOutput, confirmHtmlStr, codeLabelMap) { ... }

// ── Step 2: Source Breakdown ──────────────────────────────────

/**
 * @typedef {Object} SourceBreakdown
 * @property {string[]} maisoku_pure    - maisoku evidence のみ
 * @property {string[]} maisoku_overlap - maisoku + 他 source 重複
 * @property {string[]} legacy_only     - maisoku なし
 * @property {number}   maisoku_net_gain
 */

/** @param {Object.<string, FeatureCodeEvidence[]>} evidenceMap */
function buildSourceBreakdown(evidenceMap) { ... }

// ── Step 3: 否定語 FP 分析 ────────────────────────────────────

/**
 * @typedef {Object} NegationAnalysis
 * @property {string[]} negation_suppressed_candidates
 * @property {string[]} false_positives
 * @property {string[]} true_negatives
 * @property {number}   fp_rate
 */

/**
 * @param {string}   maisokuText
 * @param {Object[]} featureCodesConfig  - [{code, label}] 150 SSOT
 * @param {string[]} emittedMaisokuCodes - maisoku source で emit された codes
 * @returns {NegationAnalysis}
 */
function analyzeNegationFP(maisokuText, featureCodesConfig, emittedMaisokuCodes) { ... }

// ── Step 4: Score A/B ─────────────────────────────────────────

/**
 * @typedef {Object} ScoreStats
 * @property {number} n
 * @property {number} min
 * @property {number} max
 * @property {number} median
 * @property {number} mean
 * @property {number} escalation_rate
 */

/**
 * @typedef {Object} ScoreABResult
 * @property {ScoreStats} group_a
 * @property {ScoreStats} group_c
 * @property {number}     median_delta
 * @property {number}     escalation_delta
 * @property {string[]}   confounders
 */

/**
 * @param {string} logsRunDir
 * @param {string} cutoffIso  - "2026-05-17T00:00:00Z" (Group A / C の境界)
 * @returns {Promise<ScoreABResult>}
 */
async function computeScoreAB(logsRunDir, cutoffIso) { ... }

// ── Step 5: Daily Aggregate ───────────────────────────────────

/**
 * @param {string} logsRunDir
 * @param {string} dateStr     - "2026-05-17"
 * @returns {Promise<DailyReport>}
 */
async function buildDailyReport(logsRunDir, dateStr) { ... }
```

---

## 9. エッジケース処理まとめ

| シナリオ | 処理 | ログ |
|---------|------|------|
| 03b output.json 欠落 | DOM 突合 skip、score のみ記録 | `reason: "03b_missing"` |
| confirm-attempt1.html 欠落 | DOM 突合 skip | `reason: "no_confirm_html"` |
| IMAGE_INSUFFICIENT run | 全 Step を skip | `reason: "image_insufficient"` |
| NOT_FOUND / ERROR run | 全 Step を skip | `reason: run.json#status` |
| REG_FAIL run | confirm あり → DOM 突合可能 (T001 確認) | 正常処理 |
| 辞書に label なし | `UNKNOWN_LABEL` として別集計 | 辞書 stale 警告 |
| 02c output.json 欠落 or source="skipped" | maisoku 経路 0 発火として記録 | `maisoku_hit: false` |
| malformed HTML (regex fail) | try/catch で skip、warn log | `reason: "html_parse_error"` |
| score null (run.json に score なし) | confirm-attempt1 から regex fallback | 2 段 fallback |
| visionCostUSD ≥ WARN ($0.05) | warnings に追加 | `ocr_cost_warn: {runId, cost}` |

---

## 10. レポートフォーマット

### 10.1 JSON Schema (logs/reports/{date}-daily.json)

```json
{
  "date": "2026-05-17",
  "generated_at": "<ISO>",
  "maisoku": {
    "total_runs": 0,
    "runs_with_03b": 0,
    "runs_with_confirm": 0,
    "maisoku_download_rate": null,
    "pdftotext_rate": null,
    "vision_ocr_rate": null,
    "ocr_cost_total_usd": 0,
    "ocr_cost_per_run": null,
    "maisoku_net_gain_mean": null,
    "source_breakdown_agg": {
      "maisoku_pure_mean": null,
      "maisoku_overlap_mean": null,
      "legacy_only_mean": null
    }
  },
  "dom": {
    "runs_matched": 0,
    "exact_rate_mean": null,
    "phantom_rate_mean": null,
    "miss_rate_mean": null,
    "fp_rate_mean": null
  },
  "score": {
    "all_runs": { "n": 0, "min": null, "max": null, "median": null, "mean": null, "escalation_rate": null },
    "maisoku_hit_runs": 0,
    "maisoku_hit_rate": null
  },
  "warnings": []
}
```

### 10.2 Markdown 1-pager (Section 6.4 参照)

---

## 11. 既知の不確実性と [NEEDS VERIFICATION]

### 11.1 本番 N=1 問題

T021 smoke は 1 件の maisoku 経路発火を確認したが、**本番 hourly cycle での統計はまだ存在しない**。

- DOM 突合 (Step 1): 現時点で実施できない (T021 は stage 05/06 skip、confirm-attempt1.html 未生成)
- score delta (Step 4): Group C N=0 (T020 修正後の全 pipeline run は未集計)

**判断**: 本番 hourly cycle 待ち。N≥10 件溜まった時点で Step 1-4 の暫定計測を実施する。

### 11.2 Smoke 単独では DOM 突合できない理由と本番待ちの根拠

T021 smoke は scope を 03b で停止したため、stage 05 (fillTokucho) および stage 06 (forrent-register) が実行されず `confirm-attempt1.html` が生成されなかった。

**別の smoke アプローチの検討**: forrent 送信込みの「フル smoke」を実施することも原理上は可能だが:
- 実際の forrent 登録が発生するリスク (duplicate registration)
- 同一物件の 2 回目入稿は REG_FAIL になる可能性が高い (forrent の重複チェック)
- 物件選定が困難 (テスト用 forrent アカウントなし)

**推奨**: 本番 hourly cycle に委ねる。N≥10 件の confirm-attempt1.html が自然に溜まれば全 Step を実施できる。暫定として T021 の 14 maisoku evidence entries から Step 2/3 の snapshot を算出し報告する。

### 11.3 Phase α vs 本番 OCR 比率差

Phase α T002 (T010 で改めて確認): pdftotext 20% / vision-ocr 80% (N=5 PDFs、dry-run)。Phase γ smoke: pdftotext 67% / vision-ocr 33% (N=6 run)。差異の原因は母集団差と N の小ささ。

本番比率は Phase ζ 7 日観察で確定する。現時点では smoke 値を暫定値とし、OCR cost の月次試算には smoke 値の上下 bound を併記する。

### 11.4 「駐輪場無料」の否定語 FP リスク

Section 4.3 に記載。`isNegated("駐輪場無料...", "駐輪場", {})` が「無料」の「無」に反応して suppression するかを unit test で確認する必要がある。**[NEEDS VERIFICATION]**: T003 実装時に必ず追加する。

### 11.5 code-label 辞書の staleness

edit-after-teisei.html は escalation run (65/642) にしか存在しない。forrent 仕様変更で新 code が追加された場合、辞書が古くなる。週次での md5 監視を daily aggregate に組み込む。

### 11.6 Group C の定義境界

T020 修正は 2026-05-16 JST に commit された。2026-05-17 00:25 JST の T021 smoke が修正後の動作確認となった。本番 hourly cycle (watch-nyuko は hourly、07:00〜22:00 JST) での最初の修正後 run は 2026-05-17 07:00 JST 以降の run となる。Group C の定義は `ts ≥ 20260517-070000` とする。

---

## 12. Citations

### コード参照
- `code/suumo-dashboard/skills/negation-filter.js`: NEGATION_PATTERNS 7 個、NEG_WINDOW_BEFORE/AFTER 定数 (Phase δ T002)
- `code/suumo-dashboard/skills/feature-codes-resolve.js`: `resolveFeatureCodes()` signature、maisoku 経路の SSOT filter policy コメント (Phase δ T003, 617 LOC)
- `code/suumo-dashboard/scripts/stages/03b-feature-codes-resolve.js`: `resolveMaisokuTextForResolver()` helper (Phase δ T004, 132 LOC)
- `code/suumo-dashboard/skills/reins.js`: `extractZmnFlmiFromInitData()` + `page.waitForResponse()` intercept (T020, +71 LOC)
- `code/suumo-dashboard/config/forrent-feature-codes.json`: 150 SSOT (kodawari 140 + allowlist 10, Phase α T004)

### Finding 参照
- `T001-inventory.md`: DOM selector 確定 (confirm-attempt1.html)、artifact availability 統計 (642 run)、Group A/B score 統計、同一物件ペア overlap=0 確定
- `T010-rootcause.md`: zmnFlmi KEY_MISSING 622/622 run、H1 (stage 01 実装 gap) 採択
- `T020-fix-summary.md`: `page.waitForResponse` 修正、race condition 対策、278 tests pass、6 SSOT md5 不変
- `T021-smoke.md`: 本番経路初発火 (1/1 PASS, 14 maisoku evidence), launchctl try/finally 動作確認

### Blueprint / WBS 参照
- `blueprint.html "Key Decisions"`: Phase β/γ/δ/ε 設計決定と実績 (2026-05-16)
- `blueprint.html "Non-Functional Requirements"`: OCR cost policy ($0.05 WARN / $0.10 ABORT)、FP target ≤ 10%
- `wbs.html "Backlog"`: Phase ε (stage 05 本番検証)、Phase ζ (rollout 監視 7 日)

### gotchas.md 参照
- `2026-05-16: smoke script で watch-nyuko を unload したまま load し忘れ`: launchctl try/finally 必須 → T021 で遵守済み
- `2026-05-14: OpenAI quota 超過で Vision が静かに失敗`: silent failure パターン → 02c cost monitoring の根拠

---

*最終更新: 2026-05-17 · 作成: strategist agent (Phase ε T002)*
