# Phase ζ Collector Spec — 3 New Monitoring Fields

**Date**: 2026-05-17 | **Status**: approved | **Anchors**: cascade hit rate / image insufficient count / vision misclassify rate / aggregation window / backward compatibility

Spec for 3 new monitoring fields in `scripts/daily-aggregate-phase-delta.js` (384 LOC). T004 = developer. T005 = tester.

---

## Section 1: Goal & Scope

<!-- Elements check: English anchor=aggregation window / 数値=384 LOC, N=16 / file path=scripts/daily-aggregate-phase-delta.js / code snippet=§1.4 below -->

### 1.1 Why These Three Fields

Phase ε established core effectiveness measurement. Phase ζ shifts to **ongoing degradation detection**. Three blind spots:

| Field | Blind spot addressed |
|-------|---------------------|
| `cascade_hit_rate` | Phase 3a (itandi) daily effectiveness invisible. |
| `image_insufficient_count` | Silent early exits accumulate without signal. |
| `vision_misclassify_21_rate` | Rising 21-rate is the leading indicator for Vision degradation (cf. gotchas.md 2026-05-14 incident). |

### 1.2 Relationship to Phase ε Spec

Extends `docs/refactor/phase-epsilon-design.md` (724 lines, §6) with three additive sub-axes. No existing field modified. Pattern: pure functions, JSDoc typedefs, graceful null fallback, backward-compatible JSON/md under new key `zeta`.

### 1.3 Aggregation Window

Inherits existing logic: runs from `logs/runs/{YYYYMMDD-*}/` where date prefix matches `--date` (default: today JST). No change to run-scanning logic.

### 1.4 Extension Target (code snippet)

T004 extends `aggregate()` in `code/suumo-dashboard/scripts/daily-aggregate-phase-delta.js` (384 LOC):

```javascript
// T004 adds after existing maisoku/dom/score assembly:
const zetaRecords = runRecords.map(r => ({
  runDir:        r.runDir,
  out02:         safeReadJson(path.join(r.runDir, "02-images-download",  "output.json")),
  out03Classify: safeReadJson(path.join(r.runDir, "03-images-classify", "output.json")),
}));
summary.zeta = {
  cascade:            computeCascadeStats(zetaRecords),
  image_insufficient: computeImageInsufficientStats(zetaRecords),
  vision:             computeVision21Stats(zetaRecords),
};
```

---

## Section 2: New Fields Schema

### 2.1 cascade_hit_rate — **anchor: cascade hit rate**

| Property | Value |
|----------|-------|
| Field name | `zeta.cascade.{image_insufficient_runs, cascade_attempted_runs, cascade_hit_runs, cascade_miss_runs, cascade_hit_rate, platforms_seen}` |
| Formula | `cascade_hit_rate = cascade_hit_runs / cascade_attempted_runs` |
| Expected range | 0.0–1.0; null when `cascade_attempted_runs === 0` |
| Alert threshold | < 0.30 → WARNING |
| Source artifact | `logs/runs/{ts}/02-images-download/output.json` |

Source mapping: `.cascadeHit` present → cascade hit (no `imageInsufficient` set). `.imageInsufficient===true` with `.cascadeHit` absent → miss or disabled. **Denominator** = `cascade_attempted_runs` — see §9.1.

### 2.2 image_insufficient_count — **anchor: image insufficient count**

| Property | Value |
|----------|-------|
| Field name | `zeta.image_insufficient.{count, rate, total_runs, raw_count_distribution}` |
| Formula | `count = runs where imageInsufficient===true AND cascadeHit absent`; `rate = count / total_runs` |
| Expected range | rate 0.0–0.30 normal; > 0.30 → WARNING |
| Source artifact | `logs/runs/{ts}/02-images-download/output.json` |

`raw_count_distribution`: frequency map of rawCount (e.g., `{"0":2,"1":3}`). **Denominator** = `total_runs` — see §9.2.

### 2.3 vision_misclassify_21_rate — **anchor: vision misclassify rate**

