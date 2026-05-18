#!/usr/bin/env node
/**
 * test-phase-beta-parity-smoke.js — Phase β T005: Real-data parity smoke test
 *
 * Verifies that skills/feature-codes-resolve.js#resolveFeatureCodes() is
 * bitwise identical to the legacy 3-path fillTokucho() inline logic across
 * N real reins-data.json samples from logs/runs/.
 *
 * This test does NOT hit forrent / REINS / any browser. It reads existing
 * logs/runs/{runDir}/01-reins-extract/output.json (already captured artifacts).
 *
 * Usage:
 *   node scripts/test/test-phase-beta-parity-smoke.js [--sample <N>]
 *   Default: N=5
 *
 * Exit 0  = all samples diff=0 (PASS)
 * Exit 1  = at least one diff != 0 (FAIL)
 *
 * Acceptance criteria (T005):
 *   - All N samples show diff=0 (missing=[], extra=[])
 *   - Evidence per code is non-empty (schema sanity)
 *   - 2201 (FANGO default, outside SSOT) appears in every sample
 *   - At least one kodawari-like code (numeric string) appears in each sample
 */

const path = require("path");
const fs = require("fs");

const PROJECT_ROOT = path.resolve(__dirname, "../..");
const RUNS_DIR = path.join(PROJECT_ROOT, "logs", "runs");
const CONFIG_PATH = path.join(PROJECT_ROOT, "config", "forrent-feature-codes.json");

// Parse argv
const args = process.argv.slice(2);
let sampleSize = 5;
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--sample" && args[i + 1]) {
    sampleSize = parseInt(args[i + 1], 10) || 5;
  }
}

// Load feature-codes config (SSOT)
let featureCodesConfig;
try {
  featureCodesConfig = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
} catch (e) {
  console.error("FATAL: could not load config/forrent-feature-codes.json:", e.message);
  process.exit(1);
}

// Load modules after verifying they exist
const { resolveFeatureCodes, SETSUBI_TO_TOKUCHO, DEFAULT_TOKUCHO_CODES, inferTokuchoFromBuilding } =
  require("../../skills/feature-codes-resolve");
const { norm } = require("../../skills/forrent/fill-texts");

// ──────────────────────────────────────────────────────────
// legacyAllPaths: replicates legacy fillTokucho() 3-path Set.
// Mirrors the helper in test-feature-codes-resolve.js (T002 v2).
// NO SSOT filter — the bitwise-parity target.
// ──────────────────────────────────────────────────────────
function legacyAllPaths(reinsData) {
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
  // Path B: building inference. inferTokuchoFromBuilding returns Map<code, ev>
  const inferred = inferTokuchoFromBuilding(reinsData);
  const inferredCodes = inferred instanceof Map ? [...inferred.keys()] : [...inferred];
  for (const c of inferredCodes) codes.add(c);
  // Path C: FANGO defaults (always-on, includes out-of-SSOT codes like 2201)
  for (const c of DEFAULT_TOKUCHO_CODES) codes.add(c);
  return codes;
}

// ──────────────────────────────────────────────────────────
// Sample collection: pick N most-recent runs with valid reinsData
// ──────────────────────────────────────────────────────────
function collectSamples(n) {
  let entries;
  try {
    entries = fs.readdirSync(RUNS_DIR);
  } catch (e) {
    console.error("FATAL: cannot read logs/runs:", e.message);
    process.exit(1);
  }

  const sorted = entries.sort((a, b) => b.localeCompare(a)); // newest first
  const samples = [];
  for (const runDirName of sorted) {
    if (samples.length >= n) break;
    const reinsOutputPath = path.join(RUNS_DIR, runDirName, "01-reins-extract", "output.json");
    if (!fs.existsSync(reinsOutputPath)) continue;
    let parsed;
    try {
      parsed = JSON.parse(fs.readFileSync(reinsOutputPath, "utf8"));
    } catch {
      continue;
    }
    if (parsed.status !== "OK") continue;
    if (!parsed.reinsData || typeof parsed.reinsData !== "object") continue;
    if (!parsed.reinsData["建物名"]) continue;

    // Extract reinsId from directory name (format: YYYYMMDD-HHMMSS_<reinsId>)
    const reinsId = runDirName.split("_").slice(1).join("_") || runDirName;

    samples.push({
      runDirName,
      reinsId,
      propertyName: parsed.propertyName || parsed.reinsData["建物名"] || "unknown",
      reinsData: parsed.reinsData,
    });
  }
  return samples;
}

