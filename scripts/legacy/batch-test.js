/**
 * バッチテスト — 複数物件を連続処理してスコアを集計
 *
 * REINS/forrent.jpログインを1回で済ませ、14物件を順番に処理。
 *
 * Usage:
 *   bun run scripts/batch-test.js
 *   bun run scripts/batch-test.js --fresh   # キャッシュ無視
 */

const path = require("path");
const os = require("os");
const fs = require("fs");
require("dotenv").config({ path: path.join(__dirname, "..", "..", ".env.local") });

const { chromium } = require("playwright");
const reins = require("../../skills/reins");
const forrent = require("../../skills/forrent");
const { analyzeAndCropImages } = require("../../skills/image-ai");
const { generateTexts } = require("../../skills/text-ai");
const { checkImageSufficiency, fetchBukakuImages } = require("../../skills/bukaku-images");

const fresh = process.argv.includes("--fresh");

const PROPERTY_IDS = [
  "100138010905",
  "100138010644",
  "100137934373",
  "100138011179",
  "100137922489",
  "100138008048",
  "100137937131",
  "100137939644",
  "100138006806",
  "100137977235",
  "100137939263",
  "100137933042",
  "100137997996",
  "100137977820",
];

const results = [];

async function processProperty(context, reinsPage, reinsId, index) {
  const downloadDir = path.join(os.homedir(), "Desktop", "suumo-nyuko", reinsId);
  fs.mkdirSync(downloadDir, { recursive: true });
  const cacheFile = path.join(downloadDir, "test-cache.json");

  console.log(`\n${"█".repeat(60)}`);
  console.log(`  [${index + 1}/${PROPERTY_IDS.length}] ${reinsId}`);
  console.log(`${"█".repeat(60)}`);

  let reinsData, processedImages, texts;
  let cache = null;

  // キャッシュチェック
  if (!fresh && fs.existsSync(cacheFile)) {
    try {
      cache = JSON.parse(fs.readFileSync(cacheFile, "utf-8"));
      console.log(`  キャッシュ使用: ${cache.reinsData.建物名}`);
    } catch {
      cache = null;
    }
  }

  if (cache) {
    reinsData = cache.reinsData;
    processedImages = (cache.processedImages || []).filter(
      img => !img.localPath.includes("map_surrounding")
    );
    texts = cache.texts;

    // キャッシュ使用時も物確画像が不足なら取得
    const sufficiency = checkImageSufficiency(processedImages);
    if (sufficiency.insufficient && !cache.bukakuDone) {
      console.log(`  [cache+bukaku] 物確画像取得中（不足: ${sufficiency.missingCategories.join(",")}）...`);
      try {
        const bukakuImages = await fetchBukakuImages(context, reinsData, downloadDir);
        if (bukakuImages.length > 0) {
          const existingCats = processedImages.map(img => img.categoryId);
          const bukakuProcessed = await analyzeAndCropImages(bukakuImages, downloadDir, existingCats);
          processedImages.push(...bukakuProcessed);
          console.log(`  物確: ${bukakuProcessed.length}枚追加 → 合計${processedImages.length}枚`);
        }
        // キャッシュ更新
        cache.processedImages = processedImages;
        cache.bukakuDone = true;
        fs.writeFileSync(cacheFile, JSON.stringify(cache, null, 2));
      } catch (e) {
        console.log(`  物確エラー: ${e.message.slice(0, 80)}`);
      }
    }
  } else {
    // REINS データ取得
    console.log("  [1/6] REINS検索...");

    // 2物件目以降: ダッシュボードに戻ってから検索
    if (index > 0) {
      await reinsPage.goto("https://system.reins.jp/main/KG/GKG003100", {
        waitUntil: "networkidle",
        timeout: 20000,
      });
      await reinsPage.waitForTimeout(3000);
    }

    const found = await reins.searchByNumber(reinsPage, reinsId);
    if (!found) {
      console.log(`  ✗ 物件が見つかりませんでした`);
      return { reinsId, status: "NOT_FOUND", score: null, propertyName: "N/A" };
    }

    reinsData = await reins.extractPropertyData(reinsPage);
    console.log(`  物件名: ${reinsData.建物名}`);
    console.log(`  所在地: ${[reinsData.都道府県名, reinsData.所在地名１, reinsData.所在地名２, reinsData.所在地名３].join("")}`);

    // 画像スクリーンショット
    console.log("  [2/6] 画像スクリーンショット...");
    const imagesMeta = await reins.extractImageData(reinsPage);
    const downloaded = await reins.screenshotAllImages(reinsPage, imagesMeta, downloadDir);
    console.log(`  ${downloaded.length}枚取得`);

    // AI画像処理
    console.log("  [3/6] AI画像分類...");
    processedImages = await analyzeAndCropImages(downloaded, downloadDir);
    console.log(`  ${processedImages.length}枚分類完了`);

    // 物確プラットフォームから追加画像
    const sufficiency = checkImageSufficiency(processedImages);
    if (sufficiency.insufficient) {
      console.log(`  [3.5/6] 物確画像取得中（不足: ${sufficiency.missingCategories.join(",")}）...`);
      try {
        const bukakuImages = await fetchBukakuImages(context, reinsData, downloadDir);
        if (bukakuImages.length > 0) {
          const existingCats = processedImages.map(img => img.categoryId);
          const bukakuProcessed = await analyzeAndCropImages(bukakuImages, downloadDir, existingCats);
          processedImages.push(...bukakuProcessed);
          console.log(`  物確: ${bukakuProcessed.length}枚追加 → 合計${processedImages.length}枚`);
        } else {
          console.log(`  物確: 画像なし`);
        }
      } catch (e) {
        console.log(`  物確エラー: ${e.message.slice(0, 80)}`);
      }
    }

    // AIテキスト生成
    console.log("  [4/6] AIテキスト生成...");
    texts = await generateTexts(reinsData);
    console.log(`  キャッチ: "${texts.catchCopy}"`);

    // キャッシュ保存
    const cacheData = { reinsData, processedImages, texts, bukakuDone: true, cachedAt: new Date().toISOString() };
    fs.writeFileSync(cacheFile, JSON.stringify(cacheData, null, 2));
  }

  // forrent.jp フォーム入力（毎回新規ページ）
  console.log("  [5/6] forrent.jp入稿...");
  const forrentPage = await context.newPage();

  try {
    const forrentOk = await forrent.login(forrentPage, {
      id: process.env.SUUMO_LOGIN_ID,
      pass: process.env.SUUMO_LOGIN_PASS,
    });
    if (!forrentOk) {
      console.log("  ✗ forrent.jpログイン失敗");
      await forrentPage.close();
      return { reinsId, status: "LOGIN_FAIL", score: null, propertyName: reinsData.建物名 };
    }

    const { mainFrame } = await forrent.navigateToNewProperty(forrentPage);

    const { filled, errors: formErrors } = await forrent.fillPropertyForm(mainFrame, reinsData);
    const textErrors = await forrent.fillTexts(mainFrame, texts.catchCopy, texts.freeComment, reinsData);
    const { uploaded, errors: uploadErrors } = await forrent.uploadImages(mainFrame, processedImages);
    const tokuchoResult = await forrent.fillTokucho(mainFrame, reinsData);
    const transportResult = await forrent.fillTransportViaMap(forrentPage, mainFrame, reinsData.交通);
    const shuhenResult = await forrent.fillShuhenKankyo(forrentPage, mainFrame);

    const allErrors = [...formErrors, ...transportResult.errors, ...textErrors, ...uploadErrors, ...shuhenResult.errors];
    console.log(`  OK: ${Object.keys(filled).length}, NG: ${allErrors.length}, 画像: ${uploaded.length}, 交通: ${transportResult.filled.length}, 周辺: ${shuhenResult.filled.length}`);

    // 確認画面でスコア確認
    console.log("  [6/6] スコア確認...");
    let score = null;
    let validationErrors = [];

    try {
      await mainFrame.evaluate(() => window.scrollTo(0, 0));
      await mainFrame.waitForTimeout(500);

      const dialogs = [];
      forrentPage.on("dialog", async (dialog) => {
        dialogs.push({ type: dialog.type(), message: dialog.message() });
        await dialog.accept();
      });

      await mainFrame.evaluate(() => {
        const btn = document.getElementById("regButton2");
        if (btn) btn.click();
      });

      await mainFrame.waitForTimeout(10000);

      const confirmFrame = forrentPage.frame({ name: "main" }) || mainFrame;
      const pageInfo = await confirmFrame.evaluate(() => {
        const body = document.body?.innerText || "";
        const errorEls = document.querySelectorAll('.errorMessage, .error, [class*="error"], [class*="Error"]');
        const errors = [...errorEls].map(el => el.textContent.trim()).filter(Boolean);
        const redTexts = [...document.querySelectorAll('span[style*="color"], font[color="red"], .red')];
        const redErrors = redTexts.map(el => el.textContent.trim()).filter(t => t.length > 2 && t.length < 200);
        const scorePatterns = [
          /名寄せスコア[：:\s]*(\d+)/, /スコア[：:\s]*(\d+)/,
          /合計[：:\s]*(\d+)\s*点/, /(\d+)\s*点\s*\/\s*\d+\s*点/,
        ];
        let score = null;
        for (const re of scorePatterns) {
          const m = body.match(re);
          if (m) { score = parseInt(m[1]); break; }
        }
        return { errors, redErrors, score, bodySnippet: body.slice(0, 1000) };
      });

      score = pageInfo.score;
      validationErrors = [...pageInfo.errors, ...pageInfo.redErrors];
      if (dialogs.length > 0) {
        validationErrors.push(...dialogs.map(d => `[${d.type}] ${d.message}`));
      }
    } catch (e) {
      console.log(`  確認画面エラー: ${e.message.slice(0, 100)}`);
    }

    // スクリーンショット保存
    const ssPath = path.join(downloadDir, `batch-result.png`);
    await forrentPage.screenshot({ path: ssPath, fullPage: false });

    const status = score !== null ? (score >= 40 ? "PASS" : "FAIL") : "NO_SCORE";
    const icon = status === "PASS" ? "✓" : status === "FAIL" ? "✗" : "?";
    console.log(`  ${icon} スコア: ${score ?? "取得不可"} / 43 (${status})`);
    if (validationErrors.length > 0) {
      console.log(`  バリデーションエラー: ${validationErrors.slice(0, 3).join(", ")}`);
    }

    await forrentPage.close();

    return {
      reinsId,
      propertyName: reinsData.建物名 || reinsId,
      status,
      score,
      filled: Object.keys(filled).length,
      images: uploaded.length,
      transport: transportResult.filled.length,
      shuhen: shuhenResult.filled.length,
      errors: allErrors.length,
      validationErrors: validationErrors.length,
    };
  } catch (err) {
    console.log(`  ✗ エラー: ${err.message.slice(0, 150)}`);
    try { await forrentPage.close(); } catch {}
    return {
      reinsId,
      propertyName: reinsData?.建物名 || reinsId,
      status: "ERROR",
      score: null,
      error: err.message.slice(0, 100),
    };
  }
}

