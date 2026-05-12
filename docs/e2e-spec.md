# E2E Test Specification - suumo-dashboard

## 1. Overview

15 properties from REINS are processed through the full SUUMO listing pipeline
(REINS extraction -> image classification -> shuhen photos -> text generation -> forrent.jp submission).

**Goal:** Nayose score >= 40/43, pipeline errors = 0, validation errors = 0.

**Verification targets:**
- Shuhen (surrounding environment) image AI validation (google-images.js)
- REINS image classification title bias removal (image-ai.js)

---

## 2. Pipeline Steps

| Step | Process | Pass Criteria |
|------|---------|---------------|
| 0 | REINS login | Success |
| 1 | Property data extraction | Building name, rent, transport obtained |
| 2 | Image screenshots | >= 3 images |
| 3 | AI image classification + bukaku supplement | 5pt categories (room/kitchen/bath/floor plan/exterior) covered |
| 3.7 | Shuhen photos (Google Maps + AI validation) | >= 4 photos |
| 4 | AI text generation | catchCopy <= 30 chars, freeComment <= 100 chars |
| 5 | forrent.jp submission (form + images + transport + shuhen) | errors = 0 |
| 6 | Confirmation screen score check | >= 40/43, validation errors = 0 |

---

## 3. Score Breakdown (max 43)

| Category | Points | Method |
|----------|--------|--------|
| Room/Living | 5 | Image upload + category 040101 |
| Kitchen | 5 | Image + 040103 |
| Bath/Shower | 5 | Image + 040104 |
| Floor plan | 5 | clientMadoriFile slot |
| Exterior | 5 | gaikanFile slot |
| Catch copy | 5 | bukkenCatch field |
| Shuhen | 5 | shuhenKankyo1-6 + metadata |
| Panorama | 4 | **Not implemented (acceptable loss)** |
| Video CM | 4 | **Not implemented (acceptable loss)** |

**Target: 35pt (images + text) + 5pt (shuhen) = 40pt+**

---

## 4. Test Properties (15)

```
100138227796, 100138228746, 100138227301, 100138228400, 100138227721,
100138229508, 100138232077, 100138232263, 100138230439, 100138229160,
100138232623, 100138234102, 100138234131, 100138232270, 100138234101
```

---

## 5. Test Phases

### Phase 1: Smoke Test (3 properties)
- IDs: 100138227796, 100138229508, 100138234102
- Command: `node scripts/legacy/e2e-test-15.js --phase smoke --fresh`
- Pass: all 3 complete, 2/3 score >= 40

### Phase 2: Full Test (15 properties)
- Command: `node scripts/legacy/e2e-test-15.js --fresh`
- Pass:
  - 15/15 complete (no FATAL)
  - Pipeline errors total = 0
  - Validation errors total = 0
  - Average score >= 40
  - Individual score >= 40 for 13/15+

### Phase 3: Fix Verification
- Command: `node scripts/legacy/e2e-test-15.js --ids <failed_ids> --fresh`
- Pass: all score >= 40, errors = 0

---

## 6. Result Object

Each property produces:

| Field | Type | Description |
|-------|------|-------------|
| reinsId | string | REINS property ID |
| propertyName | string | Building name |
| status | enum | PASS / FAIL / NO_SCORE / ERROR / FATAL / NOT_FOUND |
| score | number? | Nayose total score |
| scoreBreakdown | object | 9-category breakdown |
| filled | number | Form fields filled |
| images | number | Images uploaded |
| transport | number | Transport entries |
| shuhen | number | Shuhen entries |
| tokucho | object | Tokucho result |
| errors | number | Pipeline error count |
| errorDetails | array | Classified error details |
| validationErrors | number | Validation error count |
| validationDetails | array | Validation error details |
| imageClassification | array | Per-image classification results |
| shuhenDetails | array | Facility name/type acquired |
| duration | number | Processing time (seconds) |
| screenshotPath | string | Path to result screenshot |

---

## 7. Error Classification

| Category | Pattern |
|----------|---------|
| form | Form field errors |
| upload | Image upload failures |
| transport | Transport/route errors |
| shuhen | Shuhen acquisition/slot errors |
| text | Text generation/fill errors |
| validation | Confirmation screen errors |

---

## 8. Issue Severity

| Level | Definition | Action |
|-------|-----------|--------|
| Critical | Multiple properties with 0pt in 5pt category / FATAL / login failure | Fix immediately after Phase 1 |
| Major | Score < 40 / allErrors > 0 / validation errors | Fix after Phase 2, verify in Phase 3 |
| Minor | Score 40-42 (optimization potential) / warnings only | Address if possible |

---

## 9. Expected Issue Patterns

| Pattern | Step | Likely Cause | Mitigation |
|---------|------|-------------|------------|
| Floor plan = 0pt | 3 | Vision misclassification / QR image only | Classification prompt enhancement |
| Kitchen = 0pt | 3 | No kitchen image in REINS | Bukaku supplement check |
| Shuhen = 0pt | 3.7/5 | Shuhen fetch failure / slot set failure | Google search query adjustment |
| Transport error | 5 | Line name mismatch / popup not opened | Fallback verification |
| NO_SCORE | 6 | Confirmation screen navigation failure / regex mismatch | Wait time extension |

---

## 10. Differences from batch-test.js

| Feature | batch-test.js | e2e-test-15.js |
|---------|--------------|----------------|
| Shuhen photos (Step 3.7) | Missing | Included via fetchShuhenPhotos |
| Score breakdown | Total only | 9-category breakdown via readNayoseScore |
| Error classification | Count only | form/upload/transport/shuhen/text/validation |
| CLI options | --fresh only | --phase, --ids, --verbose, --fresh |
| Report detail | Basic summary | Category averages, error frequency, auto-detected issues |

---

## 11. Report Output

- Console: summary table with score/errors/status per property
- JSON: `~/Desktop/suumo-nyuko/e2e-report-{timestamp}.json`
- Screenshots: `~/Desktop/suumo-nyuko/{reinsId}/batch-result.png`
