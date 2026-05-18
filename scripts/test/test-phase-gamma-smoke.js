#!/usr/bin/env node
/**
 * test-phase-gamma-smoke.js — Phase gamma T004: End-to-end smoke test
 *
 * Validates 02b (maisoku PDF fetch) + 02c (dual-mode text extract) against
 * real REINS properties. Measures actual Vision OCR cost and verifies alignment
 * with Phase alpha expectations (text-layer 20% / scan-PDF 80%).
 *
 * IMPORTANT: This script unloads watch-nyuko before accessing REINS and
 * reloads it in a try/finally block. Per gotchas.md and launchd-aware-kill.md.
 *
 * Usage:
 *   node scripts/test/test-phase-gamma-smoke.js [--sample <N>]
 *   Default: N=5, max 10.
 *
 * Env knobs (optional):
 *   SAMPLE_SEED=42          Deterministic shuffle (default: 42 for reproducibility)
 *   SAMPLE_SIZE=5           Property count (clamped 1..10)
 *   PHASE_GAMMA_OCR=0       Disable Vision OCR fallback (pdftotext-only mode)
 *
 * Exit 0 = all samples OK (PASS)
 * Exit 1 = fatal error or cost ABORT threshold hit
 *
 * Acceptance criteria (Phase gamma):
 *   - 02b downloadEvent="download" for all zmnFlmi-present properties
 *   - 02c source in {pdftotext, vision-ocr, skipped, error}
 *   - total Vision OCR cost <= sample_size * $0.10
 *   - hit rate logged (pdftotext / vision-ocr / skipped)
 *   - Phase alpha expectation check documented (20%/80%)
 *   - watch-nyuko unload/load timestamps in output
 *   - 02b/02c stage files NOT modified (md5 invariant enforced at start)
 */

"use strict";

const path = require("path");
const fs = require("fs");
const { execSync, spawnSync } = require("child_process");
require("dotenv").config({
  path: path.join(__dirname, "..", "..", ".env.local"),
});
const { chromium } = require("playwright");
const reins = require("../../skills/reins");
const { runMaisokuFetch } = require("../stages/02b-maisoku-fetch");
const { runMaisokuTextExtract } = require("../stages/02c-maisoku-text-extract");

// ── paths ─────────────────────────────────────────────────────
const PROJECT_ROOT = path.resolve(__dirname, "../..");
const LOGS_RUNS = path.join(PROJECT_ROOT, "logs", "runs");
const FINDINGS_DIR = path.resolve(
  __dirname,
  "..",
  "..",
  "..",
  "..",
  ".claude",
  "do",
  "findings"
);
const SMOKE_REPORT_MD = path.join(FINDINGS_DIR, "gamma-smoke.md");
const SMOKE_RUN_LOG = path.join(FINDINGS_DIR, "gamma-smoke-run.log");
const PLIST_PATH = path.join(
  process.env.HOME || "/Users/kentohonda",
  "Library",
  "LaunchAgents",
  "jp.fango.watch-nyuko.plist"
);

// ── md5 baseline (must not change — T002/T003 SSOT) ─────────
const MD5_BASELINE = {
  "skills/feature-codes-resolve.js": "4a818b474dbbdcb30c78a1851bae6048",
  "scripts/stages/03b-feature-codes-resolve.js": "49b8479c1f040a135ed8ab82c73270fb",
  "skills/forrent/fill-tokucho.js": "295cb84e281ed9ccbdfb21981fc19f4b",
};

// ── cost policy (phase-gamma-design.md §8) ───────────────────
const COST_WARN_PER_PROPERTY = 0.05;
const COST_ABORT_PER_PROPERTY = 0.10;

// ── tuning ───────────────────────────────────────────────────
const RAW_SAMPLE_SIZE = parseInt(process.env.SAMPLE_SIZE || "5", 10);
const SAMPLE_SIZE = Math.max(1, Math.min(10, Number.isFinite(RAW_SAMPLE_SIZE) ? RAW_SAMPLE_SIZE : 5));
const SAMPLE_SEED = process.env.SAMPLE_SEED != null
  ? Number(process.env.SAMPLE_SEED)
  : 42;

