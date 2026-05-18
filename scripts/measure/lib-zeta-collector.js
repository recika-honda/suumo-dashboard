/**
 * lib-zeta-collector.js — Phase ζ Step 5+: 3 new monitoring fields
 *
 * Pure-function library for computing 3 monitoring metrics from per-run artifacts.
 * Spec: docs/refactor/phase-zeta-collector-spec.md (T003, 400 lines, approved 2026-05-17).
 *
 * Functions (English anchors):
 *   - computeCascadeStats             — cascade hit rate
 *   - computeImageInsufficientStats   — image insufficient count
 *   - computeVision21Stats            — vision misclassify rate
 *
 * Design principles (per T003 spec):
 *   - Pure: no fs I/O. Caller supplies pre-loaded `out02` / `out03Classify` objects.
 *   - Null-safe: graceful fallback to zeros + null rates on missing/malformed input.
 *   - Backward compatible: callers can no-op when artifacts absent; rates return null
 *     when denominator is 0 (callers must not divide downstream).
 *
 * Anti-patterns avoided (per spec §9):
 *   §9.1 cascade denominator = cascade_attempted_runs (not total_runs)
 *   §9.2 image insufficient denominator = total_runs (final, runRecords.length)
 *   §9.3 vision 21-rate denominator excludes SH (周辺環境 = Google Images, not gpt-4o)
 *   §9.4 cascadeHit presence is the only signal for HIT (imageInsufficient is NOT set on hit)
 */

"use strict";

/**
 * Null state for callers that detect absent `zeta` block in old JSON files.
 * Exported per T003 §7.2: pre-T004 daily JSON files lack `zeta` — readers can
 * substitute this constant for null-safe processing.
 *
 * @type {Readonly<{
 *   cascade: import("./lib-zeta-collector.js").CascadeStats,
 *   image_insufficient: import("./lib-zeta-collector.js").ImageInsufficientStats,
 *   vision: import("./lib-zeta-collector.js").Vision21Stats,
 * }>}
 */
const ZETA_NULL_STATE = Object.freeze({
  cascade: Object.freeze({
    image_insufficient_runs: 0,
    cascade_attempted_runs: 0,
    cascade_hit_runs: 0,
    cascade_miss_runs: 0,
    cascade_hit_rate: null,
    platforms_seen: Object.freeze([]),
  }),
  image_insufficient: Object.freeze({
    count: 0,
    rate: null,
    total_runs: 0,
    raw_count_distribution: Object.freeze({}),
  }),
  vision: Object.freeze({
    total_images_classified: 0,
    category_21_count: 0,
    vision_21_rate: null,
    category_distribution: Object.freeze({}),
    runs_with_classify_output: 0,
  }),
});

/**
 * @typedef {Object} CascadeStats
 * @property {number}      image_insufficient_runs
 * @property {number}      cascade_attempted_runs
 * @property {number}      cascade_hit_runs
 * @property {number}      cascade_miss_runs
 * @property {number|null} cascade_hit_rate           - null when cascade_attempted_runs === 0
 * @property {string[]}    platforms_seen             - deduped, sorted
 */

/**
 * Compute cascade hit rate stats from a batch of run records.
 *
 * Spec: phase-zeta-collector-spec.md §3.1 / §4.1.
 * Anti-pattern §9.4: cascade HIT runs do NOT have `imageInsufficient===true`.
 * Detection order MUST be: cascadeHit first, then imageInsufficient fallback.
 *
 * @param {Array<{out02: object|null, runDir?: string}>} runRecords
 * @returns {CascadeStats}
 */
function computeCascadeStats(runRecords) {
  let imageInsufficientRuns = 0;
  let cascadeAttempted = 0;
  let cascadeHit = 0;
  const platformsSet = new Set();

  if (!Array.isArray(runRecords)) {
    return {
      image_insufficient_runs: 0,
      cascade_attempted_runs: 0,
      cascade_hit_runs: 0,
      cascade_miss_runs: 0,
      cascade_hit_rate: null,
      platforms_seen: [],
    };
  }

  for (const rec of runRecords) {
    const out02 = rec && rec.out02;
    if (!out02 || typeof out02 !== "object") continue;

    // §9.4 — cascadeHit presence is authoritative for HIT; imageInsufficient is NOT set on hit
    if (out02.cascadeHit && typeof out02.cascadeHit === "object") {
      cascadeAttempted += 1;
      cascadeHit += 1;
      // image_insufficient_runs counts runs that *entered* the cascade path,
      // i.e. were triggered by insufficient REINS images. A cascade HIT implies
      // the run was originally insufficient (rawCount <= threshold) before fallback.
      imageInsufficientRuns += 1;
      const platform =
        typeof out02.cascadeHit.platform === "string" && out02.cascadeHit.platform.length > 0
          ? out02.cascadeHit.platform
          : "unknown";
      platformsSet.add(platform);
    } else if (out02.imageInsufficient === true) {
      cascadeAttempted += 1;
      imageInsufficientRuns += 1;
      // miss: insufficient but cascade did not hit
    }
  }

  const cascadeMiss = cascadeAttempted - cascadeHit;
  const cascadeHitRate = cascadeAttempted > 0 ? cascadeHit / cascadeAttempted : null;

  return {
    image_insufficient_runs: imageInsufficientRuns,
    cascade_attempted_runs: cascadeAttempted,
    cascade_hit_runs: cascadeHit,
    cascade_miss_runs: cascadeMiss,
    cascade_hit_rate: cascadeHitRate,
    platforms_seen: Array.from(platformsSet).sort(),
  };
}

