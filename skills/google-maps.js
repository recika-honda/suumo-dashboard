/**
 * Google Maps Screenshot — 周辺環境画像取得
 *
 * Google Mapsで物件住所を検索し、地図のスクリーンショットを撮影。
 * SUUMO名寄せスコアの「周辺環境」カテゴリ画像として使用（+1pt）。
 */

const path = require("path");

/**
 * Google Mapsで住所を検索し、地図スクリーンショットを保存。
 *
 * @param {import('playwright').Page} page - Playwrightページ（専用ページを推奨）
 * @param {string} address - 検索する住所（例: "東京都新宿区上落合2丁目"）
 * @param {string} outputDir - 画像保存先ディレクトリ
 * @returns {{ localPath: string, categoryId: string, categoryLabel: string } | null}
 */
async function captureMapScreenshot(page, address, outputDir) {
  if (!address) return null;

  const fs = require("fs");
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  try {
    // Google Mapsを開く
    const searchUrl = `https://www.google.com/maps/search/${encodeURIComponent(address)}`;
    await page.goto(searchUrl, {
      waitUntil: "domcontentloaded",
      timeout: 30000,
    });

    // 地図の読み込みを待つ
    await page.waitForTimeout(5000);

    // Cookie同意ダイアログを閉じる（日本のGoogleでは出ないことが多いが念のため）
    try {
      const consentBtn = await page.$('button:has-text("同意する")');
      if (consentBtn) {
        await consentBtn.click();
        await page.waitForTimeout(2000);
      }
    } catch {}

    // サイドパネルを閉じて地図を広く表示
    try {
      const closeBtn = await page.$('button[aria-label="閉じる"]');
      if (closeBtn) {
        await closeBtn.click();
        await page.waitForTimeout(1000);
      }
    } catch {}

    // スクリーンショット撮影
    const outputPath = path.join(outputDir, "map_surrounding.jpg");
    await page.screenshot({
      type: "jpeg",
      quality: 90,
      path: outputPath,
    });

    console.log(`[google-maps] 周辺環境スクリーンショット保存: ${outputPath}`);

    return {
      localPath: outputPath,
      categoryId: "SH",
      categoryLabel: "周辺環境",
    };
  } catch (err) {
    console.error(`[google-maps] スクリーンショット取得失敗: ${err.message}`);
    return null;
  }
}

module.exports = { captureMapScreenshot };
