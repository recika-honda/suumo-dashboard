/**
 * クイックテスト — 3物件でフォーム入力の動作確認
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

const PROPERTY_IDS = [
  "100138010905",  // プルデンシャルタワー（PASS実績）
  "100137937131",  // みどり荘（管理費エラーあり → 修正確認）
  "100138006806",  // カスタリア神保町（39pt near-PASS）
  "100138010644",  // ベルファース（35pt near-PASS）
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

  if (fs.existsSync(cacheFile)) {
    try {
      cache = JSON.parse(fs.readFileSync(cacheFile, "utf-8"));
      console.log(`  キャッシュ使用: ${cache.reinsData.建物名}`);
    } catch { cache = null; }
  }

  if (cache) {
    reinsData = cache.reinsData;
    // map_surrounding除外（修正点12: Google Maps画像は使わない）
    processedImages = (cache.processedImages || []).filter(
      img => !img.localPath.includes("map_surrounding")
    );
    texts = cache.texts;
  } else {
    console.log("  [1/4] REINS検索...");
    if (index > 0) {
      await reinsPage.goto("https://system.reins.jp/main/KG/GKG003100", {
        waitUntil: "networkidle", timeout: 20000,
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

    console.log("  [2/4] 画像スクリーンショット...");
    const imagesMeta = await reins.extractImageData(reinsPage);
    const downloaded = await reins.screenshotAllImages(reinsPage, imagesMeta, downloadDir);
    console.log(`  ${downloaded.length}枚取得`);

    console.log("  [3/4] AI画像分類...");
    processedImages = await analyzeAndCropImages(downloaded, downloadDir);
    console.log(`  ${processedImages.length}枚分類完了`);

    console.log("  [4/4] AIテキスト生成...");
    texts = await generateTexts(reinsData);
    console.log(`  キャッチ: "${texts.catchCopy}"`);

    const cacheData = { reinsData, processedImages, texts, cachedAt: new Date().toISOString() };
    fs.writeFileSync(cacheFile, JSON.stringify(cacheData, null, 2));
  }

  console.log("  [5/5] forrent.jp入稿...");
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
    console.log(`  OK: ${Object.keys(filled).length}, NG: ${allErrors.length}, 画像: ${uploaded.length}, 交通: ${transportResult.filled.length}, 周辺: ${shuhenResult.filled.length}, 特徴: ${tokuchoResult.checked}`);

    // スコア確認
    console.log("  スコア確認...");
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

    const ssPath = path.join(downloadDir, `quick-test-result.png`);
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
      tokucho: tokuchoResult.checked,
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
  console.log("  クイックテスト (3物件)");
  console.log("═".repeat(60));

  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });

  try {
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
        });
      }
    }

    console.log(`\n\n${"═".repeat(70)}`);
    console.log("  クイックテスト結果");
    console.log(`${"═".repeat(70)}`);
    for (let i = 0; i < results.length; i++) {
      const r = results[i];
      const icon = r.status === "PASS" ? "✓" : r.status === "FAIL" ? "✗" : "?";
      console.log(`  ${icon} ${r.reinsId} | ${(r.propertyName || "").slice(0, 20)} | ${r.score ?? "N/A"}/43 | OK:${r.filled || 0} IMG:${r.images || 0} TR:${r.transport || 0} TK:${r.tokucho || 0} | ${r.duration || 0}s`);
    }
    const passCount = results.filter(r => r.status === "PASS").length;
    const scored = results.filter(r => r.score !== null);
    const avg = scored.length > 0 ? (scored.reduce((s, r) => s + r.score, 0) / scored.length).toFixed(1) : "N/A";
    console.log(`\n  合格: ${passCount}/${PROPERTY_IDS.length} | 平均: ${avg}pt`);
    console.log(`${"═".repeat(70)}\n`);

  } catch (err) {
    console.error("Fatal:", err);
  } finally {
    await browser.close();
  }
}

main();
