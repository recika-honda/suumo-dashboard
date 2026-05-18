/**
 * skills/forrent/fill-tokucho.js — forrent.jp 特徴項目 consumer (Phase β T004)
 *
 * Thin consumer of pre-resolved checkedCodes (from Stage 03b SSOT in
 * skills/feature-codes-resolve.js). Legacy inline routes were migrated to
 * the SSOT module; they live ONLY there. See docs/refactor/phase-beta-design.md §8.
 *
 * Public API: fillTokucho(mainFrame, reinsData, opts?) → { checked, codes }.
 * opts.checkedCodes (preferred) is wired by Stage 05 from Stage 03b output.
 * When omitted (legacy callers in scripts/legacy/*), delegate to SSOT inline —
 * never duplicate the migrated logic here.
 *
 * Checkbox toggling MUST use Playwright native API (frame.check), per
 * CLAUDE.md <rules> and gotchas (evaluate-based .checked = true is unreliable
 * against forrent's onchange handlers).
 */

const { resolveFeatureCodes } = require("../feature-codes-resolve");

const CHECKBOX_NAME = "${bukkenInputForm.categoryTokuchoCd}";

let _config = null;
function loadConfig() {
  if (_config) return _config;
  const p = require("path");
  const fs = require("fs");
  try {
    _config = JSON.parse(fs.readFileSync(p.join(__dirname, "..", "..", "config", "forrent-feature-codes.json"), "utf8"));
  } catch (e) {
    console.error(`[forrent] feature-codes config load failed: ${e.message}; using empty SSOT`);
    _config = { codes: [] };
  }
  return _config;
}

async function fillTokucho(mainFrame, reinsData, opts = {}) {
  console.log("[forrent] === TOKUCHO (特徴項目) START ===");
  let { checkedCodes, evidence } = opts;
  if (!Array.isArray(checkedCodes)) {
    // Legacy callers: delegate to SSOT (NOT a re-implementation of 3-path logic)
    console.log("[forrent] tokucho: checkedCodes not supplied, falling back to inline resolve");
    const resolved = resolveFeatureCodes({ reinsData, featureCodesConfig: loadConfig(), maisokuText: null });
    checkedCodes = resolved.checkedCodes;
    evidence = resolved.evidence;
  }
  if (!checkedCodes || checkedCodes.length === 0) {
    console.log("[forrent] tokucho: no feature codes to check");
    return { checked: 0, codes: [] };
  }
  if (evidence) {
    for (const code of checkedCodes) {
      const sources = (evidence[code] || []).map((e) => e.source).join("/") || "?";
      console.log(`[forrent] tokucho: ${code} <- ${sources}`);
    }
  }
  // Playwright native API only (frame.check fires focus → input → change in
  // the correct order). evaluate(.checked = true) is forbidden — see gotchas.md.
  let checked = 0;
  for (const code of checkedCodes) {
    const selector = `input[type="checkbox"][name="${CHECKBOX_NAME}"][value="${code}"]`;
    try {
      const loc = mainFrame.locator(selector);
      if ((await loc.count()) === 0) continue;
      if (await loc.isChecked()) continue;
      await loc.check({ force: true });
      checked++;
    } catch (e) {
      console.error(`[forrent] tokucho: check ${code} failed: ${e.message}`);
    }
  }
  console.log(`[forrent] === TOKUCHO END === checked: ${checked} / ${checkedCodes.length}`);
  return { checked, codes: [...checkedCodes] };
}

module.exports = { fillTokucho };