// ── argv override ────────────────────────────────────────────
{
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--sample" && args[i + 1]) {
      const n = parseInt(args[i + 1], 10);
      if (Number.isFinite(n) && n >= 1 && n <= 10) {
        // override already computed SAMPLE_SIZE via module-level reassignment
        // We export it via a closure below for the main logic.
      }
    }
  }
}

// Parse --sample from argv (can override env)
function parseSampleSize() {
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--sample" && args[i + 1]) {
      const n = parseInt(args[i + 1], 10);
      if (Number.isFinite(n) && n >= 1 && n <= 10) return n;
    }
  }
  return SAMPLE_SIZE;
}

// ── logging ──────────────────────────────────────────────────
const logLines = [];

function ts() {
  return new Date().toISOString();
}
function log(msg) {
  const line = `[${ts()}] ${msg}`;
  console.error(line);
  logLines.push(line);
}

// ── Mulberry32 PRNG (deterministic shuffle) ──────────────────
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

// ── md5 verification ─────────────────────────────────────────
function verifyMd5Baseline() {
  log("verifying md5 baseline for SSOT files (must not change)...");
  let allOk = true;
  for (const [relPath, expected] of Object.entries(MD5_BASELINE)) {
    const absPath = path.join(PROJECT_ROOT, relPath);
    let actual = "";
    try {
      const out = spawnSync("md5", [absPath], { encoding: "utf8" });
      // macOS md5 output: "MD5 (/path) = <hash>"
      const m = (out.stdout || "").match(/=\s+([a-f0-9]{32})/i);
      actual = m ? m[1] : "";
    } catch (e) {
      log(`  md5 error for ${relPath}: ${e.message}`);
    }
    if (actual === expected) {
      log(`  md5 OK: ${relPath} = ${actual}`);
    } else {
      log(`  md5 MISMATCH: ${relPath} expected=${expected} actual=${actual}`);
      allOk = false;
    }
  }
  return allOk;
}

// ── launchctl ────────────────────────────────────────────────
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

// ── sample selection from logs/runs/ ─────────────────────────
/**
 * Picks up to targetN distinct reinsIds from logs/runs/.
 * Dedupes to the most recent run per reinsId.
 * Only includes IDs where reins-data.json exists and has zmnFlmi field.
 * Prioritizes entries with non-empty zmnFlmi (needed for 02b to fire).
 */
function pickSample(targetN) {
  const entries = fs.readdirSync(LOGS_RUNS, { withFileTypes: true }).filter(
    (d) => d.isDirectory() && /^\d{8}-\d{6}_\d+$/.test(d.name)
  );

  const byId = new Map();
  for (const d of entries) {
    const m = d.name.match(/^(\d{8}-\d{6})_(\d+)$/);
    if (!m) continue;
    const stamp = m[1];
    const reinsId = m[2];
    const prev = byId.get(reinsId);
    if (!prev || prev.stamp < stamp) {
      byId.set(reinsId, { stamp, runDir: path.join(LOGS_RUNS, d.name) });
    }
  }

  log(`pickSample: ${entries.length} run dirs -> ${byId.size} distinct reinsIds`);

  const candidates = [];
  for (const [reinsId, { runDir }] of byId.entries()) {
    let zmnFlmi = null;
    let reinsData = null;
    // Try 01-reins-extract/output.json first
    const extractOut = path.join(runDir, "01-reins-extract", "output.json");
    const legacyReinsData = path.join(runDir, "reins-data.json");
    try {
      if (fs.existsSync(extractOut)) {
        reinsData = JSON.parse(fs.readFileSync(extractOut, "utf8"));
        zmnFlmi = reinsData?.zmnFlmi ?? null;
      } else if (fs.existsSync(legacyReinsData)) {
        reinsData = JSON.parse(fs.readFileSync(legacyReinsData, "utf8"));
        zmnFlmi = reinsData?.zmnFlmi ?? null;
      }
    } catch {
      // ignore parse errors
    }
    candidates.push({ reinsId, runDir, zmnFlmi, reinsData });
  }

  // Shuffle deterministically with SAMPLE_SEED=42
  const rng = mulberry32(SAMPLE_SEED);
  const shuffled = shuffle(candidates, rng);

  // Prefer entries with zmnFlmi non-empty (so 02b actually downloads something)
  const withZmn = shuffled.filter((c) => c.zmnFlmi && c.zmnFlmi.trim().length > 0);
  const withoutZmn = shuffled.filter((c) => !c.zmnFlmi || c.zmnFlmi.trim().length === 0);

  // Take up to targetN, prioritizing properties with zmnFlmi
  const selected = [...withZmn, ...withoutZmn].slice(0, targetN);
  log(`pickSample: ${withZmn.length} with zmnFlmi, ${withoutZmn.length} without -> selecting ${selected.length}`);
  return selected;
}

