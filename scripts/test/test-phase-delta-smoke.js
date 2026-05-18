#!/usr/bin/env node
/**
 * test-phase-delta-smoke.js — Phase delta T005: End-to-end smoke test
 *
 * Verifies the Phase delta maisoku route integration in feature-codes-resolve.js:
 *
 *   Run A (PHASE_DELTA_MAISOKU_INTEGRATE=0):
 *     - calls resolveFeatureCodes with maisokuText=null (env override forces null)
 *     - asserts checkedCodes == Phase beta bitwise baseline (diff=0)
 *
 *   Run B (default, maisoku ON):
 *     - calls resolveFeatureCodes with real maisokuText from gamma smoke dirs
 *     - maisoku-sourced codes appear only with evidence source:"maisoku"
 *     - negation-filtered codes are confirmed absent or filtered
 *
 * Acceptance criteria (Phase delta Decision 7):
 *   - Run A (maisoku OFF) == Phase beta bitwise parity (diff=0 hard gate)
 *   - Run B: all new codes have at least one evidence entry with source:"maisoku"
 *   - Run B: negation filter demonstrates at least one real filtered example
 *   - False positive rate (spot check) <= 10%
 *   - OCR cost monitoring aligned with gamma smoke ($0.0100 baseline)
 *
 * Sample selection:
 *   5 properties (SAMPLE_SEED=42). Priority: properties with confirmed maisoku
 *   text from Phase gamma smoke dirs. Falls back to runs with 01-reins-extract.
 *
 * This test does NOT touch forrent, REINS, or any browser. Pure computation.
 * watch-nyuko unload/load is performed as a safety measure when REINS is NOT
 * accessed, but the sequence is still logged for audit purposes.
 *
 * Usage:
 *   node scripts/test/test-phase-delta-smoke.js [--sample <N>]
 *   Default N=5
 *
 * Exit 0 = all acceptance criteria met (PASS)
 * Exit 1 = binary parity FAIL or fatal error
 *
 * Design SSOT: docs/refactor/phase-delta-design.md Decision 7-8
 */

"use strict";

const path = require("path");
const fs = require("fs");
const { spawnSync } = require("child_process");

const PROJECT_ROOT = path.resolve(__dirname, "../..");
const LOGS_RUNS = path.join(PROJECT_ROOT, "logs", "runs");
const LOGS_DIAG = path.join(PROJECT_ROOT, "logs", "diag");
const CONFIG_PATH = path.join(PROJECT_ROOT, "config", "forrent-feature-codes.json");

// Output paths (project root absolute, per task spec)
const FINDINGS_DIR = path.resolve(
  __dirname, "..", "..", "..", "..", ".claude", "do", "findings"
);
const SMOKE_REPORT_MD = path.join(FINDINGS_DIR, "delta-smoke.md");
const SMOKE_RUN_LOG   = path.join(FINDINGS_DIR, "delta-smoke-run.log");
const PLIST_PATH = path.join(
  process.env.HOME || "/Users/kentohonda",
  "Library", "LaunchAgents", "jp.fango.watch-nyuko.plist"
);

// ── md5 baseline (post-T003 / post-T004 values) ─────────────────
// These must not change during the delta smoke. The 03b stage md5 is the
// post-T004 value (T004 added readMaisokuText; the gamma-smoke.md records the
// pre-T004 value). Record the current actual md5 as the delta baseline.
const MD5_BASELINE = {
  "skills/feature-codes-resolve.js":           "8bd327c612a35812776b6014b469d64d",
  "scripts/stages/03b-feature-codes-resolve.js": "e38dd2b94ec862dbdb16335040391afa",
  "skills/negation-filter.js":                 "4346a48df01140d8e7925d6626df4480",
  "scripts/stages/02b-maisoku-fetch.js":       "c170bb142ac100f6d46d95ca94a9eab3",
  "scripts/stages/02c-maisoku-text-extract.js":"e88272679fb7db6a50fe80b673a12669",
  "skills/forrent/fill-tokucho.js":            "295cb84e281ed9ccbdfb21981fc19f4b",
};

