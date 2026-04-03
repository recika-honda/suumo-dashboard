#!/usr/bin/env node
/**
 * batch-nyuko.js — Notion「広告待ち」物件を自動入稿
 *
 * Notion DBから Status="広告待ち" の物件を取得し、
 * REINS → forrent.jp の入稿パイプラインを実行。
 * 成功時は Status を "登録済み" に更新。
 *
 * Usage:
 *   bun run scripts/batch-nyuko.js           # 広告待ち物件を処理
 *   bun run scripts/batch-nyuko.js --dry-run # Notion確認のみ（入稿しない）
 *
 * 出力: JSON形式のレポートを stdout に出力
 */

const path = require("path");
const os = require("os");
const fs = require("fs");

const envPath = path.join(__dirname, "..", ".env.local");
if (fs.existsSync(envPath)) {
  require("dotenv").config({ path: envPath });
}

const { chromium } = require("playwright");
const { Client: NotionClient } = require("@notionhq/client");
const reins = require("../skills/reins");
const forrent = require("../skills/forrent");
const { analyzeAndCropImages } = require("../skills/image-ai");
const { generateTexts } = require("../skills/text-ai");
const { checkImageSufficiency, fetchBukakuData } = require("../skills/bukaku");
const { fetchShuhenPhotos } = require("../skills/google-images");

const notion = new NotionClient({ auth: process.env.NOTION_TOKEN });
const DB_ID = process.env.NOTION_DATABASE_ID;

const MAX_LOGIN_RETRIES = 3;
const PROPERTY_TIMEOUT_MS = 15 * 60 * 1000; // 15 minutes per property
const dryRun = process.argv.includes("--dry-run");

// ── Notion: fetch properties with Status = "広告待ち" ────
async function fetchPendingProperties() {
  const pages = [];
  let cursor = undefined;
  do {
    const db = await notion.databases.query({
      database_id: DB_ID,
      filter: {
        property: "Status",
        status: { equals: "広告待ち" },
      },
      page_size: 100,
      ...(cursor && { start_cursor: cursor }),
    });
    for (const p of db.results) {
      pages.push({
        pageId: p.id,
        reinsId: p.properties.REINS_ID?.title?.[0]?.plain_text || "",
      });
    }
    cursor = db.has_more ? db.next_cursor : undefined;
  } while (cursor);
  return pages;
}

// ── Notion: update Status ────────────────────────────────
async function updateNotionStatus(pageId, statusName) {
  await notion.pages.update({
    page_id: pageId,
    properties: {
      Status: { status: { name: statusName } },
    },
  });
}

// ── REINS login with retry ───────────────────────────────
async function loginReins(page) {
  for (let attempt = 1; attempt <= MAX_LOGIN_RETRIES; attempt++) {
    try {
      const ok = await reins.login(page, {
        id: process.env.REINS_LOGIN_ID,
        pass: process.env.REINS_LOGIN_PASS,
      });
      if (ok) return true;
      console.error(`[reins] Login attempt ${attempt}: wrong page`);
    } catch (err) {
      console.error(`[reins] Login attempt ${attempt}: ${err.message}`);
    }
    if (attempt < MAX_LOGIN_RETRIES) await page.waitForTimeout(3000);
  }
  return false;
}

