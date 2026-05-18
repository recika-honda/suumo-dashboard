/**
 * sample-maisoku-and-zmnflmi.js — Phase 4 feasibility probes (b) + (c)
 *
 * T002: combines two measurements in one REINS session
 *   (b) PDF text-layer probe — for up to 5 properties with non-empty zmnFlmi,
 *       download the maisoku PDF and analyze text extractability with pdftotext.
 *   (c) zmnFlmi sweep — for 20-30 random properties from logs/runs/, intercept
 *       /BK/GBK003200/getInitData response and record zmnFlmi presence.
 *
 * Why one script: both tasks need a logged-in REINS session, and (b)
 * piggy-backs on (c)'s navigation. Running them separately would double
 * the REINS load and the launchctl unload/load surface area.
 *
 * Reuses T001 establish-ed primitives:
 *   - skills/reins.js (login, searchByNumber)
 *   - probe-zumen-button.js #downloadMaisokuPdf snippet (inlined here)
 *
 * IMPORTANT (per ~/.claude/rules/launchd-aware-kill.md):
 *   launchctl unload jp.fango.watch-nyuko before, load after — wrapped in try/finally.
 *
 * Outputs:
 *   .claude/do/findings/zmnflmi-sweep.jsonl        (append; safe to re-run)
 *   .claude/do/findings/pdfs/{reinsId}.pdf         (max 5)
 *   .claude/do/findings/02-pdf-text-layer.md       (overwritten per run)
 *
 * Usage: node scripts/sample-maisoku-and-zmnflmi.js
 *
 * Env knobs (optional):
 *   SAMPLE_SIZE=25                 # target property count (default 25, clamped 20..30)
 *   MAX_PDFS=5                     # max PDFs to download (default 5)
 *   SAMPLE_SEED=<int>              # deterministic shuffle for reproducibility
 */

const path = require("path");
const fs = require("fs");
const { execSync, spawnSync } = require("child_process");
require("dotenv").config({ path: path.join(__dirname, "..", ".env.local") });
const { chromium } = require("playwright");
const reins = require("../skills/reins");

// ── paths ───────────────────────────────────────────────────
const PROJECT_ROOT = path.resolve(__dirname, "..", "..", "..");
const FINDINGS_DIR = path.join(PROJECT_ROOT, ".claude", "do", "findings");
const PDFS_DIR = path.join(FINDINGS_DIR, "pdfs");
const SWEEP_JSONL = path.join(FINDINGS_DIR, "zmnflmi-sweep.jsonl");
const REPORT_MD = path.join(FINDINGS_DIR, "02-pdf-text-layer.md");
const LOGS_RUNS = path.join(__dirname, "..", "logs", "runs");
const PLIST_PATH = path.join(
  process.env.HOME || "/Users/kentohonda",
  "Library", "LaunchAgents", "jp.fango.watch-nyuko.plist"
);

// ── tuning ──────────────────────────────────────────────────
const SAMPLE_SIZE = Math.max(20, Math.min(30, Number(process.env.SAMPLE_SIZE) || 25));
const MAX_PDFS = Math.max(1, Math.min(5, Number(process.env.MAX_PDFS) || 5));
const SAMPLE_SEED = process.env.SAMPLE_SEED ? Number(process.env.SAMPLE_SEED) : null;

// ── small utilities ─────────────────────────────────────────
function ts() { return new Date().toISOString(); }
function log(msg) { console.error(`[${ts()}] ${msg}`); }

