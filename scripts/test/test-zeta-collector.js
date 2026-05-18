"use strict";
/**
 * test-zeta-collector.js — Unit tests for lib-zeta-collector.js
 *
 * Spec: docs/refactor/phase-zeta-collector-spec.md (T003, approved 2026-05-17)
 * Case tables: T003 §8.1 (computeCascadeStats, 7 cases)
 *              T003 §8.2 (computeImageInsufficientStats, 6 cases)
 *              T003 §8.3 (computeVision21Stats, 7 cases)
 *              T003 §8.4 (Integration, 5 cases)
 * Total: 30 unit cases + integration cases (T005, zeta-T005)
 *
 * DO NOT edit lib-zeta-collector.js or daily-aggregate-phase-delta.js.
 * Expected values are derived from T003 spec tables, NOT from fixture reverse-engineering.
 */

const assert = require("assert");

const {
  ZETA_NULL_STATE,
  computeCascadeStats,
  computeImageInsufficientStats,
  computeVision21Stats,
} = require("../measure/lib-zeta-collector.js");

const { renderMarkdown } = require("../daily-aggregate-phase-delta.js");

let pass = 0;
let fail = 0;

function check(label, fn) {
  try {
    fn();
    console.log(`ok  ${label}`);
    pass++;
  } catch (e) {
    console.error(`FAIL ${label}`);
    console.error(`     ${e.message}`);
    fail++;
  }
}

// ---------------------------------------------------------------------------
// §8.1 computeCascadeStats — 7 unit cases
// ---------------------------------------------------------------------------

// cascade_hit_rate_A: single HIT record
// spec: [{out02:{rawCount:1, cascadeHit:{platform:"itandi",count:6}}}]
// expected: hit=1, miss=0, attempted=1, hit_rate=1.0, platforms=["itandi"]
check("cascade §8.1-A single HIT: attempted=1 hit=1 miss=0", () => {
  const recs = [{ out02: { rawCount: 1, cascadeHit: { platform: "itandi", count: 6 } } }];
  const r = computeCascadeStats(recs);
  assert.strictEqual(r.cascade_hit_runs, 1);
  assert.strictEqual(r.cascade_miss_runs, 0);
  assert.strictEqual(r.cascade_attempted_runs, 1);
  assert.strictEqual(r.cascade_hit_rate, 1.0);
});

check("cascade §8.1-A platforms_seen includes itandi", () => {
  const recs = [{ out02: { rawCount: 1, cascadeHit: { platform: "itandi", count: 6 } } }];
  const r = computeCascadeStats(recs);
  assert.deepStrictEqual(r.platforms_seen, ["itandi"]);
});

// cascade_hit_rate_B: single MISS record (imageInsufficient=true, no cascadeHit)
// spec: [{out02:{rawCount:2, imageInsufficient:true}}]
// expected: hit=0, miss=1, attempted=1, hit_rate=0.0
check("cascade §8.1-B single MISS: attempted=1 hit=0 hit_rate=0.0", () => {
  const recs = [{ out02: { rawCount: 2, imageInsufficient: true } }];
  const r = computeCascadeStats(recs);
  assert.strictEqual(r.cascade_hit_runs, 0);
  assert.strictEqual(r.cascade_miss_runs, 1);
  assert.strictEqual(r.cascade_attempted_runs, 1);
  assert.strictEqual(r.cascade_hit_rate, 0.0);
  assert.strictEqual(r.image_insufficient_runs, 1);
});

// cascade_hit_rate_C: no cascade triggered (rawCount=8, sufficient images)
// spec: [{out02:{rawCount:8, downloaded:[]}}]
// expected: attempted=0, hit_rate=null (no cascade)
check("cascade §8.1-C no cascade (rawCount=8): attempted=0 hit_rate=null", () => {
  const recs = [{ out02: { rawCount: 8, downloaded: [] } }];
  const r = computeCascadeStats(recs);
  assert.strictEqual(r.cascade_attempted_runs, 0);
  assert.strictEqual(r.cascade_hit_rate, null);
  assert.strictEqual(r.cascade_hit_runs, 0);
  assert.strictEqual(r.image_insufficient_runs, 0);
});

