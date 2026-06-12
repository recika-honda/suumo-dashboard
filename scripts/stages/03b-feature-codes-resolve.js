/**
 * Stage 03b: Feature code resolution (SSOT) — Phase β T003 / Phase δ T004
 *
 * Pure computation stage. Reads reinsData (+ maisokuText from 02c output in
 * Phase δ), delegates to skills/feature-codes-resolve.js, and persists the
 * result to logs/runs/{ts}_{reinsId}/03b-feature-codes-resolve/output.json.
 *
 * Phase β contract (PHASE_DELTA_MAISOKU_INTEGRATE=0 or 02c absent):
 *   maisokuText=null → checkedCodes bitwise-identical to legacy fillTokucho.
 *
 * Phase δ T004 — caller-arg priority for maisokuText:
 *   (a) explicit non-null string arg              → use as-is (test seam)
 *   (b) null/omitted + 02c output usable          → read from 02c
 *   (c) null/omitted + PHASE_DELTA_*INTEGRATE=0   → null (rollback)
 *   (d) null/omitted + 02c absent / error / empty → null (graceful)
 *
 * Observability: maisoku resolution embedded in `feature_codes_resolve_start`
 * payload (hasMaisokuText / maisokuStatus / maisokuSource / maisokuChars).
 * New logStep event NAMES are NOT introduced because the Phase β contract
 * test (test-stage-03b.js case 2) asserts exact event-name sequence with
 * deepStrictEqual. Payload-only additions are backwards-compatible.
 *
 * Design SSOT: docs/refactor/phase-delta-design.md §Decision 4-5
 */

const path = require("path");
const fs = require("fs");
const { resolveFeatureCodes } = require("../../skills/feature-codes-resolve");
const { resolveMaisokuCodesLlm } = require("../../skills/maisoku-llm");
const { writeStageInput, writeStageOutput, readStageOutput } = require("../lib/artifact");

const STAGE = "03b-feature-codes-resolve";
const MAISOKU_STAGE = "02c-maisoku-text-extract";
const MAISOKU_FETCH_STAGE = "02b-maisoku-fetch";

// Lazy-load the 150-code SSOT once per process. fs read (not require) so a
// missing file degrades to {codes: []} instead of crashing module load.
let _featureCodesConfig = null;
function loadFeatureCodesConfig() {
  if (_featureCodesConfig) return _featureCodesConfig;
  const configPath = path.join(__dirname, "..", "..", "config", "forrent-feature-codes.json");
  try {
    _featureCodesConfig = JSON.parse(fs.readFileSync(configPath, "utf8"));
  } catch (e) {
    console.error(`[03b] config load failed: ${e.message}; falling back to empty SSOT`);
    _featureCodesConfig = { codes: [] };
  }
  return _featureCodesConfig;
}

/**
 * Resolve maisokuText for the resolver call.
 * @returns {{ text: string|null, status: string, source: string|null, chars: number }}
 *          status: "caller" | "loaded" | "disabled_by_env" | "skipped:<reason>"
 */
function resolveMaisokuTextForResolver({ callerArg, runDir }) {
  // (a) caller seam: explicit non-null string wins (used by tests and any
  //     future code path that pre-resolves maisoku text before calling 03b).
  if (typeof callerArg === "string" && callerArg.length > 0) {
    return { text: callerArg, status: "caller", source: "caller", chars: callerArg.length };
  }
  // (c) env-only rollback: skip 02c read entirely. Lazy read so tests can
  //     toggle per-case via process.env mutation.
  if (process.env.PHASE_DELTA_MAISOKU_INTEGRATE === "0") {
    return { text: null, status: "disabled_by_env", source: null, chars: 0 };
  }
  // (b/d) read 02c output; non-throwing artifact reader handles missing
  //       file / parse error gracefully by returning null.
  if (!runDir) return { text: null, status: "skipped:no_rundir", source: null, chars: 0 };
  const out = readStageOutput(runDir, MAISOKU_STAGE);
  if (!out) return { text: null, status: "skipped:02c_absent", source: null, chars: 0 };
  // gamma-design §9: "skipped" (no maisoku PDF) and "error" (OCR failed) are
  // non-blocking. Both → Phase β parity (maisokuText=null).
  const source = out.source;
  if (source === "skipped" || source === "error") {
    return { text: null, status: `skipped:02c_${source}`, source, chars: 0 };
  }
  const text = typeof out.maisokuText === "string" ? out.maisokuText : "";
  if (text.length === 0) {
    return { text: null, status: "skipped:02c_empty", source: source || null, chars: 0 };
  }
  return { text, status: "loaded", source: source || "unknown", chars: text.length };
}

