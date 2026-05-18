#!/usr/bin/env node
/**
 * daily-aggregate-phase-delta.js — Phase ε/ζ Step 5: daily aggregate framework
 *
 * 1 日分 (24h, JST) の logs/runs/{ts}_ artifacts を scan して 6 軸メトリクスを集計し、
 * Phase ε/ζ 安定運用フェーズの効果を時系列で観察する。
 *
 * 6 axes (per phase-epsilon-design.md §6):
 *   1. 02b/02c chain        — maisoku download rate / source (pdftotext|vision-ocr) breakdown / OCR cost
 *   2. 03b source breakdown — maisoku 純増 codes / 物件 (mean/median) / maisoku 経路発火率
 *   3. DOM 突合             — exact / missed / phantom 比率 (Step 1, T003 lib に委譲)
 *   4. score                — median / p25 / p75 / escalation rate (Step 4, T005 lib に委譲)
 *   5. 否定語 FP            — Step 3 (T003 lib に委譲)
 *   6. source breakdown agg — Step 2 (lib-dom-match の buildSourceBreakdown で計算 or pure 実装)
 *
 * 設計原則:
 *   - T003 (lib-dom-match.js) / T005 (lib-score-extract.js) が未実装でも graceful fallback
 *     (該当指標を null + warnings に "placeholder, T003/T005 完成後に再生成" を追加)
 *   - 既存 launchd 管理 routine (jp.fango.watch-nyuko) は無触り (このスクリプトは launchctl を呼ばない)
 *   - JST 日付フィルタは ts プレフィックス (YYYYMMDD) で match (タイムゾーン変換不要)
 *
 * 仕様参照:
 *   docs/refactor/phase-epsilon-design.md §6 (Daily aggregate) / §8 (JSDoc typedef) / §9 (edge cases) / §10 (report format)
 *
 * CLI:
 *   node scripts/daily-aggregate-phase-delta.js [--date=YYYY-MM-DD] [--out=logs/measure/daily] [--runs=logs/runs]
 *
 * デフォルト:
 *   --date: 今日 (JST、process 起動時刻)
 *   --out:  logs/measure/daily
 *   --runs: logs/runs
 *
 * 出力:
 *   {out}/{YYYY-MM-DD}.json   (DailyReport per §10.1)
 *   {out}/{YYYY-MM-DD}.md     (1-pager markdown per §6.4)
 */

const fs = require("fs");
const path = require("path");

// ── T003 / T005 lib import (graceful fallback) ─────────────────────────────
// TODO(T003): scripts/measure/lib-dom-match.js を実装次第、import 経由で
//   - buildDomMatchResult(run03bOutput, confirmHtmlStr, codeLabelMap) → DomMatchResult
//   - buildSourceBreakdown(evidenceMap) → SourceBreakdown
//   - analyzeNegationFP(maisokuText, featureCodesConfig, emittedMaisokuCodes) → NegationAnalysis
// を再利用する (重複実装禁止)。下記 try/catch 部の require path を T003 完成時に確定する。
//
// TODO(T005): scripts/measure/lib-score-extract.js を実装次第、import 経由で
//   - computeRunScore(runJson) → number | null
//   - computeScoreStats(scoresArray) → ScoreStats
// を再利用する。
const LIB_DOM_MATCH_PATH = path.join(__dirname, "measure", "lib-dom-match.js");
const LIB_SCORE_EXTRACT_PATH = path.join(__dirname, "measure", "lib-score-extract.js");
const LIB_ZETA_COLLECTOR_PATH = path.join(__dirname, "measure", "lib-zeta-collector.js");

let libDomMatch = null;
let libScoreExtract = null;
let libZetaCollector = null;
const importDeficits = [];

