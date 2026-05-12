/**
 * 物確対応物件のみのバッチテスト
 *
 * Usage: bun run scripts/test-bukaku-batch.js
 */

const path = require("path");
const os = require("os");
const fs = require("fs");
require("dotenv").config({ path: path.join(__dirname, "..", "..", ".env.local") });

const { chromium } = require("playwright");
const forrent = require("../../skills/forrent");
const { analyzeAndCropImages } = require("../../skills/image-ai");
const { checkImageSufficiency, fetchBukakuImages } = require("../../skills/bukaku-images");

// 物確対応3物件
const TARGET_IDS = [
  "100138008048",  // La Douceur東神田 (ITANDI BB)
  "100138010644",  // ベルファース神田神保町 (いえらぶBB)
  "100138011179",  // LaSante一番町 (ITANDI BB)
];

const results = [];

async function processProperty(context, reinsId, index) {
  const downloadDir = path.join(os.homedir(), "Desktop", "suumo-nyuko", reinsId);
  const cacheFile = path.join(downloadDir, "test-cache.json");

  console.log(`\n${"█".repeat(60)}`);
  console.log(`  [${index + 1}/${TARGET_IDS.length}] ${reinsId}`);
  console.log(`${"█".repeat(60)}`);

  if (!fs.existsSync(cacheFile)) {
    console.log("  キャッシュなし → スキップ");
    return { reinsId, status: "NO_CACHE", score: null };
  }

  const cache = JSON.parse(fs.readFileSync(cacheFile, "utf-8"));
  const reinsData = cache.reinsData;
  let processedImages = (cache.processedImages || []).filter(
    img => !img.localPath.includes("map_surrounding")
  );
  const texts = cache.texts;

  console.log(`  物件名: ${reinsData.建物名}`);
  console.log(`  商号: ${reinsData.商号}`);
  console.log(`  既存画像: ${processedImages.length}枚`);

  // 既存画像のカテゴリ表示
  const existingCats = processedImages.map(img => `${img.categoryId}(${img.categoryLabel})`);
  console.log(`  カテゴリ: ${existingCats.join(", ")}`);

  // 物確画像取得
  const sufficiency = checkImageSufficiency(processedImages);
  if (sufficiency.insufficient) {
    console.log(`  5pt不足: ${sufficiency.missingCategories.join(", ")}`);
    try {
      const bukakuImages = await fetchBukakuImages(context, reinsData, downloadDir);
      if (bukakuImages.length > 0) {
        const existCats = processedImages.map(img => img.categoryId);
        const bukakuProcessed = await analyzeAndCropImages(bukakuImages, downloadDir, existCats);
        processedImages.push(...bukakuProcessed);
        console.log(`  物確追加: ${bukakuProcessed.length}枚 → 合計${processedImages.length}枚`);
        const newCats = bukakuProcessed.map(img => `${img.categoryId}(${img.categoryLabel})`);
        console.log(`  新カテゴリ: ${newCats.join(", ")}`);
      } else {
        console.log(`  物確: 画像なし`);
      }
    } catch (e) {
      console.log(`  物確エラー: ${e.message.slice(0, 100)}`);
    }
  } else {
    console.log(`  5ptカテゴリ全て揃い → 物確不要`);
  }

  // forrent.jp入稿 + スコア確認
  console.log("  forrent.jp入稿中...");
  const forrentPage = await context.newPage();

  try {
    const forrentOk = await forrent.login(forrentPage, {
      id: process.env.SUUMO_LOGIN_ID,
      pass: process.env.SUUMO_LOGIN_PASS,
    });
    if (!forrentOk) {
      await forrentPage.close();
      return { reinsId, propertyName: reinsData.建物名, status: "LOGIN_FAIL", score: null };
    }

    const { mainFrame } = await forrent.navigateToNewProperty(forrentPage);
    const { filled, errors: formErrors } = await forrent.fillPropertyForm(mainFrame, reinsData);
    const textErrors = await forrent.fillTexts(mainFrame, texts.catchCopy, texts.freeComment, reinsData);
    const { uploaded, errors: uploadErrors } = await forrent.uploadImages(mainFrame, processedImages);
    const tokuchoResult = await forrent.fillTokucho(mainFrame, reinsData);
    const transportResult = await forrent.fillTransportViaMap(forrentPage, mainFrame, reinsData.交通);
    const shuhenResult = await forrent.fillShuhenKankyo(forrentPage, mainFrame);

    console.log(`  入力: ${Object.keys(filled).length}件, 画像: ${uploaded.length}枚, 交通: ${transportResult.filled.length}, 周辺: ${shuhenResult.filled.length}`);

    // スコア確認
    let score = null;
    try {
      await mainFrame.evaluate(() => window.scrollTo(0, 0));
      await mainFrame.waitForTimeout(500);

      forrentPage.on("dialog", async (dialog) => { await dialog.accept(); });

      await mainFrame.evaluate(() => {
        const btn = document.getElementById("regButton2");
        if (btn) btn.click();
      });
      await mainFrame.waitForTimeout(10000);

      const confirmFrame = forrentPage.frame({ name: "main" }) || mainFrame;
      const pageInfo = await confirmFrame.evaluate(() => {
        const body = document.body?.innerText || "";
        const scorePatterns = [
          /名寄せスコア[：:\s]*(\d+)/, /スコア[：:\s]*(\d+)/,
          /合計[：:\s]*(\d+)\s*点/, /(\d+)\s*点\s*\/\s*\d+\s*点/,
        ];
        let score = null;
        for (const re of scorePatterns) {
          const m = body.match(re);
          if (m) { score = parseInt(m[1]); break; }
        }
        return { score };
      });
      score = pageInfo.score;
    } catch (e) {
      console.log(`  スコア取得エラー: ${e.message.slice(0, 80)}`);
    }

    await forrentPage.close();

    const status = score !== null ? (score >= 40 ? "PASS" : "FAIL") : "NO_SCORE";
    const icon = status === "PASS" ? "✓" : "✗";
    console.log(`  ${icon} スコア: ${score ?? "N/A"} / 43 (${status})`);

    return {
      reinsId,
      propertyName: reinsData.建物名,
      status,
      score,
      images: uploaded.length,
      商号: reinsData.商号,
    };
  } catch (err) {
    try { await forrentPage.close(); } catch {}
    return { reinsId, propertyName: reinsData.建物名, status: "ERROR", score: null, error: err.message.slice(0, 100) };
  }
}

async function main() {
  console.log("═".repeat(60));
  console.log("  物確画像統合テスト");
  console.log(`  対象: ${TARGET_IDS.length}物件`);
  console.log("═".repeat(60));

  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });

  try {
    for (let i = 0; i < TARGET_IDS.length; i++) {
      const result = await processProperty(context, TARGET_IDS[i], i);
      results.push(result);
    }

    // サマリー
    console.log(`\n${"═".repeat(60)}`);
    console.log("  結果サマリー");
    console.log(`${"═".repeat(60)}`);
    for (const r of results) {
      const icon = r.status === "PASS" ? "✓" : "✗";
      console.log(`  ${icon} ${r.propertyName}: ${r.score ?? "N/A"}点 (${r.status})`);
    }

    const passCount = results.filter(r => r.status === "PASS").length;
    console.log(`\n  合格: ${passCount}/${results.length}`);
  } finally {
    await browser.close();
  }
}

main().catch(console.error);
