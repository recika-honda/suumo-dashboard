#!/usr/bin/env node
"use strict";

/**
 * measure-phase-delta-dom-match.js — Phase ε T003 CLI
 *
 * Walks logs/runs/ and computes Step 1-3 (DOM chain integrity / source
 * breakdown / negation FP) for every run that has the artifacts needed.
 *
 * Spec: code/suumo-dashboard/docs/refactor/phase-epsilon-design.md §2-4.
 *
 * Usage:
 *   node scripts/measure-phase-delta-dom-match.js \
 *     [--runs-dir=logs/runs] \
 *     [--since=2026-05-17T00:00:00Z] \
 *     [--out=logs/measure/phase-delta] \
 *     [--filter=phase-delta|baseline|all] \
 *     [--dict=path/to/edit-after-teisei.html]
 *
 * Filter semantics (mirroring phase-epsilon-design.md §5.2):
 *   phase-delta: ts ≥ 20260517-070000 (Group C, post-T020)
 *   baseline:    ts ≤ 20260516-174300 (Group A, Phase β)
 *   all:         no time filter
 *
 * Outputs:
 *   <out>/<ts>_<reinsId>.json      per-run detail
 *   <out>/summary.json             aggregate
 *   <out>/summary.md               markdown 1-pager
 *
 * Design notes:
 *
 * - All measurement primitives live in scripts/measure/lib-dom-match.js as
 *   pure functions (testable in T004). This CLI is purely I/O glue: argv
 *   parsing, fs traversal, dictionary loading, JSON writing.
 *
 * - The 491-entry code/label dictionary is built once at startup from the
 *   latest edit-after-teisei.html (or --dict). It is reused across all runs.
 *   forrent code-label drift is silent — daily / weekly md5 monitoring is
 *   recommended (§2.3 [NEEDS VERIFICATION]).
 *
 * - The 150-SSOT config is loaded once from config/forrent-feature-codes.json
 *   and passed to detectNegationContextCandidates.
 *
 * - Per §9, when key artifacts (confirm-attempt1.html or 03b output.json) are
 *   missing, we record a status string and skip the affected step. Aggregate
 *   means are computed over `status === "ok"` runs only.
 */

const fs = require("fs");
const path = require("path");

const PROJECT_ROOT = path.resolve(__dirname, "..");
const lib = require(path.resolve(__dirname, "measure", "lib-dom-match.js"));

const {
  extractCheckedCodesFromDOM,
  classifyMatch,
  extractEvidenceBySource,
  detectNegationContextCandidates,
  assessNegationFP,
  buildCodeLabelMaps,
  findLatestEditTeiseiHtml,
  RUN_STATUS,
} = lib;

// Group boundary timestamps per phase-epsilon-design.md §5.2 / 11.6
const TS_PHASE_DELTA_START = "20260517-070000";
const TS_BASELINE_END = "20260516-174300";

// ── CLI parsing ──────────────────────────────────────────────

function parseArgs(argv) {
  const out = {
    runsDir: path.join(PROJECT_ROOT, "logs", "runs"),
    since: null,
    outDir: path.join(PROJECT_ROOT, "logs", "measure", "phase-delta"),
    filter: "all",
    dictHtml: null,
  };
  for (const arg of argv.slice(2)) {
    if (arg.startsWith("--runs-dir=")) out.runsDir = path.resolve(arg.slice("--runs-dir=".length));
    else if (arg.startsWith("--since=")) out.since = arg.slice("--since=".length);
    else if (arg.startsWith("--out=")) out.outDir = path.resolve(arg.slice("--out=".length));
    else if (arg.startsWith("--filter=")) out.filter = arg.slice("--filter=".length);
    else if (arg.startsWith("--dict=")) out.dictHtml = path.resolve(arg.slice("--dict=".length));
    else if (arg === "--help" || arg === "-h") {
      printUsageAndExit(0);
    } else {
      console.error(`[error] unknown arg: ${arg}`);
      printUsageAndExit(1);
    }
  }
  if (!["phase-delta", "baseline", "all"].includes(out.filter)) {
    console.error(`[error] --filter must be phase-delta|baseline|all (got ${out.filter})`);
    printUsageAndExit(1);
  }
  if (out.since !== null && Number.isNaN(Date.parse(out.since))) {
    console.error(`[error] --since must be ISO 8601 (got ${out.since})`);
    printUsageAndExit(1);
  }
  return out;
}

