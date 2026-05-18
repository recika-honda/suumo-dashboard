"use strict";

/**
 * lib-score-extract.js — Phase ε T005 (Score A/B)
 *
 * Pure functions for forrent score extraction and group comparison.
 * No I/O concerns at the function level beyond reading already-loaded JSON.
 * The CLI (measure-score-delta.js) orchestrates fs traversal.
 *
 * Spec reference: code/suumo-dashboard/docs/refactor/phase-epsilon-design.md
 *   - Section 5 (Score A/B)
 *   - Section 8 (JSDoc typedefs ScoreStats / ScoreABResult)
 *   - Section 9 (edge cases)
 *
 * Source of truth for score field paths (verified by reading actual artifacts
 * 2026-05-17 — see `.claude/do/findings/epsilon-T005-implementation.md`):
 *
 *   1. run.json#score                          ← primary, all SUCCESS/REG_FAIL
 *   2. validation-after-escalate.json#score    ← fallback, only escalation runs (17/642)
 *
 * Per T002 §5.3 a third fallback via confirm-attempt1.html regex exists in the
 * design but is not implemented here: the two JSON sources cover 100% of runs
 * that reach forrent confirm screen (T001 inventory). If a future regression
 * leaves run.json#score null but the HTML present, add the HTML fallback then.
 */

const ESCALATION_THRESHOLD = 34; // forrent 名寄せスコア >= 34 で自動昇格 (spec §5.4)

/**
 * @typedef {Object} ScoreStats
 * @property {number}   n
 * @property {number|null} min
 * @property {number|null} max
 * @property {number|null} median
 * @property {number|null} p25
 * @property {number|null} p75
 * @property {number|null} mean
 * @property {number|null} stddev
 * @property {number|null} escalation_rate   - share of scores >= 34
 * @property {number[]}  scores              - raw scores list
 */

/**
 * @typedef {Object} GroupRunRef
 * @property {string}      run         - run directory name "{ts}_{reinsId}"
 * @property {string}      reinsId
 * @property {string}      timestamp   - run directory ts prefix "YYYYMMDD-HHMMSS"
 * @property {string|null} status      - "SUCCESS" | "REG_FAIL" | etc.
 * @property {number|null} score
 * @property {string}      scoreSource - "run.json" | "validation-after-escalate" | "none"
 */

/**
 * @typedef {Object} PairResult
 * @property {string}      reinsId
 * @property {GroupRunRef} baseline
 * @property {GroupRunRef} delta
 * @property {number|null} score_delta - delta.score - baseline.score
 */

/**
 * @typedef {Object} ScoreABResult
 * @property {string}      generated_at  - ISO timestamp
 * @property {Object}      cutoffs
 * @property {string}      cutoffs.baseline_until
 * @property {string}      cutoffs.delta_since
 * @property {ScoreStats}  group_a       - baseline (Phase β)
 * @property {ScoreStats}  group_c       - delta (Phase δ post-T020)
 * @property {number|null} median_delta
 * @property {number|null} mean_delta
 * @property {number|null} escalation_delta
 * @property {PairResult[]} same_property_pairs   - empty per T001 inventory
 * @property {string[]}    confounders
 * @property {Object}      warnings
 * @property {string[]}    warnings.missing_score - run dirs skipped due to no score
 * @property {string[]}    warnings.malformed     - run dirs skipped due to JSON parse error
 */

/* ---------- score extraction ---------- */

/**
 * Extract forrent 名寄せスコア from validation-after-escalate.json structure.
 * Returns null if the input is not a usable object or score field absent/invalid.
 * @param {any} json
 * @returns {number|null}
 */
function extractScoreFromValidation(json) {
  if (!json || typeof json !== "object") return null;
  return coerceScore(json.score);
}

/**
 * Extract score from run.json top-level. run.json always exists for finished
 * runs and contains `status` + `score` + `registrationType`.
 * @param {any} json
 * @returns {number|null}
 */
function extractScoreFromRunJson(json) {
  if (!json || typeof json !== "object") return null;
  return coerceScore(json.score);
}

/**
 * Coerce a raw score field to a finite non-negative integer or null.
 * forrent 名寄せスコア is always 0-100 integer.
 * @param {any} raw
 * @returns {number|null}
 */
function coerceScore(raw) {
  if (raw === null || raw === undefined) return null;
  const n = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isFinite(n)) return null;
  if (n < 0 || n > 100) return null;
  return Math.round(n);
}

/* ---------- statistics ---------- */

/**
 * Compute descriptive stats for an array of scores (already extracted).
 * Returns all numeric fields null if scores is empty.
 * @param {number[]} scores
 * @returns {ScoreStats}
 */
function computeScoreStats(scores) {
  const clean = (scores || []).filter((s) => typeof s === "number" && Number.isFinite(s));
  const n = clean.length;
  if (n === 0) {
    return {
      n: 0,
      min: null,
      max: null,
      median: null,
      p25: null,
      p75: null,
      mean: null,
      stddev: null,
      escalation_rate: null,
      scores: [],
    };
  }
  const sorted = [...clean].sort((a, b) => a - b);
  const mean = sorted.reduce((s, v) => s + v, 0) / n;
  const variance = sorted.reduce((s, v) => s + (v - mean) ** 2, 0) / n;
  const stddev = Math.sqrt(variance);
  const escalated = sorted.filter((s) => s >= ESCALATION_THRESHOLD).length;
  return {
    n,
    min: sorted[0],
    max: sorted[n - 1],
    median: quantile(sorted, 0.5),
    p25: quantile(sorted, 0.25),
    p75: quantile(sorted, 0.75),
    mean: round2(mean),
    stddev: round2(stddev),
    escalation_rate: round4(escalated / n),
    scores: clean,
  };
}

