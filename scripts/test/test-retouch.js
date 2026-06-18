#!/usr/bin/env node
/**
 * test-retouch.js — skills/retouch.js pure helper unit tests
 *
 * Covered functions: classifyImageKind, pickGamma, buildGrayWorldGains, buildMagickOps
 * (buildUpscaleArgs is a trivial array assembly — verified via presence check)
 *
 * All tests run without spawning magick / realesrgan or any I/O.
 * Target dimensions: 1280x960 (kento agreement 2026-06-18).
 * photo=cover, floorplan=contain white-pad.
 *
 * Run: node scripts/test/test-retouch.js
 */

"use strict";

const {
  classifyImageKind,
  pickGamma,
  buildGrayWorldGains,
  buildMagickOps,
  buildUpscaleArgs,
} = require("../../skills/retouch");

// ───── test runner ─────
let pass = 0;
let fail = 0;
const failures = [];

function assert(name, actual, expected) {
  const ok =
    typeof expected === "object"
      ? JSON.stringify(actual) === JSON.stringify(expected)
      : actual === expected;
  if (ok) {
    pass++;
    console.log(`PASS: ${name}`);
  } else {
    fail++;
    failures.push({ test: name, expected, got: actual });
    console.log(`FAIL: ${name}`);
    console.log(`  expected: ${JSON.stringify(expected)}`);
    console.log(`  got:      ${JSON.stringify(actual)}`);
  }
}

function assertIncludes(name, array, item) {
  if (array.includes(item)) {
    pass++;
    console.log(`PASS: ${name}`);
  } else {
    fail++;
    failures.push({ test: name, expected: `contains "${item}"`, got: array });
    console.log(`FAIL: ${name}`);
    console.log(`  expected array to contain: ${JSON.stringify(item)}`);
    console.log(`  got: ${JSON.stringify(array)}`);
  }
}

// ───── classifyImageKind ─────
console.log("\n== classifyImageKind ==");

// Case 1: floorplan by pixel heuristic (whitePct:83 > 60, satPct:3.5 < 6)
assert(
  "pixel heuristic: whitePct:83 satPct:3.5 → floorplan",
  classifyImageKind({}, { whitePct: 83, satPct: 3.5 }),
  "floorplan"
);

// Case 2: photo by pixel heuristic (whitePct:45.6, satPct:18.2)
assert(
  "pixel heuristic: kitchen whitePct:45.6 satPct:18.2 → photo",
  classifyImageKind({}, { whitePct: 45.6, satPct: 18.2 }),
  "photo"
);

// Case 3: photo by pixel heuristic (whitePct:11, satPct:10.7)
assert(
  "pixel heuristic: low-white whitePct:11 satPct:10.7 → photo",
  classifyImageKind({}, { whitePct: 11, satPct: 10.7 }),
  "photo"
);

// Case 4: boundary pixel values (whitePct:60 exactly is NOT > 60, should be photo;
//         satPct:6 exactly is NOT < 6, should be photo)
// Verify the boundary: whitePct must be strictly > 60 AND satPct strictly < 6 for floorplan
assert(
  "boundary: whitePct:60 satPct:6 → photo (boundary excluded — strict < and >)",
  classifyImageKind({}, { whitePct: 60, satPct: 6 }),
  "photo"
);

// Case 5: categoryId "04" overrides pixel → floorplan
assert(
  "categoryId:04 → floorplan regardless of pixel",
  classifyImageKind({ categoryId: "04" }, { whitePct: 11, satPct: 18 }),
  "floorplan"
);

// Case 6: categoryLabel "間取り図" overrides pixel → floorplan
assert(
  "categoryLabel:間取り図 → floorplan regardless of pixel",
  classifyImageKind({ categoryLabel: "間取り図" }, { whitePct: 0, satPct: 99 }),
  "floorplan"
);

// Case 7: no pixelStats, no category → photo (default)
assert(
  "no pixelStats no category → photo (default)",
  classifyImageKind({}),
  "photo"
);

// Case 8: null img arg handled gracefully
assert(
  "null img with photo pixel → photo",
  classifyImageKind(null, { whitePct: 30, satPct: 10 }),
  "photo"
);

// ───── pickGamma ─────
console.log("\n== pickGamma ==");

assert("brightnessPct:39 (< 40) → 1.22", pickGamma(39), "1.22");
assert("brightnessPct:49 (< 50) → 1.16", pickGamma(49), "1.16");
assert("brightnessPct:59 (< 60) → 1.11", pickGamma(59), "1.11");
assert("brightnessPct:70 (≥ 60) → 1.06", pickGamma(70), "1.06");

// ───── buildGrayWorldGains ─────
console.log("\n== buildGrayWorldGains ==");

// Known values: R=120, G=100, B=80 → overall=(120+100+80)/3=100
// gr = 1 + 0.5*(100/120 - 1) = 1 + 0.5*(-0.0833) ≈ 0.9583
// gg = 1 + 0.5*(100/100 - 1) = 1 + 0 = 1.0
// gb = 1 + 0.5*(100/80 - 1)  = 1 + 0.5*0.25 = 1.125
{
  const gains = buildGrayWorldGains(120, 100, 80);
  const expectedGr = 1 + 0.5 * (100 / 120 - 1);
  const expectedGg = 1 + 0.5 * (100 / 100 - 1);
  const expectedGb = 1 + 0.5 * (100 / 80 - 1);

  assert(
    "buildGrayWorldGains R=120 G=100 B=80: gr",
    gains.gr,
    expectedGr
  );
  assert(
    "buildGrayWorldGains R=120 G=100 B=80: gg",
    gains.gg,
    expectedGg
  );
  assert(
    "buildGrayWorldGains R=120 G=100 B=80: gb",
    gains.gb,
    expectedGb
  );
}