function printUsageAndExit(code) {
  process.stdout.write(
    "Usage: node scripts/measure-phase-delta-dom-match.js " +
      "[--runs-dir=PATH] [--since=ISO] [--out=PATH] " +
      "[--filter=phase-delta|baseline|all] [--dict=PATH]\n"
  );
  process.exit(code);
}

// ── Run discovery ────────────────────────────────────────────

const RUN_DIR_RE = /^(\d{8}-\d{6})_(\d+)$/;

/**
 * Yield {ts, reinsId, runDir} for every run dir matching the timestamp+id
 * convention. Sorted by ts asc for reproducibility.
 */
function* discoverRuns(runsDir, filter, sinceIso) {
  if (!fs.existsSync(runsDir)) return;
  const sinceMs = sinceIso ? Date.parse(sinceIso) : null;
  const entries = fs.readdirSync(runsDir).sort();
  for (const entry of entries) {
    const m = RUN_DIR_RE.exec(entry);
    if (!m) continue;
    const ts = m[1];
    const reinsId = m[2];
    if (filter === "phase-delta" && ts < TS_PHASE_DELTA_START) continue;
    if (filter === "baseline" && ts > TS_BASELINE_END) continue;
    if (sinceMs !== null) {
      const runMs = parseRunTsToMs(ts);
      if (Number.isNaN(runMs) || runMs < sinceMs) continue;
    }
    const runDir = path.join(runsDir, entry);
    if (!isDirectory(runDir)) continue;
    yield { ts, reinsId, runDir };
  }
}

/**
 * "20260517-092515" → ms epoch (treated as UTC for ordering; absolute correctness
 * not required because we only use it for >= comparisons within the same TZ).
 */
function parseRunTsToMs(ts) {
  const m = /^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})$/.exec(ts);
  if (!m) return NaN;
  return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
}

function isDirectory(p) {
  try { return fs.statSync(p).isDirectory(); } catch { return false; }
}

// ── Single-run measurement ───────────────────────────────────

/**
 * Read all artifacts and emit the per-run measurement record. Each phase of
 * the pipeline is wrapped to avoid letting a single bad run crash the batch.
 */