| Property | Value |
|----------|-------|
| Field name | `zeta.vision.{total_images_classified, category_21_count, vision_21_rate, category_distribution, runs_with_classify_output}` |
| Formula | `vision_21_rate = category_21_count / total_images_classified` |
| Expected range | 0.0–0.10 healthy; > 0.15 → WARNING; > 0.25 → CRITICAL |
| Source artifact | `logs/runs/{ts}/03-images-classify/output.json` |

SH (周辺環境) excluded from `total_images_classified` but included in `category_distribution`. **Denominator** = total excl SH — see §9.3.

### 2.4 Value Range Summary (all 3 fields)

<!-- Elements check: English anchor=backward compatibility / 数値=3 fields × healthy/warn/critical / file path=logs/measure/daily/{date}.json -->

| Field | Healthy | WARNING | CRITICAL |
|-------|---------|---------|----------|
| `zeta.cascade.cascade_hit_rate` (null = not a warning) | ≥ 0.50 | < 0.30 | — |
| `zeta.image_insufficient.rate` | 0.0–0.30 | > 0.30 | > 0.50 |
| `zeta.vision.vision_21_rate` | 0.0–0.10 | > 0.15 | > 0.25 |

`vision_21_rate` > 0.25 references 2026-05-14 シンク誤分類 incident (OpenAI quota exhaustion).

---

## Section 3: Pure Function Signatures

### 3.1 computeCascadeStats

```javascript
/**
 * @typedef {Object} CascadeStats
 * @property {number}      image_insufficient_runs
 * @property {number}      cascade_attempted_runs
 * @property {number}      cascade_hit_runs
 * @property {number}      cascade_miss_runs
 * @property {number|null} cascade_hit_rate  - null when cascade_attempted_runs === 0
 * @property {string[]}    platforms_seen
 */
/** Pure function — no fs I/O.
 * @param {Array<{out02: object|null, runDir: string}>} runRecords
 * @returns {CascadeStats} */
function computeCascadeStats(runRecords) { /* T004 implements */ }
```

### 3.2 computeImageInsufficientStats

```javascript
/**
 * @typedef {Object} ImageInsufficientStats
 * @property {number}         count
 * @property {number|null}    rate                     - count / total_runs; null when 0
 * @property {number}         total_runs
 * @property {Object<string,number>} raw_count_distribution
 */
/** IMAGE_INSUFFICIENT = imageInsufficient===true AND cascadeHit absent. Pure function.
 * @param {Array<{out02: object|null, runDir: string}>} runRecords
 * @returns {ImageInsufficientStats} */
function computeImageInsufficientStats(runRecords) { /* T004 implements */ }
```

### 3.3 computeVision21Stats

```javascript
/**
 * @typedef {Object} Vision21Stats
 * @property {number}         total_images_classified  - excl SH
 * @property {number}         category_21_count
 * @property {number|null}    vision_21_rate           - null when total 0
 * @property {Object<string,number>} category_distribution  - incl SH (informational)
 * @property {number}         runs_with_classify_output
 */
/** SH excluded from vision_21_rate denominator. Pure function — no fs I/O.
 * @param {Array<{out03Classify: object|null, runDir: string}>} runRecords
 * @returns {Vision21Stats} */
function computeVision21Stats(runRecords) { /* T004 implements */ }
```

---

## Section 4: Aggregation Algorithm

### 4.1 computeCascadeStats

```
for each runRecord:
  if out02.cascadeHit exists:         isAttempted=true; isHit=true; platform=cascadeHit.platform
  else if out02.imageInsufficient===true: isAttempted=true; isHit=false
  accumulate cascade_attempted_runs, cascade_hit_runs, platforms_seen (deduplicate)
cascade_miss_runs = attempted - hit
cascade_hit_rate = attempted > 0 ? hit / attempted : null
```
Edge: `out02===null` → skip; `cascadeHit.platform` absent → "unknown"; `IMAGE_INSUFFICIENT_THRESHOLD` from env (default 2).

