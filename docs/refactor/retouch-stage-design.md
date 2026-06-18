# Stage 04b — Image Retouch Design

Insertion point: between stage 04 (texts-generate) and stage 05 (forrent-fill).
Scope: design only. No implementation files touched here.

---

## 1. Input/Output Contract

### Input

`processedImages[]` — the array returned by stage 03 (`runImagesClassify`).
Each element has the shape produced by `image-ai.js#analyzeAndCropImages`:

```js
{
  localPath:     string,  // absolute path to the JPEG produced by stage 03
  categoryId:    string,  // "01"–"21" or "SH"
  categoryLabel: string,  // human-readable label ("間取り図", "建物外観", …)
  sourceIndex:   number,  // original REINS image index
  cropped?:      boolean, // true when cropMissingCategories produced this entry
  facilityType?: string,  // present on shuhen (categoryId === "SH") entries
  facilityName?: string,
}
```

Reference: `skills/image-ai.js:293-298` (primary path) and `skills/image-ai.js:434-440` (crop path).

### Output

Same `processedImages[]` shape, same length.
The only field that changes per element is `localPath`: it is replaced with the path to the retouched copy.
All other fields (`categoryId`, `categoryLabel`, `sourceIndex`, `cropped`, `facilityType`, `facilityName`) are preserved verbatim so the downstream consumer in `skills/forrent/fill-images.js#uploadImages` does not need any change.

**bukaku-supplemented images are included.**
Stage 03 may push additional entries from `bukakuProcessed` (`scripts/stages/03-images-classify.js:80`) and shuhen photos (`scripts/stages/03-images-classify.js:98-107`).
Stage 04b iterates the full array it receives and retouches every element, regardless of origin.

**Failure contract:** if retouch fails for a single image, `localPath` for that element is left as the pre-retouch value (original stage-03 output). The array is never shortened. Batch does not abort.

---

## 2. Floor-Plan (間取り図) Identification

### Primary method — `categoryId === "04"`

Stage 03 has already run Vision classification. The `categoryId` field holds the definitive result.

Reference: `skills/image-ai.js:34`

```js
{ id: "04", label: "間取り図", score: 5 }
```

The forrent slot map in `fill-images.js:116` uses `categoryLabel === "間取り図"` to route images to the `clientMadoriFile` slot:

```js
// skills/forrent/fill-images.js:116
const MADORI_CATS = ["間取り図"];
```

Both checks are equivalent when `categoryId === "04"` (the two are always in sync via the `SUUMO_CATEGORIES` table).

**Decision: use `categoryId === "04"` as the primary gate.** It is a machine-generated string constant, unambiguous, and does not depend on `categoryLabel` spelling.

### Pixel heuristic — fallback only

The shell script's white-ratio + saturation check (`wbRatio > 0.60 && saturation < 6`) is retained as a secondary signal for the case where stage 03 returned a non-"04" label but the image is visually a line-drawing floor plan.

Pixel fallback triggers only when `categoryId !== "04"` AND the heuristic fires.
When both match, retouch applies white-pad treatment; when neither matches, full photo retouch applies.

The `IRREVERSIBLE_CATS` guard in `image-ai.js:63` already prevents Vision from forcing the "04" label onto ambiguous images via fallback, so false-positive pixel heuristic hits are expected to be rare.

---

## 3. forrent Image Size Expectation

### Evidence from `fill-images.js`

`uploadImages` calls `setFileInput(mainFrame, inputName, img.localPath)` which wraps `el.setInputFiles(filePath)` directly (`skills/forrent/fill-images.js:92`). No client-side resize or dimension check is performed before upload.

The variant-fill path resizes to 1280x960 Q82 (`skills/forrent/fill-images.js:347`):

```js
.resize({ width: 1280, height: 960, fit: "cover" })
.jpeg({ quality: 82 - reuseIdx })
```

### Evidence from stage 03

`image-ai.js:289`:

```js
await sharp(img.localPath)
  .resize({ width: 1280, height: 960, fit: "cover", position: "centre" })
  .jpeg({ quality: 85 })
  .toFile(outPath);
```

All images entering stage 04b are already 1280×960 JPEG at Q85.

### Evidence from the confirm HTML

`logs/runs/20260421-105108_100138848617/confirm-attempt1.html` contains no explicit dimension validation on the file input elements (lines 3832, 3943, 4012, 4097, 4307, 4382, 4457). forrent's `gazoUpload()` JS function performs server-side upload without client-side dimension guard.

