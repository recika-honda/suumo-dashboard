/**
 * Stage 04b: local image retouch (white balance / gamma / saturation / cover-crop
 *            + Real-ESRGAN 4x upscale for photos, white-pad for floor plans)
 *
 * Insertion point: between stage 04 (texts-generate) and stage 05 (forrent-fill).
 *
 * 設計 SSOT: docs/refactor/retouch-stage-design.md (T001)
 * 純粋ロジック: skills/retouch.js — classifyImageKind / pickGamma / buildGrayWorldGains /
 *              buildChannelLut / saturationMultiplier / buildResizePlan / computePixelStats /
 *              buildUpscaleArgs。本 stage の責務は I/O (sharp 計測/加工 / realesrgan spawn / fs) のみ。
 *
 * 加工エンジン: sharp (既存パイプライン image-ai.js と同じ。本番機に magick が無いため
 *   2026-06-18 に magick CLI → sharp へ切替)。明るさ(ガンマ)は per-channel LUT で magick と数値一致。
 *
 * 失敗時セマンティクス (design §5):
 *  - 1 画像の retouch が失敗したら、その img.localPath は stage 03 の出力 (原本) のまま通す。
 *    配列は短くならない。batch は落とさない。
 *  - realesrgan が無い / 失敗したら upscale を skip し sharp tonal のみ実行 (graceful)。
 *  - sharp 加工が失敗したら原本 localPath のまま (当該画像のみ skip)。
 *
 * Real-ESRGAN 呼び出しのみ child_process (execFile, shell 非経由)。
 */

const { execFile } = require("child_process");
const { promisify } = require("util");
const fs = require("fs");
const path = require("path");
const os = require("os");
const sharp = require("sharp");

const {
  classifyImageKind,
  pickGamma,
  buildGrayWorldGains,
  buildChannelLut,
  saturationMultiplier,
  buildResizePlan,
  computePixelStats,
  buildUpscaleArgs,
} = require("../../skills/retouch");
const { writeStageInput, writeStageOutput } = require("../lib/artifact");

const execFileAsync = promisify(execFile);

const STAGE = "04b-retouch-images";

// Output target dimensions (kento 合意 2026-06-18: 全画像 1280x960、写真=cover、間取り図=contain pad)。
const TARGET_W = 1280;
const TARGET_H = 960;
const SAT_BOOST = 5; // saturation +5% (shell SAT_BOOST=105 / magick -modulate 100,105,100 と等価)
const QUALITY = 92;
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
 * sharp で 1 画像の metrics を計測する。
 *   brightnessPct / per-channel 平均 → adaptive gamma + gray-world WB の入力
 *   whitePct / satPct (縮小 raw から) → 間取り図 pixel-fallback 判定の入力
 *
 * @param {string} imgPath
 * @returns {Promise<{ whitePct:number, satPct:number, brightnessPct:number,
 *                      rMean:number, gMean:number, bMean:number }>}
 */
async function measureImage(imgPath) {
  const stats = await sharp(imgPath).stats();
  const ch = stats.channels;
  const rMean = ch[0].mean;
  const gMean = ch[1].mean;
  const bMean = ch[2].mean;
  const brightnessPct = ((rMean + gMean + bMean) / 3 / 255) * 100;

  // 縮小 raw で white率 / 彩度を計算 (pixel-fallback 用、categoryId 優先なので副次)
  const { data, info } = await sharp(imgPath)
    .removeAlpha()
    .resize(160, 160, { fit: "inside" })
    .raw()
    .toBuffer({ resolveWithObject: true });
  const { whitePct, satPct } = computePixelStats(data, info.channels);

  return { whitePct, satPct, brightnessPct, rMean, gMean, bMean };
}

/**
 * sharp で 1 画像を加工して outputPath へ書く。
 *   photo     → WB+gamma を per-channel LUT で適用 → 彩度 → cover crop → JPEG
 *   floorplan → AI/tonal なし、contain (白 pad) → JPEG
 *
 * @param {string} srcPath  入力 (写真は upscale 済 PNG or 原本、間取り図は原本)
 * @param {string} outputPath
 * @param {"floorplan"|"photo"} kind
 * @param {{gr:number,gg:number,gb:number}} gains
 * @param {string} gamma
 */
async function retouchToFile(srcPath, outputPath, kind, gains, gamma) {
  const resizePlan = buildResizePlan(kind, TARGET_W, TARGET_H);

  if (kind === "floorplan") {
    await sharp(srcPath)
      .resize(resizePlan)
      .jpeg({ quality: QUALITY })
      .toFile(outputPath);
    return;
  }

  // photo: WB+gamma LUT → saturation → cover resize
  const lutR = buildChannelLut(gains.gr, gamma);
  const lutG = buildChannelLut(gains.gg, gamma);
  const lutB = buildChannelLut(gains.gb, gamma);

  const { data, info } = await sharp(srcPath)
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const c = info.channels; // 3 after removeAlpha
  const out = Buffer.allocUnsafe(data.length);
  for (let i = 0; i < data.length; i += c) {
    out[i] = lutR[data[i]];
    out[i + 1] = lutG[data[i + 1]];
    out[i + 2] = lutB[data[i + 2]];
  }

  await sharp(out, { raw: { width: info.width, height: info.height, channels: c } })
    .modulate({ saturation: saturationMultiplier(SAT_BOOST) })
    .resize(resizePlan)
    .jpeg({ quality: QUALITY })
    .toFile(outputPath);
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
    console.error("  [04b] Real-ESRGAN 未検出 → upscale skip、sharp tonal のみで処理");
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
      // 1. metrics 計測 (原本に対して)
      const m = await measureImage(inputPath);

      // 2. floorplan / photo 判定 (categoryId==="04" 優先、pixel heuristic は副判定)
      const kind = classifyImageKind(img, {
        whitePct: m.whitePct,
        satPct: m.satPct,
      });

      const base = path.basename(inputPath).replace(/\.[^.]+$/, "");
      const outputPath = path.join(retouchDir, `${base}.jpg`);

      let tonalSource = inputPath;
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
            tonalSource = tmpUpscaled; // upscale 成功 → これを tonal 入力に
          } else {
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

      // 4. tonal パラメータ (photo のみ。floorplan は WB/gamma なし)
      let gains = { gr: 1, gg: 1, gb: 1 };
      let gamma = "1.0";
      if (kind === "photo") {
        gains = buildGrayWorldGains(m.rMean, m.gMean, m.bMean);
        gamma = pickGamma(m.brightnessPct);
      }

      // 5. sharp で加工 → outputPath
      await retouchToFile(tonalSource, outputPath, kind, gains, gamma);
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

module.exports = { runRetouchImages, resolveRealesrgan, measureImage, retouchToFile };
