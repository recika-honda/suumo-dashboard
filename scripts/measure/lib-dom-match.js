"use strict";

/**
 * lib-dom-match.js — Phase ε T003 (DOM ground-truth match measurement)
 *
 * Pure functions for measuring Phase δ effectiveness against forrent DOM
 * ground truth. No I/O at the function level beyond reading already-loaded
 * strings / objects. The CLI (measure-phase-delta-dom-match.js) handles fs
 * traversal and run discovery.
 *
 * Spec reference: code/suumo-dashboard/docs/refactor/phase-epsilon-design.md
 *   §2  DOM matching against confirm-attempt1.html (Step 1)
 *   §3  Source breakdown for evidence map (Step 2)
 *   §4  Negation false-positive analysis (Step 3)
 *   §8  JSDoc typedefs (DomMatchResult / SourceBreakdown / NegationAnalysis)
 *   §9  Edge-case handling
 *
 * Design choices (T003 implementation, 2026-05-17):
 *
 * - HTML parsing uses regex, not cheerio. Matches the pattern established in
 *   scripts/extract-feature-codes.js and verified on 3 production runs
 *   (20260516-194655 / 20260516-185832 / 20260516-185256) where the regex
 *   recovered the full label list cleanly.
 *
 * - Multi-source evidence (a code appearing in evidence[] with more than one
 *   `source`) belongs simultaneously to every raw-source set it touches
 *   (setsubi / building / default / maisoku). For the higher-level triage we
 *   classify each emitted code into exactly one of {maisoku_pure,
 *   maisoku_overlap, legacy_only} per §3.2.
 *
 * - Negation FP detection re-uses skills/negation-filter.js#isNegated verbatim
 *   (NEGATION_PATTERNS, NEG_WINDOW_BEFORE, NEG_WINDOW_AFTER). The framework
 *   measures what production does — if a partial-label boundary case like
 *   "駐輪場無料" trips the "無" pattern, the FP rate will rise and surface it
 *   here. See §4.3 and the implementation finding for the
 *   `avoid_false_positives_on_partial_label_match` notes.
 *
 * - All functions are pure: inputs are explicit, no env reads, no
 *   module-state mutation. Safe to require() at module top-level.
 */

const path = require("path");
const fs = require("fs");

const negationFilter = require(path.resolve(__dirname, "..", "..", "skills", "negation-filter.js"));
const { isNegated, NEGATION_PATTERNS } = negationFilter;

// ── Constants ────────────────────────────────────────────────

/**
 * Status codes recorded for a single run when full DOM match is not possible.
 * "ok" is the only status that contributes to aggregate means.
 */
const RUN_STATUS = Object.freeze({
  OK: "ok",
  NO_CONFIRM_HTML: "no_confirm_html",
  NO_03B_OUTPUT: "no_03b_output",
  IMAGE_INSUFFICIENT: "image_insufficient",
  HTML_PARSE_ERROR: "html_parse_error",
});

// Regex for the "特徴項目" cell inside id="tokucho" on confirm-attempt1.html.
// Verified on 3 production runs (T001 inventory §4).
// We intentionally use greedy [\s\S]*? rather than lookahead/lookbehind to keep
// the engine forgiving against whitespace/newline drift.
const TOKUCHO_BLOCK_RE = /id="tokucho"[\s\S]*?class="itemName"[^>]*>特徴項目[\s\S]*?class="inputItem"[^>]*>([\s\S]*?)<\/td>/;

// Code/label extraction from edit-after-teisei.html (491 entries).
// Mirrors the pattern used by scripts/extract-feature-codes.js#parseFeatureCodes
// but here we want every code (not just the 150 SSOT subset).
const CODE_LABEL_RE = /id="L([0-9]{4})"[^>]*>([^<]+)</g;

// ── Public API: HTML / dictionary loaders ────────────────────

/**
 * Build code → label and label → code maps from an edit-after-teisei.html
 * string. Reverse map is multi-valued in principle (multiple codes can share a
 * label, though in practice all 491 entries are unique). Stored as Array<code>
 * to support that.
 *
 * @param {string} editHtml
 * @returns {{ codeToLabel: Map<string,string>, labelToCodes: Map<string,string[]> }}
 */