The thumbnail preview tag (`<img … style="width: 90px; height: auto;">`, line 2770) scales display only.

### Conclusion

**forrent does not enforce a specific upload dimension.** The stage-03 output of 1280×960 is accepted and working (hundreds of production runs logged). kento's specification of 800×600 (SUUMO spec) does not match the forrent-facing size actually in use.

**Stage 04b must output 800×600 JPEG for the `clientMadoriFile` (floor plan) slot** as kento specified, because that slot maps to SUUMO's floor-plan field downstream via forrent's name-matching pipeline (名寄せ).
For all other slots, stage 04b produces **1280×960 Q92 JPEG** (same aspect ratio as stage-03 output, upgraded quality).

If the first real submission with 800×600 floor plan triggers a forrent validation error, fall back to 1280×960 and note in gotchas.md. Explicitly flag this as [NEEDS VERIFICATION] on first live run.

---

## 4. Real-ESRGAN Binary Production Placement

### Problem

Current binary lives at `~/Desktop/suumo-nyuko/_upscale-tool/realesrgan-ncnn-vulkan` — a developer-local path that does not survive machine migration (e.g. 園田PC is a different macOS user).

### Resolution order

Stage 04b resolves the binary path in this order:

1. `REALESRGAN_BIN` env var (explicit override; highest priority).
2. Repo-local `tools/realesrgan/realesrgan-ncnn-vulkan` (relative to repo root, committed as a binary blob or gitignored with a setup step).
3. `~/Desktop/suumo-nyuko/_upscale-tool/realesrgan-ncnn-vulkan` (developer fallback).

Models directory follows the same three-step pattern via `REALESRGAN_MODELS`:

1. `REALESRGAN_MODELS` env var.
2. `tools/realesrgan/models/`.
3. `~/Desktop/suumo-nyuko/_upscale-tool/models/`.

**Recommended placement:** commit the binary and models under `tools/realesrgan/` (gitignored for binary size, with `tools/realesrgan/README.md` and a setup script). Set `REALESRGAN_BIN` and `REALESRGAN_MODELS` in `.env.local` on 園田PC.

If the binary is not found on any path, stage 04b logs a warning and skips the upscale step entirely (processes the image through ImageMagick only, starting from the existing 1280×960 source). This is safe: the fallback image is still valid for upload.

---

## 5. Failure Semantics

### Per-image failure

If `realesrgan` or `magick` exits non-zero for image N, stage 04b:

- catches the error
- logs `[04b] retouch failed #N (${catLabel}): ${err.message.slice(0, 80)}`
- leaves `processedImages[N].localPath` unchanged (stage-03 path remains)
- continues to the next image

No exception is propagated to the caller.

### Stage-level failure

If stage 04b itself throws (e.g. disk full, spawn failure on all images), `batch-nyuko.js` catches the error at the `processProperty` level, marks the run `ERROR`, and proceeds with the original `r3.processedImages` passed directly to `runForrentFill`. This requires that `batch-nyuko.js` passes the pre-04b `processedImages` reference to stage 05 when stage 04b is absent or throws.

Implementation note: `batch-nyuko.js:277` currently passes `r3.processedImages` directly to `runForrentFill`. The call site becomes:

```js
// batch-nyuko.js, after stage 03b:
let retouchedImages = r3.processedImages;
if (process.env.PHASE_RETOUCH !== "0") {
  try {
    retouchedImages = await runImagesRetouch({ processedImages: r3.processedImages, runDir, logStep });
  } catch (e) {
    console.error(`  [04b] stage failed, using original images: ${e.message}`);
  }
}
// r5 = runForrentFill({ …, processedImages: retouchedImages, … })
```

---

## 6. Env Switch

| Name | Default | Semantics |
|------|---------|-----------|
| `PHASE_RETOUCH` | `"1"` (on) | Set to `"0"` for instant rollback. Checked in `batch-nyuko.js` before calling `runImagesRetouch`. Stage file never reads it (consistent with the pattern established by `PHASE_GAMMA_MAISOKU` / `PHASE_BETA_03B` in stage 02b and 03b). |

The check is `process.env.PHASE_RETOUCH !== "0"` (on unless explicitly disabled), consistent with how `CAPACITY_FALLBACK_ENABLED` gates `register.js:764`.

---

## 7. Pure Helper Function Signatures

All helpers are pure (no I/O, no side effects). They are exported from `scripts/stages/04b-images-retouch.js` and importable without spawning any process.

### `classifyImageKind(img)`

