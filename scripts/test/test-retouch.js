#!/usr/bin/env node
/**
 * test-retouch.js — skills/retouch.js pure helper unit tests
 *
 * Covered functions: classifyImageKind, pickGamma, buildGrayWorldGains, buildChannelLut,
 * saturationMultiplier, buildResizePlan, computePixelStats, buildUpscaleArgs (presence check)
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
  buildChannelLut,
  saturationMultiplier,
  buildResizePlan,
  computePixelStats,
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

const TARGET_W = 1280;
const TARGET_H = 960;

// ───── buildChannelLut ─────
console.log("\n== buildChannelLut ==");

// length is always 256
assert("buildChannelLut: length 256", buildChannelLut(1, "1.0").length, 256);

// identity: gain=1, gamma=1.0 → lut[i] === i (endpoints + midpoints)
{
  const lut = buildChannelLut(1, "1.0");
  assert("identity lut[0]=0", lut[0], 0);
  assert("identity lut[64]=64", lut[64], 64);
  assert("identity lut[128]=128", lut[128], 128);
  assert("identity lut[255]=255", lut[255], 255);
}

// gamma > 1 brightens midtones but preserves endpoints (no white blow-out)
{
  const lut = buildChannelLut(1, "1.14");
  assert("gamma1.14 lut[0]=0 (black preserved)", lut[0], 0);
  assert("gamma1.14 lut[255]=255 (white preserved — no blow-out)", lut[255], 255);
  const midLifted = lut[128] > 128;
  if (midLifted) {
    pass++;
    console.log("PASS: gamma1.14 lut[128] > 128 (midtone lifted)");
  } else {
    fail++;
    failures.push({ test: "gamma1.14 midtone lift", expected: "> 128", got: lut[128] });
    console.log(`FAIL: gamma1.14 midtone lift — got lut[128]=${lut[128]}`);
  }
}

// gain < 1 darkens (WB pull-down), gamma=1.0
{
  const lut = buildChannelLut(0.8, "1.0");
  assert("gain0.8 lut[255]=204 (255*0.8)", lut[255], 204);
  assert("gain0.8 lut[128]=102", lut[128], Math.round(255 * ((128 / 255) * 0.8)));
}

// gain > 1 clamps at white (no overflow past 255)
{
  const lut = buildChannelLut(1.5, "1.0");
  assert("gain1.5 lut[200] clamps to 255", lut[200], 255);
}

// ───── saturationMultiplier ─────
console.log("\n== saturationMultiplier ==");

assert("satBoost 5 → 1.05", saturationMultiplier(5), 1.05);
assert("satBoost 10 → 1.1", saturationMultiplier(10), 1.1);
assert("satBoost undefined → default 1.05", saturationMultiplier(undefined), 1.05);

// ───── buildResizePlan ─────
console.log("\n== buildResizePlan ==");

{
  const plan = buildResizePlan("photo", TARGET_W, TARGET_H);
  assert("photo plan: fit cover", plan.fit, "cover");
  assert("photo plan: width 1280", plan.width, TARGET_W);
  assert("photo plan: height 960", plan.height, TARGET_H);
  const noBg = plan.background === undefined;
  if (noBg) {
    pass++;
    console.log("PASS: photo plan: no background (cover crop, no pad)");
  } else {
    fail++;
    failures.push({ test: "photo plan no background", expected: "undefined", got: plan.background });
    console.log("FAIL: photo plan: unexpected background");
  }
}

{
  const plan = buildResizePlan("floorplan", TARGET_W, TARGET_H);
  assert("floorplan plan: fit contain", plan.fit, "contain");
  assert("floorplan plan: white background", plan.background, { r: 255, g: 255, b: 255 });
  assert("floorplan plan: width 1280", plan.width, TARGET_W);
  assert("floorplan plan: height 960", plan.height, TARGET_H);
}

// ───── computePixelStats ─────
console.log("\n== computePixelStats ==");

{
  // 3 pure-white pixels → whitePct 100, satPct 0
  const white = Buffer.from([255, 255, 255, 255, 255, 255, 255, 255, 255]);
  const s = computePixelStats(white, 3);
  assert("all-white: whitePct 100", s.whitePct, 100);
  assert("all-white: satPct 0", s.satPct, 0);
}

{
  // mid-gray (mx==mn) → satPct 0, not white
  const gray = Buffer.from([128, 128, 128, 128, 128, 128]);
  const s = computePixelStats(gray, 3);
  assert("mid-gray: whitePct 0", s.whitePct, 0);
  assert("mid-gray: satPct 0", s.satPct, 0);
}

{
  // pure red → HSL S = 1 → satPct 100, not white
  const red = Buffer.from([255, 0, 0]);
  const s = computePixelStats(red, 3);
  assert("pure-red: satPct 100", s.satPct, 100);
  assert("pure-red: whitePct 0", s.whitePct, 0);
}

{
  // empty buffer → zeros, no throw
  const s = computePixelStats(Buffer.alloc(0), 3);
  assert("empty buffer: whitePct 0", s.whitePct, 0);
  assert("empty buffer: satPct 0", s.satPct, 0);
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
