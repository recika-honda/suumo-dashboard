#!/usr/bin/env node
"use strict";

/**
 * test-score-extract.js — Phase ε T006 unit tests
 *
 * Tests for scripts/measure/lib-score-extract.js pure functions.
 * Covers all 6 perspectives from T005 handoff:
 *   1. coerceScore           — boundary: null/NaN/negative/101/string/"33"/32.7
 *   2. computeScoreStats     — empty/N=1/N=2/N=3 median interp/all-same stddev=0/escalation_rate endpoints
 *   3. detectSamePropertyPairs — overlap=0/overlap=1/baseline dup latest-ts/score null → score_delta=null
 *   4. compareScoreGroups    — empty groups → delta null / positive delta / negative delta / escalation_delta range
 *   5. parseRunTimestampToDate / classifyRunGroup — JST→UTC / between / invalid prefix
 *   6. extractScoreFromValidation / extractScoreFromRunJson — primary/fallback/both-absent
 *
 * Integration test:
 *   7. full run dir scan with fixture data → summary.json schema assertions
 *
 * Reference: code/suumo-dashboard/docs/refactor/phase-epsilon-design.md §5, §8, §9
 * Spec source: .claude/do/findings/epsilon-T005-implementation.md §9 (T006 handoff)
 *
 * Test framework: vanilla Node assert (matches test-negation-filter.js pattern).
 * No external deps. Run: node scripts/test/test-score-extract.js
 */

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execSync } = require("child_process");

const {
  coerceScore,
  computeScoreStats,
  detectSamePropertyPairs,
  compareScoreGroups,
  parseRunTimestampToDate,
  classifyRunGroup,
  extractScoreFromValidation,
  extractScoreFromRunJson,
  quantile,
  ESCALATION_THRESHOLD,
} = require("../measure/lib-score-extract");

let pass = 0;
let fail = 0;

function check(label, fn) {
  try {
    fn();
    console.log(`ok ${label}`);
    pass++;
  } catch (e) {
    console.error(`FAIL ${label}: ${e.message}`);
    fail++;
  }
}

// ── 0. Constants ───────────────────────────────────────────────
check("ESCALATION_THRESHOLD is 34", () => {
  assert.strictEqual(ESCALATION_THRESHOLD, 34);
});

// ── 1. coerceScore — boundary values ──────────────────────────
check("coerceScore: null → null", () => {
  assert.strictEqual(coerceScore(null), null);
});
check("coerceScore: undefined → null", () => {
  assert.strictEqual(coerceScore(undefined), null);
});
check("coerceScore: NaN → null", () => {
  assert.strictEqual(coerceScore(NaN), null);
});
check("coerceScore: Infinity → null", () => {
  assert.strictEqual(coerceScore(Infinity), null);
});
check("coerceScore: -1 → null (below 0)", () => {
  assert.strictEqual(coerceScore(-1), null);
});
check("coerceScore: 101 → null (above 100)", () => {
  assert.strictEqual(coerceScore(101), null);
});
check("coerceScore: 0 → 0 (boundary: minimum valid)", () => {
  assert.strictEqual(coerceScore(0), 0);
});
check("coerceScore: 100 → 100 (boundary: maximum valid)", () => {
  assert.strictEqual(coerceScore(100), 100);
});
check("coerceScore: string '33' → 33", () => {
  assert.strictEqual(coerceScore("33"), 33);
});
check("coerceScore: float 32.7 → 33 (Math.round)", () => {
  assert.strictEqual(coerceScore(32.7), 33);
});
check("coerceScore: float 32.5 → 33 (Math.round rounds 0.5 up)", () => {
  assert.strictEqual(coerceScore(32.5), 33);
});
check("coerceScore: float 32.4 → 32 (Math.round truncates)", () => {
  assert.strictEqual(coerceScore(32.4), 32);
});
check("coerceScore: string 'abc' → null (non-numeric)", () => {
  assert.strictEqual(coerceScore("abc"), null);
});
check("coerceScore: object {} → null", () => {
  assert.strictEqual(coerceScore({}), null);
});