function measureRun({ ts, reinsId, runDir, labelToCodes, ssotCodes }) {
  const record = {
    ts,
    reinsId,
    runDir: path.relative(PROJECT_ROOT, runDir),
    status: RUN_STATUS.OK,
    reason: null,
    dom: null,
    source: null,
    negation: null,
  };

  // 1. Read run.json status for short-circuit on IMAGE_INSUFFICIENT etc.
  const runJsonPath = path.join(runDir, "run.json");
  if (fs.existsSync(runJsonPath)) {
    try {
      const runJson = JSON.parse(fs.readFileSync(runJsonPath, "utf8"));
      if (runJson && runJson.status === "IMAGE_INSUFFICIENT") {
        record.status = RUN_STATUS.IMAGE_INSUFFICIENT;
        record.reason = "run.json status is IMAGE_INSUFFICIENT";
        return record;
      }
    } catch {
      // continue — run.json malformed is non-fatal for downstream stages
    }
  }

  // 2. Read 03b output (required for everything beyond).
  const out03bPath = path.join(runDir, "03b-feature-codes-resolve", "output.json");
  if (!fs.existsSync(out03bPath)) {
    record.status = RUN_STATUS.NO_03B_OUTPUT;
    record.reason = "03b-feature-codes-resolve/output.json missing";
    return record;
  }
  let out03b;
  try {
    out03b = JSON.parse(fs.readFileSync(out03bPath, "utf8"));
  } catch (e) {
    record.status = RUN_STATUS.NO_03B_OUTPUT;
    record.reason = `03b output.json malformed: ${e.message}`;
    return record;
  }
  const intentSet = new Set(Array.isArray(out03b.checkedCodes) ? out03b.checkedCodes.map(String) : []);
  const evidence = out03b.evidence && typeof out03b.evidence === "object" ? out03b.evidence : {};

  // 3. Source breakdown (always computable from 03b alone).
  const sourceBreakdown = extractEvidenceBySource(evidence);
  record.source = sourceBreakdown;

  // 4. Negation FP analysis requires 02c maisoku-text. Optional — when text is
  //    absent we skip negation but keep DOM matching.
  const maisokuText = readMaisokuText(runDir);
  if (maisokuText) {
    const { negatedCodes, details } = detectNegationContextCandidates(maisokuText, ssotCodes);
    const maisokuEmitted = new Set([...sourceBreakdown.maisoku]);
    record.negation = {
      maisoku_text_chars: maisokuText.length,
      negation_candidates: [...negatedCodes].sort(),
      negation_candidate_details: details,
      // FP/TN against the codes 03b actually emitted via maisoku source.
      // domChecked is filled in once we parse confirm-attempt1.html below.
      _emittedMaisokuCodes: [...maisokuEmitted].sort(),
    };
  }

  // 5. DOM ground truth from confirm-attempt1.html.
  const confirmPath = path.join(runDir, "confirm-attempt1.html");
  if (!fs.existsSync(confirmPath)) {
    record.status = RUN_STATUS.NO_CONFIRM_HTML;
    record.reason = "confirm-attempt1.html missing";
    // We still keep source breakdown + negation candidates; emit them.
    if (record.negation) {
      const fpRes = assessNegationFP(
        record.negation.negation_candidates,
        record.negation._emittedMaisokuCodes,
        new Set()
      );
      record.negation.false_positives = fpRes.false_positives;
      record.negation.true_negatives = fpRes.true_negatives;
      record.negation.fp_rate_intent_only = fpRes.fp_rate;
      record.negation.fp_rate = null; // DOM-confirmed FP rate unavailable
      delete record.negation._emittedMaisokuCodes;
    }
    return record;
  }

  let confirmHtml;
  try {
    confirmHtml = fs.readFileSync(confirmPath, "utf8");
  } catch (e) {
    record.status = RUN_STATUS.HTML_PARSE_ERROR;
    record.reason = `confirm-attempt1.html read failed: ${e.message}`;
    return record;
  }

  let domParsed;
  try {
    domParsed = extractCheckedCodesFromDOM(confirmHtml, labelToCodes);
  } catch (e) {
    record.status = RUN_STATUS.HTML_PARSE_ERROR;
    record.reason = `extractCheckedCodesFromDOM threw: ${e.message}`;
    return record;
  }

  const classify = classifyMatch(intentSet, domParsed.codes);
  record.dom = {
    intent_size: intentSet.size,
    dom_size: domParsed.codes.size,
    dom_labels: domParsed.labels,
    unknown_labels: domParsed.unknownLabels,
    exact: classify.exact,
    missed: classify.missed,
    phantom: classify.phantom,
    exact_rate: classify.exact_rate,
    miss_rate: classify.miss_rate,
    phantom_rate: classify.phantom_rate,
  };

  // 6. Finalise negation FP analysis with DOM-confirmed FPs.
  if (record.negation) {
    const fpRes = assessNegationFP(
      record.negation.negation_candidates,
      record.negation._emittedMaisokuCodes,
      domParsed.codes
    );
    record.negation.false_positives = fpRes.false_positives;
    record.negation.true_negatives = fpRes.true_negatives;
    record.negation.fp_rate = fpRes.fp_rate;
    delete record.negation._emittedMaisokuCodes;
  }

  return record;
}

function readMaisokuText(runDir) {
  // Preferred: 02c output.json gives the canonical text and source label.
  const out02cJson = path.join(runDir, "02c-maisoku-text-extract", "output.json");
  const out02cTxt = path.join(runDir, "02c-maisoku-text-extract", "maisoku-text.txt");
  if (fs.existsSync(out02cJson)) {
    try {
      const json = JSON.parse(fs.readFileSync(out02cJson, "utf8"));
      if (json && typeof json.text === "string" && json.text.length > 0) return json.text;
      if (json && (json.source === "skipped" || json.source === "error")) return null;
    } catch {
      // fall through to txt
    }
  }
  if (fs.existsSync(out02cTxt)) {
    try { return fs.readFileSync(out02cTxt, "utf8"); } catch { return null; }
  }
  return null;
}

// ── Aggregation ──────────────────────────────────────────────

