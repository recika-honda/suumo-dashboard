/**
 * Stage 02: REINS image download
 *
 * REINS の物件詳細ページから画像メタを抽出し、screenshot で downloadDir に保存する。
 *
 * 設計: docs/refactor/stages.md §02-images-download
 * 依存: Stage 01 終了時に reinsPage が物件詳細ページにあること
 */

const reins = require("../../skills/reins");
const { writeStageInput, writeStageOutput } = require("../lib/artifact");

const STAGE = "02-images-download";

/**
 * @param {object} opts
 * @param {import("playwright").Page} opts.reinsPage
 * @param {string} opts.downloadDir
 * @param {(name: string, extra?: object) => void} opts.logStep
 * @param {string} [opts.runDir]
 * @returns {Promise<{ downloaded: Array<object> }>}
 */
async function runImagesDownload({ reinsPage, downloadDir, logStep, runDir }) {
  writeStageInput(runDir, STAGE, { downloadDir });
  console.error("  [2/6] 画像スクリーンショット...");
  logStep("extract_image_meta_start");
  const imagesMeta = await reins.extractImageData(reinsPage);
  logStep("screenshot_start", { count: imagesMeta.length });
  const downloaded = await reins.screenshotAllImages(reinsPage, imagesMeta, downloadDir);
  console.error(`  ${downloaded.length}枚取得`);
  logStep("images_downloaded", { count: downloaded.length });
  const out = { downloaded };
  writeStageOutput(runDir, STAGE, out);
  return out;
}

module.exports = { runImagesDownload };