// ── 2. computeScoreStats ───────────────────────────────────────
check("computeScoreStats: empty array → all-null stats", () => {
  const s = computeScoreStats([]);
  assert.strictEqual(s.n, 0);
  assert.strictEqual(s.min, null);
  assert.strictEqual(s.max, null);
  assert.strictEqual(s.median, null);
  assert.strictEqual(s.p25, null);
  assert.strictEqual(s.p75, null);
  assert.strictEqual(s.mean, null);
  assert.strictEqual(s.stddev, null);
  assert.strictEqual(s.escalation_rate, null);
  assert.deepStrictEqual(s.scores, []);
});

check("computeScoreStats: N=1 → identical min/max/median/p25/p75/mean", () => {
  const s = computeScoreStats([40]);
  assert.strictEqual(s.n, 1);
  assert.strictEqual(s.min, 40);
  assert.strictEqual(s.max, 40);
  assert.strictEqual(s.median, 40);
  assert.strictEqual(s.p25, 40);
  assert.strictEqual(s.p75, 40);
  assert.strictEqual(s.mean, 40);
  assert.strictEqual(s.stddev, 0);
  assert.strictEqual(s.escalation_rate, 1); // 40 >= 34
});

check("computeScoreStats: N=2 median is average", () => {
  const s = computeScoreStats([30, 40]);
  assert.strictEqual(s.n, 2);
  assert.strictEqual(s.min, 30);
  assert.strictEqual(s.max, 40);
  // linear-interp: pos = (2-1)*0.5 = 0.5, lo=0, hi=1, frac=0.5
  // => 30*(1-0.5) + 40*0.5 = 35
  assert.strictEqual(s.median, 35);
});

check("computeScoreStats: N=3 median is middle element", () => {
  const s = computeScoreStats([20, 35, 50]);
  assert.strictEqual(s.n, 3);
  // sorted: [20, 35, 50], pos=(3-1)*0.5=1.0, lo=1=hi=1 → sorted[1]=35
  assert.strictEqual(s.median, 35);
});

check("computeScoreStats: all same value → stddev=0", () => {
  const s = computeScoreStats([30, 30, 30]);
  assert.strictEqual(s.stddev, 0);
  assert.strictEqual(s.mean, 30);
  assert.strictEqual(s.median, 30);
});

check("computeScoreStats: all scores=33 → escalation_rate=0 (none >= 34)", () => {
  const s = computeScoreStats([33, 33, 33]);
  assert.strictEqual(s.escalation_rate, 0);
});

check("computeScoreStats: all scores=34 → escalation_rate=1 (all >= 34)", () => {
  const s = computeScoreStats([34, 34, 34]);
  assert.strictEqual(s.escalation_rate, 1);
});

check("computeScoreStats: mixed escalation → rate is fraction", () => {
  // 2 out of 4 >= 34 → 0.5
  const s = computeScoreStats([30, 33, 34, 40]);
  assert.strictEqual(s.escalation_rate, 0.5);
});

check("computeScoreStats: null values in input are filtered out", () => {
  // filter should skip non-numeric
  const s = computeScoreStats([30, null, 40]);
  assert.strictEqual(s.n, 2);
  assert.deepStrictEqual(s.scores.sort(), [30, 40]);
});

check("computeScoreStats: NaN in input filtered out", () => {
  const s = computeScoreStats([30, NaN, 40]);
  assert.strictEqual(s.n, 2);
});

// quantile edge cases
check("quantile: empty sorted array → null", () => {
  assert.strictEqual(quantile([], 0.5), null);
});
check("quantile: single element → that element", () => {
  assert.strictEqual(quantile([42], 0.5), 42);
});
check("quantile: N=4, q=0.25 interpolates correctly", () => {
  // sorted=[10,20,30,40], pos=(4-1)*0.25=0.75, lo=0, hi=1, frac=0.75
  // => 10*(0.25) + 20*(0.75) = 2.5+15 = 17.5
  const q = quantile([10, 20, 30, 40], 0.25);
  assert.strictEqual(q, 17.5);
});