// cascade_hit_rate_D: null out02 (missing stage output)
// spec: [{out02:null}]
// expected: all zeros, hit_rate=null (graceful null-safe)
check("cascade §8.1-D null out02: all zeros, hit_rate=null", () => {
  const recs = [{ out02: null }];
  const r = computeCascadeStats(recs);
  assert.strictEqual(r.cascade_attempted_runs, 0);
  assert.strictEqual(r.cascade_hit_runs, 0);
  assert.strictEqual(r.cascade_miss_runs, 0);
  assert.strictEqual(r.cascade_hit_rate, null);
  assert.strictEqual(r.image_insufficient_runs, 0);
});

// cascade_hit_rate_E: mixed records (1 HIT, 1 MISS, 2 normal)
// spec: 4 records total, 1 cascadeHit, 1 imageInsufficient, 2 normal
// expected: attempted=2, hit=1, miss=1, hit_rate=0.5
check("cascade §8.1-E mixed 4 records: attempted=2 hit=1 hit_rate=0.5", () => {
  const recs = [
    { out02: { rawCount: 1, cascadeHit: { platform: "itandi", count: 3 } } },
    { out02: { rawCount: 2, imageInsufficient: true } },
    { out02: { rawCount: 10, downloaded: [] } },
    { out02: null },
  ];
  const r = computeCascadeStats(recs);
  assert.strictEqual(r.cascade_attempted_runs, 2);
  assert.strictEqual(r.cascade_hit_runs, 1);
  assert.strictEqual(r.cascade_miss_runs, 1);
  assert.strictEqual(r.cascade_hit_rate, 0.5);
});

// cascade_hit_rate_F: deduplication of platforms_seen
// spec: two runs, both cascadeHit.platform="itandi"
// expected: platforms_seen=["itandi"] (deduped, not ["itandi","itandi"])
check("cascade §8.1-F platforms_seen deduped for multiple same-platform hits", () => {
  const recs = [
    { out02: { rawCount: 1, cascadeHit: { platform: "itandi", count: 3 } } },
    { out02: { rawCount: 1, cascadeHit: { platform: "itandi", count: 5 } } },
  ];
  const r = computeCascadeStats(recs);
  assert.deepStrictEqual(r.platforms_seen, ["itandi"]);
  assert.strictEqual(r.cascade_hit_runs, 2);
  assert.strictEqual(r.cascade_hit_rate, 1.0);
});

// cascade_hit_rate_G: cascadeHit present but no platform field -> "unknown"
// spec §9.4: cascadeHit presence = HIT, missing platform -> "unknown"
check("cascade §8.1-G cascadeHit with no platform -> platforms_seen=['unknown']", () => {
  const recs = [
    { out02: { rawCount: 1, cascadeHit: {} } },  // no platform property
  ];
  const r = computeCascadeStats(recs);
  assert.strictEqual(r.cascade_hit_runs, 1);
  assert.deepStrictEqual(r.platforms_seen, ["unknown"]);
});

// bonus: non-array input returns zeros
check("cascade non-array input: returns all zeros", () => {
  const r = computeCascadeStats(null);
  assert.strictEqual(r.cascade_attempted_runs, 0);
  assert.strictEqual(r.cascade_hit_rate, null);
  assert.deepStrictEqual(r.platforms_seen, []);
});

// anti-pattern §9.4: imageInsufficient on a cascadeHit run should NOT double-count as MISS
check("cascade §9.4 anti-pattern: cascadeHit takes precedence over imageInsufficient flag", () => {
  // A run where cascade HIT succeeded: imageInsufficient should NOT also be set,
  // but even if it were, cascadeHit detection order ensures it's counted as HIT only.
  const recs = [
    {
      out02: {
        rawCount: 1,
        cascadeHit: { platform: "itandi", count: 5 },
        // imageInsufficient is NOT set on hit runs per spec §9.4,
        // but we verify the detection order is cascadeHit-first
      },
    },
  ];
  const r = computeCascadeStats(recs);
  // Should be hit=1, NOT miss=1
  assert.strictEqual(r.cascade_hit_runs, 1);
  assert.strictEqual(r.cascade_miss_runs, 0);
});

// ---------------------------------------------------------------------------
// §8.2 computeImageInsufficientStats — 6 unit cases
// ---------------------------------------------------------------------------