/**
 * Linear-interpolation quantile over a sorted ascending array.
 * Empty input returns null.
 * @param {number[]} sorted
 * @param {number} q - 0..1
 * @returns {number|null}
 */
function quantile(sorted, q) {
  if (!sorted.length) return null;
  if (sorted.length === 1) return sorted[0];
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) return round2(sorted[lo]);
  const frac = pos - lo;
  return round2(sorted[lo] * (1 - frac) + sorted[hi] * frac);
}

function round2(n) {
  return Math.round(n * 100) / 100;
}
function round4(n) {
  return Math.round(n * 10000) / 10000;
}

/* ---------- pair detection ---------- */

/**
 * Detect same-property pairs across baseline and delta groups.
 * T001 inventory confirms reinsId overlap=0 for 〜2026-05-16T08:43:10Z vs
 * post-T020, so this is expected to return [] — but we still run it as a
 * safety check per T002 §5.1 (paired comparison is preferred when available).
 *
 * @param {GroupRunRef[]} baselineRuns
 * @param {GroupRunRef[]} deltaRuns
 * @returns {PairResult[]}
 */
function detectSamePropertyPairs(baselineRuns, deltaRuns) {
  if (!Array.isArray(baselineRuns) || !Array.isArray(deltaRuns)) return [];
  const baselineByReins = new Map();
  for (const r of baselineRuns) {
    if (!r || !r.reinsId) continue;
    // Keep the latest baseline run per reinsId (max timestamp string compare is safe for "YYYYMMDD-HHMMSS")
    const prev = baselineByReins.get(r.reinsId);
    if (!prev || (r.timestamp || "") > (prev.timestamp || "")) {
      baselineByReins.set(r.reinsId, r);
    }
  }
  const pairs = [];
  for (const d of deltaRuns) {
    if (!d || !d.reinsId) continue;
    const b = baselineByReins.get(d.reinsId);
    if (!b) continue;
    const score_delta =
      typeof b.score === "number" && typeof d.score === "number"
        ? d.score - b.score
        : null;
    pairs.push({ reinsId: d.reinsId, baseline: b, delta: d, score_delta });
  }
  return pairs;
}

/* ---------- group comparison ---------- */

/**
 * Compare two groups of runs and emit ScoreABResult-compatible body (without
 * the framing fields generated_at / cutoffs / warnings — those are added by
 * the CLI).
 *
 * @param {GroupRunRef[]} baselineGroup
 * @param {GroupRunRef[]} deltaGroup
 * @returns {{group_a: ScoreStats, group_c: ScoreStats, median_delta: number|null, mean_delta: number|null, escalation_delta: number|null}}
 */
function compareScoreGroups(baselineGroup, deltaGroup) {
  const baselineScores = (baselineGroup || [])
    .map((r) => (r ? r.score : null))
    .filter((s) => typeof s === "number");
  const deltaScores = (deltaGroup || [])
    .map((r) => (r ? r.score : null))
    .filter((s) => typeof s === "number");
  const group_a = computeScoreStats(baselineScores);
  const group_c = computeScoreStats(deltaScores);
  const median_delta =
    group_a.median !== null && group_c.median !== null
      ? round2(group_c.median - group_a.median)
      : null;
  const mean_delta =
    group_a.mean !== null && group_c.mean !== null
      ? round2(group_c.mean - group_a.mean)
      : null;
  const escalation_delta =
    group_a.escalation_rate !== null && group_c.escalation_rate !== null
      ? round4(group_c.escalation_rate - group_a.escalation_rate)
      : null;
  return { group_a, group_c, median_delta, mean_delta, escalation_delta };
}

/* ---------- group assignment ---------- */

/**
 * Convert a "YYYYMMDD-HHMMSS" run timestamp prefix to a Date (UTC).
 * Returns null on malformed input.
 *
 * Note: watch-nyuko writes run directory names with local-time prefix that
 * happens to match the JST wall-clock of when the run started. Treat the
 * prefix as JST for comparison purposes (T001 inventory uses JST cutoffs).
 *
 * To keep CLI flexible, we accept both JST and UTC cutoffs as ISO strings
 * and convert the run-dir prefix to UTC by interpreting it as JST.
 *
 * @param {string} tsPrefix - "YYYYMMDD-HHMMSS"
 * @returns {Date|null}
 */
function parseRunTimestampToDate(tsPrefix) {
  if (typeof tsPrefix !== "string") return null;
  const m = /^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})$/.exec(tsPrefix);
  if (!m) return null;
  // Interpret as JST (UTC+9). Build an ISO string and parse.
  const iso = `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}+09:00`;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * Decide which group a run belongs to.
 *   "baseline" if run start <= baseline_until
 *   "delta"    if run start >= delta_since
 *   "between"  otherwise (Group B in T002 §5.2; excluded from main A/C compare)
 *
 * @param {string} runTsPrefix
 * @param {Date} baselineUntil
 * @param {Date} deltaSince
 * @returns {"baseline"|"delta"|"between"|"invalid"}
 */
function classifyRunGroup(runTsPrefix, baselineUntil, deltaSince) {
  const d = parseRunTimestampToDate(runTsPrefix);
  if (!d) return "invalid";
  if (d.getTime() <= baselineUntil.getTime()) return "baseline";
  if (d.getTime() >= deltaSince.getTime()) return "delta";
  return "between";
}

/* ---------- exports ---------- */

module.exports = {
  ESCALATION_THRESHOLD,
  extractScoreFromValidation,
  extractScoreFromRunJson,
  coerceScore,
  computeScoreStats,
  quantile,
  detectSamePropertyPairs,
  compareScoreGroups,
  parseRunTimestampToDate,
  classifyRunGroup,
};
