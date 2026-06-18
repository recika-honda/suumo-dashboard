/**
 * Stage 04b: local image retouch (white balance / gamma / saturation / cover-crop
 *            + Real-ESRGAN 4x upscale for photos, white-pad for floor plans)
 *
 * Insertion point: between stage 04 (texts-generate) and stage 05 (forrent-fill).
 *
 * 設計 SSOT: docs/refactor/retouch-stage-design.md (T001)
 * 純粋ロジック: skills/retouch.js (T002) — classifyImageKind / pickGamma /
 *              buildGrayWorldGains / buildMagickOps / buildUpscaleArgs。
 *              本 stage の責務は I/O (metrics 計測 / spawn / fs) のみ。
 *
 * 失敗時セマンティクス (design §5):
 *  - 1 画像の retouch が失敗したら、その img.localPath は stage 03 の出力 (原本) のまま通す。
 *    配列は短くならない。batch は落とさない。
 *  - realesrgan が無い / 失敗したら upscale を skip し magick のみ実行 (graceful)。
 *  - magick が失敗したら原本 localPath のまま (当該画像のみ skip)。
 *
 * child_process は execFile を使う (shell 経由しない = path に空白/特殊文字があっても安全)。
 */

const { execFile } = require("child_process");
const { promisify } = require("util");
const fs = require("fs");
const path = require("path");
const os = require("os");

const {
  classifyImageKind,
  pickGamma,
  buildGrayWorldGains,
  buildMagickOps,
  buildUpscaleArgs,
} = require("../../skills/retouch");
const { writeStageInput, writeStageOutput } = require("../lib/artifact");

const execFileAsync = promisify(execFile);

const STAGE = "04b-retouch-images";

// Output target dimensions (kento 合意 2026-06-18: 全画像 1280x960、写真=cover、間取り図=contain pad)。
const TARGET_W = 1280;
const TARGET_H = 960;
const SAT_BOOST = 5; // saturation +5% (shell SAT_BOOST=105 と等価)
const UPSCALE_MODEL = "realesrgan-x4plus";

/**
 * Real-ESRGAN binary / models のパスを解決する (design §4 の 3 段順)。
 *   1. env REALESRGAN_BIN / REALESRGAN_MODELS (明示 override)
 *   2. repo 同梱 tools/realesrgan/ (+ /models)
 *   3. ~/Desktop/suumo-nyuko/_upscale-tool/ (+ /models) (developer fallback)
 *
 * binary が実在しなければ bin=null を返し、呼び出し側は upscale を skip する。
 *
 * @returns {{ bin: string | null, models: string | null }}
 */
function resolveRealesrgan() {
  const repoRoot = path.resolve(__dirname, "../..");
  const binCandidates = [
    process.env.REALESRGAN_BIN,
    path.join(repoRoot, "tools/realesrgan/realesrgan-ncnn-vulkan"),
    path.join(os.homedir(), "Desktop/suumo-nyuko/_upscale-tool/realesrgan-ncnn-vulkan"),
  ];
  const modelCandidates = [
    process.env.REALESRGAN_MODELS,
    path.join(repoRoot, "tools/realesrgan/models"),
    path.join(os.homedir(), "Desktop/suumo-nyuko/_upscale-tool/models"),
  ];

  let bin = null;
  for (const c of binCandidates) {
    if (c && fs.existsSync(c)) {
      bin = c;
      break;
    }
  }
  let models = null;
  for (const c of modelCandidates) {
    if (c && fs.existsSync(c)) {
      models = c;
      break;
    }
  }
  // models が見つからなくても、binary 隣接の "models" を最後の望みとして使う。
  if (bin && !models) {
    const adjacent = path.join(path.dirname(bin), "models");
    if (fs.existsSync(adjacent)) models = adjacent;
  }
  return { bin, models };
}

/**
 * magick で 1 画像の metrics を計測する (shell の magick -format '%[fx:...]' 相当)。
 * 返り値は全て 0-100% スケール、または 0-255 のチャンネル平均。
 *
 * @param {string} imgPath
 * @returns {Promise<{ whitePct: number, satPct: number, brightnessPct: number,
 *                      rMean: number, gMean: number, bMean: number }>}
 */
async function measureImage(imgPath) {
  // white% (99% 閾値での平均) — 間取り図判定の主要 signal
  const whiteOut = await execFileAsync("magick", [
    imgPath,
    "-threshold",
    "99%",
    "-format",
    "%[fx:mean*100]",
    "info:",
  ]);
  // saturation% (HSL の S チャンネル平均)
  const satOut = await execFileAsync("magick", [
    imgPath,
    "-colorspace",
    "HSL",
    "-channel",
    "G",
    "-separate",
    "-format",
    "%[fx:mean*100]",
    "info:",
  ]);
  // brightness% (Gray 平均) — adaptive gamma の入力
  const brightOut = await execFileAsync("magick", [
    imgPath,
    "-colorspace",
    "Gray",
    "-format",
    "%[fx:mean*100]",
    "info:",
  ]);
  // per-channel 平均 (0-255) — gray-world WB の入力
  const chanOut = await execFileAsync("magick", [
    imgPath,
    "-format",
    "%[fx:mean.r*255] %[fx:mean.g*255] %[fx:mean.b*255]",
    "info:",
  ]);
  const [rMean, gMean, bMean] = chanOut.stdout.trim().split(/\s+/).map(Number);

  return {
    whitePct: Number(whiteOut.stdout.trim()),
    satPct: Number(satOut.stdout.trim()),
    brightnessPct: Number(brightOut.stdout.trim()),
    rMean,
    gMean,
    bMean,
  };
}