// insufficient_A: single run with imageInsufficient=true and no cascadeHit
// spec: [{out02:{imageInsufficient:true, rawCount:2}}]
// expected: count=1, rate=1.0, total_runs=1, distribution={"2":1}
check("insufficient §8.2-A single insufficient: count=1 rate=1.0 dist={'2':1}", () => {
  const recs = [{ out02: { imageInsufficient: true, rawCount: 2 } }];
  const r = computeImageInsufficientStats(recs);
  assert.strictEqual(r.count, 1);
  assert.strictEqual(r.rate, 1.0);
  assert.strictEqual(r.total_runs, 1);
  assert.deepStrictEqual(r.raw_count_distribution, { "2": 1 });
});

// insufficient_B: cascade HIT run — must NOT be counted as insufficient
// spec: [{out02:{cascadeHit:{platform:"itandi"}, rawCount:1}}]
// expected: count=0, rate=0.0, distribution={}
check("insufficient §8.2-B cascade HIT run: count=0 (not counted)", () => {
  const recs = [{ out02: { cascadeHit: { platform: "itandi" }, rawCount: 1 } }];
  const r = computeImageInsufficientStats(recs);
  assert.strictEqual(r.count, 0);
  assert.strictEqual(r.rate, 0.0);
  assert.strictEqual(r.total_runs, 1);
  assert.deepStrictEqual(r.raw_count_distribution, {});
});

// insufficient_C: zero insufficient runs (all sufficient)
// spec: [{out02:{rawCount:5, downloaded:[]}}]
// expected: count=0, rate=0.0, total_runs=1
check("insufficient §8.2-C no insufficient runs: count=0 rate=0.0", () => {
  const recs = [{ out02: { rawCount: 5, downloaded: [] } }];
  const r = computeImageInsufficientStats(recs);
  assert.strictEqual(r.count, 0);
  assert.strictEqual(r.rate, 0.0);
  assert.strictEqual(r.total_runs, 1);
});

// insufficient_D: denominator is total_runs (ALL records, including null out02)
// spec §9.2: denominator = runRecords.length, NOT count of records with out02
// spec: 3 records (1 insufficient, 1 normal, 1 null out02) -> total_runs=3
check("insufficient §8.2-D denominator=total_runs incl null out02", () => {
  const recs = [
    { out02: { imageInsufficient: true, rawCount: 1 } },
    { out02: { rawCount: 8 } },
    { out02: null },
  ];
  const r = computeImageInsufficientStats(recs);
  assert.strictEqual(r.count, 1);
  assert.strictEqual(r.total_runs, 3);
  // rate = 1/3 ≈ 0.3333...
  assert.ok(Math.abs(r.rate - 1 / 3) < 1e-9, `rate should be 1/3, got ${r.rate}`);
});

// insufficient_E: multiple insufficient runs, rate calculation
// spec: 2 insufficient + 14 normal = 16 total -> rate=0.125
check("insufficient §8.2-E rate: 2/16=0.125", () => {
  const recs = [];
  for (let i = 0; i < 2; i++) {
    recs.push({ out02: { imageInsufficient: true, rawCount: 0 } });
  }
  for (let i = 0; i < 14; i++) {
    recs.push({ out02: { rawCount: 8 } });
  }
  const r = computeImageInsufficientStats(recs);
  assert.strictEqual(r.count, 2);
  assert.strictEqual(r.total_runs, 16);
  assert.strictEqual(r.rate, 0.125);
});

// insufficient_F: unknown rawCount (null) -> distribution key "unknown"
check("insufficient §8.2-F rawCount=null -> distribution key 'unknown'", () => {
  const recs = [{ out02: { imageInsufficient: true, rawCount: null } }];
  const r = computeImageInsufficientStats(recs);
  assert.strictEqual(r.count, 1);
  assert.ok("unknown" in r.raw_count_distribution, "should have 'unknown' key");
  assert.strictEqual(r.raw_count_distribution["unknown"], 1);
});

// bonus: empty array -> count=0, rate=null, total_runs=0
check("insufficient empty array: count=0 rate=null total_runs=0", () => {
  const r = computeImageInsufficientStats([]);
  assert.strictEqual(r.count, 0);
  assert.strictEqual(r.rate, null);
  assert.strictEqual(r.total_runs, 0);
});