### 4.2 computeImageInsufficientStats

```
total_runs = runRecords.length   // ALL records incl null out02
for each runRecord:
  if out02===null: continue
  if out02.imageInsufficient===true AND out02.cascadeHit==null:
    count++; raw_count_distribution[String(rawCount)]++
rate = total_runs > 0 ? count / total_runs : null
```
**Denominator = `total_runs`** (confirmed final — §9.2). T004 implements without further confirmation.

### 4.3 computeVision21Stats

```
for each runRecord:
  if out03Classify===null or !Array.isArray(processedImages): continue
  runs_with_classify++
  for each img: category_distribution[catId]++
    if catId !== "SH": total_images++; if catId==="21": cat21_count++
vision_21_rate = total_images > 0 ? cat21_count / total_images : null
```
Edge: `out03===null` → skip; `processedImages` absent/non-array → skip run; `categoryId` non-string → skip; SH → distribution only.

---

## Section 5: JSON Output Schema (After)

<!-- Elements check: English anchor=backward compatibility / 数値=5 existing keys unchanged, 1 new key "zeta" / file path=logs/measure/daily/{date}.json / code snippet=§5.2 full JSON sample below -->

```json
{
  "date": "2026-05-17", "maisoku": {"...unchanged..."}, "dom": {"...unchanged..."},
  "score": {"...unchanged..."}, "warnings": ["..."],
  "zeta": {
    "cascade": { "image_insufficient_runs": 3, "cascade_attempted_runs": 3,
      "cascade_hit_runs": 2, "cascade_miss_runs": 1, "cascade_hit_rate": 0.6667,
      "platforms_seen": ["itandi"] },
    "image_insufficient": { "count": 1, "rate": 0.0625, "total_runs": 16,
      "raw_count_distribution": {"1": 1} },
    "vision": { "total_images_classified": 142, "category_21_count": 6,
      "vision_21_rate": 0.0423, "runs_with_classify_output": 16,
      "category_distribution": {"01":28,"02":14,"04":16,"05":15,"21":6,"SH":28} }
  }
}
```

Null-safe: `cascade_hit_rate: null` when no cascade-eligible runs; `vision_21_rate: null` when no classify artifacts.

---

## Section 6: Markdown Output Schema (After)

<!-- Elements check: English anchor=backward compatibility / 数値=4 warning threshold values / file path=logs/measure/daily/{date}.md / code snippet=§6.1 markdown template below -->

### 6.1 New Section (appended after `## Warnings`)

A `## Phase ζ Monitoring` section with three subsections (Cascade / Image Insufficient / Vision Category 21) rendered as markdown tables, showing metric / value / target columns. Values correspond to the JSON fields in §5. Warning threshold labels match §2.4 and §10.1.

### 6.2 Warning Lines

```
CASCADE WARN: cascade_hit_rate < 0.30 | IMAGE_INSUFFICIENT WARN: rate > 0.30
VISION WARN: vision_21_rate > 0.15   | VISION CRITICAL: vision_21_rate > 0.25
```

---

## Section 7: Backward Compatibility

<!-- Elements check: English anchor=backward compatibility / 数値=5 consumers verified / file path=logs/measure/daily/{date}.json / code snippet=§7.3 loadRunArtifacts extension -->

### 7.1 Consumer Impact — additive-only; no existing key modified

| Consumer | Impact |
|----------|--------|
| Manual inspection / README | `zeta` new; existing blocks unchanged |
| `daily-aggregate.plist` (CLI caller) | No impact |
| `measure-score-delta.js` (reads `#score`) | `score` key unchanged |
| `measure-phase-delta-dom-match.js` (per-run) | No impact |
| `2026-05-17-baseline.md` (static) | Not re-generated |

### 7.2 Absent `zeta` in Historical Files

Pre-T004 files lack `zeta`. Readers must treat absent `zeta` as null-state (all zeros/nulls).
T004 exports `ZETA_NULL_STATE` constant for callers.