/**
 * @param {object} opts
 * @param {object}   opts.reinsData                Stage 01 output
 * @param {string|null} [opts.maisokuText]         optional caller override; null → read 02c
 * @param {(name: string, extra?: object) => void} opts.logStep
 * @param {string}  [opts.runDir]
 * @returns {Promise<{ checkedCodes: string[], evidence: object, generated_at: string, source_files: string[] }>}
 */
/**
 * Resolve the maisoku PDF path from the 02b artifact for the LLM path.
 * Returns null (LLM path skipped, Path D fallback) when the env switch is
 * off, the run dir is absent, or 02b did not download a PDF.
 */
function resolveMaisokuPdfPathForLlm(runDir) {
  if (process.env.MAISOKU_LLM_RESOLVE === "0") return { pdfPath: null, status: "disabled_by_env" };
  if (!runDir) return { pdfPath: null, status: "skipped:no_rundir" };
  const out = readStageOutput(runDir, MAISOKU_FETCH_STAGE);
  const pdfPath = out && typeof out.maisokuPdfPath === "string" ? out.maisokuPdfPath : null;
  if (!pdfPath || !fs.existsSync(pdfPath)) return { pdfPath: null, status: "skipped:no_pdf" };
  return { pdfPath, status: "available" };
}

async function runFeatureCodesResolve({ reinsData, maisokuText = null, logStep, runDir }) {
  const log = typeof logStep === "function" ? logStep : () => {};
  const resolved = resolveMaisokuTextForResolver({ callerArg: maisokuText, runDir });

  writeStageInput(runDir, STAGE, {
    reinsData,
    hasMaisokuText: typeof resolved.text === "string" && resolved.text.length > 0,
    maisokuStatus: resolved.status,
    maisokuSource: resolved.source,
    maisokuChars: resolved.chars,
  });
  console.error("  [3b/6] 特徴コード解決...");

  log("feature_codes_resolve_start", {
    hasMaisokuText: typeof resolved.text === "string" && resolved.text.length > 0,
    maisokuStatus: resolved.status,
    maisokuSource: resolved.source,
    maisokuChars: resolved.chars,
  });

  const featureCodesConfig = loadFeatureCodesConfig();

  // LLM resolution of the maisoku image (Path E). Non-blocking: on any
  // failure llm.codes is null and resolveFeatureCodes falls back to the
  // Path D keyword matching over `resolved.text`. No new logStep event
  // NAMES (Phase beta contract test pins the start/done sequence) — LLM
  // observability rides in the `feature_codes_resolve_done` payload.
  const llmPdf = resolveMaisokuPdfPathForLlm(runDir);
  let llm = { status: llmPdf.status, codes: null, costUSD: 0, model: null };
  if (llmPdf.pdfPath) {
    console.error("  [3b/6] マイソク LLM 判定...");
    llm = await resolveMaisokuCodesLlm({
      maisokuPdfPath: llmPdf.pdfPath,
      featureCodesConfig,
      maisokuText: resolved.text,
    });
    if (llm.status === "ok") {
      console.error(`  ✓ maisoku-llm: ${llm.codes.length} codes (model=${llm.model})`);
    } else {
      console.error(`  maisoku-llm ${llm.status}${llm.error ? `: ${llm.error}` : ""} → keyword fallback`);
    }
  }

  const result = resolveFeatureCodes({
    reinsData,
    featureCodesConfig,
    maisokuText: resolved.text,
    maisokuLlmCodes: llm.status === "ok" ? llm.codes : null,
  });

  console.error(`  特徴コード: ${result.checkedCodes.length}件確定`);
  log("feature_codes_resolve_done", {
    checkedCount: result.checkedCodes.length,
    evidenceCodes: Object.keys(result.evidence).length,
    maisokuLlmStatus: llm.status,
    maisokuLlmCodeCount: Array.isArray(llm.codes) ? llm.codes.length : 0,
    maisokuLlmCostUSD: llm.costUSD,
  });

  writeStageOutput(runDir, STAGE, result);
  return result;
}

module.exports = {
  runFeatureCodesResolve,
  // Test-only export; not part of the orchestrator API.
  __resolveMaisokuTextForResolver: resolveMaisokuTextForResolver,
};