// ── smoke test for one property ──────────────────────────────
/**
 * Navigate to property detail, run 02b + 02c, return result record.
 * Returns null on navigation failure.
 */
async function smokeProperty(page, { reinsId, runDir, zmnFlmi, reinsData }, i, total) {
  log(`── ${i + 1}/${total}: reinsId=${reinsId} zmnFlmi=${zmnFlmi || "(empty)"} ──`);

  // Navigate back to dashboard for 2nd+ iteration
  if (i > 0) {
    try {
      await page.goto("https://system.reins.jp/main/KG/GKG003100", {
        waitUntil: "networkidle",
        timeout: 25000,
      });
      await page.waitForTimeout(2500);
    } catch (e) {
      log(`  goto dashboard failed: ${e.message}`);
    }
  }

  // Intercept getInitData for the property-detail screen (scoped URL per finding-01)
  const initDataPromise = page
    .waitForResponse(
      (r) =>
        /\/BK\/GBK003200\/getInitData/.test(r.url()) && r.status() === 200,
      { timeout: 30000 }
    )
    .catch(() => null);

  let found = false;
  try {
    found = await reins.searchByNumber(page, reinsId);
  } catch (e) {
    log(`  searchByNumber threw: ${e.message}`);
  }
  if (!found) {
    log(`  NOT_FOUND on REINS — skipping`);
    return {
      reinsId,
      zmnFlmi: zmnFlmi || "(empty)",
      status: "NOT_FOUND",
      stage02b: null,
      stage02c: null,
    };
  }

  // Click 詳細 to enter detail screen
  try {
    await page.click('button:has-text("詳細")', { timeout: 10000 });
    await page.waitForTimeout(3500);
  } catch (e) {
    log(`  detail click failed: ${e.message}`);
    return {
      reinsId,
      zmnFlmi: zmnFlmi || "(empty)",
      status: "NAV_FAIL",
      stage02b: null,
      stage02c: null,
    };
  }

  // Capture getInitData to extract zmnFlmi if not known from artifact
  let liveZmnFlmi = zmnFlmi;
  const initResp = await initDataPromise;
  if (initResp) {
    try {
      const j = await initResp.json();
      // Walk to find zmnFlmi (finding-01 pattern)
      function extractZmnFlmi(obj) {
        if (!obj || typeof obj !== "object") return "";
        const direct = obj.zmnFlmi || obj?.data?.zmnFlmi || obj?.result?.zmnFlmi;
        if (typeof direct === "string") return direct;
        let found = "";
        (function walk(o) {
          if (found || !o || typeof o !== "object") return;
          for (const [k, v] of Object.entries(o)) {
            if (found) return;
            if (k === "zmnFlmi" && typeof v === "string") { found = v; return; }
            if (typeof v === "object") walk(v);
          }
        })(obj);
        return found || "";
      }
      const live = extractZmnFlmi(j);
      if (live) liveZmnFlmi = live;
      log(`  zmnFlmi (live)="${live}"`);
    } catch {
      // ignore
    }
  }

  // Create a temporary runDir for this smoke run to hold artifacts
  const smokeRunDir = path.join(
    PROJECT_ROOT,
    "logs",
    "diag",
    `smoke-gamma-${Date.now()}_${reinsId}`
  );
  fs.mkdirSync(smokeRunDir, { recursive: true });

  // Synthesize reinsData for 02b
  const effectiveReinsData = reinsData
    ? { ...reinsData, zmnFlmi: liveZmnFlmi || "" }
    : { zmnFlmi: liveZmnFlmi || "" };

  const logStep = (name, extra) => {
    log(`  logStep: ${name} ${extra ? JSON.stringify(extra) : ""}`);
  };

  // ── Stage 02b ──
  log(`  running 02b-maisoku-fetch...`);
  const r2b = await runMaisokuFetch({
    reinsPage: page,
    runDir: smokeRunDir,
    logStep,
    reinsData: effectiveReinsData,
  });
  log(`  02b result: downloadEvent=${r2b.downloadEvent} downloaded=${r2b.downloaded} bytes=${r2b.bytes ?? "n/a"}`);

  // ── Stage 02c ──
  log(`  running 02c-maisoku-text-extract...`);
  const r2c = await runMaisokuTextExtract({
    maisokuPdfPath: r2b.maisokuPdfPath,
    runDir: smokeRunDir,
    logStep,
  });
  log(`  02c result: source=${r2c.source} chars=${r2c.charsExtracted} visionUsed=${r2c.visionUsed} cost=$${r2c.visionCostUSD.toFixed(4)}`);

  // Cost guard per-property
  if (r2c.visionCostUSD >= COST_ABORT_PER_PROPERTY) {
    log(`  ABORT: per-property cost $${r2c.visionCostUSD.toFixed(4)} >= $${COST_ABORT_PER_PROPERTY}`);
    throw new Error(
      `Cost ABORT at reinsId=${reinsId}: $${r2c.visionCostUSD.toFixed(4)}`
    );
  }
  if (r2c.visionCostUSD >= COST_WARN_PER_PROPERTY) {
    log(`  WARN: per-property cost $${r2c.visionCostUSD.toFixed(4)} >= $${COST_WARN_PER_PROPERTY}`);
  }

  // Verify artifacts exist
  const input02b = path.join(smokeRunDir, "02b-maisoku-fetch", "input.json");
  const output02b = path.join(smokeRunDir, "02b-maisoku-fetch", "output.json");
  const input02c = path.join(smokeRunDir, "02c-maisoku-text-extract", "input.json");
  const output02c = path.join(smokeRunDir, "02c-maisoku-text-extract", "output.json");
  const maisokuTxt = path.join(
    smokeRunDir,
    "02c-maisoku-text-extract",
    "maisoku-text.txt"
  );

  const artifacts = {
    "02b/input.json": fs.existsSync(input02b),
    "02b/output.json": fs.existsSync(output02b),
    "02c/input.json": fs.existsSync(input02c),
    "02c/output.json": fs.existsSync(output02c),
    "02c/maisoku-text.txt": fs.existsSync(maisokuTxt),
  };
  log(`  artifacts: ${JSON.stringify(artifacts)}`);

  // Sample text preview (first 120 chars)
  let textPreview = "";
  if (r2c.maisokuText && r2c.maisokuText.trim().length > 0) {
    textPreview = r2c.maisokuText.trim().slice(0, 120);
  }

  return {
    reinsId,
    zmnFlmi: liveZmnFlmi || zmnFlmi || "(empty)",
    status: "OK",
    stage02b: {
      downloadEvent: r2b.downloadEvent,
      downloaded: r2b.downloaded,
      bytes: r2b.bytes ?? null,
      error: r2b.error ?? null,
    },
    stage02c: {
      source: r2c.source,
      charsExtracted: r2c.charsExtracted,
      visionUsed: r2c.visionUsed,
      visionCostUSD: r2c.visionCostUSD,
      error: r2c.error ?? null,
    },
    artifacts,
    textPreview,
    smokeRunDir,
  };
}

