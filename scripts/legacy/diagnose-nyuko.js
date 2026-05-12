#!/usr/bin/env node
/**
 * diagnose-nyuko.js — 単一物件を1回だけパイプラインに通して診断する
 *
 * Usage:
 *   bun run scripts/diagnose-nyuko.js <reinsId>
 *
 * batch-nyuko の processProperty をそのまま呼び出すが:
 *   - Notion ステータスは更新しない
 *   - Slack 通知は出さない
 *   - 必ず runLog (logs/runs/... + logs/nyuko-history.jsonl) に artifact を残す
 *
 * 目的: 失敗が再現する物件の原因特定。確認画面スクショ・HTML ダンプ・
 *       validation.json を生成し、具体的なエラー項目を洗い出す。
 */

const path = require("path");
const fs = require("fs");

const envPath = path.join(__dirname, "..", "..", ".env.local");
if (fs.existsSync(envPath)) {
  require("dotenv").config({ path: envPath });
}

const { chromium } = require("playwright");
const reins = require("../../skills/reins");

// batch-nyuko は require すると main() が即走るため import しない。
// 1物件分のパイプラインを skills を直接呼んで複製する（下で実装）。

const reinsId = process.argv[2];
if (!reinsId) {
  console.error("Usage: bun run scripts/diagnose-nyuko.js <reinsId>");
  process.exit(1);
}

const MAX_LOGIN_RETRIES = 3;
const LOGS_DIR = path.join(__dirname, "..", "..", "logs");
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
  const dir = path.join(RUNS_DIR, `${ts}_${reinsId}_diag`);
  fs.mkdirSync(dir, { recursive: true });
  const startedAt = new Date().toISOString();
  const steps = [];
  const data = { reinsId, startedAt, steps, status: null, diagnostic: true };

  const writeRunJson = () => {
    try {
      fs.writeFileSync(path.join(dir, "run.json"), JSON.stringify(data, null, 2));
    } catch (e) {
      console.error(`[runlog] write failed: ${e.message}`);
    }
  };

  const step = (name, extra = {}) => {
    steps.push({ name, at: new Date().toISOString(), ...extra });
    writeRunJson();
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
        diagnostic: true,
      };
      fs.appendFileSync(HISTORY_PATH, JSON.stringify(hist) + "\n");
    } catch (e) {
      console.error(`[runlog] history append failed: ${e.message}`);
    }
  };

  return { dir, data, step, finish };
}

// processProperty を複製せず、batch-nyuko.js の関数を流用したいので
// module.exports を一時的に触らない方針で、子プロセスは使わずに
// batch-nyuko.js を丸ごと require すると main() が走ってしまう。
// → batch-nyuko.js は __name === "__main__" 判定をしていないため、
//   require すると即 main() が動く。
// 回避: batch-nyuko.js に main gate を追加するのが本筋。
// ここでは batch-nyuko.js を require せず、skill を直接呼ぶ軽量版を定義する。

const forrent = require("../../skills/forrent");
const { analyzeAndCropImages } = require("../../skills/image-ai");
const { generateTexts } = require("../../skills/text-ai");
const { checkImageSufficiency, fetchBukakuData } = require("../../skills/bukaku");
const { fetchShuhenPhotos } = require("../../skills/google-images");
const os = require("os");

// デフォルト headless。NYUKO_HEADED=1 でデバッグ用に画面表示。
const HEADLESS = process.env.NYUKO_HEADED !== "1";
const LAUNCH_OPTS = {
  headless: HEADLESS,
  args: [
    "--disable-blink-features=AutomationControlled",
    "--disable-features=IsolateOrigins,site-per-process",
  ],
};

async function loginReins(page) {
  for (let attempt = 1; attempt <= MAX_LOGIN_RETRIES; attempt++) {
    try {
      const ok = await reins.login(page, {
        id: process.env.REINS_LOGIN_ID,
        pass: process.env.REINS_LOGIN_PASS,
      });
      if (ok) return true;
    } catch (e) {
      console.error(`[reins] login attempt ${attempt}: ${e.message}`);
    }
    if (attempt < MAX_LOGIN_RETRIES) await page.waitForTimeout(3000);
  }
  return false;
}

