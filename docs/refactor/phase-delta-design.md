# Phase δ Design — 03b maisoku route integration + negation filter

**Date**: 2026-05-16
**Status**: APPROVED — implementation can proceed (T002–T006)
**Scope**: Wire 02c maisoku-text into 03b feature-codes-resolve. Materialise the maisoku
matching route in `skills/feature-codes-resolve.js`. Add negation filter. This is a
behavior-changing phase: new codes may be emitted from the maisoku path. Existing three
paths remain bitwise parity-preserved.

---

## Background / Evidence Anchors

- **maisoku placeholder location**: `skills/feature-codes-resolve.js` L499–520 — the
  `if (typeof maisokuText === "string" && maisokuText.length > 0)` block is intentionally
  empty in Phase β (`void allowedCodes` no-op). Phase δ materialises this block.

- **SSOT filter scope** (kento decision 2026-05-16, phase-beta-design.md Section 2):
  "SSOT filter is applied ONLY to the maisoku path … three legacy paths emit codes WITHOUT
  the SSOT filter." The 150-code SSOT (`config/forrent-feature-codes.json`) already loaded
  as `allowedCodes` (L468) but consulted only by the maisoku block.

- **02c output schema**: `MaisokuTextExtractResult.maisokuText` (string, possibly empty).
  Source: `02c-maisoku-text-extract.js` L88–107 JSDoc. Stage also writes
  `02c-maisoku-text-extract/maisoku-text.txt` for human inspection (L377–388).

- **03b current wiring**: `scripts/stages/03b-feature-codes-resolve.js` L55–77 —
  `runFeatureCodesResolve({ reinsData, maisokuText = null, logStep, runDir })`. The
  `maisokuText` param already exists; Phase δ changes the caller to supply the real value.

- **Text quality & short-label risk**: gamma-smoke.md (vision-ocr, 847 chars) — flat
  Japanese, facility keywords interspersed with address/pricing lines. 02-pdf-text-layer.md
  L36 — "フレッツ光ネクスト利用可能（**別途**契約、費用）" confirms negation filter necessity.
  Short SSOT labels: "BS" (2402), "CS" (2403), "LAN" (2413) — require word-boundary matching.

---

## Decision 1 — Maisoku matching algorithm

**Algorithm**: NFC-normalised full-width substring match via existing `norm()` (L40, L424).
Apply to both `maisokuText` and each label. Labels with `norm(label).length < 4` ("BS",
"CS", "LAN", "CATV") use regex-anchored match; all others use `normText.includes(normLabel)`.

```js
// Pseudo-code (T003 implementor reference)
const normText = norm(maisokuText);
for (const { code, label } of featureCodesConfig.codes) {
  if (!allowedCodes.has(code)) continue;           // SSOT filter (maisoku only)
  const normLabel = norm(label);
  if (normLabel.length === 0) continue;
  const hit = normLabel.length < 4
    ? new RegExp(`(?<![\\w\\uFF01-\\uFF5E])${escapeRegex(normLabel)}(?![\\w\\uFF01-\\uFF5E])`).test(normText)
    : normText.includes(normLabel);
  if (!hit) continue;
  if (isNegated(maisokuText, label)) continue;     // negation filter (Decision 2)
  addEvidence(code, { source: "maisoku", reason: `label '${label}' found`, matched: normLabel, snippet: extractSnippet(maisokuText, normLabel) });
}
```

Multi-token labels (e.g. "IT重説 対応物件" 2737) matched as single `includes` after `norm()`.

---

## Decision 2 — Negation filter specification

**Policy**: Applied only to maisoku path candidates. Never applied to setsubi / building
/ default paths (behavior-changing constraint: must not alter Phase β parity).

**Negation patterns** (exact list, confirmed by finding-02 text example "別途"):

```js
const NEGATION_PATTERNS = [
  "なし",    // explicit absence: "オートロックなし"
  "不可",    // prohibited: "ペット不可"
  "未",      // not yet: "未設置"
  "無",      // none: "駐輪場無"
  "別途",    // separate arrangement: "フレッツ光ネクスト利用可能（別途契約）"
  "要確認",  // needs verification (ambiguous, treat as unconfirmed)
  "撤去",    // removed
];
```

**Detection window**: `NEG_WINDOW_BEFORE = 0` chars (negation is postpositional in Japanese);
`NEG_WINDOW_AFTER = 15` chars (covers "（別途契約、費用）" = 12 chars). Window before = 0
avoids false suppression from unrelated negations earlier in the sentence.

```js
function isNegated(text, label) {
  const idx = text.indexOf(label);
  if (idx === -1) return false;
  const window = text.slice(idx + label.length, idx + label.length + 15);
  return NEGATION_PATTERNS.some(p => window.includes(p));
}
```

Double negation: not handled (vanishingly rare). Log WARN comment; do not implement reversal.
Separate module (`skills/negation-filter.js`) not warranted at current scope (single caller).

---

## Decision 3 — Evidence schema (snippet addition)

**Decision**: Add optional `snippet` field to `FeatureCodeEvidence` for maisoku source only.
Enables human audit of OCR hits without re-reading full maisoku text. Backward-compatible
(`snippet` optional; existing consumers ignore unknown fields).

```js
/**
 * @typedef {Object} FeatureCodeEvidence
 * @property {"setsubi"|"building"|"default"|"maisoku"} source
 * @property {string} reason
 * @property {string} [matched]   - matched keyword or label
 * @property {string} [snippet]   - maisoku source only; ~50-char context around match
 */
```