// ── 3. detectSamePropertyPairs ─────────────────────────────────
check("detectSamePropertyPairs: no overlap → empty pairs", () => {
  const baseline = [
    { run: "20260501-120000_100001", reinsId: "100001", timestamp: "20260501-120000", score: 30, status: "SUCCESS", scoreSource: "run.json" },
  ];
  const delta = [
    { run: "20260518-080000_100004", reinsId: "100004", timestamp: "20260518-080000", score: 38, status: "SUCCESS", scoreSource: "run.json" },
  ];
  const pairs = detectSamePropertyPairs(baseline, delta);
  assert.deepStrictEqual(pairs, []);
});

check("detectSamePropertyPairs: overlap=1 → one pair with correct score_delta", () => {
  const baseline = [
    { run: "20260501-120000_100001", reinsId: "100001", timestamp: "20260501-120000", score: 30, status: "SUCCESS", scoreSource: "run.json" },
  ];
  const delta = [
    { run: "20260518-080000_100001", reinsId: "100001", timestamp: "20260518-080000", score: 38, status: "SUCCESS", scoreSource: "run.json" },
  ];
  const pairs = detectSamePropertyPairs(baseline, delta);
  assert.strictEqual(pairs.length, 1);
  assert.strictEqual(pairs[0].reinsId, "100001");
  assert.strictEqual(pairs[0].score_delta, 8); // 38 - 30
});

check("detectSamePropertyPairs: baseline has duplicate reinsId → latest timestamp wins", () => {
  // Two baseline runs for same reinsId; later timestamp (20260510) should be selected
  const baseline = [
    { run: "20260501-120000_100001", reinsId: "100001", timestamp: "20260501-120000", score: 28, status: "SUCCESS", scoreSource: "run.json" },
    { run: "20260510-090000_100001", reinsId: "100001", timestamp: "20260510-090000", score: 30, status: "SUCCESS", scoreSource: "run.json" },
  ];
  const delta = [
    { run: "20260518-080000_100001", reinsId: "100001", timestamp: "20260518-080000", score: 38, status: "SUCCESS", scoreSource: "run.json" },
  ];
  const pairs = detectSamePropertyPairs(baseline, delta);
  assert.strictEqual(pairs.length, 1);
  // Should use baseline score=30 (later timestamp 20260510) not 28 (earlier 20260501)
  assert.strictEqual(pairs[0].baseline.score, 30);
  assert.strictEqual(pairs[0].score_delta, 8); // 38 - 30
});

check("detectSamePropertyPairs: baseline score=null → score_delta=null", () => {
  const baseline = [
    { run: "20260501-120000_100001", reinsId: "100001", timestamp: "20260501-120000", score: null, status: "IMAGE_INSUFFICIENT", scoreSource: "none" },
  ];
  const delta = [
    { run: "20260518-080000_100001", reinsId: "100001", timestamp: "20260518-080000", score: 38, status: "SUCCESS", scoreSource: "run.json" },
  ];
  const pairs = detectSamePropertyPairs(baseline, delta);
  assert.strictEqual(pairs.length, 1);
  assert.strictEqual(pairs[0].score_delta, null);
});

check("detectSamePropertyPairs: delta score=null → score_delta=null", () => {
  const baseline = [
    { run: "20260501-120000_100001", reinsId: "100001", timestamp: "20260501-120000", score: 30, status: "SUCCESS", scoreSource: "run.json" },
  ];
  const delta = [
    { run: "20260518-080000_100001", reinsId: "100001", timestamp: "20260518-080000", score: null, status: "IMAGE_INSUFFICIENT", scoreSource: "none" },
  ];
  const pairs = detectSamePropertyPairs(baseline, delta);
  assert.strictEqual(pairs.length, 1);
  assert.strictEqual(pairs[0].score_delta, null);
});

