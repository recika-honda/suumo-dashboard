/**
 * Stage 03: AI image classification + bukaku supplement + shuhen photos
 *
 * 1. 並列で bukaku データ (PDF 解析 + 物確画像) を fetch 開始
 * 2. REINS 画像を Anthropic Claude Vision で 14 カテゴリに分類
 * 3. 5pt カテゴリ不足時、bukaku 画像を追加分類して merge
 * 4. 別 Chromium で周辺環境写真 (Google Images) を取得して merge
 *
 * 設計: docs/refactor/stages.md §03-images-classify
 * 不変条件: shuhen 用に立ち上げた別 Chromium は finally で必ず close
 *           (contract.md §8 リソース管理)
 *
 * 失敗時の振る舞い: 例外は外に出さず catch で握り潰し、processedImages の長さ
 *                  だけが短くなる (現状仕様)。
 */

const { chromium } = require("playwright");
const { analyzeAndCropImages } = require("../../skills/image-ai");
const { checkImageSufficiency, fetchBukakuData } = require("../../skills/bukaku");
const { fetchShuhenPhotos } = require("../../skills/google-images");
const { writeStageInput, writeStageOutput } = require("../lib/artifact");

const STAGE = "03-images-classify";

/**
 * @param {object} opts
 * @param {import("playwright").BrowserContext} opts.context        bukaku 検索用
 * @param {object} opts.reinsData                                   Stage 01 の出力
 * @param {Array<object>} opts.downloaded                           Stage 02 の出力
 * @param {string} opts.downloadDir
 * @param {(name: string, extra?: object) => void} opts.logStep
 * @param {object} opts.launchOpts                                  shuhen 用 chromium.launch options
 * @returns {Promise<{ processedImages: Array<object>, initialCostData: object | null }>}
 */
async function runImagesClassify({
  context,
  reinsData,
  downloaded,
  downloadDir,
  logStep,
  launchOpts,
  runDir,
}) {
  writeStageInput(runDir, STAGE, {
    reinsData,
    downloadedCount: downloaded?.length ?? 0,
    downloadDir,
  });
  console.error("  [3/6] AI画像分類...");

  // Start bukaku fetch in parallel
  const bukakuDataPromise = fetchBukakuData(context, reinsData, downloadDir).catch((e) => {
    console.error(`  [bukaku] Error (non-blocking): ${e.message}`);
    return { initialCosts: null, images: [] };
  });

  logStep("ai_classify_start", { count: downloaded?.length ?? 0 });
  let processedImages = await analyzeAndCropImages(downloaded, downloadDir);
  console.error(`  ${processedImages.length}枚分類完了`);
  logStep("images_classified", { count: processedImages.length });

  // Bukaku supplementary images
  const bukakuResult = await bukakuDataPromise;
  const initialCostData = bukakuResult.initialCosts;
  if (initialCostData) {
    console.error(`  [bukaku] 初期費用: ${Object.keys(initialCostData).length}項目`);
  }

  const sufficiency = checkImageSufficiency(processedImages);
  if (sufficiency.insufficient && bukakuResult.images.length > 0) {
    console.error(`  [bukaku] 5ptカテゴリ不足 → 物確画像を分類中...`);
    logStep("bukaku_supplement_start", { missing: sufficiency.missing5pt });
    try {
      const existingCats = processedImages.map((img) => img.categoryId);
      const bukakuProcessed = await analyzeAndCropImages(
        bukakuResult.images,
        downloadDir,
        existingCats
      );
      processedImages.push(...bukakuProcessed);
      console.error(`  物確: ${bukakuProcessed.length}枚追加`);
    } catch (e) {
      console.error(`  [bukaku] Image classification error: ${e.message}`);
    }
  }

  // Shuhen photos (separate browser to avoid memory pressure)
  console.error("  [3.5/6] 周辺環境写真取得...");
  logStep("shuhen_fetch_start");
  let shuhenBrowser;
  try {
    shuhenBrowser = await chromium.launch(launchOpts);
    const shuhenContext = await shuhenBrowser.newContext({
      viewport: { width: 1280, height: 900 },
    });
    const shuhenPhotos = await fetchShuhenPhotos(shuhenContext, reinsData, downloadDir);
    if (shuhenPhotos.length > 0) {
      for (const photo of shuhenPhotos) {
        processedImages.push({
          localPath: photo.localPath,
          categoryId: "SH",
          categoryLabel: "周辺環境",
          facilityType: photo.facilityType,
          facilityName: photo.facilityName,
          sourceIndex: 200 + shuhenPhotos.indexOf(photo),
        });
      }
      console.error(`  周辺環境: ${shuhenPhotos.length}枚追加`);
    }
  } catch (e) {
    console.error(`  [shuhen] Error: ${e.message}`);
  } finally {
    if (shuhenBrowser) await shuhenBrowser.close().catch(() => {});
  }

  const out = { processedImages, initialCostData };
  writeStageOutput(runDir, STAGE, out);
  return out;
}

module.exports = { runImagesClassify };