try {
  libDomMatch = require(LIB_DOM_MATCH_PATH);
} catch (e) {
  importDeficits.push(`lib-dom-match.js not found (${LIB_DOM_MATCH_PATH}) — DOM 突合 / source breakdown / 否定語 FP 指標は placeholder`);
}
try {
  libScoreExtract = require(LIB_SCORE_EXTRACT_PATH);
} catch (e) {
  importDeficits.push(`lib-score-extract.js not found (${LIB_SCORE_EXTRACT_PATH}) — score median / escalation rate は run.json#score を直接読む暫定実装で代用`);
}
try {
  libZetaCollector = require(LIB_ZETA_COLLECTOR_PATH);
} catch (e) {
  importDeficits.push(`lib-zeta-collector.js not found (${LIB_ZETA_COLLECTOR_PATH}) — Phase ζ 3 監視フィールド (cascade / image_insufficient / vision_21) は欠落`);
}

// ── Path constants ─────────────────────────────────────────────────────────
const REPO_ROOT = path.resolve(__dirname, "..");
const DEFAULT_RUNS_DIR = path.join(REPO_ROOT, "logs", "runs");
const DEFAULT_OUT_DIR = path.join(REPO_ROOT, "logs", "measure", "daily");
const FEATURE_CODES_CONFIG_PATH = path.join(REPO_ROOT, "config", "forrent-feature-codes.json");

// ── CLI argument parsing ───────────────────────────────────────────────────
function parseArgs(argv) {
  const args = { date: null, out: null, runs: null };
  for (const a of argv.slice(2)) {
    const m = a.match(/^--([a-z]+)=(.+)$/);
    if (m) args[m[1]] = m[2];
  }
  return args;
}