// bonus: non-array -> zeros
check("insufficient non-array input: returns zeros", () => {
  const r = computeImageInsufficientStats(null);
  assert.strictEqual(r.count, 0);
  assert.strictEqual(r.rate, null);
  assert.strictEqual(r.total_runs, 0);
});

// ---------------------------------------------------------------------------
// §8.3 computeVision21Stats — 7 unit cases
// ---------------------------------------------------------------------------

// vision_21_rate_A: 3 cat-21 images out of 20 total (SH excluded from denominator)
// spec: 3×"21" + 17 others (no SH) -> rate=3/20=0.15
check("vision §8.3-A 3/20 cat21: vision_21_rate=0.15", () => {
  const images = [];
  for (let i = 0; i < 3; i++) images.push({ categoryId: "21" });
  for (let i = 0; i < 17; i++) images.push({ categoryId: "01" });
  const recs = [{ out03Classify: { processedImages: images } }];
  const r = computeVision21Stats(recs);
  assert.strictEqual(r.category_21_count, 3);
  assert.strictEqual(r.total_images_classified, 20);
  assert.strictEqual(r.vision_21_rate, 0.15);
  assert.strictEqual(r.runs_with_classify_output, 1);
});

// vision_21_rate_B: SH excluded from denominator but present in category_distribution
// spec §9.3: SH (周辺環境) not classified by gpt-4o, must be excluded from rate denominator
// spec: 5 SH + 10 "01" + 2 "21" -> total_classified=12, rate=2/12, dist["SH"]=5
check("vision §8.3-B SH excluded from denominator, included in distribution", () => {
  const images = [];
  for (let i = 0; i < 5; i++) images.push({ categoryId: "SH" });
  for (let i = 0; i < 10; i++) images.push({ categoryId: "01" });
  for (let i = 0; i < 2; i++) images.push({ categoryId: "21" });
  const recs = [{ out03Classify: { processedImages: images } }];
  const r = computeVision21Stats(recs);
  assert.strictEqual(r.total_images_classified, 12);  // SH excluded
  assert.strictEqual(r.category_21_count, 2);
  assert.ok(Math.abs(r.vision_21_rate - 2 / 12) < 1e-9);
  // SH appears in distribution (informational)
  assert.strictEqual(r.category_distribution["SH"], 5);
});

// vision_21_rate_C: null out03Classify -> graceful skip, rate=null
// spec: [{out03Classify:null}] -> rate=null, runs_with_classify_output=0
check("vision §8.3-C null out03Classify: rate=null runs=0", () => {
  const recs = [{ out03Classify: null }];
  const r = computeVision21Stats(recs);
  assert.strictEqual(r.vision_21_rate, null);
  assert.strictEqual(r.total_images_classified, 0);
  assert.strictEqual(r.runs_with_classify_output, 0);
});

// vision_21_rate_D: empty processedImages array -> rate=null (denominator=0)
// spec: [{out03Classify:{processedImages:[]}}] -> rate=null
check("vision §8.3-D empty processedImages: rate=null", () => {
  const recs = [{ out03Classify: { processedImages: [] } }];
  const r = computeVision21Stats(recs);
  assert.strictEqual(r.vision_21_rate, null);
  assert.strictEqual(r.total_images_classified, 0);
  assert.strictEqual(r.runs_with_classify_output, 1);  // run has classify output but no images
});

// vision_21_rate_E: warn threshold boundary (rate > 0.15)
// spec §10.1: WARNING when rate > 0.15
check("vision §8.3-E warn threshold: rate=0.16 > 0.15 WARN", () => {
  const images = [];
  for (let i = 0; i < 16; i++) images.push({ categoryId: "21" });
  for (let i = 0; i < 84; i++) images.push({ categoryId: "01" });
  const recs = [{ out03Classify: { processedImages: images } }];
  const r = computeVision21Stats(recs);
  assert.strictEqual(r.total_images_classified, 100);
  assert.ok(r.vision_21_rate > 0.15, `rate=${r.vision_21_rate} should exceed WARN threshold`);
});

