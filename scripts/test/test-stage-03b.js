#!/usr/bin/env node
/**
 * test-stage-03b.js — Phase β T003 + Phase δ T004 stage contract test
 *
 * Verifies that scripts/stages/03b-feature-codes-resolve.js:
 *   (1) returns a ResolveFeatureCodesResult with the documented schema
 *       (checkedCodes / evidence / generated_at / source_files)
 *   (2) emits the documented logStep events (start + done) with the expected
 *       payload shape
 *   (3) persists input.json and output.json under {runDir}/{STAGE}/
 *   (4) is robust to a missing runDir (artifact writes are best-effort)
 *   (5) propagates the maisokuText argument to resolveFeatureCodes (Phase β
 *       contract: null is accepted; non-empty string is also accepted but the
 *       resolver itself remains a no-op for the maisoku path until Phase γ-δ)
 *   (6) the env switch PHASE_BETA_03B is *orchestrator-level* (we document
 *       that the stage itself does NOT consult it; that lives in
 *       batch-nyuko.js#processProperty)
 *   (7) Phase δ T004: 03b reads 02c-maisoku-text-extract/output.json when
 *       the caller does NOT pass maisokuText explicitly, and pipes the
 *       extracted text into resolveFeatureCodes (so the maisoku evidence
 *       route in skills/feature-codes-resolve.js can fire). PHASE_DELTA_
 *       MAISOKU_INTEGRATE=0 reverts to Phase β no-op (instant rollback).
 *
 * The 03b stage is pure (no browser / no network), so this test runs the
 * stage end-to-end with real I/O against a tmp directory.
 */

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { runFeatureCodesResolve } = require("../stages/03b-feature-codes-resolve");

let pass = 0;
let fail = 0;
function check(label, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => {
      console.log(`ok ${label}`);
      pass++;
    })
    .catch((e) => {
      console.error(`FAIL ${label}: ${e.message}`);
      fail++;
    });
}

function mkTmpRunDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "fango-stage03b-"));
}

function mkLogStep() {
  const events = [];
  const fn = (name, extra = {}) => {
    events.push({ name, extra });
  };
  fn.events = events;
  return fn;
}

// Minimal but realistic reinsData. Mirrors the shape consumed by the resolver
// (legacy 3-path Set) and exercises building inference + setsubi keyword paths.
function fixtureReinsData() {
  return {
    建物名: "テスト中野マンション",
    部屋番号: "202",
    設備フリー: "オートロック、宅配ボックス、エアコン、フローリング、バルコニー",
    設備: "システムキッチン、追い焚き、温水洗浄便座",
    条件フリー: "",
    備考1: "",
    備考2: "",
    備考3: "",
    その他一時金: "",
    地上階層: "5",
    交通: [
      { 沿線: "山手線", 駅: "新宿", 徒歩: "5" },
      { 沿線: "中央線", 駅: "新宿", 徒歩: "8" },
    ],
    バルコニー方向: "南",
    敷金: "1ヶ月",
    礼金: "なし",
    入居時期: "即",
    築年月: `${new Date().getFullYear() - 1}年6月`,
    駐車場在否: "有",
  };
}