check("detectSamePropertyPairs: non-array inputs → empty pairs", () => {
  assert.deepStrictEqual(detectSamePropertyPairs(null, null), []);
  assert.deepStrictEqual(detectSamePropertyPairs(undefined, []), []);
  assert.deepStrictEqual(detectSamePropertyPairs([], undefined), []);
});

// ── 4. compareScoreGroups ──────────────────────────────────────
check("compareScoreGroups: empty baseline and delta → all deltas null", () => {
  const r = compareScoreGroups([], []);
  assert.strictEqual(r.median_delta, null);
  assert.strictEqual(r.mean_delta, null);
  assert.strictEqual(r.escalation_delta, null);
  assert.strictEqual(r.group_a.n, 0);
  assert.strictEqual(r.group_c.n, 0);
});

check("compareScoreGroups: empty baseline only → delta null", () => {
  const delta = [{ score: 40 }];
  const r = compareScoreGroups([], delta);
  assert.strictEqual(r.median_delta, null);
  assert.strictEqual(r.group_a.n, 0);
  assert.strictEqual(r.group_c.n, 1);
});

check("compareScoreGroups: positive median_delta when delta scores higher", () => {
  const baseline = [{ score: 30 }, { score: 32 }];
  const delta = [{ score: 38 }, { score: 40 }];
  const r = compareScoreGroups(baseline, delta);
  // baseline median: sorted=[30,32], pos=0.5, lo=0,hi=1,frac=0.5 → 31
  // delta median: sorted=[38,40], pos=0.5, lo=0,hi=1,frac=0.5 → 39
  // median_delta = 39 - 31 = 8
  assert.ok(r.median_delta > 0, `expected positive median_delta, got ${r.median_delta}`);
});

check("compareScoreGroups: negative median_delta when delta scores lower", () => {
  const baseline = [{ score: 40 }, { score: 42 }];
  const delta = [{ score: 28 }, { score: 30 }];
  const r = compareScoreGroups(baseline, delta);
  assert.ok(r.median_delta < 0, `expected negative median_delta, got ${r.median_delta}`);
});

check("compareScoreGroups: zero median_delta when groups are identical", () => {
  const baseline = [{ score: 35 }];
  const delta = [{ score: 35 }];
  const r = compareScoreGroups(baseline, delta);
  assert.strictEqual(r.median_delta, 0);
});

check("compareScoreGroups: escalation_delta is within 0-1 range when nonzero", () => {
  // baseline: 0/2 >= 34 → rate=0; delta: 2/2 >= 34 → rate=1; delta = 1.0
  const baseline = [{ score: 30 }, { score: 33 }];
  const delta = [{ score: 34 }, { score: 40 }];
  const r = compareScoreGroups(baseline, delta);
  assert.ok(r.escalation_delta >= -1 && r.escalation_delta <= 1,
    `escalation_delta out of range: ${r.escalation_delta}`);
  assert.strictEqual(r.escalation_delta, 1);
});

check("compareScoreGroups: null scores in GroupRunRef are filtered", () => {
  const baseline = [{ score: 30 }, { score: null }, { score: 32 }];
  const delta = [{ score: 40 }, { score: null }];
  const r = compareScoreGroups(baseline, delta);
  assert.strictEqual(r.group_a.n, 2);
  assert.strictEqual(r.group_c.n, 1);
});

// ── 5. parseRunTimestampToDate / classifyRunGroup ───────────────
check("parseRunTimestampToDate: valid JST prefix → correct UTC Date", () => {
  // 20260517-070000 JST = 2026-05-16T22:00:00Z UTC
  const d = parseRunTimestampToDate("20260517-070000");
  assert.ok(d instanceof Date, "expected Date object");
  assert.ok(!Number.isNaN(d.getTime()), "expected valid Date");
  assert.strictEqual(d.toISOString(), "2026-05-16T22:00:00.000Z");
});

check("parseRunTimestampToDate: 20260516-174310 JST = 2026-05-16T08:43:10Z UTC", () => {
  const d = parseRunTimestampToDate("20260516-174310");
  assert.strictEqual(d.toISOString(), "2026-05-16T08:43:10.000Z");
});