function aggregate(records) {
  const total = records.length;
  const counts = {
    total,
    ok: 0,
    no_03b_output: 0,
    no_confirm_html: 0,
    image_insufficient: 0,
    html_parse_error: 0,
  };
  const dom = { runs: 0, exact_rate_mean: null, miss_rate_mean: null, phantom_rate_mean: null };
  const negation = { runs_with_text: 0, fp_rate_mean: null };
  const source = {
    runs_with_03b: 0,
    maisoku_pure_mean: null,
    maisoku_overlap_mean: null,
    legacy_only_mean: null,
    maisoku_net_gain_mean: null,
  };

  const exactRates = [], missRates = [], phantomRates = [], fpRates = [];
  const pures = [], overlaps = [], legacies = [], netGains = [];

  for (const r of records) {
    counts[r.status] = (counts[r.status] || 0) + 1;
    if (r.source) {
      source.runs_with_03b += 1;
      pures.push(r.source.maisoku_pure.length);
      overlaps.push(r.source.maisoku_overlap.length);
      legacies.push(r.source.legacy_only.length);
      netGains.push(r.source.maisoku_net_gain);
    }
    if (r.dom && r.status === RUN_STATUS.OK) {
      dom.runs += 1;
      if (r.dom.exact_rate !== null) exactRates.push(r.dom.exact_rate);
      if (r.dom.miss_rate !== null) missRates.push(r.dom.miss_rate);
      if (r.dom.phantom_rate !== null) phantomRates.push(r.dom.phantom_rate);
    }
    if (r.negation && typeof r.negation.fp_rate === "number") {
      negation.runs_with_text += 1;
      fpRates.push(r.negation.fp_rate);
    } else if (r.negation && typeof r.negation.fp_rate_intent_only === "number") {
      // partial — count toward runs_with_text only when we lack DOM, do not
      // mix into fp_rate_mean (different denominator semantics).
      negation.runs_with_text += 1;
    }
  }
  dom.exact_rate_mean = mean(exactRates);
  dom.miss_rate_mean = mean(missRates);
  dom.phantom_rate_mean = mean(phantomRates);
  negation.fp_rate_mean = mean(fpRates);
  source.maisoku_pure_mean = mean(pures);
  source.maisoku_overlap_mean = mean(overlaps);
  source.legacy_only_mean = mean(legacies);
  source.maisoku_net_gain_mean = mean(netGains);

  return { counts, dom, source, negation };
}

function mean(arr) {
  if (!arr || arr.length === 0) return null;
  let s = 0;
  for (const v of arr) s += v;
  return s / arr.length;
}

function renderMarkdown(summary, args, dictPath, generatedAt) {
  const { counts, dom, source, negation } = summary;
  const pct = (v) => (v === null ? "—" : `${(v * 100).toFixed(1)}%`);
  const num = (v) => (v === null ? "—" : v.toFixed(2));
  return [
    "# Phase δ DOM-Match Measurement Summary",
    "",
    `- Generated: ${generatedAt}`,
    `- Runs dir: \`${path.relative(PROJECT_ROOT, args.runsDir)}\``,
    `- Filter: \`${args.filter}\`${args.since ? ` since=${args.since}` : ""}`,
    `- Dictionary HTML: \`${path.relative(PROJECT_ROOT, dictPath)}\``,
    "",
    "## Run Counts",
    "",
    "| Status | Count |",
    "|--------|------:|",
    `| total              | ${counts.total} |`,
    `| ok                 | ${counts.ok} |`,
    `| no_03b_output      | ${counts.no_03b_output} |`,
    `| no_confirm_html    | ${counts.no_confirm_html} |`,
    `| image_insufficient | ${counts.image_insufficient} |`,
    `| html_parse_error   | ${counts.html_parse_error} |`,
    "",
    "## DOM Ground Truth (Step 1)",
    "",
    "| Metric | Value | Target |",
    "|--------|------:|------:|",
    `| runs matched         | ${dom.runs} | ≥ 10 |`,
    `| exact_rate (mean)    | ${pct(dom.exact_rate_mean)} | ≥ 95% |`,
    `| phantom_rate (mean)  | ${pct(dom.phantom_rate_mean)} | ≤ 5% |`,
    `| miss_rate (mean)     | ${pct(dom.miss_rate_mean)} | — |`,
    "",
    "## Source Breakdown (Step 2)",
    "",
    "| Metric | Value |",
    "|--------|------:|",
    `| runs with 03b        | ${source.runs_with_03b} |`,
    `| maisoku_pure mean    | ${num(source.maisoku_pure_mean)} codes/run |`,
    `| maisoku_overlap mean | ${num(source.maisoku_overlap_mean)} codes/run |`,
    `| legacy_only mean     | ${num(source.legacy_only_mean)} codes/run |`,
    `| maisoku_net_gain     | ${num(source.maisoku_net_gain_mean)} codes/run |`,
    "",
    "## Negation FP (Step 3)",
    "",
    "| Metric | Value | Target |",
    "|--------|------:|------:|",
    `| runs with maisoku-text | ${negation.runs_with_text} | — |`,
    `| fp_rate (DOM-confirmed mean) | ${pct(negation.fp_rate_mean)} | ≤ 10% |`,
    "",
  ].join("\n");
}

