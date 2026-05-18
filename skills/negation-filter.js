/**
 * skills/negation-filter.js — Phase δ T002: Maisoku negation filter (pure helper)
 *
 * Suppress false-positive maisoku-text matches when the label is immediately
 * followed by a Japanese negation expression. Reference: phase-delta-design.md
 * Decision 2 (2026-05-16, kento approved).
 *
 * Module placement: standalone module per T002 task contract
 *   ("feature-codes-resolve.js を編集禁止"). T001 noted inline placement would
 *   suffice at current scope (single caller); T003 may choose to keep the
 *   require() or inline-copy. This file is intentionally side-effect-free
 *   and lazy-init compliant so either path remains open.
 *
 * Policy:
 *   - Applied only to the maisoku path (T003 wires it in feature-codes-resolve).
 *   - Never applied to setsubi / building / default paths (Phase β parity must
 *     remain bitwise-stable).
 *   - Detection window: post-keyword only. Japanese negation is postpositional
 *     ("ペット不可", "別途契約") — checking before the label produces spurious
 *     suppression from unrelated earlier negations.
 *   - Width normalisation: NFC + half-width width-fold (matching the `norm()`
 *     helper in skills/forrent/fill-texts.js). This lets "ﾍﾟｯﾄ不可" (half-width
 *     katakana) match labels like "ペット" while still detecting the trailing
 *     "不可". The label parameter is also normalised before locating it.
 *
 * Pure function: no I/O, no env reads, no module-state mutation. All inputs
 * passed explicitly; safe to require() at module top-level by callers.
 *
 * @typedef {Object} NegationResult
 * @property {boolean} negated
 * @property {string}  [pattern]  - first matching negation pattern (when negated)
 * @property {string}  [snippet]  - normalised post-label window slice (when negated)
 */

// ── Constants (T001 spec) ─────────────────────────────────────
// Order matters only for which pattern is reported first on overlap.
// Keep alphabetised-by-meaning here; the seven patterns are the SSOT.
const NEGATION_PATTERNS = Object.freeze([
  "なし",     // explicit absence: "オートロックなし"
  "不可",     // prohibited: "ペット不可"
  "未",       // not yet: "未設置"
  "無",       // none: "駐輪場無"
  "別途",     // separate arrangement / extra fee: "別途契約"
  "要確認",   // needs verification (treat as unconfirmed)
  "撤去",     // removed
]);

const NEG_WINDOW_BEFORE = 0;  // postpositional only; no look-behind
const NEG_WINDOW_AFTER  = 15; // covers "（別途契約、費用）" (12 chars) + margin

// ── Internal helpers ──────────────────────────────────────────

/**
 * Width-fold normaliser. Mirrors skills/forrent/fill-texts.js#norm but adds
 * NFC normalisation to guarantee canonical composition for combining-mark
 * input ("ヘ"+"゜" → "ペ"). We intentionally do not strip whitespace inside
 * the body the way `norm()` does (trim only at edges), because the post-label
 * window relies on positional offsets that whitespace mutation would skew.
 *
 * @param {string} s
 * @returns {string}
 */
function widthFold(s) {
  if (s == null) return "";
  if (typeof s !== "string") return "";
  return s
    .normalize("NFC")
    .replace(/[Ａ-Ｚａ-ｚ０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(/　/g, " ");
}

// ── Public API ────────────────────────────────────────────────

/**
 * Test whether `label` is negated in `text` (post-keyword window only).
 *
 * @param {string} text  - Source text (e.g. maisoku OCR output)
 * @param {string} label - The matched label whose surroundings to inspect
 * @param {Object} [options]
 * @param {number} [options.windowBefore=0]  - characters before the label
 *                                              (currently unused; kept for
 *                                              future symmetric-window support)
 * @param {number} [options.windowAfter=15]  - characters after the label
 * @returns {NegationResult}
 *
 * Edge cases:
 *   - empty text / non-string text  → { negated: false }  (no throw)
 *   - empty label                   → { negated: false }  (cannot locate)
 *   - label not found in text       → { negated: false }
 *   - multiple label occurrences    → first occurrence is inspected; rare
 *                                     in practice and consistent with the
 *                                     T001 pseudocode (`text.indexOf(label)`)
 */
function isNegated(text, label, options) {
  const opts = options || {};
  const windowAfter = Number.isFinite(opts.windowAfter) ? opts.windowAfter : NEG_WINDOW_AFTER;
  // windowBefore is accepted but not yet consumed; document explicitly.
  // const windowBefore = Number.isFinite(opts.windowBefore) ? opts.windowBefore : NEG_WINDOW_BEFORE;

  const normText = widthFold(text);
  const normLabel = widthFold(label);

  if (!normText || !normLabel) return { negated: false };

  const idx = normText.indexOf(normLabel);
  if (idx === -1) return { negated: false };

  const start = idx + normLabel.length;
  const end = Math.min(normText.length, start + Math.max(0, windowAfter));
  const window = normText.slice(start, end);

  for (const pattern of NEGATION_PATTERNS) {
    if (window.includes(pattern)) {
      return { negated: true, pattern, snippet: window };
    }
  }
  return { negated: false };
}

module.exports = {
  isNegated,
  NEGATION_PATTERNS,
  NEG_WINDOW_BEFORE,
  NEG_WINDOW_AFTER,
  // exposed for unit tests; T003 should not depend on this
  _widthFold: widthFold,
};
