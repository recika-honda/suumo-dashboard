/**
 * 物確画像取得テスト — ITANDI BB + いえらぶBB
 *
 * Usage: bun run scripts/test-bukaku.js
 */
const path = require("path");
const fs = require("fs");
require("dotenv").config({ path: path.join(__dirname, "..", "..", ".env.local") });
const { chromium } = require("playwright");
const { detectPlatform, fetchBukakuImages, checkImageSufficiency } = require("../../skills/bukaku-images");

const TEST_CASES = [
  {
    label: "La Douceur東神田 (ITANDI BB)",
    reinsData: {
      商号: "東急住宅リース（株）　リーシングサポートグループ１",
      建物名: "Ｌａ　Ｄｏｕｃｅｕｒ東神田",
      部屋番号: "202",
    },
  },
  {
    label: "ベルファース神田神保町 (いえらぶBB)",
    reinsData: {
      商号: "三井不動産レジデンシャルリース（株）　受託運営本部　運営三部運営課",
      建物名: "ベルファース神田神保町",
      部屋番号: "202",
    },
  },
  {
    label: "鈴木荘 (対応なし)",
    reinsData: {
      商号: "（株）未来投資不動産",
      建物名: "鈴木荘",
      部屋番号: "202",
    },
  },
];

async function test() {
  console.log("=== detectPlatform テスト ===\n");
  for (const tc of TEST_CASES) {
    const result = detectPlatform(tc.reinsData.商号);
    console.log(`${tc.label}:`);
    console.log(`  商号: ${tc.reinsData.商号}`);
    console.log(`  → platform: ${result.platform}, company: ${result.companyName}`);
    console.log();
  }

  console.log("=== fetchBukakuImages テスト ===\n");
  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });

  for (const tc of TEST_CASES) {
    const { platform } = detectPlatform(tc.reinsData.商号);
    if (!platform) {
      console.log(`[SKIP] ${tc.label}: 対応プラットフォームなし\n`);
      continue;
    }

    console.log(`[TEST] ${tc.label}`);
    const downloadDir = path.join(__dirname, "..", "..", "tmp", "bukaku-test");
    fs.mkdirSync(downloadDir, { recursive: true });

    try {
      const images = await fetchBukakuImages(context, tc.reinsData, downloadDir);
      console.log(`  結果: ${images.length}枚取得`);
      for (const img of images) {
        const stats = fs.statSync(img.localPath);
        console.log(`  - ${path.basename(img.localPath)} (${(stats.size / 1024).toFixed(0)}KB)`);
      }
    } catch (e) {
      console.error(`  エラー: ${e.message}`);
    }
    console.log();
  }

  console.log("テスト完了。ブラウザを閉じています...");
  await browser.close();
}

test().catch(console.error);