### 7.3 loadRunArtifacts Extension

```javascript
// Before: { runDir, runJson, reinsData, out02b, out02c, out03b, confirmHtml }
// After:  { ...same..., out02, out03Classify }  ← additive; existing destructuring unbroken
```

---

## Section 8: Test Plan (Outline for T005)

<!-- Elements check: English anchor=cascade hit rate / image insufficient count / vision misclassify rate / 数値=7+6+7+5=25 minimum cases / file path=code/suumo-dashboard/scripts/test/test-daily-aggregate-zeta.js / code snippet=§8.1-8.3 case tables + §8.4 integration -->

File: `scripts/test/test-daily-aggregate-zeta.js` (new). Minimum: **25 unit + 5 integration = 30 cases**. Existing 387 must stay green.

### 8.1 computeCascadeStats (7 cases)

| Case | Input summary | Expected |
|------|---------------|----------|
| cascade_hit_A | `{rawCount:1, cascadeHit:{platform:"itandi",count:6}}` | hit=1, attempted=1, hit_rate=1.0 |
| cascade_miss_B | `{rawCount:2, imageInsufficient:true}` | miss=1, attempted=1, hit_rate=0.0 |
| no_cascade_C | `{rawCount:8, downloaded:[...]}` (rawCount > threshold) | attempted=0, hit_rate=null |
| null_out02_D | out02=null | all zeros, hit_rate=null |
| mixed_E | [hit_A, miss_B, no_cascade_C] | attempted=2, hit=1, hit_rate=0.5 |
| platforms_seen_F | two hits platform="itandi" | platforms_seen=["itandi"] (deduped) |
| zero_platform_G | cascadeHit present, platform absent | platforms_seen=["unknown"] |

### 8.2 computeImageInsufficientStats (6 cases)

| Case | Input summary | Expected |
|------|---------------|----------|
| insufficient_A | `{imageInsufficient:true, rawCount:2}` | count=1, distribution={"2":1} |
| cascade_hit_not_counted_B | `{cascadeHit:{platform:"itandi"}, rawCount:1}` | count=0 |
| normal_run_C | `{downloaded:[...], rawCount:8}` | count=0 |
| null_out02_D | null | count=0 |
| rate_E | 2 insufficient / 16 total | rate=0.125 |
| warn_threshold_F | rate > 0.30 | warning in warnings array |

### 8.3 computeVision21Stats (7 cases)

| Case | Input summary | Expected |
|------|---------------|----------|
| cat21_A | 3 × "21" + 17 others | 21_rate=3/20=0.15 |
| sh_excluded_B | 5 SH + 10 "01" + 2 "21" | total=12, rate=0.167, distribution has "SH":5 |
| null_out03_C | out03Classify=null | vision_21_rate=null |
| empty_images_D | processedImages=[] | rate=null |
| warn_threshold_E | 21_rate > 0.15 | WARN line generated |
| critical_threshold_F | 21_rate > 0.25 | CRITICAL warning generated |
| distribution_G | mixed categories | distribution keys = all unique categoryId values |

### 8.4 Integration Tests (5 cases)

| Case | Description |
|------|-------------|
| integration_A | Full `aggregate()` → `report.zeta` has all three sub-objects |
| integration_B | No `02-images-download/output.json` → `zeta.cascade` all zeros, no crash |
| integration_C | No `03-images-classify/output.json` → `zeta.vision.vision_21_rate` null, no crash |
| integration_D | `renderMarkdown(report)` contains "Phase ζ Monitoring" section |
| integration_E | `renderMarkdown(report)` handles absent `report.zeta` gracefully (no crash) |

---

## Section 9: Risks & Anti-patterns

<!-- Elements check: English anchor=image insufficient count / 数値=total_runs denominator (final), 0.30 warn threshold / file path=code/suumo-dashboard/scripts/daily-aggregate-phase-delta.js / code snippet=§9.1 anti-pattern block -->

### 9.1 Cascade Denominator