(async function main() {
  // ──────────────────────────────────────────────────────────
  // (1) Schema: checkedCodes / evidence / generated_at / source_files
  // ──────────────────────────────────────────────────────────
  await check("schema: returns ResolveFeatureCodesResult with all 4 fields", async () => {
    const runDir = mkTmpRunDir();
    const logStep = mkLogStep();
    const out = await runFeatureCodesResolve({
      reinsData: fixtureReinsData(),
      maisokuText: null,
      logStep,
      runDir,
    });
    assert.ok(Array.isArray(out.checkedCodes), "checkedCodes must be array");
    assert.strictEqual(typeof out.evidence, "object", "evidence must be object");
    assert.match(out.generated_at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/, "generated_at must be ISO 8601");
    assert.ok(Array.isArray(out.source_files), "source_files must be array");
    assert.ok(out.checkedCodes.length > 0, "checkedCodes should be non-empty for a realistic fixture");
  });

  // ──────────────────────────────────────────────────────────
  // (2) logStep events: start + done with expected payload
  // ──────────────────────────────────────────────────────────
  await check("logStep: emits feature_codes_resolve_start and _done in order", async () => {
    const runDir = mkTmpRunDir();
    const logStep = mkLogStep();
    await runFeatureCodesResolve({
      reinsData: fixtureReinsData(),
      maisokuText: null,
      logStep,
      runDir,
    });
    const names = logStep.events.map((e) => e.name);
    assert.deepStrictEqual(
      names,
      ["feature_codes_resolve_start", "feature_codes_resolve_done"],
      `logStep order mismatch: ${JSON.stringify(names)}`
    );
    const done = logStep.events[1];
    assert.strictEqual(typeof done.extra.checkedCount, "number", "done.checkedCount must be number");
    assert.ok(done.extra.checkedCount > 0, "checkedCount should be > 0");
    assert.strictEqual(typeof done.extra.evidenceCodes, "number", "done.evidenceCodes must be number");
  });

  await check("logStep: start carries hasMaisokuText flag (false when null)", async () => {
    const runDir = mkTmpRunDir();
    const logStep = mkLogStep();
    await runFeatureCodesResolve({
      reinsData: fixtureReinsData(),
      maisokuText: null,
      logStep,
      runDir,
    });
    const start = logStep.events.find((e) => e.name === "feature_codes_resolve_start");
    assert.strictEqual(start.extra.hasMaisokuText, false);
  });

  await check("logStep: start hasMaisokuText is true for a non-empty string", async () => {
    const runDir = mkTmpRunDir();
    const logStep = mkLogStep();
    await runFeatureCodesResolve({
      reinsData: fixtureReinsData(),
      maisokuText: "オートロック ペット可",
      logStep,
      runDir,
    });
    const start = logStep.events.find((e) => e.name === "feature_codes_resolve_start");
    assert.strictEqual(start.extra.hasMaisokuText, true);
  });

  // ──────────────────────────────────────────────────────────
  // (3) Artifact persistence under {runDir}/{STAGE}/
  // ──────────────────────────────────────────────────────────
  await check("artifact: writes input.json and output.json under runDir", async () => {
    const runDir = mkTmpRunDir();
    const logStep = mkLogStep();
    await runFeatureCodesResolve({
      reinsData: fixtureReinsData(),
      maisokuText: null,
      logStep,
      runDir,
    });
    const stageDir = path.join(runDir, "03b-feature-codes-resolve");
    assert.ok(fs.existsSync(path.join(stageDir, "input.json")), "input.json missing");
    assert.ok(fs.existsSync(path.join(stageDir, "output.json")), "output.json missing");
    const input = JSON.parse(fs.readFileSync(path.join(stageDir, "input.json"), "utf8"));
    assert.strictEqual(input.hasMaisokuText, false);
    assert.ok(input.reinsData, "input.reinsData must be present");
    const output = JSON.parse(fs.readFileSync(path.join(stageDir, "output.json"), "utf8"));
    assert.ok(Array.isArray(output.checkedCodes), "output.checkedCodes must be array");
    assert.strictEqual(typeof output.evidence, "object", "output.evidence must be object");
  });

  // ──────────────────────────────────────────────────────────
  // (4) Robust to missing runDir
  // ──────────────────────────────────────────────────────────
  await check("artifact: runDir=undefined does not throw (artifact writes are no-op)", async () => {
    const logStep = mkLogStep();
    const out = await runFeatureCodesResolve({
      reinsData: fixtureReinsData(),
      maisokuText: null,
      logStep,
      runDir: undefined,
    });
    assert.ok(Array.isArray(out.checkedCodes), "checkedCodes must still be returned");
  });

  // ──────────────────────────────────────────────────────────
  // (5) maisokuText propagation
  // ──────────────────────────────────────────────────────────
  await check("maisoku: maisokuText=null is the Phase β default and accepted without error", async () => {
    const out = await runFeatureCodesResolve({
      reinsData: fixtureReinsData(),
      maisokuText: null,
      logStep: () => {},
    });
    // Phase β contract: no source:'maisoku' evidence should be emitted.
    for (const entries of Object.values(out.evidence)) {
      for (const ent of entries) {
        assert.notStrictEqual(ent.source, "maisoku", "Phase β must not emit maisoku evidence");
      }
    }
  });

  await check("maisoku: omitted maisokuText also works (defaults to null)", async () => {
    const out = await runFeatureCodesResolve({
      reinsData: fixtureReinsData(),
      logStep: () => {},
    });
    assert.ok(Array.isArray(out.checkedCodes));
  });

  // ──────────────────────────────────────────────────────────
  // (6) Determinism: same input → same checkedCodes (generated_at varies)
  // ──────────────────────────────────────────────────────────
  await check("determinism: identical reinsData yields identical checkedCodes across runs", async () => {
    const reinsData = fixtureReinsData();
    const a = await runFeatureCodesResolve({ reinsData, maisokuText: null, logStep: () => {} });
    const b = await runFeatureCodesResolve({ reinsData, maisokuText: null, logStep: () => {} });
    assert.deepStrictEqual(a.checkedCodes, b.checkedCodes);
  });

  // ──────────────────────────────────────────────────────────
  // (7) Documented env switch is orchestrator-level (this test pins the contract)
  //
  // The stage itself must NOT read process.env.PHASE_BETA_03B. The skip switch
  // lives in batch-nyuko.js#processProperty so that "PHASE_BETA_03B=0" means
  // "do not call runFeatureCodesResolve at all" — not "call it but no-op",
  // which would silently still consume CPU and emit logStep events.
  // ──────────────────────────────────────────────────────────
  await check("env contract: stage runs regardless of PHASE_BETA_03B=0 (skip is orchestrator-level)", async () => {
    const saved = process.env.PHASE_BETA_03B;
    process.env.PHASE_BETA_03B = "0";
    try {
      const logStep = mkLogStep();
      const out = await runFeatureCodesResolve({
        reinsData: fixtureReinsData(),
        maisokuText: null,
        logStep,
        runDir: mkTmpRunDir(),
      });
      // The stage must still execute end-to-end. The skip decision lives in
      // the orchestrator, not here. logStep events MUST still fire.
      assert.ok(Array.isArray(out.checkedCodes), "stage must still execute");
      assert.strictEqual(logStep.events.length, 2, "logStep events must still fire");
    } finally {
      if (saved === undefined) delete process.env.PHASE_BETA_03B;
      else process.env.PHASE_BETA_03B = saved;
    }
  });

  // ──────────────────────────────────────────────────────────
  // (8) Phase δ T004: 02c integration — runDir-scoped reading
  //
  // The stage now reads 02c-maisoku-text-extract/output.json from runDir
  // when the caller does not pass maisokuText explicitly. The resolver
  // (skills/feature-codes-resolve.js) only emits maisoku evidence when
  // maisokuText is a non-empty string; presence of source:"maisoku"
  // entries proves the wiring works end-to-end.
  // ──────────────────────────────────────────────────────────

  // Helper: seed an 02c output.json under runDir for the new tests.
  function seedMaisoku02cOutput(runDir, body) {
    const dir = path.join(runDir, "02c-maisoku-text-extract");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "output.json"), JSON.stringify(body));
  }

  // Maisoku text containing at least one 150-SSOT label so that the
  // resolver will emit a source:"maisoku" evidence entry. Choosing
  // "オートロック" (code 1101) — a common, multi-character label that
  // does NOT match any setsubi-keyword from the fixture's 設備フリー
  // ALONE (i.e. its existence in fixtureReinsData is irrelevant for
  // the maisoku route's *existence proof*; we only need ≥1 maisoku
  // evidence entry to appear).
  const maisokuWithLabel =
    "中野マンション 202 オートロック完備 駅徒歩5分 礼金なし バルコニー南向き";

  await check("phase δ T004: 02c output with source=pdftotext is read and piped to resolver", async () => {
    const runDir = mkTmpRunDir();
    seedMaisoku02cOutput(runDir, {
      maisokuText: maisokuWithLabel,
      charsExtracted: maisokuWithLabel.length,
      source: "pdftotext",
      visionUsed: false,
      visionCostUSD: 0,
      generated_at: new Date().toISOString(),
    });
    const logStep = mkLogStep();
    const out = await runFeatureCodesResolve({
      reinsData: fixtureReinsData(),
      // caller passes nothing → 02c read should kick in
      logStep,
      runDir,
    });

    // (a) start event records the source & chars
    const start = logStep.events.find((e) => e.name === "feature_codes_resolve_start");
    assert.strictEqual(start.extra.hasMaisokuText, true, "start.hasMaisokuText must be true");
    assert.strictEqual(start.extra.maisokuStatus, "loaded");
    assert.strictEqual(start.extra.maisokuSource, "pdftotext");
    assert.strictEqual(start.extra.maisokuChars, maisokuWithLabel.length);

    // (b) input.json persisted reflects the resolution
    const input = JSON.parse(
      fs.readFileSync(path.join(runDir, "03b-feature-codes-resolve", "input.json"), "utf8")
    );
    assert.strictEqual(input.hasMaisokuText, true);
    assert.strictEqual(input.maisokuSource, "pdftotext");

    // (c) at least one evidence entry sourced from maisoku is present
    let foundMaisokuEvidence = false;
    for (const entries of Object.values(out.evidence)) {
      for (const ent of entries) {
        if (ent.source === "maisoku") {
          foundMaisokuEvidence = true;
          break;
        }
      }
      if (foundMaisokuEvidence) break;
    }
    assert.ok(
      foundMaisokuEvidence,
      "expected at least one source:'maisoku' evidence entry when 02c output is wired"
    );
  });

  await check("phase δ T004: 02c output with source=vision-ocr is also accepted", async () => {
    const runDir = mkTmpRunDir();
    seedMaisoku02cOutput(runDir, {
      maisokuText: maisokuWithLabel,
      charsExtracted: maisokuWithLabel.length,
      source: "vision-ocr",
      visionUsed: true,
      visionCostUSD: 0.005,
      generated_at: new Date().toISOString(),
    });
    const logStep = mkLogStep();
    await runFeatureCodesResolve({
      reinsData: fixtureReinsData(),
      logStep,
      runDir,
    });
    const start = logStep.events.find((e) => e.name === "feature_codes_resolve_start");
    assert.strictEqual(start.extra.maisokuStatus, "loaded");
    assert.strictEqual(start.extra.maisokuSource, "vision-ocr");
    assert.ok(start.extra.maisokuChars > 0);
  });

  await check("phase δ T004: 02c output absent → maisokuText:null, no maisoku evidence", async () => {
    const runDir = mkTmpRunDir(); // empty — no 02c/output.json
    const logStep = mkLogStep();
    const out = await runFeatureCodesResolve({
      reinsData: fixtureReinsData(),
      logStep,
      runDir,
    });
    const start = logStep.events.find((e) => e.name === "feature_codes_resolve_start");
    assert.strictEqual(start.extra.hasMaisokuText, false);
    assert.strictEqual(start.extra.maisokuStatus, "skipped:02c_absent");

    // Phase β parity: no maisoku evidence even though the resolver would have
    // tried to read 02c — it's a graceful pass-through.
    for (const entries of Object.values(out.evidence)) {
      for (const ent of entries) {
        assert.notStrictEqual(ent.source, "maisoku");
      }
    }
  });

  await check("phase δ T004: 02c output source=error → maisokuText:null (graceful)", async () => {
    const runDir = mkTmpRunDir();
    seedMaisoku02cOutput(runDir, {
      maisokuText: "",
      charsExtracted: 0,
      source: "error",
      visionUsed: false,
      visionCostUSD: 0,
      error: "pdftoppm exited with code 1",
      generated_at: new Date().toISOString(),
    });
    const logStep = mkLogStep();
    const out = await runFeatureCodesResolve({
      reinsData: fixtureReinsData(),
      logStep,
      runDir,
    });
    const start = logStep.events.find((e) => e.name === "feature_codes_resolve_start");
    assert.strictEqual(start.extra.hasMaisokuText, false);
    assert.strictEqual(start.extra.maisokuStatus, "skipped:02c_error");
    // No maisoku evidence
    for (const entries of Object.values(out.evidence)) {
      for (const ent of entries) {
        assert.notStrictEqual(ent.source, "maisoku");
      }
    }
  });

  await check("phase δ T004: PHASE_DELTA_MAISOKU_INTEGRATE=0 forces rollback even when 02c present", async () => {
    const runDir = mkTmpRunDir();
    seedMaisoku02cOutput(runDir, {
      maisokuText: maisokuWithLabel,
      charsExtracted: maisokuWithLabel.length,
      source: "pdftotext",
      visionUsed: false,
      visionCostUSD: 0,
      generated_at: new Date().toISOString(),
    });
    const saved = process.env.PHASE_DELTA_MAISOKU_INTEGRATE;
    process.env.PHASE_DELTA_MAISOKU_INTEGRATE = "0";
    try {
      const logStep = mkLogStep();
      const out = await runFeatureCodesResolve({
        reinsData: fixtureReinsData(),
        logStep,
        runDir,
      });
      const start = logStep.events.find((e) => e.name === "feature_codes_resolve_start");
      assert.strictEqual(start.extra.hasMaisokuText, false, "env=0 must skip 02c read");
      assert.strictEqual(start.extra.maisokuStatus, "disabled_by_env");
      assert.strictEqual(start.extra.maisokuSource, null);
      // No maisoku evidence even though 02c output exists with usable text
      for (const entries of Object.values(out.evidence)) {
        for (const ent of entries) {
          assert.notStrictEqual(
            ent.source,
            "maisoku",
            "env=0 must yield Phase β parity (no maisoku evidence)"
          );
        }
      }
    } finally {
      if (saved === undefined) delete process.env.PHASE_DELTA_MAISOKU_INTEGRATE;
      else process.env.PHASE_DELTA_MAISOKU_INTEGRATE = saved;
    }
  });

  await check("phase δ T004: explicit caller arg trumps 02c read (test seam preserved)", async () => {
    const runDir = mkTmpRunDir();
    seedMaisoku02cOutput(runDir, {
      maisokuText: "完全に違うテキスト",
      charsExtracted: 9,
      source: "pdftotext",
      visionUsed: false,
      visionCostUSD: 0,
      generated_at: new Date().toISOString(),
    });
    const logStep = mkLogStep();
    await runFeatureCodesResolve({
      reinsData: fixtureReinsData(),
      maisokuText: "caller-provided オートロック",
      logStep,
      runDir,
    });
    const start = logStep.events.find((e) => e.name === "feature_codes_resolve_start");
    assert.strictEqual(start.extra.maisokuStatus, "caller");
    assert.strictEqual(start.extra.maisokuSource, "caller");
    assert.strictEqual(start.extra.maisokuChars, "caller-provided オートロック".length);
  });

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
})();
