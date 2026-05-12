#!/usr/bin/env node
/**
 * batch-nyuko.js — Notion「広告待ち」物件を自動入稿
 *
 * Notion DBから Status="広告待ち" の物件を取得し、
 * REINS → forrent.jp の入稿パイプラインを実行。
 * 成功時は Status を "掲載保留" に更新 (forrent側は shijiIsize=3=保留 で登録)。
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
const slack = require("../skills/slack");

const notion = new NotionClient({ auth: process.env.NOTION_TOKEN });
const DB_ID = process.env.NOTION_DATABASE_ID;

const MAX_LOGIN_RETRIES = 3;
const PROPERTY_TIMEOUT_MS = 15 * 60 * 1000; // 15 minutes per property
const dryRun = process.argv.includes("--dry-run");

// ── Run artifact / history logging ───────────────────────
const LOGS_DIR = path.join(__dirname, "..", "logs");
const RUNS_DIR = path.join(LOGS_DIR, "runs");
const HISTORY_PATH = path.join(LOGS_DIR, "nyuko-history.jsonl");

function nowTsCompact() {
  const d = new Date();
  const jst = new Date(d.getTime() + 9 * 3600 * 1000);
  const pad = (n) => String(n).padStart(2, "0");
  return `${jst.getUTCFullYear()}${pad(jst.getUTCMonth() + 1)}${pad(jst.getUTCDate())}-${pad(jst.getUTCHours())}${pad(jst.getUTCMinutes())}${pad(jst.getUTCSeconds())}`;
}

function createRunLog(reinsId) {
  const ts = nowTsCompact();
  const dir = path.join(RUNS_DIR, `${ts}_${reinsId}`);
  fs.mkdirSync(dir, { recursive: true });
  const startedAt = new Date().toISOString();
  const steps = [];
  const data = { reinsId, startedAt, steps, status: null };

  const writeRunJson = () => {
    try {
      fs.writeFileSync(path.join(dir, "run.json"), JSON.stringify(data, null, 2));
    } catch (e) {
      console.error(`[runlog] write failed: ${e.message}`);
    }
  };

  const step = (name, extra = {}) => {
    const entry = { name, at: new Date().toISOString(), ...extra };
    steps.push(entry);
    writeRunJson();
    return entry;
  };

  const finish = (summary) => {
    Object.assign(data, summary, { finishedAt: new Date().toISOString() });
    writeRunJson();
    try {
      fs.mkdirSync(LOGS_DIR, { recursive: true });
      const hist = {
        ts: data.finishedAt,
        reinsId,
        propertyName: data.propertyName || null,
        status: data.status,
        score: data.score || null,
        duration: data.duration || null,
        errorsCount: Array.isArray(data.errors) ? data.errors.length : 0,
        firstError: Array.isArray(data.errors) && data.errors.length ? data.errors[0] : null,
        runDir: dir,
      };
      fs.appendFileSync(HISTORY_PATH, JSON.stringify(hist) + "\n");
    } catch (e) {
      console.error(`[runlog] history append failed: ${e.message}`);
    }
  };

  return { dir, data, step, finish };
}

// ── Browser launch options ──────────────────────────────
// デフォルト headless。NYUKO_HEADED=1 を立てれば画面表示（デバッグ用）。
const HEADLESS = process.env.NYUKO_HEADED !== "1";
const LAUNCH_OPTS = {
  headless: HEADLESS,
  args: [
    "--disable-blink-features=AutomationControlled",
    "--disable-features=IsolateOrigins,site-per-process",
  ],
};

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
async function processProperty(context, reinsPage, reinsId, index, total, runLog) {
  const downloadDir = path.join(os.homedir(), "Desktop", "suumo-nyuko", reinsId);
  fs.mkdirSync(downloadDir, { recursive: true });

  const label = `[${index + 1}/${total}] ${reinsId}`;
  console.error(`\n${"━".repeat(50)}`);
  console.error(`  ${label}`);
  console.error(`${"━".repeat(50)}`);

  const logStep = runLog ? runLog.step : () => {};

  // ── Step 1: REINS data extraction ──
  if (index > 0) {
    await reinsPage.goto("https://system.reins.jp/main/KG/GKG003100", {
      waitUntil: "networkidle",
      timeout: 20000,
    });
    await reinsPage.waitForTimeout(3000);
  }

  console.error("  [1/6] REINS検索...");
  logStep("reins_search_start");
  const found = await reins.searchByNumber(reinsPage, reinsId);
  if (!found) {
    console.error("  -> 物件が見つかりませんでした");
    logStep("reins_search_not_found");
    return { reinsId, status: "NOT_FOUND", propertyName: "N/A" };
  }

  const reinsData = await reins.extractPropertyData(reinsPage);
  console.error(`  物件名: ${reinsData.建物名}`);
  logStep("reins_extracted", { propertyName: reinsData.建物名, fieldCount: Object.keys(reinsData).length });
  if (runLog) {
    runLog.data.propertyName = reinsData.建物名;
    try {
      fs.writeFileSync(path.join(runLog.dir, "reins-data.json"), JSON.stringify(reinsData, null, 2));
    } catch {}
  }

  // ── 早期バリデーション: forrent.jp 必須項目欠落のショートサーキット ──

  // 物件名 (建物名) は全物件種目で forrent サーバ側必須。空ならば即 REG_FAIL。
  // (再現済み: 100139015499 — REINS 抽出で建物名 None / forrent「物件名を入力して下さい」)
  const buildingName = reinsData.建物名 ? String(reinsData.建物名).trim() : "";
  if (!buildingName) {
    console.error("  -> 建物名未取得（forrent必須） → REG_FAIL早期確定");
    logStep("missing_required_field", { field: "建物名", 物件種目: reinsData.物件種目 });
    return {
      reinsId,
      status: "REG_FAIL",
      propertyName: reinsId,
      reason: "REINSデータに建物名がありません",
    };
  }

  // 部屋番号は マンション/アパート で forrent サーバ側必須。REINS から取れていない場合、
  // 画像取得・AI 分類・ブラウザ起動を一切行わず REG_FAIL として入稿失敗に流す。
  const requiresHeyaNo = ["マンション", "アパート"].includes(reinsData.物件種目);
  if (requiresHeyaNo && !reinsData.部屋番号) {
    console.error("  -> 部屋番号未取得（forrent必須） → REG_FAIL早期確定");
    logStep("missing_required_field", { field: "部屋番号", 物件種目: reinsData.物件種目 });
    return {
      reinsId,
      status: "REG_FAIL",
      propertyName: reinsData.建物名,
      reason: "REINSデータに部屋番号がありません",
    };
  }

  // ── Step 2: Images ──
  console.error("  [2/6] 画像スクリーンショット...");
  const imagesMeta = await reins.extractImageData(reinsPage);
  const downloaded = await reins.screenshotAllImages(reinsPage, imagesMeta, downloadDir);
  console.error(`  ${downloaded.length}枚取得`);
  logStep("images_downloaded", { count: downloaded.length });

  // ── Step 3: AI image classification + bukaku + shuhen ──
  console.error("  [3/6] AI画像分類...");

  // Start bukaku fetch in parallel
  const bukakuDataPromise = fetchBukakuData(context, reinsData, downloadDir).catch((e) => {
    console.error(`  [bukaku] Error (non-blocking): ${e.message}`);
    return { initialCosts: null, images: [] };
  });

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
    shuhenBrowser = await chromium.launch(LAUNCH_OPTS);
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
  logStep("texts_generated", { catchCopy: texts.catchCopy, hasFreeComment: !!texts.freeComment });

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
    logStep("form_filled", {
      filledFields: Object.keys(filled).length,
      uploadedImages: uploaded.length,
      transport: transportResult.filled.length,
      shuhen: shuhenResult.filled.length,
      formFillErrors: allErrors.length,
    });

    // ── Step 6: Register (actual save) ──
    console.error("  [6/6] 登録...");
    let regResult = { saved: false, registrationType: null };
    try {
      regResult = await forrent.registerProperty(forrentPage, mainFrame, {
        artifactDir: runLog ? runLog.dir : undefined,
      });
      if (regResult.saved) {
        const scoreText = regResult.score ? ` (${regResult.score}pt/43pt)` : "";
        console.error(`  -> ${regResult.registrationType}完了${scoreText}`);
        logStep("register_success", { score: regResult.score });
      } else {
        const firstErr = (regResult.errors || [])[0] || regResult.error || "不明";
        console.error(`  -> 登録失敗: ${firstErr}`);
        if (regResult.errors && regResult.errors.length) {
          for (const e of regResult.errors.slice(0, 8)) console.error(`       - ${e}`);
        }
        logStep("register_failed", {
          error: regResult.error || null,
          errors: regResult.errors || [],
          score: regResult.score || null,
        });
      }
    } catch (e) {
      console.error(`  -> 登録エラー: ${e.message.slice(0, 100)}`);
      logStep("register_exception", { error: e.message.slice(0, 300) });
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
      errors: regResult.errors || [],
      formFillErrors: allErrors.length,
    };
  } catch (err) {
    console.error(`  -> エラー: ${err.message.slice(0, 150)}`);
    logStep("pipeline_exception", { error: err.message.slice(0, 300) });
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
  const browser = await chromium.launch(LAUNCH_OPTS);
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
    const runLog = createRunLog(reinsId);

    let result;
    try {
      // Per-property timeout
      result = await Promise.race([
        processProperty(context, reinsPage, reinsId, i, pending.length, runLog),
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
    result.runDir = runLog.dir;
    runLog.finish({
      status: result.status,
      propertyName: result.propertyName,
      score: result.score || null,
      duration: result.duration,
      errors: result.errors || (result.error ? [result.error] : []),
      registrationType: result.registrationType || null,
    });

    // Update Notion status + notify Slack on success
    if (result.status === "SUCCESS") {
      try {
        await updateNotionStatus(pageId, "掲載保留");
        console.error(`  [notion] Status → 掲載保留`);
        succeeded++;
      } catch (e) {
        console.error(`  [notion] Status更新失敗: ${e.message}`);
        result.notionUpdateFailed = true;
      }

      try {
        const r = await slack.notifyNyukoSuccess({
          reinsId: result.reinsId,
          propertyName: result.propertyName,
          score: result.score,
          registrationType: result.registrationType,
        });
        if (r.ok) console.error(`  [slack] DM送信 → 大木さん`);
      } catch (e) {
        console.error(`  [slack] DM送信失敗: ${e.message}`);
      }
    } else {
      failed++;

      // データ系失敗は「入稿失敗」にフリップして retry loop を止める。
      //  - REG_FAIL (バリデーションで蹴られた)
      //  - NOT_FOUND (REINS で該当物件なし)
      // 以下は transient とみなし、広告待ちのまま次サイクルで再試行:
      //  - TIMEOUT, ERROR, FORRENT_LOGIN_FAIL
      const dataLevelFailure = result.status === "REG_FAIL" || result.status === "NOT_FOUND";
      if (dataLevelFailure) {
        try {
          await updateNotionStatus(pageId, "入稿失敗");
          console.error(`  [notion] Status → 入稿失敗 (${result.status})`);
        } catch (e) {
          console.error(`  [notion] Status更新失敗: ${e.message}`);
        }
      }

      try {
        await slack.notifyError({
          reinsId: result.reinsId,
          propertyName: result.propertyName,
          error: result.error || result.status,
        });
      } catch (e) {
        console.error(`  [slack] エラー通知失敗: ${e.message}`);
      }
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

// main gate: require() 時に勝手に走らないようにする
if (require.main === module) {
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
}

module.exports = { processProperty, createRunLog };