// ── Process single property (full pipeline) ──────────────
async function processProperty(context, reinsPage, reinsId, index, total) {
  const downloadDir = path.join(os.homedir(), "Desktop", "suumo-nyuko", reinsId);
  fs.mkdirSync(downloadDir, { recursive: true });

  const label = `[${index + 1}/${total}] ${reinsId}`;
  console.error(`\n${"━".repeat(50)}`);
  console.error(`  ${label}`);
  console.error(`${"━".repeat(50)}`);

  // ── Step 1: REINS data extraction ──
  if (index > 0) {
    await reinsPage.goto("https://system.reins.jp/main/KG/GKG003100", {
      waitUntil: "networkidle",
      timeout: 20000,
    });
    await reinsPage.waitForTimeout(3000);
  }

  console.error("  [1/6] REINS検索...");
  const found = await reins.searchByNumber(reinsPage, reinsId);
  if (!found) {
    console.error("  -> 物件が見つかりませんでした");
    return { reinsId, status: "NOT_FOUND", propertyName: "N/A" };
  }

  const reinsData = await reins.extractPropertyData(reinsPage);
  console.error(`  物件名: ${reinsData.建物名}`);

  // ── Step 2: Images ──
  console.error("  [2/6] 画像スクリーンショット...");
  const imagesMeta = await reins.extractImageData(reinsPage);
  const downloaded = await reins.screenshotAllImages(reinsPage, imagesMeta, downloadDir);
  console.error(`  ${downloaded.length}枚取得`);

  // ── Step 3: AI image classification + bukaku + shuhen ──
  console.error("  [3/6] AI画像分類...");

  // Start bukaku fetch in parallel
  const bukakuDataPromise = fetchBukakuData(context, reinsData, downloadDir).catch((e) => {
    console.error(`  [bukaku] Error (non-blocking): ${e.message}`);
    return { initialCosts: null, images: [] };
  });

  let processedImages = await analyzeAndCropImages(downloaded, downloadDir);
  console.error(`  ${processedImages.length}枚分類完了`);

  // Bukaku supplementary images
  const bukakuResult = await bukakuDataPromise;
  const initialCostData = bukakuResult.initialCosts;
  if (initialCostData) {
    console.error(`  [bukaku] 初期費用: ${Object.keys(initialCostData).length}項目`);
  }

  const sufficiency = checkImageSufficiency(processedImages);
  if (sufficiency.insufficient && bukakuResult.images.length > 0) {
    console.error(`  [bukaku] 5ptカテゴリ不足 → 物確画像を分類中...`);
    try {
      const existingCats = processedImages.map((img) => img.categoryId);
      const bukakuProcessed = await analyzeAndCropImages(bukakuResult.images, downloadDir, existingCats);
      processedImages.push(...bukakuProcessed);
      console.error(`  物確: ${bukakuProcessed.length}枚追加`);
    } catch (e) {
      console.error(`  [bukaku] Image classification error: ${e.message}`);
    }
  }

  // Shuhen photos (separate browser to avoid memory pressure)
  console.error("  [3.5/6] 周辺環境写真取得...");
  let shuhenBrowser;
  try {
    shuhenBrowser = await chromium.launch({ headless: false });
    const shuhenContext = await shuhenBrowser.newContext({ viewport: { width: 1280, height: 900 } });
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

  // ── Step 4: AI text generation ──
  console.error("  [4/6] AIテキスト生成...");
  const texts = await generateTexts(reinsData);
  console.error(`  キャッチ: "${texts.catchCopy}"`);

  // ── Step 5: forrent.jp submission ──
  console.error("  [5/6] forrent.jp入稿...");
  const forrentPage = await context.newPage();

  try {
    const forrentOk = await forrent.login(forrentPage, {
      id: process.env.SUUMO_LOGIN_ID,
      pass: process.env.SUUMO_LOGIN_PASS,
    });
    if (!forrentOk) {
      console.error("  -> forrent.jpログイン失敗");
      await forrentPage.close();
      return { reinsId, status: "FORRENT_LOGIN_FAIL", propertyName: reinsData.建物名 };
    }

    let { mainFrame } = await forrent.navigateToNewProperty(forrentPage);

    const { filled, errors: formErrors } = await forrent.fillPropertyForm(
      mainFrame,
      reinsData,
      initialCostData
    );

    const textErrors = await forrent.fillTexts(
      mainFrame,
      texts.catchCopy,
      texts.freeComment,
      reinsData,
      initialCostData
    );

    const { uploaded, errors: uploadErrors } = await forrent.uploadImages(mainFrame, processedImages);
    const tokuchoResult = await forrent.fillTokucho(mainFrame, reinsData);
    const transportResult = await forrent.fillTransportViaMap(forrentPage, mainFrame, reinsData.交通);

    mainFrame = forrentPage.frame({ name: "main" }) || mainFrame;

    const shuhenResult = await forrent.fillShuhenKankyo(forrentPage, mainFrame);
    mainFrame = forrentPage.frame({ name: "main" }) || mainFrame;

    // Sync shuhen facility names
    try {
      await mainFrame.evaluate(() => {
        for (let i = 0; i < 6; i++) {
          const nameEl = document.querySelector(
            `input[name="bukkenInputForm.shuhenKankyoInputForm[${i}].shuhenKankyoNm"]`
          );
          const destEl = document.getElementById(`destination${i + 1}`);
          if (nameEl && nameEl.value && destEl) {
            destEl.value = nameEl.value;
            destEl.dispatchEvent(new Event("input", { bubbles: true }));
          }
        }
      });
    } catch (e) {
      // Non-critical
    }

    const allErrors = [
      ...formErrors,
      ...transportResult.errors,
      ...textErrors,
      ...uploadErrors,
      ...shuhenResult.errors,
    ];

    console.error(
      `  入力: ${Object.keys(filled).length}件, 画像: ${uploaded.length}枚, 交通: ${transportResult.filled.length}件, 周辺: ${shuhenResult.filled.length}件`
    );

    // ── Step 6: Register (actual save) ──
    console.error("  [6/6] 登録...");
    let regResult = { saved: false, registrationType: null };
    try {
      regResult = await forrent.registerProperty(forrentPage, mainFrame);
      if (regResult.saved) {
        const scoreText = regResult.score ? ` (${regResult.score}pt/43pt)` : "";
        console.error(`  -> ${regResult.registrationType}完了${scoreText}`);
      } else {
        console.error(`  -> 登録失敗: ${regResult.error || "不明"}`);
      }
    } catch (e) {
      console.error(`  -> 登録エラー: ${e.message.slice(0, 100)}`);
    }

    await forrentPage.close();

    return {
      reinsId,
      propertyName: reinsData.建物名 || reinsId,
      status: regResult.saved ? "SUCCESS" : "REG_FAIL",
      score: regResult.score || null,
      registrationType: regResult.registrationType,
      filledFields: Object.keys(filled).length,
      uploadedImages: uploaded.length,
      transport: transportResult.filled.length,
      shuhen: shuhenResult.filled.length,
      errors: allErrors.length,
    };
  } catch (err) {
    console.error(`  -> エラー: ${err.message.slice(0, 150)}`);
    try {
      await forrentPage.close();
    } catch {}
    return {
      reinsId,
      propertyName: reinsData?.建物名 || reinsId,
      status: "ERROR",
      error: err.message.slice(0, 200),
    };
  }
}

// ── Main ─────────────────────────────────────────────────
async function main() {
  console.error("═".repeat(50));
  console.error("  SUUMO入稿バッチ (batch-nyuko)");
  console.error("═".repeat(50));

  // 1. Fetch pending properties from Notion
  const pending = await fetchPendingProperties();
  console.error(`\n  Notion「広告待ち」: ${pending.length}件`);

  if (pending.length === 0) {
    const report = { processed: 0, succeeded: 0, failed: 0, results: [] };
    console.log(JSON.stringify(report));
    return;
  }

  if (dryRun) {
    console.error("\n  [dry-run] 物件一覧:");
    for (const p of pending) {
      console.error(`    - ${p.reinsId}`);
    }
    const report = { processed: 0, succeeded: 0, failed: 0, dryRun: true, pending: pending.length, results: [] };
    console.log(JSON.stringify(report));
    return;
  }

  // 2. Launch browser & login to REINS
  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const reinsPage = await context.newPage();

  console.error("\n  REINSログイン中...");
  const reinsOk = await loginReins(reinsPage);
  if (!reinsOk) {
    await browser.close();
    const report = {
      processed: 0,
      succeeded: 0,
      failed: pending.length,
      error: "REINS_LOGIN_FAILED",
      results: [],
    };
    console.log(JSON.stringify(report));
    process.exit(1);
  }
  console.error("  REINSログイン成功\n");

  // 3. Process each property
  const results = [];
  let succeeded = 0;
  let failed = 0;

  for (let i = 0; i < pending.length; i++) {
    const { pageId, reinsId } = pending[i];
    const startTime = Date.now();

    let result;
    try {
      // Per-property timeout
      result = await Promise.race([
        processProperty(context, reinsPage, reinsId, i, pending.length),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error("タイムアウト（15分）")), PROPERTY_TIMEOUT_MS)
        ),
      ]);
    } catch (err) {
      result = {
        reinsId,
        propertyName: "N/A",
        status: "TIMEOUT",
        error: err.message,
      };
    }

    result.duration = Math.round((Date.now() - startTime) / 1000);

    // Update Notion status on success
    if (result.status === "SUCCESS") {
      try {
        await updateNotionStatus(pageId, "登録済み");
        console.error(`  [notion] Status → 登録済み`);
        succeeded++;
      } catch (e) {
        console.error(`  [notion] Status更新失敗: ${e.message}`);
        result.notionUpdateFailed = true;
      }
    } else {
      failed++;
    }

    results.push(result);
  }

  await browser.close();

  // 4. Output JSON report
  const report = {
    processed: pending.length,
    succeeded,
    failed,
    results,
  };
  console.log(JSON.stringify(report));

  // Summary to stderr
  console.error(`\n${"═".repeat(50)}`);
  console.error(`  完了: ${succeeded}/${pending.length} 成功, ${failed} 失敗`);
  for (const r of results) {
    const icon = r.status === "SUCCESS" ? "✓" : "✗";
    const score = r.score ? ` (${r.score}pt)` : "";
    console.error(`  ${icon} ${r.reinsId} ${r.propertyName || ""}${score} [${r.duration}s]`);
  }
  console.error("═".repeat(50));
}

main().catch(async (err) => {
  const report = {
    processed: 0,
    succeeded: 0,
    failed: 0,
    error: err.message,
    results: [],
  };
  console.log(JSON.stringify(report));
  process.exit(1);
});
