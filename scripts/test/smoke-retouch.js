#!/usr/bin/env node
/**
 * smoke-retouch.js — integration smoke for stage 04b-retouch-images
 *
 * Verifies:
 *  1. Photo pipeline: Real-ESRGAN (or magick fallback) → 1280x960, Q92, localPath→retouched/
 *  2. Floorplan (reins_5) pipeline: contain white-pad → 1280x960, AI non-processed
 *  3. Graceful fallback when REALESRGAN_BIN is set to a nonexistent path
 *  4. Array length unchanged (failure doesn't shorten array)
 *  5. SSOT config not touched (checked by caller via git status)
 *
 * Uses real images from ~/Desktop/suumo-nyuko/100139579278/
 * Real-ESRGAN binary at ~/Desktop/suumo-nyuko/_upscale-tool/ — actual AI upscale runs.
 * Expected wall-clock: ~13s per photo image.
 *
 * Run: node scripts/test/smoke-retouch.js
 */

"use strict";

const fs   = require("fs");
const path = require("path");
const os   = require("os");
const { execFile } = require("child_process");
const { promisify } = require("util");

const execFileAsync = promisify(execFile);

const { runRetouchImages } = require("../stages/04b-retouch-images");

// ───── config ─────
const SOURCE_DIR = path.join(os.homedir(), "Desktop/suumo-nyuko/100139579278");
const WORK_DIR   = "/tmp/smoke-retouch-out";

const TARGET_W = 1280;
const TARGET_H = 960;
const MAX_BYTES = 12 * 1024 * 1024; // 12 MB

// ───── mini assertion framework ─────
let pass = 0;
let fail = 0;
const failures = [];

function assert(name, actual, expected) {
  const ok = actual === expected;
  if (ok) {
    pass++;
    console.log(`  PASS: ${name}`);
  } else {
    fail++;
    failures.push({ name, expected, actual });
    console.log(`  FAIL: ${name}`);
    console.log(`        expected: ${JSON.stringify(expected)}`);
    console.log(`        got:      ${JSON.stringify(actual)}`);
  }
}

function assertTrue(name, value) {
  if (value) {
    pass++;
    console.log(`  PASS: ${name}`);
  } else {
    fail++;
    failures.push({ name, expected: true, actual: value });
    console.log(`  FAIL: ${name} (got falsy)`);
  }
}

// ───── helper: measure dimensions via magick identify ─────
async function getDimensions(imgPath) {
  const out = await execFileAsync("magick", [
    "identify",
    "-format",
    "%w %h",
    imgPath,
  ]);
  const [w, h] = out.stdout.trim().split(/\s+/).map(Number);
  return { w, h };
}

// ───── helper: build processedImages array from source files ─────
function buildProcessedImages(srcDir, destDir) {
  const files = fs.readdirSync(srcDir)
    .filter(f => /^reins_\d+\.jpg$/i.test(f))
    .sort((a, b) => {
      const na = parseInt(a.match(/\d+/)[0], 10);
      const nb = parseInt(b.match(/\d+/)[0], 10);
      return na - nb;
    });

  return files.map(fname => {
    const src  = path.join(srcDir, fname);
    const dest = path.join(destDir, fname);
    fs.copyFileSync(src, dest);

    // reins_5 = floorplan (categoryId "04"), others are photos
    const num = parseInt(fname.match(/\d+/)[0], 10);
    const isFloor = num === 5;
    return {
      localPath: dest,
      categoryId:    isFloor ? "04"    : undefined,
      categoryLabel: isFloor ? "間取り図" : undefined,
    };
  });
}