function jstTodayISO() {
  // Node 標準 toLocaleString で JST 日付を確実に取得
  // ("Asia/Tokyo" を明示)
  const now = new Date();
  const jst = new Date(now.toLocaleString("en-US", { timeZone: "Asia/Tokyo" }));
  const y = jst.getFullYear();
  const m = String(jst.getMonth() + 1).padStart(2, "0");
  const d = String(jst.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function dateToTsPrefix(dateStr) {
  // "2026-05-17" → "20260517"
  return dateStr.replace(/-/g, "");
}

// ── Run scanning ───────────────────────────────────────────────────────────
function listRunsForDate(runsDir, dateStr) {
  const prefix = dateToTsPrefix(dateStr);
  if (!fs.existsSync(runsDir)) return [];
  const entries = fs.readdirSync(runsDir, { withFileTypes: true });
  return entries
    .filter((e) => e.isDirectory() && e.name.startsWith(prefix + "-"))
    .map((e) => path.join(runsDir, e.name))
    .sort();
}

function safeReadJson(filePath) {
  if (!fs.existsSync(filePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (e) {
    return null;
  }
}

function safeReadText(filePath) {
  if (!fs.existsSync(filePath)) return null;
  try {
    return fs.readFileSync(filePath, "utf8");
  } catch (e) {
    return null;
  }
}

/**
 * 1 run の artifacts を集約する。欠落 artifact は null で記録 (§9 edge cases 準拠)
 *
 * Phase ζ 拡張 (T004, 2026-05-17): additive で `out02` (02-images-download) と
 * `out03Classify` (03-images-classify) を追加。既存 destructuring 句は無破壊。
 * (phase-zeta-collector-spec.md §7.3 参照)
 */
function loadRunArtifacts(runDir) {
  const runJson = safeReadJson(path.join(runDir, "run.json"));
  const reinsData = safeReadJson(path.join(runDir, "reins-data.json"));
  const out02 = safeReadJson(path.join(runDir, "02-images-download", "output.json"));
  const out02b = safeReadJson(path.join(runDir, "02b-maisoku-fetch", "output.json"));
  const out02c = safeReadJson(path.join(runDir, "02c-maisoku-text-extract", "output.json"));
  const out03Classify = safeReadJson(path.join(runDir, "03-images-classify", "output.json"));
  const out03b = safeReadJson(path.join(runDir, "03b-feature-codes-resolve", "output.json"));
  const confirmHtml = safeReadText(path.join(runDir, "confirm-attempt1.html"));
  return {
    runDir,
    runJson,
    reinsData,
    out02,
    out02b,
    out02c,
    out03Classify,
    out03b,
    confirmHtml,
  };
}

// ── Source breakdown (Step 2、03b evidence から純粋計算可能) ──────────────
//
// T003 lib に同関数を持たせる予定だが、daily aggregate は本関数が無いと 6 軸の 1 軸が
// まるごと埋められないため pure 実装を inline で保持。T003 完成時は lib に統合する。
//
// TODO(T003): T003 で lib-dom-match.js#buildSourceBreakdown が実装されたら
// 本関数を削除し libDomMatch.buildSourceBreakdown を直接呼ぶ。
function buildSourceBreakdownLocal(evidenceMap) {
  if (!evidenceMap || typeof evidenceMap !== "object") {
    return { maisoku_pure: [], maisoku_overlap: [], legacy_only: [], maisoku_net_gain: 0 };
  }
  const maisokuPure = [];
  const maisokuOverlap = [];
  const legacyOnly = [];
  for (const [code, entries] of Object.entries(evidenceMap)) {
    if (!Array.isArray(entries) || entries.length === 0) continue;
    const sources = new Set(entries.map((e) => e && e.source).filter(Boolean));
    const hasMaisoku = sources.has("maisoku");
    if (hasMaisoku && sources.size === 1) maisokuPure.push(code);
    else if (hasMaisoku) maisokuOverlap.push(code);
    else legacyOnly.push(code);
  }
  return {
    maisoku_pure: maisokuPure,
    maisoku_overlap: maisokuOverlap,
    legacy_only: legacyOnly,
    maisoku_net_gain: maisokuPure.length + maisokuOverlap.length,
  };
}

// ── Score extract (Step 4 暫定実装、T005 で置き換え) ──────────────────────
//
// TODO(T005): T005 で lib-score-extract.js が実装されたら libScoreExtract.computeRunScore に
// 置き換える (confirm-attempt1.html regex fallback と validation-after-escalate.json 経路を含む)。
// 現状は run.json#score のみを参照する暫定実装。
function getRunScoreLocal(runJson) {
  if (!runJson) return null;
  if (typeof runJson.score === "number") return runJson.score;
  return null;
}

// ── Stats helpers ──────────────────────────────────────────────────────────
function median(values) {
  const sorted = values.slice().sort((a, b) => a - b);
  const n = sorted.length;
  if (n === 0) return null;
  if (n % 2 === 1) return sorted[(n - 1) / 2];
  return (sorted[n / 2 - 1] + sorted[n / 2]) / 2;
}

function percentile(values, p) {
  const sorted = values.slice().sort((a, b) => a - b);
  const n = sorted.length;
  if (n === 0) return null;
  const idx = Math.min(n - 1, Math.max(0, Math.floor((p / 100) * n)));
  return sorted[idx];
}

function mean(values) {
  if (!values.length) return null;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

function safeRate(num, denom) {
  if (!denom) return null;
  return num / denom;
}

function round(n, digits = 4) {
  if (n === null || n === undefined || Number.isNaN(n)) return null;
  const f = Math.pow(10, digits);
  return Math.round(n * f) / f;
}

// ── Aggregation ────────────────────────────────────────────────────────────
function aggregate(runs, dateStr) {
  const warnings = [];
  if (importDeficits.length > 0) {
    for (const d of importDeficits) warnings.push(d);
  }

  // 02b / 02c metrics
  const totalRuns = runs.length;
  let runsWith03b = 0;
  let runsWithConfirm = 0;
  let downloadCount = 0;
  let pdftotextCount = 0;
  let visionOcrCount = 0;
  let skippedOcrCount = 0;
  let ocrCostTotal = 0;
  const maisokuNetGains = [];
  const maisokuPureCounts = [];
  const maisokuOverlapCounts = [];
  const legacyOnlyCounts = [];

  let maisokuHitRuns = 0; // 03b で maisoku 経路から少なくとも 1 code 追加した run 数

  // score
  const scores = [];
  let escalatedCount = 0;

  // DOM match (T003 待ち)
  const domMatchResults = [];
  let domMatchRunsCounted = 0;

  // 否定語 FP (T003 待ち)
  const negationFpResults = [];

  for (const r of runs) {
    // 02b downloadEvent
    if (r.out02b && r.out02b.downloadEvent === "download") {
      downloadCount += 1;
    }
    // 02c source breakdown
    if (r.out02c) {
      const src = r.out02c.source;
      if (src === "pdftotext") pdftotextCount += 1;
      else if (src === "vision-ocr") visionOcrCount += 1;
      else if (src === "skipped") skippedOcrCount += 1;
      if (typeof r.out02c.visionCostUSD === "number") {
        ocrCostTotal += r.out02c.visionCostUSD;
        if (r.out02c.visionCostUSD >= 0.05) {
          warnings.push(
            `OCR cost WARN threshold ($0.05) hit: ${path.basename(r.runDir)} cost=$${r.out02c.visionCostUSD}`
          );
        }
      }
    }
    // 03b breakdown
    if (r.out03b) {
      runsWith03b += 1;
      const breakdown = libDomMatch && typeof libDomMatch.buildSourceBreakdown === "function"
        ? libDomMatch.buildSourceBreakdown(r.out03b.evidence)
        : buildSourceBreakdownLocal(r.out03b.evidence);
      maisokuPureCounts.push(breakdown.maisoku_pure.length);
      maisokuOverlapCounts.push(breakdown.maisoku_overlap.length);
      legacyOnlyCounts.push(breakdown.legacy_only.length);
      maisokuNetGains.push(breakdown.maisoku_net_gain);
      if (breakdown.maisoku_net_gain > 0) maisokuHitRuns += 1;
    }
    if (r.confirmHtml) runsWithConfirm += 1;

    // DOM 突合 (T003 lib に委譲、未実装時は skip)
    if (libDomMatch && typeof libDomMatch.buildDomMatchResult === "function" && r.out03b && r.confirmHtml) {
      try {
        const codeLabelMap = libDomMatch.getCodeLabelMap && libDomMatch.getCodeLabelMap();
        const m = libDomMatch.buildDomMatchResult(r.out03b, r.confirmHtml, codeLabelMap);
        if (m && m.status === "ok") {
          domMatchResults.push(m);
          domMatchRunsCounted += 1;
        }
      } catch (e) {
        warnings.push(`DOM 突合失敗 ${path.basename(r.runDir)}: ${e.message}`);
      }
    }

    // 否定語 FP (T003 lib に委譲)
    if (libDomMatch && typeof libDomMatch.analyzeNegationFP === "function" && r.out02c && r.out03b) {
      try {
        const maisokuText = (r.out02c && r.out02c.maisokuText) || "";
        const featureCodesConfig = safeReadJson(FEATURE_CODES_CONFIG_PATH);
        const codesArray = featureCodesConfig && featureCodesConfig.codes ? featureCodesConfig.codes : [];
        const evidenceMap = r.out03b.evidence || {};
        const emittedMaisoku = Object.entries(evidenceMap)
          .filter(([, ents]) => Array.isArray(ents) && ents.some((e) => e && e.source === "maisoku"))
          .map(([code]) => code);
        const fp = libDomMatch.analyzeNegationFP(maisokuText, codesArray, emittedMaisoku);
        if (fp) negationFpResults.push(fp);
      } catch (e) {
        warnings.push(`否定語 FP 分析失敗 ${path.basename(r.runDir)}: ${e.message}`);
      }
    }

    // score
    const score = libScoreExtract && typeof libScoreExtract.computeRunScore === "function"
      ? libScoreExtract.computeRunScore(r.runJson)
      : getRunScoreLocal(r.runJson);
    if (typeof score === "number") {
      scores.push(score);
      if (score >= 34) escalatedCount += 1;
    }
  }

  const totalOcrCalls = pdftotextCount + visionOcrCount;
  const ocrCostPerRun = totalOcrCalls > 0 ? ocrCostTotal / totalOcrCalls : null;

  // DOM aggregate
  const domAgg = {
    runs_matched: domMatchRunsCounted,
    exact_rate_mean: domMatchResults.length
      ? round(mean(domMatchResults.map((r) => r.exact_rate ?? 0)), 4)
      : null,
    phantom_rate_mean: domMatchResults.length
      ? round(mean(domMatchResults.map((r) => r.phantom_rate ?? 0)), 4)
      : null,
    miss_rate_mean: domMatchResults.length
      ? round(mean(domMatchResults.map((r) => r.miss_rate ?? 0)), 4)
      : null,
    fp_rate_mean: negationFpResults.length
      ? round(mean(negationFpResults.map((r) => r.fp_rate ?? 0)), 4)
      : null,
    status: domMatchResults.length ? "ok" : "placeholder_T003_pending",
  };

  if (domMatchResults.length === 0) {
    warnings.push(
      "DOM 突合 / 否定語 FP 指標は placeholder, T003 (lib-dom-match.js) 完成後に再生成"
    );
  }
  if (!libScoreExtract) {
    warnings.push(
      "score 指標は run.json#score を直接読む暫定実装で計算済, T005 (lib-score-extract.js) 完成後に validation-after-escalate / confirm-attempt1 fallback を含む正確版で再生成"
    );
  }

  // ── Phase ζ 3 monitoring fields (T004, 2026-05-17) ──────────────────────
  // Spec: docs/refactor/phase-zeta-collector-spec.md §1.4 / §3 / §4 / §5.
  // Pure-function delegate to libZetaCollector. additive: existing 5 keys 不変。
  const zetaRecords = runs.map((r) => ({
    runDir: r.runDir,
    out02: r.out02,
    out03Classify: r.out03Classify,
  }));

  let zetaBlock = null;
  if (libZetaCollector) {
    const cascade = libZetaCollector.computeCascadeStats(zetaRecords);
    const imageInsufficient = libZetaCollector.computeImageInsufficientStats(zetaRecords);
    const vision = libZetaCollector.computeVision21Stats(zetaRecords);

    zetaBlock = {
      cascade: {
        ...cascade,
        cascade_hit_rate: round(cascade.cascade_hit_rate, 4),
      },
      image_insufficient: {
        ...imageInsufficient,
        rate: round(imageInsufficient.rate, 4),
      },
      vision: {
        ...vision,
        vision_21_rate: round(vision.vision_21_rate, 4),
      },
    };

    // Threshold warnings (§10.1)
    if (
      cascade.cascade_hit_rate !== null &&
      cascade.cascade_attempted_runs > 0 &&
      cascade.cascade_hit_rate < 0.30
    ) {
      warnings.push(
        `CASCADE WARN: cascade_hit_rate=${(cascade.cascade_hit_rate * 100).toFixed(1)}% < 30% ` +
          `(attempted=${cascade.cascade_attempted_runs}, hit=${cascade.cascade_hit_runs})`
      );
    }
    if (imageInsufficient.rate !== null && imageInsufficient.rate > 0.30) {
      const sev = imageInsufficient.rate > 0.50 ? "CRITICAL" : "WARN";
      warnings.push(
        `IMAGE_INSUFFICIENT ${sev}: rate=${(imageInsufficient.rate * 100).toFixed(1)}% > 30% ` +
          `(count=${imageInsufficient.count}, total=${imageInsufficient.total_runs})`
      );
    }
    if (vision.vision_21_rate !== null) {
      if (vision.vision_21_rate > 0.25) {
        warnings.push(
          `VISION CRITICAL: vision_21_rate=${(vision.vision_21_rate * 100).toFixed(1)}% > 25% ` +
            `(cf. 2026-05-14 シンク誤分類事件、OpenAI quota 超過の leading indicator)`
        );
      } else if (vision.vision_21_rate > 0.15) {
        warnings.push(
          `VISION WARN: vision_21_rate=${(vision.vision_21_rate * 100).toFixed(1)}% > 15% ` +
            `(category_21=${vision.category_21_count}, total=${vision.total_images_classified})`
        );
      }
    }
  }

  const report = {
    date: dateStr,
    generated_at: new Date().toISOString(),
    maisoku: {
      total_runs: totalRuns,
      runs_with_03b: runsWith03b,
      runs_with_confirm: runsWithConfirm,
      maisoku_download_rate: round(safeRate(downloadCount, runsWith03b), 4),
      pdftotext_rate: round(safeRate(pdftotextCount, runsWith03b), 4),
      vision_ocr_rate: round(safeRate(visionOcrCount, runsWith03b), 4),
      skipped_rate: round(safeRate(skippedOcrCount, runsWith03b), 4),
      ocr_cost_total_usd: round(ocrCostTotal, 4),
      ocr_cost_per_run: round(ocrCostPerRun, 4),
      maisoku_net_gain_mean: round(mean(maisokuNetGains), 2),
      source_breakdown_agg: {
        maisoku_pure_mean: round(mean(maisokuPureCounts), 2),
        maisoku_overlap_mean: round(mean(maisokuOverlapCounts), 2),
        legacy_only_mean: round(mean(legacyOnlyCounts), 2),
      },
    },
    dom: domAgg,
    score: {
      all_runs: {
        n: scores.length,
        min: scores.length ? Math.min(...scores) : null,
        max: scores.length ? Math.max(...scores) : null,
        median: round(median(scores), 2),
        p25: round(percentile(scores, 25), 2),
        p75: round(percentile(scores, 75), 2),
        mean: round(mean(scores), 2),
      },
      escalation_rate: round(safeRate(escalatedCount, scores.length), 4),
      maisoku_hit_runs: maisokuHitRuns,
      maisoku_hit_rate: round(safeRate(maisokuHitRuns, runsWith03b), 4),
    },
    warnings,
  };

  if (zetaBlock) {
    report.zeta = zetaBlock;
  }

  return report;
}

// ── Markdown rendering ─────────────────────────────────────────────────────
function renderMarkdown(report) {
  const m = report.maisoku;
  const d = report.dom;
  const s = report.score;

  const pct = (n) => (n === null || n === undefined ? "—" : `${(n * 100).toFixed(1)}%`);
  const num = (n) => (n === null || n === undefined ? "—" : String(n));

  const lines = [];
  lines.push(`# Phase ε/ζ Daily Report — ${report.date}`);
  lines.push("");
  lines.push(`generated_at: ${report.generated_at}`);
  lines.push("");
  lines.push("## Maisoku Chain (02b / 02c / 03b)");
  lines.push("");
  lines.push("| Metric | Value | Target |");
  lines.push("|--------|-------|--------|");
  lines.push(`| total runs (今日) | ${num(m.total_runs)} | — |`);
  lines.push(`| runs with 03b output.json | ${num(m.runs_with_03b)} | — |`);
  lines.push(`| runs with confirm-attempt1.html | ${num(m.runs_with_confirm)} | ≥ 10 for DOM 突合 |`);
  lines.push(`| 02b download rate | ${pct(m.maisoku_download_rate)} | ≥ 60% (REINS-resolved 限定) |`);
  lines.push(`| 02c pdftotext rate | ${pct(m.pdftotext_rate)} | (参考: smoke 67%) |`);
  lines.push(`| 02c vision-ocr rate | ${pct(m.vision_ocr_rate)} | (参考: smoke 33%) |`);
  lines.push(`| 02c skipped rate | ${pct(m.skipped_rate)} | (zmnFlmi 空率) |`);
  lines.push(`| OCR cost total ($) | ${num(m.ocr_cost_total_usd)} | — |`);
  lines.push(`| OCR cost per OCR call ($) | ${num(m.ocr_cost_per_run)} | ≤ $0.05 WARN |`);
  lines.push(`| maisoku net gain (mean codes / 物件) | ${num(m.maisoku_net_gain_mean)} | ≥ 5 (smoke +7.2) |`);
  lines.push(`| source breakdown: maisoku_pure mean | ${num(m.source_breakdown_agg.maisoku_pure_mean)} | — |`);
  lines.push(`| source breakdown: maisoku_overlap mean | ${num(m.source_breakdown_agg.maisoku_overlap_mean)} | — |`);
  lines.push(`| source breakdown: legacy_only mean | ${num(m.source_breakdown_agg.legacy_only_mean)} | — |`);
  lines.push("");
  lines.push("## DOM Ground Truth (Step 1-3)");
  lines.push("");
  lines.push("| Metric | Value | Target |");
  lines.push("|--------|-------|--------|");
  lines.push(`| status | ${d.status} | ok 期待 (T003 完成後) |`);
  lines.push(`| DOM 突合実施 run 数 | ${num(d.runs_matched)} | ≥ 10 / day |`);
  lines.push(`| exact_rate (mean) | ${pct(d.exact_rate_mean)} | ≥ 95% |`);
  lines.push(`| phantom_rate (mean) | ${pct(d.phantom_rate_mean)} | ≤ 5% |`);
  lines.push(`| miss_rate (mean) | ${pct(d.miss_rate_mean)} | ≤ 5% |`);
  lines.push(`| negation FP rate (mean) | ${pct(d.fp_rate_mean)} | ≤ 10% |`);
  lines.push("");
  lines.push("## Score (Step 4)");
  lines.push("");
  lines.push("| Metric | Today | Baseline (Group A) |");
  lines.push("|--------|-------|--------------------|");
  lines.push(`| n (with score) | ${num(s.all_runs.n)} | 41 |`);
  lines.push(`| min / max | ${num(s.all_runs.min)} / ${num(s.all_runs.max)} | 8 / 41 |`);
  lines.push(`| median | ${num(s.all_runs.median)} | 32 |`);
  lines.push(`| p25 / p75 | ${num(s.all_runs.p25)} / ${num(s.all_runs.p75)} | — |`);
  lines.push(`| mean | ${num(s.all_runs.mean)} | 31.6 |`);
  lines.push(`| escalation rate (≥34) | ${pct(s.escalation_rate)} | 24% (5/21) |`);
  lines.push(`| maisoku hit runs | ${num(s.maisoku_hit_runs)} | 0 (Phase β) |`);
  lines.push(`| maisoku hit rate | ${pct(s.maisoku_hit_rate)} | — |`);
  lines.push("");
  lines.push("## Warnings");
  lines.push("");
  if (report.warnings.length === 0) {
    lines.push("(なし)");
  } else {
    for (const w of report.warnings) lines.push(`- ${w}`);
  }
  lines.push("");

  // ── Phase ζ Monitoring (T004) ─────────────────────────────────────────
  // graceful absent: 古い JSON (zeta key 無し) でも例外を出さない (integration_E)
  if (report.zeta) {
    const z = report.zeta;
    const c = z.cascade || {};
    const ii = z.image_insufficient || {};
    const v = z.vision || {};

    lines.push("## Phase ζ Monitoring");
    lines.push("");
    lines.push("### Cascade Hit Rate (Phase 3a itandi)");
    lines.push("");
    lines.push("| Metric | Value | Target |");
    lines.push("|--------|-------|--------|");
    lines.push(`| image_insufficient_runs | ${num(c.image_insufficient_runs)} | — |`);
    lines.push(`| cascade_attempted_runs | ${num(c.cascade_attempted_runs)} | — |`);
    lines.push(`| cascade_hit_runs | ${num(c.cascade_hit_runs)} | — |`);
    lines.push(`| cascade_miss_runs | ${num(c.cascade_miss_runs)} | — |`);
    lines.push(`| cascade_hit_rate | ${pct(c.cascade_hit_rate)} | ≥ 50% healthy / < 30% WARN |`);
    lines.push(
      `| platforms_seen | ${Array.isArray(c.platforms_seen) && c.platforms_seen.length ? c.platforms_seen.join(", ") : "—"} | itandi (Phase 3a) |`
    );
    lines.push("");
    lines.push("### Image Insufficient Count");
    lines.push("");
    lines.push("| Metric | Value | Target |");
    lines.push("|--------|-------|--------|");
    lines.push(`| count | ${num(ii.count)} | — |`);
    lines.push(`| total_runs | ${num(ii.total_runs)} | — |`);
    lines.push(`| rate | ${pct(ii.rate)} | 0–30% healthy / > 30% WARN / > 50% CRITICAL |`);
    const rawDistKeys = ii.raw_count_distribution && typeof ii.raw_count_distribution === "object"
      ? Object.keys(ii.raw_count_distribution).sort()
      : [];
    if (rawDistKeys.length > 0) {
      const distStr = rawDistKeys.map((k) => `${k}=${ii.raw_count_distribution[k]}`).join(", ");
      lines.push(`| raw_count_distribution | ${distStr} | — |`);
    } else {
      lines.push(`| raw_count_distribution | — | — |`);
    }
    lines.push("");
    lines.push("### Vision Category 21 (\"その他\") Misclassify Rate");
    lines.push("");
    lines.push("| Metric | Value | Target |");
    lines.push("|--------|-------|--------|");
    lines.push(`| total_images_classified (excl SH) | ${num(v.total_images_classified)} | — |`);
    lines.push(`| category_21_count | ${num(v.category_21_count)} | — |`);
    lines.push(`| vision_21_rate | ${pct(v.vision_21_rate)} | 0–10% healthy / > 15% WARN / > 25% CRITICAL |`);
    lines.push(`| runs_with_classify_output | ${num(v.runs_with_classify_output)} | — |`);
    const catDistKeys = v.category_distribution && typeof v.category_distribution === "object"
      ? Object.keys(v.category_distribution).sort()
      : [];
    if (catDistKeys.length > 0) {
      const catDistStr = catDistKeys.map((k) => `${k}=${v.category_distribution[k]}`).join(", ");
      lines.push(`| category_distribution (incl SH) | ${catDistStr} | — |`);
    } else {
      lines.push(`| category_distribution (incl SH) | — | — |`);
    }
    lines.push("");
  }
  return lines.join("\n");
}

// ── Output ─────────────────────────────────────────────────────────────────
function writeReport(outDir, dateStr, report, markdown) {
  fs.mkdirSync(outDir, { recursive: true });
  const jsonPath = path.join(outDir, `${dateStr}.json`);
  const mdPath = path.join(outDir, `${dateStr}.md`);
  fs.writeFileSync(jsonPath, JSON.stringify(report, null, 2));
  fs.writeFileSync(mdPath, markdown);
  return { jsonPath, mdPath };
}

// ── Main ───────────────────────────────────────────────────────────────────
function main() {
  const args = parseArgs(process.argv);
  const dateStr = args.date || jstTodayISO();
  const outDir = path.resolve(args.out || DEFAULT_OUT_DIR);
  const runsDir = path.resolve(args.runs || DEFAULT_RUNS_DIR);

  console.log(`[daily-aggregate] date=${dateStr} runs=${runsDir} out=${outDir}`);

  const runDirs = listRunsForDate(runsDir, dateStr);
  console.log(`[daily-aggregate] scanned ${runDirs.length} run dir(s) for ${dateStr}`);

  const artifacts = runDirs.map(loadRunArtifacts);
  const report = aggregate(artifacts, dateStr);
  const markdown = renderMarkdown(report);
  const { jsonPath, mdPath } = writeReport(outDir, dateStr, report, markdown);

  console.log(`[daily-aggregate] wrote ${jsonPath}`);
  console.log(`[daily-aggregate] wrote ${mdPath}`);
  console.log(
    `[daily-aggregate] summary: runs=${report.maisoku.total_runs} ` +
      `w03b=${report.maisoku.runs_with_03b} wConfirm=${report.maisoku.runs_with_confirm} ` +
      `maisokuHit=${report.score.maisoku_hit_runs} medianScore=${report.score.all_runs.median} ` +
      `warnings=${report.warnings.length}`
  );
}

// Expose pure helpers for unit tests (no side effects on import)
module.exports = {
  buildSourceBreakdownLocal,
  getRunScoreLocal,
  median,
  percentile,
  mean,
  safeRate,
  round,
  dateToTsPrefix,
  parseArgs,
  listRunsForDate,
  loadRunArtifacts,
  aggregate,
  renderMarkdown,
};

if (require.main === module) {
  try {
    main();
  } catch (e) {
    console.error(`[daily-aggregate] fatal: ${e.message}`);
    process.exit(1);
  }
}