```js
/**
 * Decide how to retouch an image based on stage-03 classification.
 *
 * @param {{ categoryId: string, localPath: string }} img
 * @returns {"floor_plan" | "photo"}
 *
 * "floor_plan" → white-pad treatment (800x600, no crop).
 * "photo"      → Real-ESRGAN upscale + WB + gamma + saturation + cover-crop (1280x960).
 *
 * Primary gate: categoryId === "04".
 * Pixel heuristic (whiteRatio > 0.6 && saturation < 6) used as secondary
 * signal only when categoryId !== "04" and the caller passes pixelStats.
 */
function classifyImageKind(img, pixelStats = null) { ... }
```

### `pickGamma(brightness)`

```js
/**
 * Return the gamma exponent for the adaptive gamma correction step.
 *
 * Matches the shell script thresholds:
 *   brightness < 40  → 1.22
 *   brightness < 50  → 1.16
 *   brightness < 60  → 1.11
 *   else             → 1.06
 *
 * @param {number} brightness  Average pixel brightness in [0, 255].
 * @returns {number}           Gamma exponent.
 */
function pickGamma(brightness) { ... }
```

### `buildGrayWorldGains(rMean, gMean, bMean)`

```js
/**
 * Compute per-channel gain multipliers using the gray-world assumption (weight 0.5).
 *
 * gain_c = (overall_mean / channel_mean) * 0.5 + 0.5
 *
 * @param {number} rMean  Mean red channel value [0, 255].
 * @param {number} gMean  Mean green channel value [0, 255].
 * @param {number} bMean  Mean blue channel value [0, 255].
 * @returns {{ r: number, g: number, b: number }}  Gain multipliers.
 */
function buildGrayWorldGains(rMean, gMean, bMean) { ... }
```

### `buildMagickOps(kind, gains, gamma)`

```js
/**
 * Build the ImageMagick command-line argument array for a single image.
 *
 * @param {"floor_plan" | "photo"} kind
 * @param {{ r: number, g: number, b: number }} gains  Gray-world gains (ignored for floor_plan).
 * @param {number} gamma  Adaptive gamma exponent (ignored for floor_plan).
 * @returns {string[]}  Argument array suitable for spawn("magick", [inputPath, ...ops, outputPath]).
 *
 * photo ops (in order):
 *   -evaluate-sequence multiply per channel (WB)
 *   -gamma {gamma}
 *   -modulate 100,105,100  (saturation +5%)
 *   -resize 1280x960^
 *   -gravity Center -extent 1280x960
 *   -quality 92
 *
 * floor_plan ops:
 *   -resize 800x600
 *   -background white -gravity Center -extent 800x600
 *   -quality 92
 */
function buildMagickOps(kind, gains, gamma) { ... }
```

### `buildUpscaleArgs(inputPath, outputPath, modelName, binaryPath)`

```js
/**
 * Build the realesrgan-ncnn-vulkan argument array.
 *
 * @param {string} inputPath   Absolute path to the source JPEG.
 * @param {string} outputPath  Absolute path for the upscaled output (PNG or JPEG).
 * @param {string} modelName   Default "realesrgan-x4plus".
 * @param {string} binaryPath  Resolved path to the binary.
 * @returns {string[]}  Argument array for spawn(binaryPath, args).
 *
 * Emits: ["-i", inputPath, "-o", outputPath, "-n", modelName]
 */
function buildUpscaleArgs(inputPath, outputPath, modelName, binaryPath) { ... }
```

---

## Summary of Key Citations

| Item | Conclusion | Evidence |
|------|-----------|---------|
| floor-plan categoryId | `"04"` (string) | `image-ai.js:34` |
| floor-plan categoryLabel | `"間取り図"` | `image-ai.js:34` |
| floor-plan forrent slot | `clientMadoriFile` | `fill-images.js:214` |
| stage-03 output size | 1280×960 Q85 JPEG | `image-ai.js:289-290` |
| forrent upload size constraint | none enforced client-side | `confirm-attempt1.html:3832,3943` |
| variant-fill size (existing code) | 1280×960 | `fill-images.js:347` |
| insertion point in orchestrator | after `r3b`, before `r5` | `batch-nyuko.js:267-277` |
| env switch pattern | `!== "0"` in orchestrator | `batch-nyuko.js` env gates (PHASE_GAMMA_MAISOKU etc.) |

[NEEDS VERIFICATION] — floor-plan 800×600 upload on first live run: confirm forrent does not reject the different aspect ratio vs the 1280×960 currently in production. If rejected, revert to 1280×960 white-pad and update this doc.