// vision_21_rate_F: critical threshold boundary (rate > 0.25)
// spec §10.1: CRITICAL when rate > 0.25
check("vision §8.3-F critical threshold: rate=0.26 > 0.25 CRITICAL", () => {
  const images = [];
  for (let i = 0; i < 26; i++) images.push({ categoryId: "21" });
  for (let i = 0; i < 74; i++) images.push({ categoryId: "01" });
  const recs = [{ out03Classify: { processedImages: images } }];
  const r = computeVision21Stats(recs);
  assert.ok(r.vision_21_rate > 0.25, `rate=${r.vision_21_rate} should exceed CRITICAL threshold`);
});

// vision_21_rate_G: all unique categories appear in distribution
// spec: multiple distinct categories all appear in category_distribution keys
check("vision §8.3-G all category values appear in distribution", () => {
  const categories = ["01", "02", "03", "04", "05", "SH", "21"];
  const images = categories.map((c) => ({ categoryId: c }));
  const recs = [{ out03Classify: { processedImages: images } }];
  const r = computeVision21Stats(recs);
  for (const cat of categories) {
    assert.ok(cat in r.category_distribution, `category '${cat}' should be in distribution`);
    assert.strictEqual(r.category_distribution[cat], 1);
  }
  // SH excluded from total_images_classified
  assert.strictEqual(r.total_images_classified, categories.length - 1);  // all minus SH
});

// bonus: non-array input -> zeros
check("vision non-array input: returns zeros", () => {
  const r = computeVision21Stats(null);
  assert.strictEqual(r.total_images_classified, 0);
  assert.strictEqual(r.vision_21_rate, null);
  assert.strictEqual(r.runs_with_classify_output, 0);
});

// bonus: null categoryId in processedImages -> skipped gracefully
check("vision null categoryId: skipped gracefully, no throw", () => {
  const recs = [
    {
      out03Classify: {
        processedImages: [
          { categoryId: "01" },
          { categoryId: null },  // should be skipped
          {},                    // missing categoryId, should be skipped
          { categoryId: "21" },
        ],
      },
    },
  ];
  const r = computeVision21Stats(recs);
  assert.strictEqual(r.total_images_classified, 2);  // only "01" and "21"
  assert.strictEqual(r.category_21_count, 1);
  assert.ok(Math.abs(r.vision_21_rate - 0.5) < 1e-9);
});

// bonus: zero cat-21 images -> rate=0.0
check("vision zero cat-21: rate=0.0", () => {
  const images = [
    { categoryId: "01" },
    { categoryId: "02" },
    { categoryId: "03" },
  ];
  const recs = [{ out03Classify: { processedImages: images } }];
  const r = computeVision21Stats(recs);
  assert.strictEqual(r.category_21_count, 0);
  assert.strictEqual(r.vision_21_rate, 0);
  assert.strictEqual(r.total_images_classified, 3);
});

// bonus: multiple runs aggregated correctly
check("vision multiple runs: totals accumulated across runs", () => {
  const recs = [
    { out03Classify: { processedImages: [{ categoryId: "21" }, { categoryId: "01" }] } },
    { out03Classify: { processedImages: [{ categoryId: "21" }, { categoryId: "02" }, { categoryId: "03" }] } },
  ];
  const r = computeVision21Stats(recs);
  assert.strictEqual(r.runs_with_classify_output, 2);
  assert.strictEqual(r.total_images_classified, 5);
  assert.strictEqual(r.category_21_count, 2);
  assert.ok(Math.abs(r.vision_21_rate - 2 / 5) < 1e-9);
});

// ---------------------------------------------------------------------------
// §8.4 Integration — 5 cases
// ---------------------------------------------------------------------------