/**
 * @param {object} opts
 * @param {Array<object>} opts.processedImages   Stage 03 の出力 (localPath / categoryId / ...)
 * @param {string} opts.downloadDir              retouched/ を作る基底ディレクトリ
 * @param {(name: string, extra?: object) => void} [opts.logStep]
 * @param {string} [opts.runDir]                 artifact 出力先 (省略時は input/output 書き込みを skip)
 * @returns {Promise<{ processedImages: Array<object> }>}
 *   同じ長さ・同じ shape。retouch 成功した要素のみ localPath を retouched パスに差し替える。
 */
async function runRetouchImages({ processedImages, downloadDir, logStep, runDir }) {
  const log = typeof logStep === "function" ? logStep : () => {};
  if (runDir) {
    writeStageInput(runDir, STAGE, {
      processedImagesCount: processedImages?.length ?? 0,
      downloadDir,
    });
  }
  console.error("  [4.5/6] 画像リタッチ...");

  const images = Array.isArray(processedImages) ? processedImages : [];
  const retouchDir = path.join(downloadDir, "retouched");
  fs.mkdirSync(retouchDir, { recursive: true });

  const { bin: realesrganBin, models: realesrganModels } = resolveRealesrgan();
  if (!realesrganBin) {
    console.error("  [04b] Real-ESRGAN 未検出 → upscale skip、magick のみで処理");
  }
  log("retouch_start", {
    count: images.length,
    upscaleAvailable: !!realesrganBin,
  });

  let retouched = 0;
  let skipped = 0;

  for (let i = 0; i < images.length; i++) {
    const img = images[i];
    const inputPath = img && img.localPath;
    const catLabel = (img && img.categoryLabel) || (img && img.categoryId) || "?";

    if (!inputPath || !fs.existsSync(inputPath)) {
      skipped++;
      continue; // 原本 localPath のまま (空欄ならそのまま)
    }

    try {
      // 1. metrics 計測
      const m = await measureImage(inputPath);

      // 2. floorplan / photo 判定 (categoryId==="04" 優先、pixel heuristic は副判定)
      const kind = classifyImageKind(img, {
        whitePct: m.whitePct,
        satPct: m.satPct,
      });

      const base = path.basename(inputPath).replace(/\.[^.]+$/, "");
      const outputPath = path.join(retouchDir, `${base}.jpg`);

      let magickSource = inputPath;
      let tmpUpscaled = null;

      // 3. 写真は Real-ESRGAN 4x upscale (失敗 / binary 不在なら原本 fallback)
      if (kind === "photo" && realesrganBin && realesrganModels) {
        tmpUpscaled = path.join(
          os.tmpdir(),
          `retouch-${process.pid}-${i}-${Date.now()}.png`
        );
        const upArgs = buildUpscaleArgs(
          inputPath,
          tmpUpscaled,
          UPSCALE_MODEL,
          realesrganModels
        );
        try {
          await execFileAsync(realesrganBin, upArgs);
          if (fs.existsSync(tmpUpscaled) && fs.statSync(tmpUpscaled).size > 0) {
            magickSource = tmpUpscaled; // upscale 成功 → これを magick 入力に
          } else {
            // 空出力 = 失敗扱い、原本へ fallback
            safeUnlink(tmpUpscaled);
            tmpUpscaled = null;
          }
        } catch (e) {
          // upscale 失敗は致命ではない。原本 source で tonal だけ走らせる。
          safeUnlink(tmpUpscaled);
          tmpUpscaled = null;
          console.error(
            `  [04b] upscale 失敗 #${i} (${catLabel}): ${e.message.slice(0, 80)}`
          );
        }
      }

      // 4. magick ops を組み立て (photo=WB+gamma+sat+cover / floorplan=white-pad contain)
      let gains = { gr: 1, gg: 1, gb: 1 };
      let gamma = "1.0";
      if (kind === "photo") {
        gains = buildGrayWorldGains(m.rMean, m.gMean, m.bMean);
        gamma = pickGamma(m.brightnessPct);
      }
      const ops = buildMagickOps(kind, gains, gamma, {
        targetW: TARGET_W,
        targetH: TARGET_H,
        satBoost: SAT_BOOST,
      });

      // 5. magick 実行: [input, ...ops, output]
      await execFileAsync("magick", [magickSource, ...ops, outputPath]);
      safeUnlink(tmpUpscaled); // upscale 中間 PNG を掃除

      if (fs.existsSync(outputPath) && fs.statSync(outputPath).size > 0) {
        img.localPath = outputPath; // 成功時のみ差し替え (他 field は維持)
        retouched++;
      } else {
        skipped++; // 出力が空 → 原本のまま
      }
    } catch (e) {
      // 当該画像のみ skip。原本 localPath を維持して次へ。
      skipped++;
      console.error(
        `  [04b] retouch failed #${i} (${catLabel}): ${e.message.slice(0, 80)}`
      );
    }
  }

  console.error(`  リタッチ: ${retouched}枚加工 / ${skipped}枚原本維持`);
  log("retouch_done", { retouched, skipped, total: images.length });

  const out = { processedImages: images };
  if (runDir) {
    writeStageOutput(runDir, STAGE, {
      retouched,
      skipped,
      total: images.length,
    });
  }
  return out;
}

/**
 * unlink を握り潰す (中間ファイルの掃除で本筋を落とさない)。
 * @param {string | null} p
 */
function safeUnlink(p) {
  if (!p) return;
  try {
    if (fs.existsSync(p)) fs.unlinkSync(p);
  } catch (_) {
    /* noop */
  }
}

module.exports = { runRetouchImages, resolveRealesrgan, measureImage };
