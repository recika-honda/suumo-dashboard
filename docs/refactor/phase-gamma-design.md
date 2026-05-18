# Phase γ Design — 02b maisoku fetch + 02c text extract

**Date**: 2026-05-16
**Status**: APPROVED — implementation can proceed (T002 → T003 → T004)
**Scope**: 02b maisoku-fetch stage + 02c maisoku-text-extract stage. Pipeline wiring into
batch-nyuko.js. Does NOT include 03b maisoku route materialisation (Phase δ).

---

## Background / Evidence Anchors

- **maisoku fetch**: `page.on('download')` fires on 図面参照 click. API filter must scope to
  `/BK/GBK003200/getInitData` (bare `/getInitData` matches GKG003100 dashboard too, yields no
  `zmnFlmi`). `downloadMaisokuPdf(page, savePath)` confirmed working: 593KB PDF, REINS ID
  100139151756. Source: `findings/01-zumen-button-behavior.md` L12-19.

- **dual-mode OCR fallback**: text layer 20% (1/5), scan PDF 80% (4/5). Scan PDFs return
  `chars=1`. `MIN_MEANINGFUL_CHARS=50` threshold required. Source: `findings/02-pdf-text-layer.md`
  L28-51.

- **cost monitoring**: $0.01–0.02/property for Vision OCR path. Source: finding-02 L49.

- **ownership rate**: REINS-resolved `zmnFlmi` 100% (15/15) — all in-pipeline properties fire 02b.
  Source: `findings/03-maisoku-ownership-rate.md` L22-27.

- **Pipeline wiring**: `batch-nyuko.js` L229–243 — current order r2→r3→r3b→texts. 02b/02c insert
  between r2 and r3.

- **OCR input format**: `skills/image-ai.js` L94–103 uses `data:image/jpeg;base64,${b64}` with
  `detail: VISION_DETAIL`. OpenAI API does not accept PDF directly. Phase γ must convert PDF
  page to JPEG first, then pass base64 — same pattern as existing image-ai.js.

---

## 1. 02b Output Schema (JSDoc)

```js
/**
 * @typedef {Object} MaisokuFetchResult
 * @property {string|null} maisokuPdfPath
 *   Absolute path to saved PDF; null if skipped or errored.
 * @property {string|null} zmnFlmi
 *   Raw value from REINS getInitData. Empty string or null = no maisoku.
 * @property {boolean}     downloaded
 *   True iff a PDF file was actually saved to disk.
 * @property {"download"|"skipped"|"error"} downloadEvent
 *   "download"  — Playwright download event fired and file saved.
 *   "skipped"   — zmnFlmi was empty; no attempt made.
 *   "error"     — attempt made but failed (see error field).
 * @property {string} [error]
 *   Human-readable error message when downloadEvent === "error".
 * @property {string} generated_at
 *   ISO 8601 timestamp.
 */
```

**Guaranteed invariants**:
- When `downloadEvent === "skipped"`, `maisokuPdfPath === null` and `downloaded === false`.
- When `downloadEvent === "error"`, `downloaded === false` and `error` is present.
- When `downloadEvent === "download"`, `downloaded === true` and `maisokuPdfPath` is a valid
  absolute path to an existing file.

---

## 2. 02b Stage Signature

```js
/**
 * Stage 02b: maisoku fetch
 * Reuses existing REINS session (reinsPage on detail screen after Stage 01).
 * @param {object} opts
 * @param {import("playwright").Page} opts.reinsPage
 * @param {string}   opts.runDir
 * @param {(name: string, extra?: object) => void} opts.logStep
 * @returns {Promise<MaisokuFetchResult>}
 */
async function runMaisokuFetch({ reinsPage, runDir, logStep }) { ... }
module.exports = { runMaisokuFetch };
```

**Rationale**: reusage of Stage 01 session avoids a new REINS login. `downloadMaisokuPdf(page, savePath)` from finding-01 accepts a `page` arg — reuse verbatim. Smoke runs require `launchctl unload jp.fango.watch-nyuko.plist` first (see Section 10).

---

## 3. 02c Output Schema (JSDoc)