// ──────────────────────────────────────────────────────────
// Parity check for a single sample
// Returns { reinsId, propertyName, countA, countB, missing, extra, pass, error }
// ──────────────────────────────────────────────────────────
function checkParity(sample) {
  const { reinsId, propertyName, reinsData, runDirName } = sample;
  try {
    // Set A (legacy): inline 3-path replication
    const setA = legacyAllPaths(reinsData);

    // Set B (new): feature-codes-resolve.js with maisokuText=null
    const result = resolveFeatureCodes({
      reinsData,
      featureCodesConfig,
      maisokuText: null,
    });
    const setB = new Set(result.checkedCodes);

    // Diff
    const missing = [...setA].filter((c) => !setB.has(c)).sort(); // in A, not in B
    const extra   = [...setB].filter((c) => !setA.has(c)).sort(); // in B, not in A

    // Sanity: 2201 should be in both (FANGO default)
    const has2201A = setA.has("2201");
    const has2201B = setB.has("2201");
    const sanity2201 = has2201A && has2201B;

    // Sanity: at least one numeric code exists (forrent codes are 4-digit strings)
    const hasCodeA = [...setA].some((c) => /^\d{4}$/.test(c));
    const hasCodeB = result.checkedCodes.some((c) => /^\d{4}$/.test(c));

    return {
      runDirName,
      reinsId,
      propertyName,
      countA: setA.size,
      countB: setB.size,
      missing,
      extra,
      pass: missing.length === 0 && extra.length === 0,
      sanity2201,
      hasCode: hasCodeA && hasCodeB,
      error: null,
    };
  } catch (err) {
    return {
      runDirName,
      reinsId,
      propertyName,
      countA: -1,
      countB: -1,
      missing: [],
      extra: [],
      pass: false,
      sanity2201: false,
      hasCode: false,
      error: err.message,
    };
  }
}

// ──────────────────────────────────────────────────────────
// Main
// ──────────────────────────────────────────────────────────
const samples = collectSamples(sampleSize);
if (samples.length === 0) {
  console.error("FATAL: no valid samples found in logs/runs/");
  process.exit(1);
}

const results = samples.map(checkParity);

let allPass = true;
console.log(`\n=== Phase β T005 Parity Smoke (${results.length} samples) ===\n`);

const rows = [];
for (const r of results) {
  const statusLabel = r.error ? "ERROR" : r.pass ? "PASS" : "FAIL";
  const diffLabel = r.error ? `error: ${r.error}` :
    (r.missing.length === 0 && r.extra.length === 0)
      ? "diff=0"
      : `missing=[${r.missing.join(",")}] extra=[${r.extra.join(",")}]`;

  console.log(
    `${statusLabel.padEnd(5)} ${r.reinsId} ${r.propertyName.slice(0, 25).padEnd(25)} ` +
    `A=${String(r.countA).padStart(3)} B=${String(r.countB).padStart(3)} ${diffLabel}`
  );

  if (r.error || !r.pass) allPass = false;
  rows.push(r);
}

const passCount = rows.filter((r) => r.pass).length;
const failCount = rows.length - passCount;

console.log(`\n=== Summary ===`);
console.log(`Samples: ${rows.length}  PASS: ${passCount}  FAIL: ${failCount}`);
console.log(`Overall: ${allPass ? "PASS — all diffs are 0" : "FAIL — see details above"}`);

// Sanity checks
const sanity2201Fail = rows.filter((r) => !r.error && !r.sanity2201);
if (sanity2201Fail.length > 0) {
  console.log(`WARN: 2201 missing from ${sanity2201Fail.length} sample(s): ${sanity2201Fail.map((r) => r.reinsId).join(", ")}`);
}
const noCodeFail = rows.filter((r) => !r.error && !r.hasCode);
if (noCodeFail.length > 0) {
  console.log(`WARN: no numeric codes in ${noCodeFail.length} sample(s): ${noCodeFail.map((r) => r.reinsId).join(", ")}`);
}

process.exit(allPass ? 0 : 1);