function buildCodeLabelMaps(editHtml) {
  const codeToLabel = new Map();
  const labelToCodes = new Map();
  if (typeof editHtml !== "string" || !editHtml.length) {
    return { codeToLabel, labelToCodes };
  }
  CODE_LABEL_RE.lastIndex = 0;
  let m;
  while ((m = CODE_LABEL_RE.exec(editHtml)) !== null) {
    const code = m[1];
    const label = m[2].trim();
    if (!label) continue;
    if (!codeToLabel.has(code)) codeToLabel.set(code, label);
    const list = labelToCodes.get(label);
    if (list) {
      if (!list.includes(code)) list.push(code);
    } else {
      labelToCodes.set(label, [code]);
    }
  }
  return { codeToLabel, labelToCodes };
}

/**
 * Parse the "特徴項目" cell of confirm-attempt1.html into a Set of codes that
 * are actually-checked in the DOM ground truth.
 *
 * @param {string} confirmHtml         - confirm-attempt1.html as a string
 * @param {Map<string,string[]>} labelToCodes - reverse dictionary from
 *                                              buildCodeLabelMaps
 * @returns {{ codes: Set<string>, labels: string[], unknownLabels: string[] }}
 *
 * Edge cases:
 *   - empty / non-string html → { codes: Set(), labels: [], unknownLabels: [] }
 *   - regex no match          → same
 *   - label not in dictionary → recorded in unknownLabels (dictionary stale signal)
 */
function extractCheckedCodesFromDOM(confirmHtml, labelToCodes) {
  const codes = new Set();
  const labels = [];
  const unknownLabels = [];
  if (typeof confirmHtml !== "string" || !confirmHtml.length) {
    return { codes, labels, unknownLabels };
  }
  const m = TOKUCHO_BLOCK_RE.exec(confirmHtml);
  if (!m) return { codes, labels, unknownLabels };

  // Strip residual tags, split on '/', trim, drop empties.
  const inner = m[1].replace(/<[^>]+>/g, "").trim();
  if (!inner) return { codes, labels, unknownLabels };
  const tokens = inner.split("/").map((s) => s.trim()).filter((s) => s.length);
  for (const lbl of tokens) {
    labels.push(lbl);
    const mapping = labelToCodes && labelToCodes.get(lbl);
    if (!mapping || mapping.length === 0) {
      unknownLabels.push(lbl);
      continue;
    }
    for (const code of mapping) codes.add(code);
  }
  return { codes, labels, unknownLabels };
}

// ── Public API: classification ───────────────────────────────

/**
 * Classify the 3-class match between 03b-emitted intent and forrent DOM truth.
 *
 * @param {Set<string>|Iterable<string>} intent - 03b output.json#checkedCodes
 * @param {Set<string>|Iterable<string>} dom    - DOM checked code set
 * @returns {{
 *   exact: string[], missed: string[], phantom: string[],
 *   exact_rate: number|null, miss_rate: number|null, phantom_rate: number|null
 * }}
 *
 * Rate semantics (§2.4):
 *   exact_rate  = |exact| / |dom|    (1.0 when dom empty AND intent empty)
 *   miss_rate   = |missed| / |dom|
 *   phantom_rate = |phantom| / |intent|
 *
 * Both empty sides → all rates are null (no signal to report). One side empty:
 *   intent empty, dom non-empty: exact_rate=0, miss_rate=1, phantom_rate=null
 *   intent non-empty, dom empty: exact_rate=null, miss_rate=null, phantom_rate=1
 */
function classifyMatch(intent, dom) {
  const intentSet = toStringSet(intent);
  const domSet = toStringSet(dom);
  const exact = [];
  const missed = [];
  const phantom = [];
  for (const c of domSet) (intentSet.has(c) ? exact : missed).push(c);
  for (const c of intentSet) {
    if (!domSet.has(c)) phantom.push(c);
  }
  exact.sort();
  missed.sort();
  phantom.sort();

  const exact_rate = domSet.size > 0 ? exact.length / domSet.size : null;
  const miss_rate = domSet.size > 0 ? missed.length / domSet.size : null;
  const phantom_rate = intentSet.size > 0 ? phantom.length / intentSet.size : null;
  return { exact, missed, phantom, exact_rate, miss_rate, phantom_rate };
}

// ── Public API: source breakdown ─────────────────────────────