async function main() {
  console.error("═".repeat(50));
  console.error(`  diagnose-nyuko: ${reinsId}`);
  console.error("═".repeat(50));

  const runLog = createRunLog(reinsId);
  const start = Date.now();
  const downloadDir = path.join(os.homedir(), "Desktop", "suumo-nyuko", reinsId);
  fs.mkdirSync(downloadDir, { recursive: true });

  const browser = await chromium.launch(LAUNCH_OPTS);
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const reinsPage = await context.newPage();

  let status = "ERROR";
  let propertyName = null;
  let regResult = null;

  try {
    console.error("  REINSログイン中...");
    const ok = await loginReins(reinsPage);
    if (!ok) throw new Error("REINS_LOGIN_FAILED");
    console.error("  REINSログイン成功");
    runLog.step("reins_login_ok");

    console.error("  [1/6] REINS検索...");
    const found = await reins.searchByNumber(reinsPage, reinsId);
    if (!found) {
      console.error("  -> 物件が見つかりませんでした");
      runLog.step("reins_not_found");
      status = "NOT_FOUND";
      return;
    }

    const reinsData = await reins.extractPropertyData(reinsPage);
    propertyName = reinsData.建物名;
    console.error(`  物件名: ${propertyName}`);
    runLog.step("reins_extracted", { propertyName, fieldCount: Object.keys(reinsData).length });
    try {
      fs.writeFileSync(path.join(runLog.dir, "reins-data.json"), JSON.stringify(reinsData, null, 2));
    } catch {}

    console.error("  [2/6] 画像スクリーンショット...");
    const imagesMeta = await reins.extractImageData(reinsPage);
    const downloaded = await reins.screenshotAllImages(reinsPage, imagesMeta, downloadDir);
    console.error(`  ${downloaded.length}枚取得`);
    runLog.step("images_downloaded", { count: downloaded.length });

    console.error("  [3/6] AI画像分類...");
    const bukakuDataPromise = fetchBukakuData(context, reinsData, downloadDir).catch((e) => {
      console.error(`  [bukaku] Error: ${e.message}`);
      return { initialCosts: null, images: [] };
    });
    let processedImages = await analyzeAndCropImages(downloaded, downloadDir);
    console.error(`  ${processedImages.length}枚分類完了`);
    const bukakuResult = await bukakuDataPromise;
    const initialCostData = bukakuResult.initialCosts;
    const sufficiency = checkImageSufficiency(processedImages);
    if (sufficiency.insufficient && bukakuResult.images.length > 0) {
      try {
        const existingCats = processedImages.map((img) => img.categoryId);
        const bukakuProcessed = await analyzeAndCropImages(bukakuResult.images, downloadDir, existingCats);
        processedImages.push(...bukakuProcessed);
      } catch (e) {
        console.error(`  [bukaku] Image classification error: ${e.message}`);
      }
    }

    console.error("  [3.5/6] 周辺環境写真取得...");
    let shuhenBrowser;
    try {
      shuhenBrowser = await chromium.launch(LAUNCH_OPTS);
      const shuhenContext = await shuhenBrowser.newContext({ viewport: { width: 1280, height: 900 } });
      const shuhenPhotos = await fetchShuhenPhotos(shuhenContext, reinsData, downloadDir);
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
    } catch (e) {
      console.error(`  [shuhen] Error: ${e.message}`);
    } finally {
      if (shuhenBrowser) await shuhenBrowser.close().catch(() => {});
    }

    console.error("  [4/6] AIテキスト生成...");
    const texts = await generateTexts(reinsData);
    console.error(`  キャッチ: "${texts.catchCopy}"`);
    runLog.step("texts_generated", { catchCopy: texts.catchCopy });

    console.error("  [5/6] forrent.jp入稿...");
    const forrentPage = await context.newPage();
    const forrentOk = await forrent.login(forrentPage, {
      id: process.env.SUUMO_LOGIN_ID,
      pass: process.env.SUUMO_LOGIN_PASS,
    });
    if (!forrentOk) throw new Error("FORRENT_LOGIN_FAIL");

    let { mainFrame } = await forrent.navigateToNewProperty(forrentPage);
    const { filled, errors: formErrors } = await forrent.fillPropertyForm(mainFrame, reinsData, initialCostData);
    const textErrors = await forrent.fillTexts(mainFrame, texts.catchCopy, texts.freeComment, reinsData, initialCostData);
    const { uploaded, errors: uploadErrors } = await forrent.uploadImages(mainFrame, processedImages);
    await forrent.fillTokucho(mainFrame, reinsData);
    const transportResult = await forrent.fillTransportViaMap(forrentPage, mainFrame, reinsData.交通);
    mainFrame = forrentPage.frame({ name: "main" }) || mainFrame;
    const shuhenResult = await forrent.fillShuhenKankyo(forrentPage, mainFrame);
    mainFrame = forrentPage.frame({ name: "main" }) || mainFrame;

    runLog.step("form_filled", {
      filledFields: Object.keys(filled).length,
      uploaded: uploaded.length,
      transport: transportResult.filled.length,
      shuhen: shuhenResult.filled.length,
      formWarnings: [...formErrors, ...textErrors, ...uploadErrors].length,
    });

    console.error("  [6/6] 登録...");
    regResult = await forrent.registerProperty(forrentPage, mainFrame, {
      artifactDir: runLog.dir,
    });

    if (regResult.saved) {
      console.error(`  -> 登録完了 (${regResult.score}pt/43pt)`);
      status = "SUCCESS";
      runLog.step("register_success", { score: regResult.score });
    } else {
      console.error(`  -> 登録失敗: ${(regResult.errors || [])[0] || regResult.error || "不明"}`);
      for (const e of (regResult.errors || []).slice(0, 20)) console.error(`     - ${e}`);
      status = "REG_FAIL";
      runLog.step("register_failed", {
        error: regResult.error || null,
        errors: regResult.errors || [],
        score: regResult.score || null,
      });
    }

    try { await forrentPage.close(); } catch {}
  } catch (e) {
    console.error(`  -> エラー: ${e.message}`);
    runLog.step("exception", { error: e.message });
  } finally {
    try { await browser.close(); } catch {}
    const duration = Math.round((Date.now() - start) / 1000);
    runLog.finish({
      status,
      propertyName,
      score: regResult?.score || null,
      duration,
      errors: regResult?.errors || [],
      registrationType: regResult?.registrationType || null,
    });
    console.error(`\n  完了: ${status} [${duration}s]`);
    console.error(`  runDir: ${runLog.dir}`);
  }
}

main().catch((e) => {
  console.error("fatal:", e);
  process.exit(1);
});
