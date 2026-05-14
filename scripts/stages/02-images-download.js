/**
 * Stage 02: REINS image download
 *
 * REINS の物件詳細ページから画像メタを抽出し、screenshot で downloadDir に保存する。
 *
 * 設計: docs/refactor/stages.md §02-images-download
 * 依存: Stage 01 終了時に reinsPage が物件詳細ページにあること
 *
 * Phase 2 (2026-05-15): REINS 画像が閾値以下なら screenshot を撮らず早期 exit
 * → caller が status="IMAGE_INSUFFICIENT" として Notion を「画像欠落」にフリップ。
 * 閾値は env IMAGE_INSUFFICIENT_THRESHOLD で上書き可 (default: 2、つまり 0/1/2 枚で skip)。
 *
 * Phase 3a (2026-05-15): 早期 exit する前に物確 cascade (itandi → ...) を試行。
 * cascade がヒットしたら downloaded を埋めて通常 flow を続行 (imageInsufficient=false)。
 * cascade 全 miss なら従来通り IMAGE_INSUFFICIENT で早期 exit。
 * env PHASE3_CASCADE=0 で cascade を無効化 (デバッグ用)。
 */

const reins = require("../../skills/reins");
const imageCascade = require("../../skills/image-cascade");
const { writeStageInput, writeStageOutput } = require("../lib/artifact");

const STAGE = "02-images-download";
const IMAGE_INSUFFICIENT_THRESHOLD = (() => {
  const raw = process.env.IMAGE_INSUFFICIENT_THRESHOLD;
  if (raw == null || raw === "") return 2;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 2;
})();
const CASCADE_ENABLED = process.env.PHASE3_CASCADE !== "0";

/**
 * @param {object} opts
 * @param {import("playwright").Page} opts.reinsPage
 * @param {string} opts.downloadDir
 * @param {(name: string, extra?: object) => void} opts.logStep
 * @param {string} [opts.runDir]
 * @param {import("playwright").BrowserContext} [opts.context]   Phase 3 cascade 用 (新 page を開く)
 * @param {object} [opts.reinsData]                              Phase 3 cascade 用 (建物名/部屋番号)
 * @returns {Promise<{ downloaded: Array<object>, imageInsufficient?: boolean, rawCount?: number, cascadeHit?: { platform: string, count: number } }>}
 *   imageInsufficient:true のときは downloaded は空配列で、後続 stage を skip すべき。
 */
async function runImagesDownload({ reinsPage, downloadDir, logStep, runDir, context, reinsData }) {
  writeStageInput(runDir, STAGE, { downloadDir });
  console.error("  [2/6] 画像スクリーンショット...");
  logStep("extract_image_meta_start");
  const imagesMeta = await reins.extractImageData(reinsPage);
  const rawCount = imagesMeta.length;

  if (rawCount <= IMAGE_INSUFFICIENT_THRESHOLD) {
    console.error(`  REINS 画像 ${rawCount} 枚 (閾値 ${IMAGE_INSUFFICIENT_THRESHOLD} 以下)`);
    logStep("image_insufficient_detected", { rawCount, threshold: IMAGE_INSUFFICIENT_THRESHOLD });

    // Phase 3a: 物確 cascade 試行
    if (CASCADE_ENABLED && context && reinsData) {
      console.error("  → 物確 cascade 起動 (itandi)...");
      logStep("cascade_start", { platforms: ["itandi"] });
      let cascadeResult = { platform: null, images: [], attempts: [] };
      try {
        cascadeResult = await imageCascade.cascadeImageFetch(context, reinsData, downloadDir);
      } catch (e) {
        console.error(`  cascade 例外 (非ブロッキング): ${e.message}`);
        logStep("cascade_error", { error: e.message.slice(0, 200) });
      }
      if (cascadeResult.images.length > 0) {
        console.error(`  cascade ヒット: ${cascadeResult.platform} (${cascadeResult.images.length}枚)`);
        logStep("cascade_hit", {
          platform: cascadeResult.platform,
          count: cascadeResult.images.length,
          attempts: cascadeResult.attempts,
        });
        const out = {
          downloaded: cascadeResult.images,
          rawCount,
          cascadeHit: { platform: cascadeResult.platform, count: cascadeResult.images.length },
        };
        writeStageOutput(runDir, STAGE, out);
        return out;
      }
      logStep("cascade_miss", { attempts: cascadeResult.attempts });
      console.error(`  cascade 全 miss → 画像欠落判定`);
    }

    logStep("image_insufficient", { rawCount, threshold: IMAGE_INSUFFICIENT_THRESHOLD });
    const out = { downloaded: [], imageInsufficient: true, rawCount };
    writeStageOutput(runDir, STAGE, out);
    return out;
  }

  logStep("screenshot_start", { count: rawCount });
  const downloaded = await reins.screenshotAllImages(reinsPage, imagesMeta, downloadDir);
  console.error(`  ${downloaded.length}枚取得`);
  logStep("images_downloaded", { count: downloaded.length });
  const out = { downloaded, rawCount };
  writeStageOutput(runDir, STAGE, out);
  return out;
}

module.exports = { runImagesDownload, IMAGE_INSUFFICIENT_THRESHOLD };