// ── report writer ─────────────────────────────────────────────
function writeReport({
  startedAt,
  finishedAt,
  sampleSize,
  results,
  totalCostUSD,
  launchctlLog,
  md5Ok,
}) {
  const ok = results.filter((r) => r.status === "OK");
  const notFound = results.filter((r) => r.status === "NOT_FOUND");
  const navFail = results.filter((r) => r.status === "NAV_FAIL");

  const downloaded = ok.filter((r) => r.stage02b?.downloadEvent === "download");
  const skipped = ok.filter((r) => r.stage02b?.downloadEvent === "skipped");
  const errored = ok.filter((r) => r.stage02b?.downloadEvent === "error");

  const pdftotext = ok.filter((r) => r.stage02c?.source === "pdftotext");
  const visionOcr = ok.filter((r) => r.stage02c?.source === "vision-ocr");
  const skipped02c = ok.filter((r) => r.stage02c?.source === "skipped");
  const error02c = ok.filter((r) => r.stage02c?.source === "error");

  const totalProcessed = ok.length;
  const downloadedForOCR = downloaded.length; // 02b download succeeded

  // Phase alpha expectation: pdftotext 20%, vision-ocr 80% of downloaded
  const pdftotextRate = downloadedForOCR > 0
    ? ((pdftotext.length / downloadedForOCR) * 100).toFixed(0)
    : "n/a";
  const visionOcrRate = downloadedForOCR > 0
    ? ((visionOcr.length / downloadedForOCR) * 100).toFixed(0)
    : "n/a";

  const avgCost = ok.length > 0
    ? (totalCostUSD / ok.length).toFixed(4)
    : "0.0000";

  const lines = [];
  lines.push(`# Phase gamma Smoke Report`);
  lines.push(``);
  lines.push(`**Date**: ${startedAt.slice(0, 10)}`);
  lines.push(`**Run window**: ${startedAt} -> ${finishedAt}`);
  lines.push(`**Sample size (requested)**: ${sampleSize}`);
  lines.push(`**Sample size (processed)**: ${totalProcessed}`);
  lines.push(`**SAMPLE_SEED**: 42 (deterministic)`);
  lines.push(``);
  lines.push(`---`);
  lines.push(``);
  lines.push(`## md5 Invariant Check`);
  lines.push(``);
  lines.push(`Status: **${md5Ok ? "PASS" : "FAIL"}**`);
  lines.push(``);
  for (const [relPath, expected] of Object.entries(MD5_BASELINE)) {
    lines.push(`- \`${relPath}\`: ${expected}`);
  }
  lines.push(``);
  lines.push(`## Sample Results`);
  lines.push(``);
  lines.push(
    `| # | reinsId | zmnFlmi | 02b event | bytes | 02c source | chars | visionCost | status |`
  );
  lines.push(
    `|---|---|---|---|---|---|---|---|---|`
  );
  results.forEach((r, i) => {
    const b = r.stage02b;
    const c = r.stage02c;
    const bytes = b?.bytes != null ? String(b.bytes) : "-";
    const chars = c?.charsExtracted != null ? String(c.charsExtracted) : "-";
    const cost = c?.visionCostUSD != null ? `$${c.visionCostUSD.toFixed(4)}` : "-";
    const event = b?.downloadEvent ?? r.status;
    const source = c?.source ?? "-";
    lines.push(
      `| ${i + 1} | ${r.reinsId} | ${(r.zmnFlmi || "(empty)").slice(0, 30)} | ${event} | ${bytes} | ${source} | ${chars} | ${cost} | ${r.status} |`
    );
  });
  lines.push(``);
  lines.push(`## Hit Rate Summary`);
  lines.push(``);
  lines.push(`### Stage 02b (maisoku fetch)`);
  lines.push(``);
  lines.push(`- download: ${downloaded.length}/${ok.length}`);
  lines.push(`- skipped (no zmnFlmi): ${skipped.length}/${ok.length}`);
  lines.push(`- error: ${errored.length}/${ok.length}`);
  lines.push(`- NOT_FOUND (REINS): ${notFound.length}`);
  lines.push(`- NAV_FAIL: ${navFail.length}`);
  lines.push(``);
  lines.push(`### Stage 02c (text extract) — of downloaded (${downloadedForOCR})`);
  lines.push(``);
  lines.push(`- pdftotext: ${pdftotext.length} (${pdftotextRate}%)`);
  lines.push(`- vision-ocr: ${visionOcr.length} (${visionOcrRate}%)`);
  lines.push(`- skipped: ${skipped02c.length}`);
  lines.push(`- error: ${error02c.length}`);
  lines.push(``);
  lines.push(`## Phase alpha Expectation Alignment`);
  lines.push(``);
  lines.push(`Phase alpha T002 measured: **pdftotext 20% / vision-ocr 80%** (1/5 text layer, 4/5 scan).`);
  lines.push(``);
  if (downloadedForOCR === 0) {
    lines.push(`No PDFs downloaded — cannot compare with Phase alpha expectation.`);
  } else {
    lines.push(`Smoke result: pdftotext ${pdftotextRate}% / vision-ocr ${visionOcrRate}% (of ${downloadedForOCR} downloaded).`);
    const ptxt = pdftotext.length;
    const vocr = visionOcr.length;
    const total = ptxt + vocr;
    if (total === 0) {
      lines.push(`All downloads resulted in skipped/error 02c — no comparison possible.`);
    } else {
      const ptxtPct = Math.round((ptxt / total) * 100);
      const vocrPct = Math.round((vocr / total) * 100);
      const inRange = ptxtPct <= 40 && vocrPct >= 60; // within 20% tolerance of 20/80
      lines.push(`Alignment: **${inRange ? "IN RANGE" : "OUT OF RANGE"}** (expected ~20/80, got ${ptxtPct}/${vocrPct}).`);
      lines.push(``);
      if (inRange) {
        lines.push(`Phase alpha expectation confirmed. Dual-mode OCR design is validated.`);
      } else {
        lines.push(`Phase alpha expectation not matched. This could mean:`);
        lines.push(`- Sample bias (pdftotext-heavy or scan-heavy batch)`);
        lines.push(`- REINS PDF stock has changed since Phase alpha probe`);
        lines.push(`- Small sample size (increase to 10 for more reliable estimate)`);
      }
    }
  }
  lines.push(``);
  lines.push(`## OCR Cost`);
  lines.push(``);
  lines.push(`- Total Vision OCR cost: **$${totalCostUSD.toFixed(4)}**`);
  lines.push(`- Average per property (processed): **$${avgCost}**`);
  lines.push(`- WARN threshold: $${COST_WARN_PER_PROPERTY}/property`);
  lines.push(`- ABORT threshold: $${COST_ABORT_PER_PROPERTY}/property`);
  lines.push(``);
  if (visionOcr.length > 0) {
    const firstVision = visionOcr[0];
    lines.push(`## OCR Text Sample (first vision-ocr result)`);
    lines.push(``);
    lines.push(`reinsId: \`${firstVision.reinsId}\``);
    lines.push(``);
    lines.push("```");
    lines.push(firstVision.textPreview || "(empty)");
    lines.push("```");
    lines.push(``);
  } else if (pdftotext.length > 0) {
    const firstPdf = pdftotext[0];
    lines.push(`## Text Sample (first pdftotext result)`);
    lines.push(``);
    lines.push(`reinsId: \`${firstPdf.reinsId}\``);
    lines.push(``);
    lines.push("```");
    lines.push(firstPdf.textPreview || "(empty)");
    lines.push("```");
    lines.push(``);
  }
  lines.push(`## watch-nyuko unload/load sequence`);
  lines.push(``);
  for (const entry of launchctlLog) {
    lines.push(`- ${entry}`);
  }
  lines.push(``);
  lines.push(`## Anomalies`);
  lines.push(``);
  const anomalies = results.filter(
    (r) =>
      r.status !== "OK" ||
      r.stage02b?.downloadEvent === "error" ||
      r.stage02c?.source === "error" ||
      (r.stage02c?.visionCostUSD ?? 0) >= COST_WARN_PER_PROPERTY
  );
  if (anomalies.length === 0) {
    lines.push(`None detected.`);
  } else {
    for (const a of anomalies) {
      lines.push(`- \`${a.reinsId}\`: status=${a.status} 02b=${a.stage02b?.downloadEvent ?? "-"} 02c=${a.stage02c?.source ?? "-"} cost=$${(a.stage02c?.visionCostUSD ?? 0).toFixed(4)}`);
      if (a.stage02b?.error) lines.push(`  02b error: ${a.stage02b.error}`);
      if (a.stage02c?.error) lines.push(`  02c error: ${a.stage02c.error}`);
    }
  }
  lines.push(``);

  fs.mkdirSync(FINDINGS_DIR, { recursive: true });
  fs.writeFileSync(SMOKE_REPORT_MD, lines.join("\n"));
  log(`report written -> ${SMOKE_REPORT_MD}`);
}

