#!/usr/bin/env node
"use strict";

/**
 * measure-score-delta.js — Phase ε T005 (Score A/B)
 *
 * CLI that compares forrent 名寄せスコア distribution between the Phase β
 * baseline period and the Phase δ post-T020 period.
 *
 * Spec: code/suumo-dashboard/docs/refactor/phase-epsilon-design.md §5 + §8 + §10.
 * Inventory: .claude/do/findings/epsilon-T001-inventory.md
 *   - Phase β last run boundary: 2026-05-16T08:43:10Z (just before delta start)
 *   - Phase δ first effective run after T020: ts >= 20260517-070000 JST
 *   - Same-property pairs: 0 (REINS pool refreshes daily)
 *
 * Usage:
 *   node scripts/measure-score-delta.js
 *     [--baseline-until <ISO>]   default: 2026-05-16T08:43:10Z (JST 17:43)
 *     [--delta-since <ISO>]      default: 2026-05-16T22:00:00Z (JST 2026-05-17 07:00, per T002 §11.6)
 *     [--out <dir>]              default: logs/measure/score-delta (relative to suumo-dashboard root)
 *     [--logs-runs <dir>]        default: logs/runs (relative to suumo-dashboard root)
 *
 * Output (per spec §10.1):
 *   {out}/summary.json   - machine-readable ScoreABResult
 *   {out}/summary.md     - 1-pager (group stats, escalation rate, confounders, pair section)
 *
 * Score extraction priority (see lib-score-extract.js header for full notes):
 *   1. run.json#score
 *   2. validation-after-escalate.json#score   (fallback for escalation REG_FAIL where
 *      run.json#score happens to be null — rare in practice but kept defensively)
 *
 * Confounders are emitted both as a JSON array (summary.json#confounders) and
 * a bulleted list (summary.md).
 *
 * Existing SSOT (skills/feature-codes-resolve.js, skills/reins.js,
 * skills/negation-filter.js, fill-tokucho.js, stages 02b/02c/03b) are NOT
 * touched by this script.
 */

const fs = require("fs");
const path = require("path");
const {
  extractScoreFromValidation,
  extractScoreFromRunJson,
  computeScoreStats,
  detectSamePropertyPairs,
  compareScoreGroups,
  classifyRunGroup,
} = require("./measure/lib-score-extract");

const PROJECT_ROOT = path.resolve(__dirname, "..");

const DEFAULT_BASELINE_UNTIL = "2026-05-16T08:43:10Z";
// T002 §11.6: Group C definition = ts >= 20260517-070000 JST = 2026-05-16T22:00:00Z UTC.
const DEFAULT_DELTA_SINCE = "2026-05-16T22:00:00Z";
const DEFAULT_OUT_REL = "logs/measure/score-delta";
const DEFAULT_LOGS_RUNS_REL = "logs/runs";

const CONFOUNDERS = Object.freeze([
  "REINS 物件特性差: Group A と Group C は同一物件の再入稿ではなく、別物件群 (T001 reinsId overlap=0)。築年数・間取り・地域分布が両群で異なる",
  "季節差: 入稿時期 (Phase β = 2026-04-21〜2026-05-16 JST 17:12, Group C = 2026-05-17 07:00 JST 以降) で REINS 掲載物件プールが異なる",
  "元付業者分布: maisoku PDF 所持率は元付業者の運用次第 (T001 推測: 60% 程度)。Group A/C で母集団が異なるので所持率も均一でない",
  "maisoku 所持率の不確実性: T021 smoke 1 件 + Phase δ smoke 5 件のみ。本番 N≥20 での実測 hit 率は Phase ζ で別途取得",
  "T020 修正前 delta (Group B, 12 runs) の maisoku 0 発火: T020 (skills/reins.js zmnFlmi intercept fix) 以前の 12 件 (2026-05-16 17:43〜2026-05-17 07:00 JST) は zmnFlmi KEY_MISSING のため maisoku 経路 0 発火。Group C には含めない",
  "統計的有意性: N_C < 50 段階では effect size 中心、p 値は参考扱い。median/mean/escalation_rate の信頼区間は本レポートでは出力していない (T002 §5.4)",
]);