```js
function extractSnippet(text, normLabel, windowEach = 25) {
  const idx = text.indexOf(normLabel);
  if (idx === -1) return "";
  const start = Math.max(0, idx - windowEach);
  const end = Math.min(text.length, idx + normLabel.length + windowEach);
  return text.slice(start, end).replace(/\s+/g, " ").trim();
}
```

---

## Decision 4 — 03b wiring change

**Change**: `runFeatureCodesResolve` reads `02c-maisoku-text-extract/output.json` from
`runDir` and extracts `maisokuText`. Caller signature unchanged; `batch-nyuko.js` requires
no edit. When `output.json` absent, returns `null` → Phase β no-op, parity maintained.

```js
function readMaisokuText(runDir) {
  if (!runDir || process.env.PHASE_DELTA_MAISOKU_INTEGRATE === "0") return null;
  try {
    const outPath = path.join(runDir, "02c-maisoku-text-extract", "output.json");
    if (!fs.existsSync(outPath)) return null;
    const out = JSON.parse(fs.readFileSync(outPath, "utf8"));
    return (typeof out.maisokuText === "string" && out.maisokuText.length > 0) ? out.maisokuText : null;
  } catch { return null; }
}
```

---

## Decision 5 — Env switch `PHASE_DELTA_MAISOKU_INTEGRATE`

| Variable | Default | Behaviour when set to `0` |
|----------|---------|--------------------------|
| `PHASE_DELTA_MAISOKU_INTEGRATE` | enabled | Forces `readMaisokuText` to return `null`; 03b skips maisoku route (Phase β equivalent) |

Orthogonal to `PHASE_GAMMA_MAISOKU` (02b) and `PHASE_GAMMA_OCR` (02c). Checked at call
time inside `readMaisokuText()` (lazy-init rule).

---

## Decision 6 — Migration order

T002 → T003 → T004 → T005 → T006. Gate: `npm test` green after every task.

**T002** (0.5d): Add `NEGATION_PATTERNS`, `NEG_WINDOW_AFTER = 15`, `isNegated()` as pure
functions; do NOT wire yet. Add `test-negation-filter.js` ~12 cases (all 7 patterns,
boundary, double, empty). `npm test` green.

**T003** (1d): Materialise Phase β placeholder (L515–520): label iteration, short-label
regex, `isNegated`, snippet, `addEvidence`. Add `extractSnippet()`, `escapeRegex()` inline.
Update `@typedef FeatureCodeEvidence` with `[snippet]`. Extend tests +10 cases (~31 total).
03b still passes `null` (not yet wired). `npm test` green.

**T004** (0.5d): Add `readMaisokuText(runDir)` to `03b-feature-codes-resolve.js`; pass to
`resolveFeatureCodes`. Log `maisoku_text_integrated` step event `{ chars, source }`. Smoke:
1 property with 02c output → verify at least one `source:"maisoku"` evidence entry.

**T005** (1d): Run 5 properties with `PHASE_DELTA_MAISOKU_INTEGRATE=0` → diff=0 vs Phase β
(parity-preserved). Re-run enabled → diff allowed; verify all new codes have maisoku evidence.
Spot-check snippets: false-positive rate target ≤ 10%. Also record forrent name-matching score
delta (neutral or positive expected). `npm test` ≥ 211 cases.

**T006** (0.5d): Update `blueprint.html` Key Decisions + `context.md` Active section.

---

## Decision 7 — Behavior-changing policy

Phase δ is behavior-changing: new codes from maisoku route WILL appear in `checkedCodes`.

| Condition | Requirement |
|-----------|-------------|
| `PHASE_DELTA_MAISOKU_INTEGRATE=0` (or 02c absent) | `checkedCodes` == Phase β output, diff=0 (parity-preserved) |
| Enabled | New codes allowed; all must have `evidence[code][*].source === "maisoku"` (evidence trail) |

False-positive policy: if rate > 10% in T005 smoke, do NOT ship — add negation patterns and
re-smoke. Negative score delta must be investigated before shipping.

---

## Decision 8 — Risk and rollback

| Risk | Severity | Mitigation |
|------|----------|------------|
| OCR noise matches short labels (BS/CS) | Medium | Short-label regex boundary (D1); negation filter (D2). Raise `labelMinLen` or denylist if still noisy |
| Negation too aggressive | Low | 15-char post-keyword window only; adjustable via `NEG_WINDOW_AFTER` constant |
| Vision-ocr hallucination | Low | SSOT filter limits to 150 codes; evidence trail + snippet enable post-hoc audit |
| Parity regression in existing 3 routes | Critical | `PHASE_DELTA_MAISOKU_INTEGRATE=0` smoke is hard gate in T005; diff ≠ 0 blocks merge |
| Test suite regression | Low | `npm test` green mandatory at every task; 211-case baseline |

**Rollback**: T002/T003 — `git revert`; no pipeline impact until T003/T004 respectively.
T004+ — set `PHASE_DELTA_MAISOKU_INTEGRATE=0` for instant env-only rollback without code
change. Post-T005 false positives — env override while adding negation patterns, re-smoke.

---

## Anchor glossary

- **maisoku matching**: substring match of 150-SSOT labels against OCR text from 02c
- **negation filter**: post-keyword window check suppressing false-positive maisoku hits
- **evidence trail**: per-code `{ source, reason, matched, snippet }` array in 03b output
- **behavior-changing**: Phase δ intentionally adds new codes; not a parity-preserving refactor
- **parity-preserved**: `PHASE_DELTA_MAISOKU_INTEGRATE=0` guarantees bitwise equality with Phase β checkedCodes