/**
 * @typedef {Object} ImageInsufficientStats
 * @property {number}                  count
 * @property {number|null}             rate                     - count / total_runs; null when total_runs === 0
 * @property {number}                  total_runs
 * @property {Object<string, number>}  raw_count_distribution
 */

/**
 * Compute IMAGE_INSUFFICIENT stats from a batch of run records.
 *
 * Spec: phase-zeta-collector-spec.md §3.2 / §4.2.
 * Definition: a run is "image insufficient" iff `imageInsufficient===true` AND
 * `cascadeHit` is absent (i.e. cascade did not save it).
 * Denominator: §9.2 final = `total_runs = runRecords.length` (incl null out02).
 *
 * @param {Array<{out02: object|null, runDir?: string}>} runRecords
 * @returns {ImageInsufficientStats}
 */
function computeImageInsufficientStats(runRecords) {
  if (!Array.isArray(runRecords)) {
    return { count: 0, rate: null, total_runs: 0, raw_count_distribution: {} };
  }
  const totalRuns = runRecords.length;
  let count = 0;
  const dist = {};

  for (const rec of runRecords) {
    const out02 = rec && rec.out02;
    if (!out02 || typeof out02 !== "object") continue;
    if (out02.imageInsufficient !== true) continue;
    if (out02.cascadeHit != null) continue; // cascade saved it → not counted

    count += 1;
    const rawCountKey = String(
      typeof out02.rawCount === "number" ? out02.rawCount : "unknown"
    );
    dist[rawCountKey] = (dist[rawCountKey] || 0) + 1;
  }

  const rate = totalRuns > 0 ? count / totalRuns : null;
  return {
    count,
    rate,
    total_runs: totalRuns,
    raw_count_distribution: dist,
  };
}

/**
 * @typedef {Object} Vision21Stats
 * @property {number}                  total_images_classified  - excludes SH (周辺環境)
 * @property {number}                  category_21_count
 * @property {number|null}             vision_21_rate           - null when total === 0
 * @property {Object<string, number>}  category_distribution    - INCLUDES SH (informational)
 * @property {number}                  runs_with_classify_output
 */

/**
 * Compute Vision category-21 (= "その他" misclassify) rate from a batch of run records.
 *
 * Spec: phase-zeta-collector-spec.md §3.3 / §4.3.
 * Anti-pattern §9.3: SH (周辺環境) is fetched via Google Images, not gpt-4o classified.
 *   It MUST be excluded from `vision_21_rate` denominator, but is included in
 *   `category_distribution` for informational visibility.
 *
 * Threshold reference (per §10.1):
 *   WARNING > 0.15, CRITICAL > 0.25 (echoes 2026-05-14 sink misclassification incident).
 *
 * @param {Array<{out03Classify: object|null, runDir?: string}>} runRecords
 * @returns {Vision21Stats}
 */
function computeVision21Stats(runRecords) {
  if (!Array.isArray(runRecords)) {
    return {
      total_images_classified: 0,
      category_21_count: 0,
      vision_21_rate: null,
      category_distribution: {},
      runs_with_classify_output: 0,
    };
  }

  let runsWithClassify = 0;
  let totalImages = 0;
  let cat21Count = 0;
  const dist = {};

  for (const rec of runRecords) {
    const out = rec && rec.out03Classify;
    if (!out || typeof out !== "object") continue;
    if (!Array.isArray(out.processedImages)) continue;

    runsWithClassify += 1;
    for (const img of out.processedImages) {
      if (!img || typeof img !== "object") continue;
      const catId = typeof img.categoryId === "string" ? img.categoryId : null;
      if (!catId) continue;

      // Always count in distribution (informational, includes SH)
      dist[catId] = (dist[catId] || 0) + 1;

      // Vision 21-rate denominator excludes SH (§9.3)
      if (catId === "SH") continue;
      totalImages += 1;
      if (catId === "21") cat21Count += 1;
    }
  }

  const visionRate = totalImages > 0 ? cat21Count / totalImages : null;
  return {
    total_images_classified: totalImages,
    category_21_count: cat21Count,
    vision_21_rate: visionRate,
    category_distribution: dist,
    runs_with_classify_output: runsWithClassify,
  };
}

module.exports = {
  ZETA_NULL_STATE,
  computeCascadeStats,
  computeImageInsufficientStats,
  computeVision21Stats,
};