check("parseRunTimestampToDate: null input → null", () => {
  assert.strictEqual(parseRunTimestampToDate(null), null);
});

check("parseRunTimestampToDate: invalid prefix format → null", () => {
  assert.strictEqual(parseRunTimestampToDate("invalid"), null);
  assert.strictEqual(parseRunTimestampToDate("20260517"), null);
  assert.strictEqual(parseRunTimestampToDate(""), null);
});

check("classifyRunGroup: baseline run (ts <= baseline_until) → 'baseline'", () => {
  const baselineUntil = new Date("2026-05-16T08:43:10Z");
  const deltaSince = new Date("2026-05-16T22:00:00Z");
  // 20260516-174310 JST = 2026-05-16T08:43:10Z — exactly at boundary
  const g = classifyRunGroup("20260516-174310", baselineUntil, deltaSince);
  assert.strictEqual(g, "baseline");
});

check("classifyRunGroup: delta run (ts >= delta_since) → 'delta'", () => {
  const baselineUntil = new Date("2026-05-16T08:43:10Z");
  const deltaSince = new Date("2026-05-16T22:00:00Z");
  // 20260517-070000 JST = 2026-05-16T22:00:00Z — exactly at delta_since boundary
  const g = classifyRunGroup("20260517-070000", baselineUntil, deltaSince);
  assert.strictEqual(g, "delta");
});

check("classifyRunGroup: between run → 'between'", () => {
  const baselineUntil = new Date("2026-05-16T08:43:10Z");
  const deltaSince = new Date("2026-05-16T22:00:00Z");
  // 20260517-050000 JST = 2026-05-16T20:00:00Z — after baseline, before delta
  const g = classifyRunGroup("20260517-050000", baselineUntil, deltaSince);
  assert.strictEqual(g, "between");
});

check("classifyRunGroup: invalid prefix → 'invalid'", () => {
  const baselineUntil = new Date("2026-05-16T08:43:10Z");
  const deltaSince = new Date("2026-05-16T22:00:00Z");
  assert.strictEqual(classifyRunGroup("badprefix", baselineUntil, deltaSince), "invalid");
  assert.strictEqual(classifyRunGroup(null, baselineUntil, deltaSince), "invalid");
  assert.strictEqual(classifyRunGroup("", baselineUntil, deltaSince), "invalid");
});

check("classifyRunGroup: early baseline run well before cutoff → 'baseline'", () => {
  const baselineUntil = new Date("2026-05-16T08:43:10Z");
  const deltaSince = new Date("2026-05-16T22:00:00Z");
  // 20260501-120000 JST = 2026-05-01T03:00:00Z — well before baseline_until
  const g = classifyRunGroup("20260501-120000", baselineUntil, deltaSince);
  assert.strictEqual(g, "baseline");
});

check("classifyRunGroup: future delta run → 'delta'", () => {
  const baselineUntil = new Date("2026-05-16T08:43:10Z");
  const deltaSince = new Date("2026-05-16T22:00:00Z");
  // 20260518-120000 JST = 2026-05-18T03:00:00Z
  const g = classifyRunGroup("20260518-120000", baselineUntil, deltaSince);
  assert.strictEqual(g, "delta");
});

// ── 6. extractScoreFromValidation / extractScoreFromRunJson ────
check("extractScoreFromValidation: normal object with score=40 → 40", () => {
  assert.strictEqual(extractScoreFromValidation({ score: 40, hasError: false, errors: [] }), 40);
});

check("extractScoreFromValidation: score=null → null", () => {
  assert.strictEqual(extractScoreFromValidation({ score: null, hasError: true }), null);
});

check("extractScoreFromValidation: score absent → null", () => {
  assert.strictEqual(extractScoreFromValidation({ hasError: false }), null);
});

check("extractScoreFromValidation: invalid type (string 'abc') → null", () => {
  assert.strictEqual(extractScoreFromValidation({ score: "abc" }), null);
});