/**
 * @typedef {Object} SourceBreakdown
 * @property {string[]} setsubi          - codes with any setsubi-source evidence
 * @property {string[]} building         - codes with any building-source evidence
 * @property {string[]} default          - codes with any default-source evidence
 * @property {string[]} maisoku          - codes with any maisoku-source evidence
 * @property {string[]} maisoku_pure     - codes whose evidence is maisoku ONLY
 * @property {string[]} maisoku_overlap  - codes with maisoku + any other source
 * @property {string[]} legacy_only      - codes without maisoku evidence
 * @property {number}   maisoku_net_gain - maisoku_pure.length + maisoku_overlap.length
 *
 * Multi-source codes (e.g. code 1001 = building + maisoku per T021 smoke) appear
 * in BOTH the building set AND the maisoku set per §3.2; the higher-level
 * pure/overlap/legacy_only classification places each code in exactly one bucket.
 */
function extractEvidenceBySource(evidenceMap) {
  const setsubi = [];
  const building = [];
  const defaultSrc = [];
  const maisoku = [];
  const maisokuPure = [];
  const maisokuOverlap = [];
  const legacyOnly = [];
  if (!evidenceMap || typeof evidenceMap !== "object") {
    return {
      setsubi, building,
      default: defaultSrc,
      maisoku, maisoku_pure: maisokuPure,
      maisoku_overlap: maisokuOverlap,
      legacy_only: legacyOnly,
      maisoku_net_gain: 0,
    };
  }
  // Stable ordering for reproducible reports.
  const codes = Object.keys(evidenceMap).sort();
  for (const code of codes) {
    const entries = evidenceMap[code];
    if (!Array.isArray(entries) || entries.length === 0) continue;
    const sources = new Set();
    for (const e of entries) {
      if (e && typeof e.source === "string") sources.add(e.source);
    }
    if (sources.has("setsubi")) setsubi.push(code);
    if (sources.has("building")) building.push(code);
    if (sources.has("default")) defaultSrc.push(code);
    if (sources.has("maisoku")) maisoku.push(code);
    const hasMaisoku = sources.has("maisoku");
    const hasOther = sources.has("setsubi") || sources.has("building") || sources.has("default");
    if (hasMaisoku && !hasOther) maisokuPure.push(code);
    else if (hasMaisoku && hasOther) maisokuOverlap.push(code);
    else legacyOnly.push(code);
  }
  return {
    setsubi,
    building,
    default: defaultSrc,
    maisoku,
    maisoku_pure: maisokuPure,
    maisoku_overlap: maisokuOverlap,
    legacy_only: legacyOnly,
    maisoku_net_gain: maisokuPure.length + maisokuOverlap.length,
  };
}

// ── Public API: negation FP detection ────────────────────────

/**
 * Walk the 150-SSOT label list against the maisoku-text and return the set of
 * codes whose label occurrence is followed (within NEG_WINDOW_AFTER chars) by
 * any NEGATION_PATTERN. These are the codes the production negation filter is
 * expected to suppress.
 *
 * Re-uses skills/negation-filter.js#isNegated verbatim so the measurement
 * tracks production behaviour. If a partial-label boundary case (e.g.
 * "駐輪場無料" matching the "無" pattern) over-flags, that is exposed by the FP
 * rate this framework reports — not silently softened here.
 *
 * @param {string} maisokuText
 * @param {Array<{code:string,label:string}>|Map<string,string>} ssotLabels
 *   Either the codes[] array from config/forrent-feature-codes.json or a
 *   Map<code,label>. Codes/labels with falsy label are skipped.
 * @returns {{
 *   negatedCodes: Set<string>,
 *   details: Array<{code:string,label:string,pattern:string,snippet:string}>
 * }}
 */
function detectNegationContextCandidates(maisokuText, ssotLabels) {
  const negatedCodes = new Set();
  const details = [];
  if (typeof maisokuText !== "string" || !maisokuText.length) {
    return { negatedCodes, details };
  }
  const iter = normaliseSsotIter(ssotLabels);
  for (const { code, label } of iter) {
    if (!label) continue;
    const res = isNegated(maisokuText, label);
    if (res && res.negated) {
      negatedCodes.add(code);
      details.push({
        code,
        label,
        pattern: res.pattern || "",
        snippet: res.snippet || "",
      });
    }
  }
  return { negatedCodes, details };
}