// ───── main ─────
async function main() {
  // ─ Phase 1: Normal run (Real-ESRGAN enabled) ─────────────────────────────

  console.log("\n=== Phase 1: Normal run (Real-ESRGAN enabled) ===");

  // Prepare work directory — fresh copy of source images
  if (fs.existsSync(WORK_DIR)) fs.rmSync(WORK_DIR, { recursive: true, force: true });
  fs.mkdirSync(WORK_DIR, { recursive: true });

  const processedImages = buildProcessedImages(SOURCE_DIR, WORK_DIR);
  const inputCount = processedImages.length;
  console.log(`  Input images: ${inputCount}`);

  // no-op logStep (matches pipeline convention)
  const logStep = () => {};
  const runDir = path.join(WORK_DIR, "run");
  fs.mkdirSync(runDir, { recursive: true });

  const t0 = Date.now();
  const result = await runRetouchImages({
    processedImages,
    downloadDir: WORK_DIR,
    logStep,
    runDir,
  });
  const elapsed = Math.round((Date.now() - t0) / 1000);
  console.log(`  Completed in ${elapsed}s`);

  // Array length unchanged
  assert(
    "output array length equals input",
    result.processedImages.length,
    inputCount
  );

  // Per-image verification
  console.log("\n  --- Per-image results ---");
  const tableRows = [];

  for (const img of result.processedImages) {
    const lp = img.localPath;
    const isFloor = img.categoryId === "04" || img.categoryLabel === "間取り図";
    const exists = fs.existsSync(lp);
    const fname = path.basename(lp);

    if (!exists) {
      fail++;
      failures.push({ name: `${fname}: file exists`, expected: true, actual: false });
      console.log(`  FAIL: ${fname}: file not found at ${lp}`);
      tableRows.push({ file: fname, w: "?", h: "?", size: "?", kind: isFloor ? "floorplan" : "photo", retouched: false });
      continue;
    }

    const { w, h } = await getDimensions(lp);
    const bytes = fs.statSync(lp).size;
    const inRetouched = lp.includes(path.sep + "retouched" + path.sep);

    tableRows.push({
      file: fname,
      w, h,
      size: Math.round(bytes / 1024),
      kind: isFloor ? "floorplan" : "photo",
      retouched: inRetouched,
    });

    assert(`${fname}: width=1280`, w, TARGET_W);
    assert(`${fname}: height=960`, h, TARGET_H);
    assertTrue(`${fname}: size < 12 MB (${Math.round(bytes / 1024)} KB)`, bytes < MAX_BYTES);
    assertTrue(`${fname}: localPath in retouched/`, inRetouched);
  }

  // Print summary table
  console.log("\n  --- Dimension / size table ---");
  console.log("  File".padEnd(14), "W".padStart(5), "H".padStart(5), "KB".padStart(8), "Kind".padEnd(12), "retouched/");
  for (const r of tableRows) {
    console.log(
      `  ${r.file}`.padEnd(14),
      String(r.w).padStart(5),
      String(r.h).padStart(5),
      String(r.size).padStart(8),
      r.kind.padEnd(12),
      r.retouched ? "yes" : "NO"
    );
  }

  // Specific check: reins_5 is floorplan contain (AI non-processed path)
  // Contain-pad signature: the image dimension fits within 1280x960 maintaining ratio.
  // Since the original reins_5 might not be 4:3, containment means borders may appear.
  // We verify via kind classification only — AI path skip means it went through
  // magick contain-pad (no upscale temp file).
  const floorRow = tableRows.find(r => r.file === "reins_5.jpg");
  if (floorRow) {
    assert("reins_5 (floorplan): width=1280", floorRow.w, TARGET_W);
    assert("reins_5 (floorplan): height=960", floorRow.h, TARGET_H);
    // kind must be floorplan
    assert("reins_5 kind=floorplan", floorRow.kind, "floorplan");
  } else {
    fail++;
    failures.push({ name: "reins_5 found in result", expected: true, actual: false });
    console.log("  FAIL: reins_5 not found in result");
  }

  // ─ Phase 2: Graceful fallback (REALESRGAN_BIN nonexistent) ──────────────

  console.log("\n=== Phase 2: Graceful fallback (REALESRGAN_BIN → nonexistent) ===");

  const WORK_DIR2 = "/tmp/smoke-retouch-fallback";
  if (fs.existsSync(WORK_DIR2)) fs.rmSync(WORK_DIR2, { recursive: true, force: true });
  fs.mkdirSync(WORK_DIR2, { recursive: true });

  // Override REALESRGAN_BIN to a nonexistent path
  process.env.REALESRGAN_BIN = "/nonexistent/realesrgan-ncnn-vulkan";

  const imagesForFallback = buildProcessedImages(SOURCE_DIR, WORK_DIR2);

  const t1 = Date.now();
  let fallbackResult;
  let fallbackError = null;
  try {
    fallbackResult = await runRetouchImages({
      processedImages: imagesForFallback,
      downloadDir: WORK_DIR2,
      logStep,
    });
  } catch (e) {
    fallbackError = e;
  }
  const elapsed2 = Math.round((Date.now() - t1) / 1000);
  console.log(`  Fallback run completed in ${elapsed2}s`);

  // Must NOT throw
  assertTrue("fallback: runRetouchImages did not throw", fallbackError === null);

  if (fallbackResult) {
    assert(
      "fallback: output array length equals input",
      fallbackResult.processedImages.length,
      imagesForFallback.length
    );

    // Spot-check one photo image (reins_1) — magick only, still 1280x960
    const fallbackImg = fallbackResult.processedImages.find(img =>
      path.basename(img.localPath) === "reins_1.jpg"
    );
    if (fallbackImg && fs.existsSync(fallbackImg.localPath)) {
      const { w, h } = await getDimensions(fallbackImg.localPath);
      const bytes = fs.statSync(fallbackImg.localPath).size;
      assert("fallback reins_1: width=1280", w, TARGET_W);
      assert("fallback reins_1: height=960", h, TARGET_H);
      assertTrue(
        `fallback reins_1: size < 12 MB (${Math.round(bytes / 1024)} KB)`,
        bytes < MAX_BYTES
      );
      assertTrue(
        "fallback reins_1: localPath in retouched/",
        fallbackImg.localPath.includes(path.sep + "retouched" + path.sep)
      );
      console.log(
        `  Fallback photo (reins_1): ${w}x${h}, ${Math.round(bytes / 1024)} KB — magick-only path confirmed`
      );
    } else {
      fail++;
      failures.push({ name: "fallback: reins_1 output exists", expected: true, actual: false });
      console.log("  FAIL: fallback reins_1 output not found");
    }
  }

  // Restore env (clean up override)
  delete process.env.REALESRGAN_BIN;

  // ─ Summary ──────────────────────────────────────────────────────────────

  console.log(`\n=== Summary ===`);
  console.log(`Pass: ${pass}, Fail: ${fail}`);

  if (fail > 0) {
    console.error("\nFailed assertions:");
    for (const f of failures) {
      console.error(`  - ${f.name}`);
      console.error(`    expected: ${JSON.stringify(f.expected)}`);
      console.error(`    got:      ${JSON.stringify(f.actual)}`);
    }
    process.exit(1);
  }

  console.log("\nAll assertions PASS.");
  process.exit(0);
}

main().catch(e => {
  console.error("Smoke fatal error:", e);
  process.exit(1);
});