async function main() {
  console.log("═".repeat(60));
  console.log("  SUUMO入稿バッチテスト");
  console.log(`  物件数: ${PROPERTY_IDS.length}`);
  console.log(`  キャッシュ: ${fresh ? "無視" : "あれば使用"}`);
  console.log("═".repeat(60));

  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });

  try {
    // REINS ログイン（1回だけ）
    const reinsPage = await context.newPage();
    console.log("\n  REINSログイン中...");
    const reinsOk = await reins.login(reinsPage, {
      id: process.env.REINS_LOGIN_ID,
      pass: process.env.REINS_LOGIN_PASS,
    });
    if (!reinsOk) {
      console.error("REINSログイン失敗");
      await browser.close();
      process.exit(1);
    }
    console.log("  REINSログイン成功\n");

    // 各物件を処理
    for (let i = 0; i < PROPERTY_IDS.length; i++) {
      const startTime = Date.now();
      try {
        const result = await processProperty(context, reinsPage, PROPERTY_IDS[i], i);
        result.duration = Math.round((Date.now() - startTime) / 1000);
        results.push(result);
      } catch (err) {
        console.error(`  致命的エラー: ${err.message}`);
        results.push({
          reinsId: PROPERTY_IDS[i],
          propertyName: "N/A",
          status: "FATAL",
          score: null,
          duration: Math.round((Date.now() - startTime) / 1000),
          error: err.message.slice(0, 100),
        });
      }
    }

    // ══ 最終レポート ══
    console.log(`\n\n${"═".repeat(70)}`);
    console.log("  バッチテスト結果サマリー");
    console.log(`${"═".repeat(70)}`);
    console.log("");
    console.log("  #  | REINS ID       | 物件名                       | Score | Status    | Time");
    console.log("  " + "-".repeat(80));

    let passCount = 0;
    let totalScore = 0;
    let scoredCount = 0;

    for (let i = 0; i < results.length; i++) {
      const r = results[i];
      const name = (r.propertyName || "").slice(0, 24).padEnd(24);
      const scoreStr = r.score !== null ? `${r.score}/43` : "  N/A";
      const statusIcon = r.status === "PASS" ? "✓" : r.status === "FAIL" ? "✗" : r.status === "NOT_FOUND" ? "?" : "!";
      const dur = r.duration ? `${r.duration}s` : "";
      console.log(`  ${String(i + 1).padStart(2)} | ${r.reinsId} | ${name} | ${scoreStr.padStart(5)} | ${statusIcon} ${(r.status || "").padEnd(9)} | ${dur}`);

      if (r.status === "PASS") passCount++;
      if (r.score !== null) {
        totalScore += r.score;
        scoredCount++;
      }
    }

    console.log("  " + "-".repeat(80));
    console.log(`  合格: ${passCount}/${PROPERTY_IDS.length} (40点以上)`);
    if (scoredCount > 0) {
      console.log(`  平均スコア: ${(totalScore / scoredCount).toFixed(1)}点`);
    }
    const failedIds = results.filter(r => r.status !== "PASS").map(r => r.reinsId);
    if (failedIds.length > 0) {
      console.log(`  不合格/エラー: ${failedIds.join(", ")}`);
    }
    console.log(`${"═".repeat(70)}\n`);

    // 結果をJSONで保存
    const reportPath = path.join(os.homedir(), "Desktop", "suumo-nyuko", `batch-report-${Date.now()}.json`);
    fs.writeFileSync(reportPath, JSON.stringify(results, null, 2));
    console.log(`  レポート保存: ${reportPath}`);

  } catch (err) {
    console.error("Fatal:", err);
  } finally {
    await browser.close();
  }
}

main();