/**
 * Classify each 03b-emitted maisoku-source code as FP / TN against the
 * negation-candidate set derived from the same maisoku-text.
 *
 * FP definition (§4.2): a code that is in the negation-candidate set
 * (production filter is expected to suppress it) yet 03b emitted via the
 * maisoku source AND it was actually checked in the forrent DOM.
 *
 * @param {Set<string>|Iterable<string>} negationCandidates - from detectNegationContextCandidates
 * @param {Set<string>|Iterable<string>} emittedMaisokuCodes - source breakdown maisoku set
 *                                                              (pure + overlap; supplied by caller)
 * @param {Set<string>|Iterable<string>} domChecked          - DOM ground-truth checked codes
 * @returns {{
 *   false_positives: string[],
 *   true_negatives: string[],
 *   fp_rate: number|null
 * }}
 *
 * Notes:
 *   - When the maisoku-emitted set is empty the rate is null (no denominator).
 *   - When domChecked is empty we still report FP for codes the resolver shipped
 *     into intent, by treating the resolver emission as the FP signal — this
 *     mirrors the §4.2 production definition (filter was supposed to suppress).
 *     However if a confirm DOM is available, we tighten by AND-ing with
 *     domChecked: this captures FPs that survived all the way to the form.
 */
function assessNegationFP(negationCandidates, emittedMaisokuCodes, domChecked) {
  const cand = toStringSet(negationCandidates);
  const emitted = toStringSet(emittedMaisokuCodes);
  const dom = toStringSet(domChecked);
  const fp = [];
  const tn = [];
  for (const code of emitted) {
    if (cand.has(code) && (dom.size === 0 ? true : dom.has(code))) fp.push(code);
    else tn.push(code);
  }
  fp.sort();
  tn.sort();
  const fp_rate = emitted.size > 0 ? fp.length / emitted.size : null;
  return { false_positives: fp, true_negatives: tn, fp_rate };
}

// ── Helpers ──────────────────────────────────────────────────

/**
 * Loose iterable → Set<string>. Drops null/undefined entries silently. Used to
 * keep the public API tolerant of either Set or Array<string> from callers.
 */
function toStringSet(input) {
  const out = new Set();
  if (!input) return out;
  if (input instanceof Set) {
    for (const x of input) if (x != null && x !== "") out.add(String(x));
    return out;
  }
  if (Array.isArray(input) || typeof input[Symbol.iterator] === "function") {
    for (const x of input) if (x != null && x !== "") out.add(String(x));
    return out;
  }
  return out;
}

/**
 * Normalise SSOT input — config/forrent-feature-codes.json#codes (Array<{code,label,...}>)
 * or a Map<code,label> — into a generator of {code,label} entries.
 */
function* normaliseSsotIter(ssotLabels) {
  if (!ssotLabels) return;
  if (ssotLabels instanceof Map) {
    for (const [code, label] of ssotLabels) yield { code, label };
    return;
  }
  if (Array.isArray(ssotLabels)) {
    for (const entry of ssotLabels) {
      if (!entry || typeof entry !== "object") continue;
      yield { code: entry.code, label: entry.label };
    }
    return;
  }
  // Plain object: treat as code → label
  if (typeof ssotLabels === "object") {
    for (const code of Object.keys(ssotLabels)) {
      yield { code, label: ssotLabels[code] };
    }
  }
}

/**
 * Auto-discover the most recently mtime-stamped edit-after-teisei.html under
 * a runsDir. Used by the CLI when no explicit dictionary path is given. Pure
 * function I/O wise except it reads fs; returns null when nothing is found.
 *
 * @param {string} runsDir
 * @returns {string|null}
 */
function findLatestEditTeiseiHtml(runsDir) {
  if (!runsDir || !fs.existsSync(runsDir)) return null;
  let best = null;
  for (const entry of fs.readdirSync(runsDir)) {
    const htmlPath = path.join(runsDir, entry, "edit-after-teisei.html");
    let st;
    try { st = fs.statSync(htmlPath); } catch { continue; }
    if (!st.isFile()) continue;
    if (!best || st.mtimeMs > best.mtimeMs) {
      best = { path: htmlPath, mtimeMs: st.mtimeMs };
    }
  }
  return best ? best.path : null;
}

module.exports = {
  // primary exports per task contract
  extractCheckedCodesFromDOM,
  classifyMatch,
  extractEvidenceBySource,
  detectNegationContextCandidates,
  assessNegationFP,

  // supporting helpers (used by CLI; exposed for unit tests in T004)
  buildCodeLabelMaps,
  findLatestEditTeiseiHtml,
  RUN_STATUS,

  // forwarded constants for measurement context
  NEGATION_PATTERNS,

  // internal helpers exposed for unit tests; not intended for callers
  _toStringSet: toStringSet,
  _TOKUCHO_BLOCK_RE: TOKUCHO_BLOCK_RE,
};