// Equal channels: R=G=B=128 → all gains = 1.0
{
  const gains = buildGrayWorldGains(128, 128, 128);
  assert("equal channels R=G=B=128 → gr=1.0", gains.gr, 1.0);
  assert("equal channels R=G=B=128 → gg=1.0", gains.gg, 1.0);
  assert("equal channels R=G=B=128 → gb=1.0", gains.gb, 1.0);
}

// ───── buildMagickOps ─────
console.log("\n== buildMagickOps ==");

const TARGET_W = 1280;
const TARGET_H = 960;
const DIM = "1280x960";

const sampleGains = buildGrayWorldGains(120, 100, 80);
const sampleGamma = "1.16";

// photo: cover crop → must contain resize with ^ and -extent
{
  const ops = buildMagickOps("photo", sampleGains, sampleGamma, { targetW: TARGET_W, targetH: TARGET_H });
  assertIncludes("photo ops: -resize with ^ (cover crop)", ops, `${DIM}^`);
  assertIncludes("photo ops: -extent <dim>", ops, DIM);
  assertIncludes("photo ops: -gamma", ops, "-gamma");
  assertIncludes("photo ops: -quality 92", ops, "92");
  // must NOT contain -background white (that's floorplan)
  const noBg = !ops.includes("-background");
  if (noBg) {
    pass++;
    console.log("PASS: photo ops: no -background white");
  } else {
    fail++;
    failures.push({ test: "photo ops: no -background white", expected: "absent", got: ops });
    console.log("FAIL: photo ops: no -background white");
    console.log("  expected: -background to be absent");
    console.log(`  got: ${JSON.stringify(ops)}`);
  }
}

// floorplan: contain (white-pad) → -background white, no ^ resize
{
  const ops = buildMagickOps("floorplan", sampleGains, sampleGamma, { targetW: TARGET_W, targetH: TARGET_H });
  assertIncludes("floorplan ops: -background white", ops, "-background");
  assertIncludes("floorplan ops: white value", ops, "white");
  assertIncludes("floorplan ops: -resize <dim> (no ^)", ops, DIM);
  // ^ must NOT appear in floorplan (no cover crop)
  const noHat = !ops.includes(`${DIM}^`);
  if (noHat) {
    pass++;
    console.log("PASS: floorplan ops: no ^ in resize (contain, not cover)");
  } else {
    fail++;
    failures.push({ test: "floorplan ops: no ^ in resize", expected: "absent", got: ops });
    console.log("FAIL: floorplan ops: no ^ in resize");
    console.log("  expected: no cover-resize ^");
    console.log(`  got: ${JSON.stringify(ops)}`);
  }
  assertIncludes("floorplan ops: -gravity center", ops, "-gravity");
  assertIncludes("floorplan ops: -extent <dim>", ops, DIM);
  assertIncludes("floorplan ops: -quality 92", ops, "92");
}

// photo with custom satBoost: modulate should use 100+satBoost
{
  const satBoost = 10;
  const ops = buildMagickOps("photo", sampleGains, sampleGamma, {
    targetW: TARGET_W,
    targetH: TARGET_H,
    satBoost,
  });
  assertIncludes(
    "photo ops: satBoost=10 → modulate 100,110,100",
    ops,
    "100,110,100"
  );
}

// photo default satBoost=5
{
  const ops = buildMagickOps("photo", sampleGains, sampleGamma, { targetW: TARGET_W, targetH: TARGET_H });
  assertIncludes("photo ops: default satBoost=5 → modulate 100,105,100", ops, "100,105,100");
}

// ───── buildUpscaleArgs (sanity) ─────
console.log("\n== buildUpscaleArgs ==");

{
  const args = buildUpscaleArgs("/in/image.jpg", "/out/image.jpg", "realesrgan-x4plus", "/models");
  assert("buildUpscaleArgs: -i flag", args[0], "-i");
  assert("buildUpscaleArgs: input path", args[1], "/in/image.jpg");
  assert("buildUpscaleArgs: -o flag", args[2], "-o");
  assert("buildUpscaleArgs: output path", args[3], "/out/image.jpg");
  assert("buildUpscaleArgs: -n flag", args[4], "-n");
  assert("buildUpscaleArgs: model name", args[5], "realesrgan-x4plus");
  assert("buildUpscaleArgs: -m flag", args[6], "-m");
  assert("buildUpscaleArgs: modelsDir", args[7], "/models");
}

// ───── summary ─────
console.log(`\nTotal: ${pass}/${pass + fail}`);
if (fail > 0) {
  console.error("\nFailures:");
  for (const f of failures) {
    console.error(`  - ${f.test}`);
    console.error(`    expected: ${JSON.stringify(f.expected)}`);
    console.error(`    got:      ${JSON.stringify(f.got)}`);
  }
  process.exit(1);
}