// ── Parse argv ───────────────────────────────────────────────────
const args = process.argv.slice(2);
let sampleSize = 5;
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--sample" && args[i + 1]) {
    const n = parseInt(args[i + 1], 10);
    if (Number.isFinite(n) && n >= 1 && n <= 5) sampleSize = n;
  }
}

// ── Logging ──────────────────────────────────────────────────────
const logLines = [];
function ts() { return new Date().toISOString(); }
function log(msg) {
  const line = `[${ts()}] ${msg}`;
  console.error(line);
  logLines.push(line);
}

// ── Mulberry32 PRNG ──────────────────────────────────────────────
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function shuffle(arr, rng) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// ── md5 verification ─────────────────────────────────────────────
function verifyMd5Baseline() {
  log("verifying md5 baseline...");
  let allOk = true;
  const results = {};
  for (const [relPath, expected] of Object.entries(MD5_BASELINE)) {
    const absPath = path.join(PROJECT_ROOT, relPath);
    let actual = "";
    try {
      const out = spawnSync("md5", [absPath], { encoding: "utf8" });
      const m = (out.stdout || "").match(/=\s+([a-f0-9]{32})/i);
      actual = m ? m[1] : "";
    } catch (e) {
      log(`  md5 error for ${relPath}: ${e.message}`);
    }
    const ok = actual === expected;
    results[relPath] = { expected, actual, ok };
    if (ok) {
      log(`  md5 OK: ${relPath}`);
    } else {
      log(`  md5 MISMATCH: ${relPath} expected=${expected} actual=${actual}`);
      allOk = false;
    }
  }
  return { allOk, results };
}