// Mulberry32 PRNG for SAMPLE_SEED-driven shuffle (deterministic re-runs)
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
    const j = Math.floor((rng ? rng() : Math.random()) * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// ── launchctl wrapper ───────────────────────────────────────
function launchctlAction(verb) {
  const startedAt = ts();
  try {
    const r = spawnSync("launchctl", [verb, PLIST_PATH], { stdio: ["ignore", "pipe", "pipe"] });
    const ok = r.status === 0;
    log(`launchctl ${verb} ${PLIST_PATH} ${ok ? "OK" : "FAIL"} (status=${r.status}) at ${startedAt}`);
    if (!ok) log(`stderr: ${(r.stderr || "").toString().trim()}`);
    return ok;
  } catch (e) {
    log(`launchctl ${verb} threw: ${e.message}`);
    return false;
  }
}

// ── sample selection ────────────────────────────────────────
/**
 * Picks SAMPLE_SIZE distinct reinsIds from logs/runs/.
 * Each subdir is named "{YYYYMMDD-HHMMSS}_{reinsId}". Multiple subdirs can
 * share a reinsId (re-runs); we dedupe to the most recent one per reinsId.
 *
 * Returns: [{ reinsId, runDir, motozuke }, ...]
 */
function pickSample() {
  const entries = fs.readdirSync(LOGS_RUNS, { withFileTypes: true })
    .filter((d) => d.isDirectory() && /^\d{8}-\d{6}_\d+$/.test(d.name));
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
  const all = [...byId.entries()].map(([reinsId, { runDir }]) => ({ reinsId, runDir }));
  log(`pickSample: ${entries.length} run subdirs → ${all.length} distinct reinsIds`);

  const rng = SAMPLE_SEED !== null ? mulberry32(SAMPLE_SEED) : null;
  const shuffled = shuffle(all, rng).slice(0, SAMPLE_SIZE);

  return shuffled.map(({ reinsId, runDir }) => {
    let motozuke = null;
    try {
      const reinsDataPath = path.join(runDir, "reins-data.json");
      if (fs.existsSync(reinsDataPath)) {
        const j = JSON.parse(fs.readFileSync(reinsDataPath, "utf8"));
        motozuke = j["商号"] || j.shogo || null;
      }
    } catch { /* ignore */ }
    return { reinsId, runDir, motozuke };
  });
}

// ── PDF capture (inlined from T001 findings doc) ────────────
async function downloadMaisokuPdf(page, savePath) {
  try {
    await page.click('button:has-text("画像・図面")', { timeout: 5000 });
    await page.waitForTimeout(1500);
  } catch { /* already open or unavailable */ }

  const hasBtn = await page.evaluate(() =>
    [...document.querySelectorAll("button")].some((b) => /図面参照/.test(b.textContent || ""))
  );
  if (!hasBtn) return { saved: false, reason: "図面参照 button not present" };

  const downloadPromise = page.waitForEvent("download", { timeout: 15000 });
  await page.click('button:has-text("図面参照")');
  let dl;
  try {
    dl = await downloadPromise;
  } catch (e) {
    return { saved: false, reason: `download event not fired: ${e.message}` };
  }
  const url = dl.url();
  const filename = dl.suggestedFilename();
  await dl.saveAs(savePath);
  const bytes = fs.statSync(savePath).size;
  return { saved: true, bytes, url, filename };
}

// ── extract zmnFlmi from getInitData JSON tree ──────────────
function extractZmnFlmi(json) {
  if (!json || typeof json !== "object") return "";
  // Common locations seen in T001: top-level, .data, .result. Also fall back to walking.
  const direct = json.zmnFlmi || json?.data?.zmnFlmi || json?.result?.zmnFlmi;
  if (typeof direct === "string") return direct;
  let found = "";
  (function walk(o) {
    if (found || !o || typeof o !== "object") return;
    for (const [k, v] of Object.entries(o)) {
      if (found) return;
      if (k === "zmnFlmi" && typeof v === "string") { found = v; return; }
      if (typeof v === "object") walk(v);
    }
  })(json);
  return found || "";
}

// ── pdftotext analysis ──────────────────────────────────────
// Threshold for "has a meaningful text layer". Empirically, scan-only PDFs
// produced by REINS leak 0-1 bytes (just a trailing newline) through
// pdftotext. The smallest *real* extraction observed was ~1.4 KB. Anything
// below MIN_MEANINGFUL_CHARS is treated as scan/OCR-required.
const MIN_MEANINGFUL_CHARS = 50;

function analyzePdfTextLayer(pdfPath) {
  // returns { method, chars, meaningfulChars, sample, ok, error? }
  try {
    const out = execSync(`pdftotext "${pdfPath}" -`, {
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
      timeout: 20000,
    });
    const text = out || "";
    const chars = text.length;
    // Strip whitespace to see how much *real* content survives.
    // (pdftotext on scan PDFs often emits one trailing \n only.)
    const compact = text.replace(/\s+/g, "");
    const meaningfulChars = compact.length;
    const trimmedForSample = text.replace(/\s+/g, " ").trim();
    return {
      method: "pdftotext",
      chars,
      meaningfulChars,
      sample: trimmedForSample.slice(0, 200),
      ok: meaningfulChars >= MIN_MEANINGFUL_CHARS,
    };
  } catch (e) {
    return {
      method: "pdftotext",
      chars: 0,
      meaningfulChars: 0,
      sample: "",
      ok: false,
      error: e.message.split("\n")[0].slice(0, 200),
    };
  }
}

// ── report writer ───────────────────────────────────────────
function writeReport(reportData) {
  const {
    runStartedAt, runFinishedAt, sweepCount, zmnNonEmpty, pdfResults, sampleSize,
  } = reportData;
  const scanPdfs = pdfResults.filter((r) => r.pdfDownloaded && !r.textLayer.ok);
  const textPdfs = pdfResults.filter((r) => r.pdfDownloaded && r.textLayer.ok);

  const lines = [];
  lines.push(`# Finding 02 — PDF text-layer probe`);
  lines.push(``);
  lines.push(`**Task**: Phase 4 (マイソク OCR) feasibility — measure whether REINS maisoku PDFs carry an embedded text layer (cheap) or require OCR (expensive).`);
  lines.push(``);
  lines.push(`**Date**: ${runStartedAt.slice(0, 10)}`);
  lines.push(`**Probe script**: \`code/suumo-dashboard/scripts/sample-maisoku-and-zmnflmi.js\``);
  lines.push(`**Run window**: ${runStartedAt} → ${runFinishedAt}`);
  lines.push(`**Sample size**: ${sampleSize} properties drawn from \`logs/runs/\` (distinct reinsIds, most-recent stamp per id)`);
  lines.push(``);
  lines.push(`---`);
  lines.push(``);
  lines.push(`## zmnFlmi sweep summary (Phase 4 task c)`);
  lines.push(``);
  const ownership = sweepCount > 0 ? ((zmnNonEmpty / sweepCount) * 100).toFixed(1) : "0.0";
  lines.push(`- sample = ${sweepCount}`);
  lines.push(`- non-empty zmnFlmi = ${zmnNonEmpty} (= **${ownership}%** maisoku ownership)`);
  lines.push(`- empty zmnFlmi = ${sweepCount - zmnNonEmpty}`);
  lines.push(``);
  lines.push(`Raw per-property log: \`.claude/do/findings/zmnflmi-sweep.jsonl\` (append-mode; one JSON record per property).`);
  lines.push(``);
  lines.push(`## PDF text-layer results (Phase 4 task b)`);
  lines.push(``);
  lines.push(`PDFs downloaded: ${pdfResults.filter((r) => r.pdfDownloaded).length} / target ${MAX_PDFS}`);
  lines.push(`- text-layer present (pdftotext > 0 char): ${textPdfs.length}`);
  lines.push(`- scan / no text layer (pdftotext 0 char or error): ${scanPdfs.length}`);
  lines.push(``);
  lines.push(`PDFs are classified as "text-layer present" iff non-whitespace pdftotext output >= ${MIN_MEANINGFUL_CHARS} chars. (Scan-only PDFs typically leak just a trailing newline through pdftotext.)`);
  lines.push(``);
  lines.push(`| # | reinsId | motozuke | size (bytes) | raw chars | meaningful chars | text layer? | sample (head 200) |`);
  lines.push(`|---|---|---|---|---|---|---|---|`);
  pdfResults.forEach((r, i) => {
    const sample = (r.textLayer?.sample || "").replace(/\|/g, "\\|").replace(/\n/g, " ");
    lines.push(`| ${i + 1} | ${r.reinsId} | ${r.motozuke || "(unknown)"} | ${r.pdfSize || 0} | ${r.textLayer?.chars ?? 0} | ${r.textLayer?.meaningfulChars ?? 0} | ${r.textLayer?.ok ? "yes" : "no"} | ${sample} |`);
  });
  lines.push(``);
  if (scanPdfs.length) {
    lines.push(`### Scan-PDF / OCR-required detail`);
    for (const r of scanPdfs) {
      const why = r.textLayer.error
        ? `error: ${r.textLayer.error}`
        : `meaningful chars = ${r.textLayer.meaningfulChars} (< ${MIN_MEANINGFUL_CHARS})`;
      lines.push(`- \`${r.reinsId}\`: ${why}`);
    }
    lines.push(``);
  }
  lines.push(`## Phase γ implication`);
  lines.push(``);
  const total = pdfResults.filter((r) => r.pdfDownloaded).length;
  if (total === 0) {
    lines.push(`No PDFs were captured in this run. Re-run with a larger \`SAMPLE_SIZE\` or fix capture errors before deciding on OCR fallback.`);
  } else {
    const scanRate = (scanPdfs.length / total) * 100;
    const textRate = (textPdfs.length / total) * 100;
    lines.push(`- text-layer hit rate = **${textRate.toFixed(0)}%** (${textPdfs.length}/${total}) → \`pdftotext\` is free and sufficient`);
    lines.push(`- scan-PDF rate = **${scanRate.toFixed(0)}%** (${scanPdfs.length}/${total}) → would need gpt-4o Vision OCR fallback at ~\\$0.01-0.02/property`);
    if (scanRate === 0) {
      lines.push(``);
      lines.push(`If this rate holds at scale, Phase γ (02c maisoku-text-extract) can ship with **pdftotext alone**; OCR fallback may be implemented later as a defensive path.`);
    } else if (scanRate < 30) {
      lines.push(``);
      lines.push(`Mixed mode is acceptable: implement pdftotext first, add Vision OCR fallback for the minority scan-only properties.`);
    } else {
      lines.push(``);
      lines.push(`OCR is critical path: design 02c with Vision-first or pdftotext-first-and-then-Vision-fallback depending on detection cost.`);
    }
  }
  lines.push(``);
  lines.push(`## launchctl ledger`);
  lines.push(``);
  for (const entry of reportData.launchctlLog) lines.push(`- ${entry}`);
  lines.push(``);
  lines.push(`## Re-run`);
  lines.push(``);
  lines.push("```sh");
  lines.push("launchctl unload ~/Library/LaunchAgents/jp.fango.watch-nyuko.plist  # (script does this)");
  lines.push("node scripts/sample-maisoku-and-zmnflmi.js");
  lines.push("# jsonl appends, so multi-run aggregation is built-in. To start fresh, rm zmnflmi-sweep.jsonl first.");
  lines.push("```");
  lines.push(``);
  fs.writeFileSync(REPORT_MD, lines.join("\n"));
  log(`report written → ${REPORT_MD}`);
}

// ── main ────────────────────────────────────────────────────
async function main() {
  fs.mkdirSync(FINDINGS_DIR, { recursive: true });
  fs.mkdirSync(PDFS_DIR, { recursive: true });

  const runStartedAt = ts();
  const launchctlLog = [];
  launchctlLog.push(`unload at ${ts()}`);
  launchctlAction("unload");

  const sample = pickSample();
  log(`sample size = ${sample.length} (target ${SAMPLE_SIZE})`);
  if (sample.length === 0) {
    throw new Error("pickSample returned empty — logs/runs/ contains no valid subdirs");
  }

  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext({
    viewport: { width: 1280, height: 900 },
    acceptDownloads: true,
  });
  const page = await context.newPage();

  const sweepResults = []; // for in-memory aggregation; jsonl is also appended live
  const pdfResults = [];   // for properties where we attempted a PDF download
  let pdfDownloadedCount = 0;

  try {
    log("REINS login…");
    const ok = await reins.login(page, {
      id: process.env.REINS_LOGIN_ID,
      pass: process.env.REINS_LOGIN_PASS,
    });
    if (!ok) {
      throw new Error("REINS login failed (check .env.local REINS_LOGIN_ID/REINS_LOGIN_PASS)");
    }
    log("login OK");

    for (let i = 0; i < sample.length; i++) {
      const { reinsId, motozuke } = sample[i];
      log(`── ${i + 1}/${sample.length}: ${reinsId} (motozuke=${motozuke || "?"}) ──`);

      // Navigate back to dashboard for 2nd+ iteration (skills/reins pattern)
      if (i > 0) {
        try {
          await page.goto("https://system.reins.jp/main/KG/GKG003100", {
            waitUntil: "networkidle", timeout: 20000,
          });
          await page.waitForTimeout(2500);
        } catch (e) {
          log(`  goto dashboard failed: ${e.message}`);
        }
      }

      // Scoped to property-detail (T001 finding: bare /getInitData hits dashboard menu too).
      const initDataPromise = page.waitForResponse(
        (r) => /\/BK\/GBK003200\/getInitData/.test(r.url()) && r.status() === 200,
        { timeout: 25000 }
      ).catch(() => null);

      const sweepRecord = {
        reinsId,
        motozuke: motozuke || null,
        zmnFlmi: "",
        zmnFlmiPresent: false,
        searchFound: false,
        pdfDownloaded: false,
        pdfPath: null,
        pdfSize: 0,
        downloadReason: null,
        timestamp: ts(),
      };

      let found = false;
      try {
        found = await reins.searchByNumber(page, reinsId);
      } catch (e) {
        log(`  searchByNumber threw: ${e.message}`);
      }
      sweepRecord.searchFound = !!found;
      if (!found) {
        log(`  not found on REINS — recording zmnFlmi="" and skipping PDF`);
        sweepResults.push(sweepRecord);
        fs.appendFileSync(SWEEP_JSONL, JSON.stringify(sweepRecord) + "\n");
        continue;
      }

      // Click "詳細" to enter property-detail page — triggers GBK003200/getInitData
      try {
        await page.click('button:has-text("詳細")', { timeout: 8000 });
      } catch (e) {
        log(`  detail click failed: ${e.message}`);
        sweepResults.push(sweepRecord);
        fs.appendFileSync(SWEEP_JSONL, JSON.stringify(sweepRecord) + "\n");
        continue;
      }
      await page.waitForTimeout(3500);

      const initResp = await initDataPromise;
      if (initResp) {
        try {
          const j = await initResp.json();
          const z = extractZmnFlmi(j);
          sweepRecord.zmnFlmi = z;
          sweepRecord.zmnFlmiPresent = !!z;
          log(`  zmnFlmi="${z}"`);
        } catch (e) {
          log(`  getInitData JSON parse error: ${e.message}`);
        }
      } else {
        log(`  getInitData response not captured`);
      }

      // PDF download path: only when zmnFlmi is non-empty AND we still need more PDFs
      const shouldFetchPdf = sweepRecord.zmnFlmiPresent && pdfDownloadedCount < MAX_PDFS;
      if (shouldFetchPdf) {
        const pdfPath = path.join(PDFS_DIR, `${reinsId}.pdf`);
        const dlRes = await downloadMaisokuPdf(page, pdfPath);
        if (dlRes.saved) {
          sweepRecord.pdfDownloaded = true;
          sweepRecord.pdfPath = path.relative(PROJECT_ROOT, pdfPath);
          sweepRecord.pdfSize = dlRes.bytes;
          pdfDownloadedCount += 1;
          log(`  ✓ PDF saved (${dlRes.bytes} bytes) → ${sweepRecord.pdfPath}`);

          const textLayer = analyzePdfTextLayer(pdfPath);
          pdfResults.push({
            reinsId,
            motozuke: motozuke || null,
            pdfDownloaded: true,
            pdfSize: dlRes.bytes,
            pdfPath: sweepRecord.pdfPath,
            textLayer,
          });
          log(`  pdftotext: chars=${textLayer.chars} ok=${textLayer.ok}`);
        } else {
          sweepRecord.downloadReason = dlRes.reason || "unknown";
          log(`  PDF not saved: ${sweepRecord.downloadReason}`);
        }
      } else if (sweepRecord.zmnFlmiPresent) {
        sweepRecord.downloadReason = "MAX_PDFS reached, skipped";
      } else {
        sweepRecord.downloadReason = "zmnFlmi empty";
      }

      sweepResults.push(sweepRecord);
      fs.appendFileSync(SWEEP_JSONL, JSON.stringify(sweepRecord) + "\n");
    }
  } finally {
    try { await browser.close(); } catch { /* noop */ }
    launchctlLog.push(`load at ${ts()}`);
    launchctlAction("load");
  }

  const runFinishedAt = ts();
  const zmnNonEmpty = sweepResults.filter((r) => r.zmnFlmiPresent).length;
  log(`sweep done: ${sweepResults.length} properties, ${zmnNonEmpty} with non-empty zmnFlmi`);
  log(`PDFs downloaded: ${pdfDownloadedCount} / ${MAX_PDFS}`);

  writeReport({
    runStartedAt,
    runFinishedAt,
    sweepCount: sweepResults.length,
    zmnNonEmpty,
    pdfResults,
    sampleSize: SAMPLE_SIZE,
    launchctlLog,
  });

  log("DONE");
}

main().catch((e) => {
  log(`FATAL: ${e.stack || e.message}`);
  // Best-effort re-load even if something exploded before the finally block ran.
  try { launchctlAction("load"); } catch { /* noop */ }
  process.exit(1);
});