// integration_A: all 3 sub-objects present when calling with mixed records
// verify no throw, all 3 keys returned with correct types
check("integration §8.4-A all 3 functions return expected sub-objects", () => {
  const recs = [
    { out02: { rawCount: 1, cascadeHit: { platform: "itandi", count: 3 } }, out03Classify: null },
    { out02: { imageInsufficient: true, rawCount: 2 }, out03Classify: { processedImages: [{ categoryId: "21" }] } },
    { out02: { rawCount: 8 }, out03Classify: { processedImages: [{ categoryId: "01" }, { categoryId: "SH" }] } },
  ];
  const cascade = computeCascadeStats(recs);
  const insufficient = computeImageInsufficientStats(recs);
  const vision = computeVision21Stats(recs);

  // cascade: 1 HIT (itandi) + 1 MISS
  assert.strictEqual(cascade.cascade_hit_runs, 1);
  assert.strictEqual(cascade.cascade_miss_runs, 1);
  assert.deepStrictEqual(cascade.platforms_seen, ["itandi"]);

  // insufficient: 1 run with imageInsufficient=true AND no cascadeHit (the MISS run)
  assert.strictEqual(insufficient.count, 1);
  assert.strictEqual(insufficient.total_runs, 3);

  // vision: 1 cat-21 + 1 cat-01 (SH excluded from denominator), run with null out03Classify skipped
  assert.strictEqual(vision.category_21_count, 1);
  assert.strictEqual(vision.total_images_classified, 2);  // "21" + "01" (SH excluded)
  assert.strictEqual(vision.runs_with_classify_output, 2);
});

// integration_B: null out02 records -> all cascade zeros, no throw
check("integration §8.4-B all null out02: cascade zeros, no throw", () => {
  const recs = [{ out02: null }, { out02: null }, { out02: null }];
  assert.doesNotThrow(() => {
    const r = computeCascadeStats(recs);
    assert.strictEqual(r.cascade_attempted_runs, 0);
    assert.strictEqual(r.cascade_hit_rate, null);
  });
});

// integration_C: null out03Classify records -> vision_21_rate null, no throw
check("integration §8.4-C all null out03Classify: vision_21_rate=null, no throw", () => {
  const recs = [{ out03Classify: null }, { out03Classify: null }];
  assert.doesNotThrow(() => {
    const r = computeVision21Stats(recs);
    assert.strictEqual(r.vision_21_rate, null);
    assert.strictEqual(r.runs_with_classify_output, 0);
  });
});

// integration_D: renderMarkdown with report.zeta present -> contains "Phase" text
// per T004 §3.2 backward compat test, renderMarkdown is exported from daily-aggregate
// renderMarkdown requires full report structure (maisoku / dom / score / warnings)
check("integration §8.4-D renderMarkdown with report.zeta: outputs monitoring section", () => {
  const mockZeta = {
    cascade: {
      image_insufficient_runs: 2,
      cascade_attempted_runs: 2,
      cascade_hit_runs: 1,
      cascade_miss_runs: 1,
      cascade_hit_rate: 0.5,
      platforms_seen: ["itandi"],
    },
    image_insufficient: {
      count: 1,
      rate: 0.0417,
      total_runs: 24,
      raw_count_distribution: { "0": 1 },
    },
    vision: {
      total_images_classified: 145,
      category_21_count: 16,
      vision_21_rate: 0.1103,
      category_distribution: { "21": 16, "01": 50 },
      runs_with_classify_output: 17,
    },
  };
  // renderMarkdown expects a full report object — all top-level fields used by the function
  const mockReport = {
    date: "2026-05-17",
    generated_at: "2026-05-17T09:00:00.000Z",
    warnings: [],
    maisoku: {
      total_runs: 24,
      runs_with_03b: 20,
      runs_with_confirm: 16,
      maisoku_download_rate: 0.875,
      pdftotext_rate: 0.188,
      vision_ocr_rate: 0.688,
      skipped_rate: 0.125,
      ocr_cost_total_usd: 0.055,
      ocr_cost_per_run: 0.0039,
      maisoku_net_gain_mean: 7.76,
      source_breakdown_agg: {
        maisoku_pure_mean: 6.5,
        maisoku_overlap_mean: 1.4,
        legacy_only_mean: 13.3,
      },
    },
    dom: {
      status: "ok",
      runs_matched: 16,
      exact_rate_mean: 1.0,
      phantom_rate_mean: 0.0,
      miss_rate_mean: 0.0,
      fp_rate_mean: 0.0,
    },
    score: {
      all_runs: { n: 16, min: 28, max: 48, median: 39, p25: 35, p75: 43, mean: 39.1 },
      escalation_rate: 0.6,
      maisoku_hit_runs: 13,
      maisoku_hit_rate: 0.813,
    },
    zeta: mockZeta,
  };
  assert.doesNotThrow(() => {
    const md = renderMarkdown(mockReport);
    assert.ok(typeof md === "string", "renderMarkdown should return a string");
    // Should contain Phase zeta section markers
    const hasZetaSection = md.includes("cascade") || md.includes("Phase") || md.includes("ζ");
    assert.ok(hasZetaSection, "markdown should contain zeta monitoring content");
  });
});