```js
/**
 * @typedef {Object} MaisokuTextExtractResult
 * @property {string}  maisokuText
 *   Extracted flat text. Empty string if skipped or extraction failed.
 * @property {number}  charsExtracted
 *   Length of maisokuText (meaningful chars, post-trim).
 * @property {"pdftotext"|"vision-ocr"|"skipped"|"error"} source
 *   "pdftotext"   — text layer was usable (charsExtracted >= MIN_MEANINGFUL_CHARS).
 *   "vision-ocr"  — OCR fallback was used (gpt-4o Vision on converted JPEG).
 *   "skipped"     — maisokuPdfPath was null (02b skipped or errored).
 *   "error"       — both pdftotext and vision-ocr failed.
 * @property {boolean} visionUsed
 *   True iff gpt-4o Vision API was called.
 * @property {number}  visionCostUSD
 *   Estimated Vision API cost in USD. 0 when visionUsed === false.
 * @property {string}  [error]
 *   Human-readable message when source === "error".
 * @property {string}  generated_at
 *   ISO 8601 timestamp.
 */
```

---

## 4. 02c Stage Signature

```js
/**
 * Stage 02c: maisoku text extract (dual-mode). Pure I/O, no browser.
 * Primary: pdftotext ($0). Fallback: gpt-4o Vision OCR.
 * @param {object} opts
 * @param {string|null} opts.maisokuPdfPath  null → "skipped" path
 * @param {string}   opts.runDir
 * @param {(name: string, extra?: object) => void} opts.logStep
 * @returns {Promise<MaisokuTextExtractResult>}
 */
async function runMaisokuTextExtract({ maisokuPdfPath, runDir, logStep }) { ... }
module.exports = { runMaisokuTextExtract };
```

**Rationale**: no browser keeps browser/compute logic orthogonal (simplifies unit testing and rollback).

---

## 5. Stage File Paths

| Stage | Path |
|-------|------|
| 02b | `code/suumo-dashboard/scripts/stages/02b-maisoku-fetch.js` |
| 02c | `code/suumo-dashboard/scripts/stages/02c-maisoku-text-extract.js` |

Artifacts under `logs/runs/{ts}_{reinsId}/`:

| Stage | Subdir | Files |
|-------|--------|-------|
| 02b | `02b-maisoku-fetch/` | `input.json`, `output.json` |
| 02c | `02c-maisoku-text-extract/` | `input.json`, `output.json`, `maisoku-text.txt` |

`maisoku.pdf` at runDir root (`logs/runs/{ts}_{reinsId}/maisoku.pdf`) — shared binary asset, not stage-specific (matches `downloadDir` pattern in Stage 02).

---

## 6. Pipeline Wiring (batch-nyuko.js)

Citation: `batch-nyuko.js` L229–243 — current order r2→r3→r3b→texts. Insert after `r2`, before `r3`.

```js
// batch-nyuko.js addition — after r2, before r3
const r2b = await runMaisokuFetch({ reinsPage, runDir, logStep });
const r2c = await runMaisokuTextExtract({ maisokuPdfPath: r2b.maisokuPdfPath, runDir, logStep });
// r3b receives maisokuText: null in Phase γ; Phase δ wires r2c.maisokuText
```

Phase γ order: `01 → 02 → 02b(NEW) → 02c(NEW) → 03 → 03b(null) → 04 → 05 → 06`

**Why 02b immediately after 02**: reinsPage is still on detail screen; no extra navigation.

---

## 7. Env Switches

| Variable | Default | Behaviour when set to `0` |
|----------|---------|--------------------------|
| `PHASE_GAMMA_MAISOKU` | enabled | `=0` skips 02b entirely; 02c also auto-skips (maisokuPdfPath=null) |
| `PHASE_GAMMA_OCR` | enabled | `=0` disables Vision OCR in 02c; pdftotext-only mode (scan PDFs yield empty text) |
| `MAISOKU_MIN_MEANINGFUL_CHARS` | `50` | Override text-layer detection threshold (finding-02 confirmed 50 chars as correct boundary: scan PDFs yield 1 char, text-layer PDFs yield 1236+ chars) |

All three are read at runtime (not at require time), consistent with lazy-init rule.

---

## 8. OCR Implementation Method

**Decision**: `pdftoppm -jpeg -r 150 maisoku.pdf page` → `page-1.jpg`, then pass as
`data:image/jpeg;base64,...` to gpt-4o Vision.