check("extractScoreFromValidation: non-object input (null) → null", () => {
  assert.strictEqual(extractScoreFromValidation(null), null);
});

check("extractScoreFromValidation: non-object input (string) → null", () => {
  assert.strictEqual(extractScoreFromValidation("not an object"), null);
});

check("extractScoreFromRunJson: normal SUCCESS run.json with score=38 → 38", () => {
  const runJson = { status: "SUCCESS", score: 38, registrationType: "掲載指示" };
  assert.strictEqual(extractScoreFromRunJson(runJson), 38);
});

check("extractScoreFromRunJson: score=null → null", () => {
  const runJson = { status: "IMAGE_INSUFFICIENT", score: null };
  assert.strictEqual(extractScoreFromRunJson(runJson), null);
});

check("extractScoreFromRunJson: null input → null", () => {
  assert.strictEqual(extractScoreFromRunJson(null), null);
});

check("extractScoreFromRunJson: both run.json and validation absent → null (fallback chain)", () => {
  // Simulates a run where pipeline never reached confirm screen
  // extractScoreFromRunJson(null) → null, extractScoreFromValidation(null) → null
  const fromRun = extractScoreFromRunJson(null);
  const fromVal = extractScoreFromValidation(null);
  assert.strictEqual(fromRun, null);
  assert.strictEqual(fromVal, null);
});

check("extractScoreFromRunJson: validation-after-escalate fallback → score", () => {
  // Primary is null (run.json missing score), fallback from validation
  const runJson = { status: "SUCCESS", score: null };
  const valJson = { score: 40, hasError: true, errors: ["掲載数オーバー"] };
  const primary = extractScoreFromRunJson(runJson);
  const fallback = primary !== null ? primary : extractScoreFromValidation(valJson);
  assert.strictEqual(fallback, 40);
});