function parseArgs(argv) {
  const args = argv.slice(2);
  const opts = {
    baselineUntil: DEFAULT_BASELINE_UNTIL,
    deltaSince: DEFAULT_DELTA_SINCE,
    out: null,
    logsRuns: null,
    help: false,
  };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--help" || a === "-h") {
      opts.help = true;
    } else if (a.startsWith("--baseline-until=")) {
      opts.baselineUntil = a.split("=").slice(1).join("=");
    } else if (a === "--baseline-until") {
      opts.baselineUntil = args[++i];
    } else if (a.startsWith("--delta-since=")) {
      opts.deltaSince = a.split("=").slice(1).join("=");
    } else if (a === "--delta-since") {
      opts.deltaSince = args[++i];
    } else if (a.startsWith("--out=")) {
      opts.out = a.split("=").slice(1).join("=");
    } else if (a === "--out") {
      opts.out = args[++i];
    } else if (a.startsWith("--logs-runs=")) {
      opts.logsRuns = a.split("=").slice(1).join("=");
    } else if (a === "--logs-runs") {
      opts.logsRuns = args[++i];
    } else {
      console.error(`Unknown arg: ${a}`);
      opts.help = true;
    }
  }
  return opts;
}

function printHelp() {
  console.log(
    [
      "Usage: node scripts/measure-score-delta.js [options]",
      "",
      "Options:",
      `  --baseline-until <ISO>  Phase β baseline cutoff (default: ${DEFAULT_BASELINE_UNTIL})`,
      `  --delta-since <ISO>     Phase δ post-T020 start (default: ${DEFAULT_DELTA_SINCE})`,
      `  --out <dir>             Output dir relative to suumo-dashboard (default: ${DEFAULT_OUT_REL})`,
      `  --logs-runs <dir>       Runs dir relative to suumo-dashboard (default: ${DEFAULT_LOGS_RUNS_REL})`,
      "  --help, -h              Show this help",
    ].join("\n")
  );
}

/**
 * Read a JSON file, returning the parsed object or null on missing/malformed.
 * Errors are pushed to the caller's warning bucket.
 */
function readJsonSafe(filePath, warnings, runName, label) {
  if (!fs.existsSync(filePath)) return null;
  try {
    const raw = fs.readFileSync(filePath, "utf8");
    return JSON.parse(raw);
  } catch (err) {
    warnings.malformed.push(`${runName}:${label}:${err.message}`);
    return null;
  }
}

/**
 * Build a GroupRunRef for one run directory.
 * Returns null if the directory name doesn't match "{ts}_{reinsId}".
 */
function loadRunRef(runsDir, runName, warnings) {
  const m = /^(\d{8}-\d{6})_(\d+)$/.exec(runName);
  if (!m) return null;
  const timestamp = m[1];
  const reinsId = m[2];
  const runDir = path.join(runsDir, runName);
  const runJsonPath = path.join(runDir, "run.json");
  const valPath = path.join(runDir, "validation-after-escalate.json");

  const runJson = readJsonSafe(runJsonPath, warnings, runName, "run.json");
  const valJson = readJsonSafe(valPath, warnings, runName, "validation-after-escalate.json");

  let score = extractScoreFromRunJson(runJson);
  let scoreSource = score !== null ? "run.json" : "none";
  if (score === null) {
    const vs = extractScoreFromValidation(valJson);
    if (vs !== null) {
      score = vs;
      scoreSource = "validation-after-escalate";
    }
  }
  const status =
    runJson && typeof runJson.status === "string" ? runJson.status : null;
  return { run: runName, timestamp, reinsId, status, score, scoreSource };
}

/**
 * Walk logs/runs and bucket runs into baseline / delta / between groups.
 */
function loadAllRuns(runsDir, baselineUntil, deltaSince, warnings) {
  if (!fs.existsSync(runsDir)) {
    throw new Error(`logs/runs not found: ${runsDir}`);
  }
  const entries = fs.readdirSync(runsDir, { withFileTypes: true });
  const baseline = [];
  const delta = [];
  const between = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    if (e.name === "archive") continue;
    const ref = loadRunRef(runsDir, e.name, warnings);
    if (!ref) continue;
    const group = classifyRunGroup(ref.timestamp, baselineUntil, deltaSince);
    if (group === "invalid") {
      warnings.malformed.push(`${e.name}:invalid_timestamp`);
      continue;
    }
    if (group === "baseline") baseline.push(ref);
    else if (group === "delta") delta.push(ref);
    else between.push(ref);
  }
  return { baseline, delta, between };
}

