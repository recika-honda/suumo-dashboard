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
 */

const reins = require("../../skills/reins");
const { writeStageInput, writeStageOutput } = require("../lib/artifact");

const STAGE = "02-images-download";
const IMAGE_INSUFFICIENT_THRESHOLD = (() => {
  const raw = process.env.IMAGE_INSUFFICIENT_THRESHOLD;
  if (raw == null || raw === "") return 2;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 2;
})();

/**
 * @param {object} opts
 * @param {import("playwright").Page} opts.reinsPage
 * @param {string} opts.downloadDir
 * @param {(name: string, extra?: object) => void} opts.logStep
 * @param {string} [opts.runDir]
 * @returns {Promise<{ downloaded: Array<object>, imageInsufficient?: boolean, rawCount?: number }>}
 *   imageInsufficient:true のときは downloaded は空配列で、後続 stage を skip すべき。
 */
async function runImagesDownload({ reinsPage, downloadDir, logStep, runDir }) {
  writeStageInput(runDir, STAGE, { downloadDir });
  console.error("  [2/6] 画像スクリーンショット...");
  logStep("extract_image_meta_start");
  const imagesMeta = await reins.extractImageData(reinsPage);
  const rawCount = imagesMeta.length;

  if (rawCount <= IMAGE_INSUFFICIENT_THRESHOLD) {
    console.error(`  画像 ${rawCount} 枚 (閾値 ${IMAGE_INSUFFICIENT_THRESHOLD} 以下) → 画像欠落判定で早期 exit`);
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