// ── Main ─────────────────────────────────────────────────────

function main() {
  const args = parseArgs(process.argv);

  const dictPath = args.dictHtml || findLatestEditTeiseiHtml(args.runsDir);
  if (!dictPath || !fs.existsSync(dictPath)) {
    console.error(
      `[error] no edit-after-teisei.html found under ${args.runsDir} ` +
        `and --dict not given. cannot build code-label dictionary.`
    );
    process.exit(2);
  }
  const dictHtml = fs.readFileSync(dictPath, "utf8");
  const { codeToLabel, labelToCodes } = buildCodeLabelMaps(dictHtml);
  if (codeToLabel.size === 0) {
    console.error(`[error] dictionary parse yielded 0 entries from ${dictPath}`);
    process.exit(2);
  }

  // 150 SSOT
  const ssotPath = path.join(PROJECT_ROOT, "config", "forrent-feature-codes.json");
  let ssotCodes = [];
  if (fs.existsSync(ssotPath)) {
    try {
      const ssotJson = JSON.parse(fs.readFileSync(ssotPath, "utf8"));
      ssotCodes = Array.isArray(ssotJson.codes) ? ssotJson.codes : [];
    } catch (e) {
      console.warn(`[warn] failed to load SSOT ${ssotPath}: ${e.message}`);
    }
  } else {
    console.warn(`[warn] SSOT missing: ${ssotPath} — negation analysis disabled`);
  }

  fs.mkdirSync(args.outDir, { recursive: true });

  const records = [];
  for (const r of discoverRuns(args.runsDir, args.filter, args.since)) {
    const rec = measureRun({
      ts: r.ts,
      reinsId: r.reinsId,
      runDir: r.runDir,
      labelToCodes,
      ssotCodes,
    });
    records.push(rec);
    const perRunPath = path.join(args.outDir, `${r.ts}_${r.reinsId}.json`);
    fs.writeFileSync(perRunPath, JSON.stringify(rec, null, 2) + "\n", "utf8");
  }

  const generatedAt = new Date().toISOString();
  const summary = aggregate(records);
  const summaryDoc = {
    generated_at: generatedAt,
    runs_dir: path.relative(PROJECT_ROOT, args.runsDir),
    dict_html: path.relative(PROJECT_ROOT, dictPath),
    code_label_dict_size: codeToLabel.size,
    ssot_size: ssotCodes.length,
    filter: args.filter,
    since: args.since,
    ...summary,
    records_count: records.length,
  };
  fs.writeFileSync(
    path.join(args.outDir, "summary.json"),
    JSON.stringify(summaryDoc, null, 2) + "\n",
    "utf8"
  );
  fs.writeFileSync(
    path.join(args.outDir, "summary.md"),
    renderMarkdown(summary, args, dictPath, generatedAt),
    "utf8"
  );

  // stdout: one-line summary so callers / cron can pipe to a log line
  console.log(
    `[measure-phase-delta] runs=${summaryDoc.records_count} ` +
      `ok=${summary.counts.ok} dom_runs=${summary.dom.runs} ` +
      `exact_mean=${formatPct(summary.dom.exact_rate_mean)} ` +
      `fp_mean=${formatPct(summary.negation.fp_rate_mean)} ` +
      `out=${path.relative(PROJECT_ROOT, args.outDir)}`
  );
}

function formatPct(v) {
  if (v === null || v === undefined || Number.isNaN(v)) return "—";
  return `${(v * 100).toFixed(1)}%`;
}

if (require.main === module) {
  try {
    main();
  } catch (e) {
    console.error(`[fatal] ${e.stack || e.message || e}`);
    process.exit(1);
  }
}

module.exports = { parseArgs, discoverRuns, measureRun, aggregate, renderMarkdown };