**Rationale**: `skills/image-ai.js` L94–103 uses this pattern. OpenAI rejects PDF input (JPEG/PNG/GIF/WebP only). Maisoku is 1-page (confirmed finding-01). `pdftoppm` system binary, no npm dep. `pdf-parse` handles text-layer path.

**cost monitoring**: gpt-4o Vision ≈ $0.005/property. Budget ceiling: $0.01–0.02 (finding-02).
Per-call `console.error("[02c] vision-ocr cost ~$0.005 for <reinsId>")`. WARN >$0.05; ABORT >$0.10 (`source:"error"`).

---

## 9. OCR Fallback Policy (dual-mode)

02c is **non-blocking** — failure does not stop the pipeline. 03b handles `maisokuText = null` gracefully (Phase β design).

| Step | Condition | Return |
|------|-----------|--------|
| 1 | `maisokuPdfPath` is null | `{ source:"skipped", maisokuText:"" }` |
| 2 | pdftotext chars >= `MIN_MEANINGFUL_CHARS` | `{ source:"pdftotext" }` |
| 3 | `PHASE_GAMMA_OCR=0` | `{ source:"pdftotext", maisokuText:"", visionUsed:false }` |
| 4 | scan PDF — call gpt-4o Vision | `{ source:"vision-ocr", visionUsed:true, visionCostUSD:N }` |
| 5 | any exception in steps 2–4 | `{ source:"error", maisokuText:"", visionUsed:false, visionCostUSD:0 }` |

---

## 10. REINS Session Management

02b shares the existing REINS session (`reinsPage` from Stage 01). No new login.

Before any smoke: `launchctl unload ~/Library/LaunchAgents/jp.fango.watch-nyuko.plist`.
Source: gotchas.md ("watch-nyuko 並走中に batch-nyuko を pkill しても launchd 経由で再起動")
and CLAUDE.md NEVER rule for launchd routines.

---

## 11. Migration Order (T002 → T003 → T004)

Acceptance gate after each task: `npm test` (211 cases) all green.

**T002 — 02b implementation** (2 days):
- `scripts/stages/02b-maisoku-fetch.js`: `runMaisokuFetch`. Integrate `downloadMaisokuPdf` from finding-01 verbatim.
- `test-stage-02b.js`: skip (zmnFlmi empty) / error (download timeout) / success (~8 cases).
- Do NOT wire into batch-nyuko.js yet.

**T003 — 02c implementation + pipeline wiring** (2 days):
- `scripts/stages/02c-maisoku-text-extract.js`: `runMaisokuTextExtract` with dual-mode OCR fallback.
- Wire 02b + 02c into `batch-nyuko.js` after r2, before r3. `r3b` keeps `maisokuText: null`.
- `test-stage-02c.js`: pdftotext / vision-ocr / skipped / PHASE_GAMMA_OCR=0 (~10 cases).
- Smoke: 1 property — verify `02b/output.json`, `02c/output.json`, `maisoku.pdf` present.

**T004 — smoke validation** (1 day):
- 3–5 properties: `maisoku.pdf` present; `maisoku-text.txt` non-empty for text-layer PDFs;
  `[02c] vision-ocr cost` log for scan PDFs; 03b output parity with Phase β baseline; npm test green.

---

## 12. Risk and Rollback

| Risk | Severity | Mitigation |
|------|----------|------------|
| 02b REINS session conflict with watch-nyuko | High | `launchctl unload` mandatory before smoke; documented in NEVER rule |
| pdftoppm not installed on host | Medium | Check with `which pdftoppm` in T003; fallback to `pdf-parse` for text-layer path, log warn for scan path |
| gpt-4o Vision OCR cost overrun | Medium | Per-property abort at $0.10; daily batch 100 props × $0.02 = $2/day well within quota |
| 02b download event not fired on new REINS version | Medium | `downloadMaisokuPdf` has a 15s timeout and returns `{ saved: false, reason }` non-blocking; pipeline continues without maisoku |
| 02c silently empty maisokuText | Low | `source` field distinguishes "skipped"/"error"/"pdftotext"/"vision-ocr"; 03b evidence trail records source |
| Existing 211 tests regress | Low | Each task requires npm test green before proceeding |

**Rollback**: T002 — `git revert <T002>` (no batch-nyuko.js impact). T003 — `git revert <T003>`; `PHASE_GAMMA_MAISOKU=0` as emergency fallback. T004 — no code change; `PHASE_GAMMA_MAISOKU=0` if regression.