// integration_E: renderMarkdown without zeta key -> no throw, no zeta-specific content
check("integration §8.4-E renderMarkdown without zeta key: no throw, graceful skip", () => {
  // renderMarkdown expects full report structure — omitting only the zeta key
  const mockReport = {
    date: "2026-05-17",
    generated_at: "2026-05-17T09:00:00.000Z",
    warnings: [],
    maisoku: {
      total_runs: 24,
      runs_with_03b: 20,
      runs_with_confirm: 16,
      maisoku_download_rate: 0.875,
      pdftotext_rate: 0.188,
      vision_ocr_rate: 0.688,
      skipped_rate: 0.125,
      ocr_cost_total_usd: 0.055,
      ocr_cost_per_run: 0.0039,
      maisoku_net_gain_mean: 7.76,
      source_breakdown_agg: {
        maisoku_pure_mean: 6.5,
        maisoku_overlap_mean: 1.4,
        legacy_only_mean: 13.3,
      },
    },
    dom: {
      status: "ok",
      runs_matched: 16,
      exact_rate_mean: 1.0,
      phantom_rate_mean: 0.0,
      miss_rate_mean: 0.0,
      fp_rate_mean: 0.0,
    },
    score: {
      all_runs: { n: 16, min: 28, max: 48, median: 39, p25: 35, p75: 43, mean: 39.1 },
      escalation_rate: 0.6,
      maisoku_hit_runs: 13,
      maisoku_hit_rate: 0.813,
    },
    // no zeta key — backward compat: must not throw
  };
  assert.doesNotThrow(() => {
    const md = renderMarkdown(mockReport);
    assert.ok(typeof md === "string", "renderMarkdown should return a string even without zeta");
    // zeta section should NOT appear when zeta key is absent
    assert.ok(!md.includes("Phase ζ Monitoring"), "zeta section should be absent");
  });
});

// ---------------------------------------------------------------------------
// ZETA_NULL_STATE — structural integrity
// ---------------------------------------------------------------------------

check("ZETA_NULL_STATE: cascade sub-object has correct zero values", () => {
  const c = ZETA_NULL_STATE.cascade;
  assert.strictEqual(c.image_insufficient_runs, 0);
  assert.strictEqual(c.cascade_attempted_runs, 0);
  assert.strictEqual(c.cascade_hit_runs, 0);
  assert.strictEqual(c.cascade_miss_runs, 0);
  assert.strictEqual(c.cascade_hit_rate, null);
  assert.ok(Array.isArray(c.platforms_seen) && c.platforms_seen.length === 0);
});

check("ZETA_NULL_STATE: image_insufficient sub-object has correct zero values", () => {
  const ins = ZETA_NULL_STATE.image_insufficient;
  assert.strictEqual(ins.count, 0);
  assert.strictEqual(ins.rate, null);
  assert.strictEqual(ins.total_runs, 0);
  assert.deepStrictEqual(ins.raw_count_distribution, {});
});

check("ZETA_NULL_STATE: vision sub-object has correct zero values", () => {
  const v = ZETA_NULL_STATE.vision;
  assert.strictEqual(v.total_images_classified, 0);
  assert.strictEqual(v.category_21_count, 0);
  assert.strictEqual(v.vision_21_rate, null);
  assert.deepStrictEqual(v.category_distribution, {});
  assert.strictEqual(v.runs_with_classify_output, 0);
});

check("ZETA_NULL_STATE: is frozen (immutable)", () => {
  assert.ok(Object.isFrozen(ZETA_NULL_STATE), "top-level object should be frozen");
  assert.ok(Object.isFrozen(ZETA_NULL_STATE.cascade), "cascade sub-object should be frozen");
  assert.ok(Object.isFrozen(ZETA_NULL_STATE.image_insufficient), "image_insufficient should be frozen");
  assert.ok(Object.isFrozen(ZETA_NULL_STATE.vision), "vision sub-object should be frozen");
});