/**
 * Partition runs that have a usable score from runs that don't.
 * No-score runs are recorded as warnings (NOT_FOUND, IMAGE_INSUFFICIENT,
 * TIMEOUT pre-confirm, etc.).
 */
function partitionByScore(runs, warnings) {
  const scored = [];
  for (const r of runs) {
    if (typeof r.score === "number") {
      scored.push(r);
    } else {
      warnings.missing_score.push(`${r.run}:status=${r.status}`);
    }
  }
  return scored;
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function fmtPct(rate) {
  if (rate === null || rate === undefined) return "—";
  return `${(rate * 100).toFixed(1)}%`;
}
function fmtNum(n) {
  if (n === null || n === undefined) return "—";
  return String(n);
}
function fmtSigned(n) {
  if (n === null || n === undefined) return "—";
  return n > 0 ? `+${n}` : `${n}`;
}

function renderMarkdown(result) {
  const { group_a, group_c, median_delta, mean_delta, escalation_delta } = result;
  const lines = [];
  lines.push("# Phase ε T005 — Score Delta Report");
  lines.push("");
  lines.push(`generated_at: ${result.generated_at}`);
  lines.push(`baseline_until (UTC): ${result.cutoffs.baseline_until}`);
  lines.push(`delta_since (UTC):    ${result.cutoffs.delta_since}`);
  lines.push("");
  lines.push("## Group A — Phase β baseline (〜baseline_until)");
  lines.push("");
  lines.push(`- N: ${group_a.n}`);
  lines.push(`- min/median/max: ${fmtNum(group_a.min)} / ${fmtNum(group_a.median)} / ${fmtNum(group_a.max)}`);
  lines.push(`- p25 / p75: ${fmtNum(group_a.p25)} / ${fmtNum(group_a.p75)}`);
  lines.push(`- mean (stddev): ${fmtNum(group_a.mean)} (±${fmtNum(group_a.stddev)})`);
  lines.push(`- escalation_rate (≥34): ${fmtPct(group_a.escalation_rate)}`);
  lines.push("");
  lines.push("## Group C — Phase δ post-T020 (delta_since〜)");
  lines.push("");
  lines.push(`- N: ${group_c.n}`);
  lines.push(`- min/median/max: ${fmtNum(group_c.min)} / ${fmtNum(group_c.median)} / ${fmtNum(group_c.max)}`);
  lines.push(`- p25 / p75: ${fmtNum(group_c.p25)} / ${fmtNum(group_c.p75)}`);
  lines.push(`- mean (stddev): ${fmtNum(group_c.mean)} (±${fmtNum(group_c.stddev)})`);
  lines.push(`- escalation_rate (≥34): ${fmtPct(group_c.escalation_rate)}`);
  lines.push("");
  lines.push("## Delta (Group C − Group A)");
  lines.push("");
  lines.push(`- median_delta: ${fmtSigned(median_delta)}`);
  lines.push(`- mean_delta:   ${fmtSigned(mean_delta)}`);
  lines.push(`- escalation_delta: ${escalation_delta === null ? "—" : fmtSigned(round4ToPct(escalation_delta))}`);
  lines.push("");
  lines.push("## Same-property pairs");
  lines.push("");
  if (result.same_property_pairs.length === 0) {
    lines.push("(no pairs — T001 inventory confirmed overlap=0; group comparison adopted)");
  } else {
    lines.push(`Found ${result.same_property_pairs.length} pair(s). Per-pair delta:`);
    lines.push("");
    lines.push("| reinsId | baseline ts | baseline score | delta ts | delta score | score_delta |");
    lines.push("|---------|-------------|----------------|----------|-------------|-------------|");
    for (const p of result.same_property_pairs) {
      lines.push(
        `| ${p.reinsId} | ${p.baseline.timestamp} | ${fmtNum(p.baseline.score)} | ${p.delta.timestamp} | ${fmtNum(p.delta.score)} | ${fmtSigned(p.score_delta)} |`
      );
    }
  }
  lines.push("");
  lines.push("## Confounders (T002 §5.5)");
  lines.push("");
  for (const c of result.confounders) {
    lines.push(`- ${c}`);
  }
  lines.push("");
  lines.push("## Diagnostics");
  lines.push("");
  lines.push(`- baseline group runs scanned: ${result.diagnostics.baseline_total}`);
  lines.push(`- delta group runs scanned:    ${result.diagnostics.delta_total}`);
  lines.push(`- between (Group B) runs:      ${result.diagnostics.between_total}`);
  lines.push(`- baseline runs with score:    ${group_a.n}`);
  lines.push(`- delta runs with score:       ${group_c.n}`);
  lines.push(`- skipped (missing score):     ${result.warnings.missing_score.length}`);
  lines.push(`- skipped (malformed JSON):    ${result.warnings.malformed.length}`);
  return lines.join("\n") + "\n";
}

// escalation_delta is stored as a rate diff (e.g. 0.12 = +12pp). Render as percentage points.
function round4ToPct(rateDiff) {
  return `${(rateDiff * 100).toFixed(1)}pp`;
}

function main() {
  const opts = parseArgs(process.argv);
  if (opts.help) {
    printHelp();
    process.exit(0);
  }

  const baselineUntil = new Date(opts.baselineUntil);
  const deltaSince = new Date(opts.deltaSince);
  if (Number.isNaN(baselineUntil.getTime())) {
    console.error(`Invalid --baseline-until: ${opts.baselineUntil}`);
    process.exit(1);
  }
  if (Number.isNaN(deltaSince.getTime())) {
    console.error(`Invalid --delta-since: ${opts.deltaSince}`);
    process.exit(1);
  }

  const runsDir = path.resolve(
    PROJECT_ROOT,
    opts.logsRuns || DEFAULT_LOGS_RUNS_REL
  );
  const outDir = path.resolve(PROJECT_ROOT, opts.out || DEFAULT_OUT_REL);

  const warnings = { missing_score: [], malformed: [] };
  const groups = loadAllRuns(runsDir, baselineUntil, deltaSince, warnings);

  // detectSamePropertyPairs operates on raw refs (T001 inventory says 0 pairs,
  // but we run defensively).
  const samePairs = detectSamePropertyPairs(groups.baseline, groups.delta);
  // For pair-level score_delta we need both ends to have a score; filter pairs
  // that lack data on either side. (Empty in practice given overlap=0.)
  const usablePairs = samePairs.filter((p) => p.score_delta !== null);

  // Group-comparison fallback (per T002 §5.1 — primary mode when pairs=0)
  const scoredBaseline = partitionByScore(groups.baseline, warnings);
  const scoredDelta = partitionByScore(groups.delta, warnings);
  const grouped = compareScoreGroups(scoredBaseline, scoredDelta);

  const result = {
    generated_at: new Date().toISOString(),
    cutoffs: {
      baseline_until: baselineUntil.toISOString(),
      delta_since: deltaSince.toISOString(),
    },
    group_a: grouped.group_a,
    group_c: grouped.group_c,
    median_delta: grouped.median_delta,
    mean_delta: grouped.mean_delta,
    escalation_delta: grouped.escalation_delta,
    same_property_pairs: usablePairs,
    confounders: CONFOUNDERS.slice(),
    diagnostics: {
      baseline_total: groups.baseline.length,
      delta_total: groups.delta.length,
      between_total: groups.between.length,
    },
    warnings,
  };

  ensureDir(outDir);
  const jsonPath = path.join(outDir, "summary.json");
  const mdPath = path.join(outDir, "summary.md");
  fs.writeFileSync(jsonPath, JSON.stringify(result, null, 2) + "\n");
  fs.writeFileSync(mdPath, renderMarkdown(result));

  console.log(`Wrote ${jsonPath}`);
  console.log(`Wrote ${mdPath}`);
  console.log(
    `Group A: N=${result.group_a.n}  median=${result.group_a.median}  escalation_rate=${result.group_a.escalation_rate}`
  );
  console.log(
    `Group C: N=${result.group_c.n}  median=${result.group_c.median}  escalation_rate=${result.group_c.escalation_rate}`
  );
  console.log(
    `median_delta=${result.median_delta}  mean_delta=${result.mean_delta}  escalation_delta=${result.escalation_delta}`
  );
}

if (require.main === module) {
  try {
    main();
  } catch (err) {
    console.error("ERROR:", err && err.message ? err.message : err);
    process.exit(1);
  }
}

module.exports = { parseArgs, renderMarkdown, CONFOUNDERS };