// ── 7. Integration: fixture run dir scan → summary.json schema ─
check("integration: fixture baseline+delta dirs produce valid summary.json", () => {
  const FIXTURE_ROOT = path.resolve(
    __dirname,
    "fixtures/score-delta"
  );
  const SCRIPT = path.resolve(__dirname, "../measure-score-delta.js");
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "score-delta-test-"));

  // Use a dedicated fixture runs dir that has all groups pre-staged.
  // The fixture layout (created in T006):
  //   fixtures/score-delta/baseline/20260501-120000_100001/run.json  (score:30)
  //   fixtures/score-delta/baseline/20260510-090000_100002/run.json  (score:32)
  //   fixtures/score-delta/baseline/20260512-150000_100003/run.json  (score:null) + validation(score:35)
  //   fixtures/score-delta/delta/20260518-080000_100004/run.json      (score:38)
  //   fixtures/score-delta/delta/20260518-100000_100005/run.json      (score:40)
  //   fixtures/score-delta/delta/20260518-120000_100006/run.json      (score:36, REG_FAIL)
  //   fixtures/score-delta/between/20260517-050000_100007/run.json    (score:33, between)
  //
  // We create a merged flat directory for the CLI, since it expects one flat logs/runs dir.
  const runsDir = fs.mkdtempSync(path.join(os.tmpdir(), "score-delta-runs-"));

  // Helper to copy a run directory into the flat runsDir
  function copyRun(srcDir) {
    const entries = fs.readdirSync(srcDir);
    for (const name of entries) {
      if (!fs.statSync(path.join(srcDir, name)).isDirectory()) continue;
      const dest = path.join(runsDir, name);
      fs.mkdirSync(dest, { recursive: true });
      for (const f of fs.readdirSync(path.join(srcDir, name))) {
        fs.copyFileSync(
          path.join(srcDir, name, f),
          path.join(dest, f)
        );
      }
    }
  }

  for (const group of ["baseline", "delta", "between"]) {
    const groupDir = path.join(FIXTURE_ROOT, group);
    if (fs.existsSync(groupDir)) copyRun(groupDir);
  }

  // Cutoffs:
  // baseline_until: 2026-05-16T22:00:00Z  (all 20260501/10/12 are before)
  // delta_since:    2026-05-18T00:00:00Z  (20260518 are after; 20260517-050000 JST=20260516T20:00Z = between)
  const baselineUntil = "2026-05-16T22:00:00Z";
  const deltaSince = "2026-05-18T00:00:00Z";

  const cmd = [
    "node",
    JSON.stringify(SCRIPT),
    "--logs-runs", JSON.stringify(runsDir),
    "--out", JSON.stringify(outDir),
    "--baseline-until", baselineUntil,
    "--delta-since", deltaSince,
  ].join(" ");

  execSync(cmd, { stdio: "inherit" });

  const summaryPath = path.join(outDir, "summary.json");
  assert.ok(fs.existsSync(summaryPath), "summary.json should be written");

  const summary = JSON.parse(fs.readFileSync(summaryPath, "utf8"));

  // Schema checks
  assert.ok(typeof summary.generated_at === "string", "generated_at should be string");
  assert.ok(typeof summary.cutoffs === "object", "cutoffs should be object");
  // cutoffs are stored as ISO strings normalized by new Date(...).toISOString()
  // so compare as Date equality, not string equality
  assert.strictEqual(
    new Date(summary.cutoffs.baseline_until).toISOString(),
    new Date(baselineUntil).toISOString()
  );
  assert.strictEqual(
    new Date(summary.cutoffs.delta_since).toISOString(),
    new Date(deltaSince).toISOString()
  );

  // group_a: baseline runs with scores (100001=30, 100002=32, 100003 has null run.json but validation=35)
  assert.ok(typeof summary.group_a === "object", "group_a should be object");
  assert.ok(summary.group_a.n >= 2, `group_a.n should be >= 2, got ${summary.group_a.n}`);
  assert.ok(typeof summary.group_a.median === "number" || summary.group_a.median === null);

  // group_c: delta runs (100004=38, 100005=40, 100006=36)
  assert.ok(typeof summary.group_c === "object", "group_c should be object");
  assert.ok(summary.group_c.n >= 1, `group_c.n should be >= 1, got ${summary.group_c.n}`);

  // Deltas should be numbers or null
  const allowedTypes = v => v === null || typeof v === "number";
  assert.ok(allowedTypes(summary.median_delta), `median_delta type: ${typeof summary.median_delta}`);
  assert.ok(allowedTypes(summary.mean_delta), `mean_delta type: ${typeof summary.mean_delta}`);
  assert.ok(allowedTypes(summary.escalation_delta), `escalation_delta type: ${typeof summary.escalation_delta}`);

  // same_property_pairs: no overlap in our fixtures → should be empty
  assert.ok(Array.isArray(summary.same_property_pairs), "same_property_pairs should be array");

  // confounders: non-empty array
  assert.ok(Array.isArray(summary.confounders) && summary.confounders.length > 0,
    "confounders should be non-empty array");

  // diagnostics
  assert.ok(typeof summary.diagnostics === "object", "diagnostics should be object");
  assert.ok(typeof summary.diagnostics.baseline_total === "number");
  assert.ok(typeof summary.diagnostics.delta_total === "number");
  assert.ok(typeof summary.diagnostics.between_total === "number");

  // warnings
  assert.ok(Array.isArray(summary.warnings.missing_score), "warnings.missing_score should be array");
  assert.ok(Array.isArray(summary.warnings.malformed), "warnings.malformed should be array");

  // summary.md should also be written
  const mdPath = path.join(outDir, "summary.md");
  assert.ok(fs.existsSync(mdPath), "summary.md should be written");
  const md = fs.readFileSync(mdPath, "utf8");
  assert.ok(md.includes("Group A"), "summary.md should contain Group A section");
  assert.ok(md.includes("Group C"), "summary.md should contain Group C section");
  assert.ok(md.includes("Confounders"), "summary.md should contain Confounders section");
});

// ── Summary ───────────────────────────────────────────────────
console.log("");
console.log(`Results: ${pass} passed, ${fail} failed`);
if (fail > 0) {
  process.exit(1);
}