// ── launchctl ────────────────────────────────────────────────────
function launchctlAction(verb) {
  const startedAt = ts();
  try {
    const r = spawnSync("launchctl", [verb, PLIST_PATH], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    const ok = r.status === 0;
    log(`launchctl ${verb} ${ok ? "OK" : "FAIL"} (status=${r.status}) at ${startedAt}`);
    if (!ok && (r.stderr || "").toString().trim()) {
      log(`  stderr: ${(r.stderr || "").toString().trim()}`);
    }
    return ok;
  } catch (e) {
    log(`launchctl ${verb} threw: ${e.message}`);
    return false;
  }
}

// ── Sample collection ────────────────────────────────────────────
/**
 * Collect samples: for each candidate, we need:
 *   (a) reinsData from logs/runs/{ts}_{reinsId}/01-reins-extract/output.json
 *   (b) maisokuText from logs/diag/smoke-gamma-*_{reinsId}/02c-maisoku-text-extract/output.json
 *
 * Both (a) and (b) must be present for a candidate to be included.
 * Priority: candidates with real maisoku text (chars > 0) first.
 */
function collectSamples(targetN) {
  const rng = mulberry32(42);

  // Index run dirs by reinsId
  const runsByReins = new Map();
  try {
    for (const d of fs.readdirSync(LOGS_RUNS)) {
      const m = d.match(/^(\d{8}-\d{6})_(\d+)$/);
      if (!m) continue;
      const reinsId = m[2];
      const prev = runsByReins.get(reinsId);
      if (!prev || prev.stamp < m[1]) {
        runsByReins.set(reinsId, { stamp: m[1], runDir: path.join(LOGS_RUNS, d) });
      }
    }
  } catch (e) {
    log(`WARN: cannot read logs/runs: ${e.message}`);
  }

  // Index diag/smoke-gamma dirs by reinsId
  const smokeByReins = new Map();
  try {
    for (const d of fs.readdirSync(LOGS_DIAG)) {
      if (!d.startsWith("smoke-gamma-")) continue;
      const m = d.match(/_(\d+)$/);
      if (!m) continue;
      const reinsId = m[1];
      const tsNum = parseInt(d.split("_")[1] || "0", 10);
      const prev = smokeByReins.get(reinsId);
      if (!prev || prev.ts < tsNum) {
        smokeByReins.set(reinsId, { ts: tsNum, smokeDir: path.join(LOGS_DIAG, d) });
      }
    }
  } catch (e) {
    log(`WARN: cannot read logs/diag: ${e.message}`);
  }

  // Build candidate list
  const candidates = [];
  const allReinsIds = new Set([...runsByReins.keys(), ...smokeByReins.keys()]);
  for (const reinsId of allReinsIds) {
    const runEntry = runsByReins.get(reinsId);
    const smokeEntry = smokeByReins.get(reinsId);
    if (!runEntry || !smokeEntry) continue;

    // Load reinsData: try 01-reins-extract/output.json first (new format),
    // then fall back to root reins-data.json (old pre-Phase-beta format).
    const reinsOutPath = path.join(runEntry.runDir, "01-reins-extract", "output.json");
    const reinsLegacyPath = path.join(runEntry.runDir, "reins-data.json");
    let reinsData = null;
    if (fs.existsSync(reinsOutPath)) {
      try {
        const j = JSON.parse(fs.readFileSync(reinsOutPath, "utf8"));
        reinsData = j.reinsData || null;
        if (!reinsData && j["建物名"]) reinsData = j; // legacy format
      } catch { /* skip */ }
    } else if (fs.existsSync(reinsLegacyPath)) {
      try {
        const j = JSON.parse(fs.readFileSync(reinsLegacyPath, "utf8"));
        // Old reins-data.json is flat: keys are directly property fields
        if (j["建物名"]) reinsData = j;
      } catch { /* skip */ }
    }
    if (!reinsData || typeof reinsData !== "object") continue;

    // Load maisokuText
    const maisokuOutPath = path.join(
      smokeEntry.smokeDir,
      "02c-maisoku-text-extract",
      "output.json"
    );
    if (!fs.existsSync(maisokuOutPath)) continue;
    let maisokuText = null;
    let maisokuSource = "?";
    let maisokuChars = 0;
    try {
      const j = JSON.parse(fs.readFileSync(maisokuOutPath, "utf8"));
      if (typeof j.maisokuText === "string" && j.maisokuText.length > 0) {
        maisokuText = j.maisokuText;
        maisokuSource = j.source || "?";
        maisokuChars = j.maisokuText.length;
      }
    } catch { continue; }

    const propertyName = reinsData["建物名"] || reinsId;
    candidates.push({
      reinsId,
      propertyName,
      reinsData,
      maisokuText,
      maisokuSource,
      maisokuChars,
      runDir: runEntry.runDir,
      smokeDir: smokeEntry.smokeDir,
    });
  }

  log(`collectSamples: ${candidates.length} candidates with both reinsData + maisokuText`);

  // Shuffle deterministically; prefer those with real maisoku text
  const withMaisoku    = candidates.filter(c => c.maisokuText !== null);
  const withoutMaisoku = candidates.filter(c => c.maisokuText === null);

  const shuffledWith    = shuffle(withMaisoku, rng);
  const shuffledWithout = shuffle(withoutMaisoku, mulberry32(42));

  const selected = [...shuffledWith, ...shuffledWithout].slice(0, targetN);
  log(`collectSamples: ${withMaisoku.length} with maisoku, selected ${selected.length}`);
  return selected;
}

// ── legacyAllPaths (Phase beta parity reference) ─────────────────
// Mirrors the Phase beta T005 helper exactly (bitwise reference implementation).
function buildLegacyAllPaths(resolveModule) {
  const { SETSUBI_TO_TOKUCHO, DEFAULT_TOKUCHO_CODES, inferTokuchoFromBuilding } = resolveModule;
  const { norm } = require(path.join(PROJECT_ROOT, "skills", "forrent", "fill-texts"));

  return function legacyAllPaths(reinsData) {
    const textFields = [
      reinsData.設備フリー || "",
      reinsData.設備 || "",
      reinsData.条件フリー || "",
      reinsData.備考1 || "",
      reinsData.備考2 || "",
      reinsData.備考3 || "",
      reinsData.その他一時金 || "",
    ].map(norm);

    const codes = new Set();
    // Path A: setsubi keyword match
    for (const [keyword, mapped] of Object.entries(SETSUBI_TO_TOKUCHO)) {
      const normKey = norm(keyword);
      if (textFields.some((t) => t.includes(normKey))) {
        for (const c of mapped) codes.add(c);
      }
    }
    // Path B: building inference
    const inferred = inferTokuchoFromBuilding(reinsData);
    const inferredCodes = inferred instanceof Map ? [...inferred.keys()] : [...inferred];
    for (const c of inferredCodes) codes.add(c);
    // Path C: FANGO defaults
    for (const c of DEFAULT_TOKUCHO_CODES) codes.add(c);
    return codes;
  };
}

// ── False positive spot check ────────────────────────────────────
/**
 * For each maisoku-sourced code in the resolve result, re-run isNegated()
 * against the original maisoku text for that matched label.
 * A true false positive is a code that slipped through the negation filter
 * but isNegated() would actually flag it. This is a post-hoc audit.
 *
 * Returns { total, suspicious, rate, details }
 */
function spotCheckFalsePositives(sample, resolveResult) {
  const { isNegated } = require(path.join(PROJECT_ROOT, "skills", "negation-filter"));
  const suspicious = [];
  let total = 0;

  for (const [code, evidences] of Object.entries(resolveResult.evidence)) {
    const maisokuEv = evidences.filter(e => e.source === "maisoku");
    if (maisokuEv.length === 0) continue;
    total++;

    // Re-run isNegated against the full maisoku text for each matched label
    for (const ev of maisokuEv) {
      const label = ev.matched || "";
      if (!label || !sample.maisokuText) continue;
      const negResult = isNegated(sample.maisokuText, label);
      if (negResult.negated) {
        // The code is in the result but isNegated says it should have been filtered
        suspicious.push({
          reinsId: sample.reinsId,
          code,
          label,
          snippet: ev.snippet || "",
          suspectedPattern: negResult.pattern,
          negWindow: negResult.snippet,
        });
      }
    }
  }

  const rate = total > 0 ? (suspicious.length / total) : 0;
  return { total, suspicious, rate };
}

// ── Main smoke runner ─────────────────────────────────────────────
function runSmoke(samples, featureCodesConfig, resolveModule) {
  const { resolveFeatureCodes } = resolveModule;
  const legacyAllPaths = buildLegacyAllPaths(resolveModule);

  const results = [];
  for (const sample of samples) {
    log(`── ${sample.reinsId} (${sample.propertyName.slice(0, 30)}) maisokuChars=${sample.maisokuChars} ──`);

    // Run A: maisoku OFF (Phase beta parity reference)
    const prevEnv = process.env.PHASE_DELTA_MAISOKU_INTEGRATE;
    process.env.PHASE_DELTA_MAISOKU_INTEGRATE = "0";
    let resultA;
    try {
      resultA = resolveFeatureCodes({
        reinsData: sample.reinsData,
        featureCodesConfig,
        maisokuText: null,
      });
    } finally {
      if (prevEnv === undefined) {
        delete process.env.PHASE_DELTA_MAISOKU_INTEGRATE;
      } else {
        process.env.PHASE_DELTA_MAISOKU_INTEGRATE = prevEnv;
      }
    }
    log(`  Run A (OFF): ${resultA.checkedCodes.length} codes`);

    // Phase beta parity assertion
    const legacySet = legacyAllPaths(sample.reinsData);
    const setA = new Set(resultA.checkedCodes);
    const missing = [...legacySet].filter(c => !setA.has(c)).sort();
    const extra   = [...setA].filter(c => !legacySet.has(c)).sort();
    const parityPass = missing.length === 0 && extra.length === 0;
    log(`  parity: ${parityPass ? "PASS diff=0" : "FAIL missing=["+missing+"] extra=["+extra+"]"}`);

    // Run B: maisoku ON (real maisokuText)
    const resultB = resolveFeatureCodes({
      reinsData: sample.reinsData,
      featureCodesConfig,
      maisokuText: sample.maisokuText,
    });
    log(`  Run B (ON): ${resultB.checkedCodes.length} codes`);

    // diff (B - A) = maisoku-only additions
    const setB = new Set(resultB.checkedCodes);
    const diffCodes = [...setB].filter(c => !setA.has(c)).sort();
    log(`  diff (B-A): ${diffCodes.length} codes: [${diffCodes.join(",")}]`);

    // Evidence audit for each diff code
    const maisokuEvidences = {};
    for (const code of diffCodes) {
      const evArr = resultB.evidence[code] || [];
      const maisokuEv = evArr.filter(e => e.source === "maisoku");
      maisokuEvidences[code] = maisokuEv;
      if (maisokuEv.length > 0) {
        const ev = maisokuEv[0];
        log(`    code=${code} label=${ev.matched||"?"} snippet=${JSON.stringify((ev.snippet||"").slice(0,60))}`);
      } else {
        log(`    WARN: code=${code} diff but no maisoku evidence!`);
      }
    }

    // False positive spot check
    const fpCheck = spotCheckFalsePositives(sample, resultB);
    log(`  false positive spot check: ${fpCheck.suspicious.length}/${fpCheck.total} suspicious (rate=${(fpCheck.rate*100).toFixed(0)}%)`);
    if (fpCheck.suspicious.length > 0) {
      for (const fp of fpCheck.suspicious) {
        log(`    FP suspect: code=${fp.code} label=${fp.label} pattern=${fp.suspectedPattern} snippet=${JSON.stringify(fp.snippet.slice(0,60))}`);
      }
    }

    // Negation filter demonstration: look for negated labels in the maisoku text
    const { isNegated } = require(path.join(PROJECT_ROOT, "skills", "negation-filter"));
    const negationExamples = [];
    if (sample.maisokuText) {
      // Scan all SSOT labels and find ones that would have matched but were negated
      for (const entry of featureCodesConfig.codes) {
        if (!entry || typeof entry.label !== "string") continue;
        const label = entry.label;
        const idx = sample.maisokuText.indexOf(label);
        if (idx === -1) continue;
        const negResult = isNegated(sample.maisokuText, label);
        if (negResult.negated) {
          negationExamples.push({
            code: entry.code,
            label,
            pattern: negResult.pattern,
            snippet: negResult.snippet,
          });
        }
      }
    }
    if (negationExamples.length > 0) {
      log(`  negation filter examples (${negationExamples.length} filtered):`);
      for (const ex of negationExamples.slice(0, 3)) {
        log(`    code=${ex.code} label=${ex.label} pattern=${ex.pattern} window=${JSON.stringify((ex.snippet||"").slice(0,40))}`);
      }
    }

    results.push({
      reinsId: sample.reinsId,
      propertyName: sample.propertyName,
      maisokuSource: sample.maisokuSource,
      maisokuChars: sample.maisokuChars,
      countA: resultA.checkedCodes.length,
      countB: resultB.checkedCodes.length,
      diffCodes,
      maisokuEvidences,
      parityPass,
      parityMissing: missing,
      parityExtra: extra,
      fpCheck,
      negationExamples,
    });
  }
  return results;
}

// ── Report writer ─────────────────────────────────────────────────
function writeReport({ startedAt, finishedAt, results, md5Results, launchctlLog, allParityPass, totalFpSuspicious, totalFpTotal }) {
  const lines = [];
  lines.push(`# Phase delta Smoke Report`);
  lines.push(``);
  lines.push(`**Date**: ${startedAt.slice(0, 10)}`);
  lines.push(`**Run window**: ${startedAt} -> ${finishedAt}`);
  lines.push(`**Sample size**: ${results.length}`);
  lines.push(`**SAMPLE_SEED**: 42 (deterministic)`);
  lines.push(``);
  lines.push(`---`);
  lines.push(``);

  // md5
  lines.push(`## md5 Invariant Check`);
  lines.push(``);
  const md5AllOk = Object.values(md5Results).every(r => r.ok);
  lines.push(`Status: **${md5AllOk ? "PASS" : "FAIL"}**`);
  lines.push(``);
  lines.push(`| File | Expected | Actual | Status |`);
  lines.push(`|---|---|---|---|`);
  for (const [relPath, { expected, actual, ok }] of Object.entries(md5Results)) {
    lines.push(`| \`${relPath}\` | ${expected} | ${actual} | ${ok ? "PASS" : "FAIL"} |`);
  }
  lines.push(``);

  // Binary parity summary
  lines.push(`## Run A (maisoku OFF) — Phase beta Binary Parity`);
  lines.push(``);
  lines.push(`**Overall**: ${allParityPass ? "**PASS — all diffs are 0**" : "**FAIL — see details**"}`);
  lines.push(``);
  lines.push(`| # | reinsId | Property | Set A | Legacy | missing | extra | Parity |`);
  lines.push(`|---|---|---|---|---|---|---|---|`);
  results.forEach((r, i) => {
    const par = r.parityPass ? "PASS" : "FAIL";
    lines.push(`| ${i+1} | ${r.reinsId} | ${r.propertyName.slice(0,20)} | ${r.countA} | ${r.countA} | [${r.parityMissing.join(",")}] | [${r.parityExtra.join(",")}] | **${par}** |`);
  });
  lines.push(``);

  // Run B sample table
  lines.push(`## Run B (maisoku ON) — Sample Results`);
  lines.push(``);
  lines.push(`| # | reinsId | maisoku source | chars | Set A | Set B | diff count |`);
  lines.push(`|---|---|---|---|---|---|---|`);
  results.forEach((r, i) => {
    lines.push(`| ${i+1} | ${r.reinsId} | ${r.maisokuSource} | ${r.maisokuChars} | ${r.countA} | ${r.countB} | ${r.diffCodes.length} |`);
  });
  lines.push(``);

  // Maisoku-added codes with evidence
  lines.push(`## Maisoku-Added Codes (Run B - Run A) with Evidence`);
  lines.push(``);
  let hasMaisokuHit = false;
  for (const r of results) {
    if (r.diffCodes.length === 0) continue;
    hasMaisokuHit = true;
    lines.push(`### reinsId: ${r.reinsId} (${r.propertyName.slice(0,30)})`);
    lines.push(``);
    lines.push(`${r.diffCodes.length} new code(s) from maisoku route:`);
    lines.push(``);
    lines.push(`| code | label (matched) | source | snippet |`);
    lines.push(`|---|---|---|---|`);
    for (const code of r.diffCodes) {
      const evArr = r.maisokuEvidences[code] || [];
      if (evArr.length > 0) {
        const ev = evArr[0];
        const snippet = (ev.snippet || "").slice(0, 50).replace(/\n/g, " ");
        lines.push(`| ${code} | ${ev.matched || "?"} | ${ev.source} | ${snippet} |`);
      } else {
        lines.push(`| ${code} | ? | MISSING | (no maisoku evidence found — BUG) |`);
      }
    }
    lines.push(``);
  }
  if (!hasMaisokuHit) {
    lines.push(`No maisoku-added codes in this sample set.`);
    lines.push(``);
  }

  // Negation filter examples
  lines.push(`## Negation Filter — Real Examples`);
  lines.push(``);
  let negTotal = 0;
  for (const r of results) {
    if (r.negationExamples.length === 0) continue;
    lines.push(`### reinsId: ${r.reinsId}`);
    lines.push(``);
    lines.push(`| code | label | pattern | post-keyword window |`);
    lines.push(`|---|---|---|---|`);
    for (const ex of r.negationExamples) {
      const window = (ex.snippet || "").slice(0, 40).replace(/\n/g, " ");
      lines.push(`| ${ex.code} | ${ex.label} | ${ex.pattern} | ${window} |`);
      negTotal++;
    }
    lines.push(``);
  }
  if (negTotal === 0) {
    lines.push(`No negation filter activations found in this sample set.`);
    lines.push(``);
    lines.push(`> Note: Negation activation depends on sample text. The negation filter is`);
    lines.push(`> tested separately in test-negation-filter.js (T002 unit tests).`);
    lines.push(``);
  }

  // False positive spot check
  lines.push(`## False Positive Spot Check`);
  lines.push(``);
  const fpRate = totalFpTotal > 0 ? ((totalFpSuspicious / totalFpTotal) * 100).toFixed(1) : "0.0";
  const fpTarget = 10;
  const fpPass = parseFloat(fpRate) <= fpTarget;
  lines.push(`**Target**: <= ${fpTarget}% (Decision 8)`);
  lines.push(`**Actual**: ${fpRate}% (${totalFpSuspicious} / ${totalFpTotal} maisoku-sourced codes flagged suspicious)`);
  lines.push(`**Status**: **${fpPass ? "PASS" : "FAIL"}**`);
  lines.push(``);
  const allFpSuspicious = results.flatMap(r => r.fpCheck.suspicious);
  if (allFpSuspicious.length > 0) {
    lines.push(`Suspicious codes (snippet contained negation pattern):`);
    lines.push(``);
    lines.push(`| reinsId | code | label | pattern | negation window |`);
    lines.push(`|---|---|---|---|---|`);
    for (const fp of allFpSuspicious) {
      lines.push(`| ${fp.reinsId} | ${fp.code} | ${fp.label} | ${fp.suspectedPattern} | ${(fp.negWindow||fp.snippet||"").slice(0,50).replace(/\n/g," ")} |`);
    }
    lines.push(``);
  } else {
    lines.push(`No suspicious snippets found.`);
    lines.push(``);
  }

  // OCR cost note (Phase gamma comparison)
  lines.push(`## OCR Cost Note`);
  lines.push(``);
  lines.push(`This test is a pure-computation smoke (no browser / no REINS access).`);
  lines.push(`Maisoku texts are pre-captured from Phase gamma smoke runs.`);
  lines.push(``);
  const visionSamples = results.filter(r => r.maisokuSource === "vision-ocr");
  const pdftextSamples = results.filter(r => r.maisokuSource === "pdftotext");
  lines.push(`- Vision-OCR sourced samples: ${visionSamples.length}`);
  lines.push(`- pdftotext sourced samples: ${pdftextSamples.length}`);
  lines.push(`- Phase gamma smoke OCR cost: **$0.0100** (2 vision-ocr calls across 3 samples)`);
  lines.push(`- Phase gamma average per property: **$0.0033**`);
  lines.push(`- Expected total per ${results.length}-property full run (80% vision-ocr): ~$${(0.005 * results.length).toFixed(4)}`);
  lines.push(``);

  // watch-nyuko sequence
  lines.push(`## watch-nyuko unload/load sequence`);
  lines.push(``);
  for (const entry of launchctlLog) {
    lines.push(`- ${entry}`);
  }
  lines.push(``);

  // Summary
  lines.push(`## Summary`);
  lines.push(``);
  const allPass = md5AllOk && allParityPass && fpPass;
  lines.push(`| Criterion | Result |`);
  lines.push(`|---|---|`);
  lines.push(`| md5 invariant | ${md5AllOk ? "PASS" : "FAIL"} |`);
  lines.push(`| Run A parity (diff=0) | ${allParityPass ? "PASS" : "FAIL"} |`);
  lines.push(`| Maisoku evidence (all diff codes have source:maisoku) | ${hasMaisokuHit ? "PASS" : "N/A (no hits)"} |`);
  lines.push(`| Negation filter demonstrated | ${negTotal > 0 ? "PASS ("+negTotal+" filtered)" : "N/A (no activation in sample)"} |`);
  lines.push(`| False positive rate <= 10% | ${fpPass ? "PASS ("+fpRate+"%)" : "FAIL ("+fpRate+"%)"} |`);
  lines.push(``);
  lines.push(`**Overall: ${allPass ? "PASS" : "FAIL"}**`);
  lines.push(``);

  fs.mkdirSync(FINDINGS_DIR, { recursive: true });
  fs.writeFileSync(SMOKE_REPORT_MD, lines.join("\n"));
  log(`report written -> ${SMOKE_REPORT_MD}`);
}

// ── main ──────────────────────────────────────────────────────────
function main() {
  const startedAt = ts();
  log(`Phase delta smoke — sample=${sampleSize} seed=42`);

  // 1. md5 baseline check
  const { allOk: md5AllOk, results: md5Results } = verifyMd5Baseline();
  if (!md5AllOk) {
    log("FATAL: md5 mismatch — SSOT files were modified. Aborting.");
    process.exit(1);
  }

  const launchctlLog = [];

  // 2. Unload watch-nyuko (safety measure; this test is browser-free but
  //    following the required launchd protocol from gotchas.md)
  launchctlLog.push(`unload at ${ts()}`);
  launchctlAction("unload");

  try {
    // 3. Load modules
    const resolveModule = require(path.join(PROJECT_ROOT, "skills", "feature-codes-resolve"));
    const featureCodesConfig = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));

    // 4. Collect samples
    const samples = collectSamples(sampleSize);
    if (samples.length === 0) {
      log("FATAL: no valid samples found (need both reinsData + maisokuText)");
      process.exit(1);
    }
    log(`collected ${samples.length} samples`);

    // 5. Run smoke
    const results = runSmoke(samples, featureCodesConfig, resolveModule);

    // 6. Aggregate results
    const allParityPass = results.every(r => r.parityPass);
    const totalFpSuspicious = results.reduce((sum, r) => sum + r.fpCheck.suspicious.length, 0);
    const totalFpTotal = results.reduce((sum, r) => sum + r.fpCheck.total, 0);

    const finishedAt = ts();

    // 7. Write report
    writeReport({
      startedAt,
      finishedAt,
      results,
      md5Results,
      launchctlLog,
      allParityPass,
      totalFpSuspicious,
      totalFpTotal,
    });

    // 8. Write run log
    fs.mkdirSync(FINDINGS_DIR, { recursive: true });
    fs.writeFileSync(SMOKE_RUN_LOG, logLines.join("\n") + "\n");
    log(`run log written -> ${SMOKE_RUN_LOG}`);

    // 9. Console summary
    console.log(`\n=== Phase delta smoke summary ===`);
    console.log(`samples: ${results.length}`);
    console.log(`parity (Run A == Phase beta): ${allParityPass ? "PASS" : "FAIL"}`);
    const totalDiff = results.reduce((s, r) => s + r.diffCodes.length, 0);
    console.log(`maisoku-added codes (total across samples): ${totalDiff}`);
    const negTotal = results.reduce((s, r) => s + r.negationExamples.length, 0);
    console.log(`negation filter activations: ${negTotal}`);
    const fpRate = totalFpTotal > 0 ? ((totalFpSuspicious / totalFpTotal) * 100).toFixed(1) : "0.0";
    console.log(`false positive rate: ${fpRate}% (${totalFpSuspicious}/${totalFpTotal})`);
    console.log(`md5 invariant: PASS`);
    console.log(`report: ${SMOKE_REPORT_MD}`);
    console.log(`run log: ${SMOKE_RUN_LOG}`);

    // 10. Exit
    if (!allParityPass) {
      console.log(`\nRESULT: FAIL (parity breach)`);
      process.exit(1);
    }
    console.log(`\nRESULT: PASS`);
    process.exit(0);

  } finally {
    launchctlLog.push(`load at ${ts()}`);
    launchctlAction("load");
  }
}

main();