// backward compat: pre-T004 JSON files without zeta -> use ZETA_NULL_STATE as fallback
check("ZETA_NULL_STATE: usable as fallback when zeta key absent in old JSON", () => {
  // Simulate reading an old daily JSON file that lacks the zeta key
  const oldDailyJson = { date: "2026-05-16", maisoku: {}, dom: {}, score: {} };
  const zeta = oldDailyJson.zeta || ZETA_NULL_STATE;
  assert.strictEqual(zeta.cascade.cascade_attempted_runs, 0);
  assert.strictEqual(zeta.vision.vision_21_rate, null);
});

// ---------------------------------------------------------------------------
// Day 1 baseline replay (canonical values from T004 findings, N=24 runs)
// Source: zeta-T004-implementation.md §2.1 dry-run output
// ---------------------------------------------------------------------------

check("Day1 baseline: cascade attempted=2 hit=1 miss=1 hit_rate=0.5", () => {
  // Constructed to reproduce Day 1 canonical output (N=24 runs, 1 HIT itandi, 1 MISS)
  const recs = [];
  // 1 HIT run
  recs.push({ out02: { rawCount: 1, cascadeHit: { platform: "itandi", count: 5 } } });
  // 1 MISS run
  recs.push({ out02: { rawCount: 2, imageInsufficient: true } });
  // 22 normal runs (no cascade)
  for (let i = 0; i < 22; i++) recs.push({ out02: { rawCount: 8 } });

  const r = computeCascadeStats(recs);
  assert.strictEqual(r.cascade_attempted_runs, 2);
  assert.strictEqual(r.cascade_hit_runs, 1);
  assert.strictEqual(r.cascade_miss_runs, 1);
  assert.strictEqual(r.cascade_hit_rate, 0.5);
  assert.deepStrictEqual(r.platforms_seen, ["itandi"]);
});

check("Day1 baseline: image_insufficient count=1 rate=1/24 total_runs=24", () => {
  // Per T004: image_insufficient count=1, rate=0.0417, total_runs=24
  const recs = [];
  recs.push({ out02: { imageInsufficient: true, rawCount: 0 } });
  for (let i = 0; i < 23; i++) recs.push({ out02: { rawCount: 8 } });

  const r = computeImageInsufficientStats(recs);
  assert.strictEqual(r.count, 1);
  assert.strictEqual(r.total_runs, 24);
  assert.ok(Math.abs(r.rate - 1 / 24) < 1e-9, `rate should be ~0.0417, got ${r.rate}`);
  assert.deepStrictEqual(r.raw_count_distribution, { "0": 1 });
});

check("Day1 baseline: vision total=145 cat21=16 rate~0.1103 runs=17", () => {
  // Per T004: total_images_classified=145, category_21_count=16, vision_21_rate=0.1103,
  //           runs_with_classify_output=17
  // Construct: 17 runs, total 145 images (SH not counted), 16 cat21
  const recs = [];
  // Run 1: 16 cat-21 images
  const run1Images = [];
  for (let i = 0; i < 16; i++) run1Images.push({ categoryId: "21" });
  // Fill the rest: 145-16=129 non-21 images, across 17 runs
  for (let i = 0; i < 129; i++) run1Images.push({ categoryId: "01" });
  recs.push({ out03Classify: { processedImages: run1Images } });
  // Runs 2-17: empty processedImages (still count as runs_with_classify_output)
  for (let i = 1; i < 17; i++) {
    recs.push({ out03Classify: { processedImages: [] } });
  }

  const r = computeVision21Stats(recs);
  assert.strictEqual(r.total_images_classified, 145);
  assert.strictEqual(r.category_21_count, 16);
  assert.ok(Math.abs(r.vision_21_rate - 16 / 145) < 1e-9, `rate should be ~0.1103, got ${r.vision_21_rate}`);
  assert.strictEqual(r.runs_with_classify_output, 17);
});

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

console.log(`\nPassed: ${pass}  Failed: ${fail}  Total: ${pass + fail}`);
if (fail > 0) process.exit(1);