**Decision**: `cascade_attempted_runs` (not `total_runs`). Total_runs dilutes rate on good-image days.
```javascript
// WRONG: cascade_hit_rate = cascade_hit_runs / total_runs
// CORRECT: cascade_hit_rate = cascade_hit_runs / cascade_attempted_runs (null when 0)
```

### 9.2 IMAGE_INSUFFICIENT Rate Denominator

**Decision (final)**: `total_runs = runRecords.length`. T004 implements without further confirmation.

#### 9.2.1 Optional Override (post-implementation)

If kento wants `runs_with_02_output` denominator after observing Phase ζ data:
```javascript
const runs_with_02 = runRecords.filter(r => r.out02 !== null).length;
rate = runs_with_02 > 0 ? count / runs_with_02 : null;
```
Escalate only if degradation monitoring reveals misleading values.

### 9.3 Vision 21-Rate Denominator

**Decision**: Exclude SH — Google Images fetched separately, not gpt-4o-classified.
```javascript
// WRONG: total_images = processedImages.length  // includes SH → dilutes 21-rate
// CORRECT: skip catId==="SH" when incrementing total_images
```

### 9.4 Cascade-Hit Detection (imageInsufficient Absent on Hit)

When cascade hits, `imageInsufficient` is NOT set (verified: artifact `20260515-095829_100139127191`):
```javascript
// WRONG: if (out02.imageInsufficient === true) { isAttempted = true; }  // misses HIT runs
// CORRECT:
if (out02.cascadeHit != null) { isAttempted = true; isHit = true; }
else if (out02.imageInsufficient === true) { isAttempted = true; isHit = false; }
```

### 9.5 03-images-classify Path

Many runs lack `03-images-classify/output.json` (IMAGE_INSUFFICIENT exits before stage 03). `safeReadJson` fallback to `null` is essential. Confirmed structure: `{ "processedImages": [...], "initialCostData": null }` — `initialCostData` is bukaku field, not image data.

---

## Section 10: Acceptance Criteria for T004

<!-- Elements check: English anchor=cascade hit rate / image insufficient count / vision misclassify rate / 数値=10 criteria, 387 existing tests / file path=code/suumo-dashboard/scripts/daily-aggregate-phase-delta.js / code snippet=§1.4 integration point (canonical) -->

| # | Criterion | How to verify |
|---|-----------|---------------|
| 1 | Three pure functions exported | T005 unit cases via `npm test` |
| 2 | `aggregate()` includes `report.zeta` with all three sub-objects | integration_A |
| 3 | `aggregate()` does not throw when artifact absent | integration_B, integration_C |
| 4 | `loadRunArtifacts()` returns `out02` and `out03Classify` | Unit test: destructure |
| 5 | `renderMarkdown()` includes "Phase ζ Monitoring" section | integration_D |
| 6 | `renderMarkdown()` handles absent `report.zeta` gracefully | integration_E |
| 7 | T005 30 cases (§8.1–8.4) all pass, 0 failures | `npm test` |
| 8 | Existing 387 npm test cases pass (no regression) | `npm test` ≥ 387 |
| 9 | `logs/measure/daily/{today}.json` parseable by old reader | Manual `jq` |
| 10 | Warning lines in `report.warnings[]` when thresholds exceeded | §8.2 warn_F, §8.3 warn/critical |

### 10.1 Threshold Reference

| Metric | WARNING | CRITICAL |
|--------|---------|----------|
| `cascade_hit_rate` | < 0.30 | — |
| `image_insufficient.rate` | > 0.30 | — |
| `vision_21_rate` | > 0.15 | > 0.25 |

### 10.2 File Locations

- Implementation: `scripts/daily-aggregate-phase-delta.js`
- New test: `scripts/test/test-daily-aggregate-zeta.js`
- Phase ε spec: `docs/refactor/phase-epsilon-design.md`
- Stage sources: `scripts/stages/02-images-download.js` / `03-images-classify.js`
- Cascade skill: `skills/image-cascade.js`