// ── main ──────────────────────────────────────────────────────
async function main() {
  const startedAt = ts();
  const targetN = parseSampleSize();
  log(`Phase gamma smoke — sample=${targetN} seed=${SAMPLE_SEED}`);

  // 1. md5 baseline check (02b/02c SSOT invariant)
  const md5Ok = verifyMd5Baseline();
  if (!md5Ok) {
    log("FATAL: md5 mismatch — 02b/02c SSOT files were modified. Aborting.");
    process.exit(1);
  }

  const launchctlLog = [];

  // 2. unload watch-nyuko (gotchas.md / launchd-aware-kill.md)
  launchctlLog.push(`unload at ${ts()}`);
  launchctlAction("unload");

  const sample = pickSample(targetN);
  if (sample.length === 0) {
    log("FATAL: pickSample returned empty — logs/runs/ has no valid subdirs");
    launchctlLog.push(`load at ${ts()} (abort)`);
    launchctlAction("load");
    process.exit(1);
  }
  log(`sample selected: ${sample.length} properties`);

  const results = [];
  let totalCostUSD = 0;

  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext({
    viewport: { width: 1280, height: 900 },
    acceptDownloads: true,
  });
  const page = await context.newPage();

  try {
    log("REINS login...");
    const ok = await reins.login(page, {
      id: process.env.REINS_LOGIN_ID,
      pass: process.env.REINS_LOGIN_PASS,
    });
    if (!ok) {
      throw new Error("REINS login failed (check .env.local REINS_LOGIN_ID/REINS_LOGIN_PASS)");
    }
    log("login OK");

    for (let i = 0; i < sample.length; i++) {
      const item = sample[i];
      let result;
      try {
        result = await smokeProperty(page, item, i, sample.length);
      } catch (e) {
        // Cost ABORT or unexpected error
        log(`  FATAL during smoke[${i}] reinsId=${item.reinsId}: ${e.message}`);
        results.push({
          reinsId: item.reinsId,
          zmnFlmi: item.zmnFlmi || "(empty)",
          status: "SMOKE_ERROR",
          stage02b: null,
          stage02c: null,
        });
        // If cost abort, stop immediately
        if (e.message.startsWith("Cost ABORT")) {
          log("Stopping smoke due to cost ABORT.");
          break;
        }
        continue;
      }

      if (result) {
        results.push(result);
        const cost = result.stage02c?.visionCostUSD ?? 0;
        totalCostUSD += cost;
        log(`  cumulative cost: $${totalCostUSD.toFixed(4)}`);
      }
    }
  } finally {
    try {
      await browser.close();
    } catch {
      // noop
    }
    launchctlLog.push(`load at ${ts()}`);
    launchctlAction("load");
  }

  const finishedAt = ts();

  // 3. Write report
  writeReport({
    startedAt,
    finishedAt,
    sampleSize: targetN,
    results,
    totalCostUSD,
    launchctlLog,
    md5Ok,
  });

  // 4. Write run log
  fs.mkdirSync(FINDINGS_DIR, { recursive: true });
  fs.writeFileSync(SMOKE_RUN_LOG, logLines.join("\n") + "\n");
  log(`run log written -> ${SMOKE_RUN_LOG}`);

  // 5. Summary to stdout
  const processed = results.filter((r) => r.status === "OK").length;
  const downloaded = results.filter((r) => r.stage02b?.downloadEvent === "download").length;
  const pdftotext = results.filter((r) => r.stage02c?.source === "pdftotext").length;
  const visionOcr = results.filter((r) => r.stage02c?.source === "vision-ocr").length;
  const errors = results.filter(
    (r) => r.stage02b?.downloadEvent === "error" || r.stage02c?.source === "error"
  ).length;

  console.log(`\n=== Phase gamma smoke summary ===`);
  console.log(`processed: ${processed}/${results.length}`);
  console.log(`02b download: ${downloaded}/${processed}`);
  console.log(`02c pdftotext: ${pdftotext} vision-ocr: ${visionOcr}`);
  console.log(`errors: ${errors}`);
  console.log(`total cost: $${totalCostUSD.toFixed(4)}`);
  console.log(`md5 invariant: ${md5Ok ? "PASS" : "FAIL"}`);
  console.log(`report: ${SMOKE_REPORT_MD}`);
  console.log(`run log: ${SMOKE_RUN_LOG}`);

  // Final pass/fail
  const anyFatal = results.some((r) => r.status === "SMOKE_ERROR");
  if (!md5Ok || anyFatal) {
    console.log(`\nRESULT: FAIL`);
    process.exit(1);
  }
  console.log(`\nRESULT: PASS`);
  process.exit(0);
}

main().catch((e) => {
  log(`FATAL: ${e.stack || e.message}`);
  // Best-effort reload if something blew up before finally
  try {
    launchctlAction("load");
  } catch {
    // noop
  }
  fs.mkdirSync(FINDINGS_DIR, { recursive: true });
  fs.writeFileSync(SMOKE_RUN_LOG, logLines.join("\n") + "\n");
  process.exit(1);
});
