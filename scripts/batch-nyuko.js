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
const slack = require("../skills/slack");
const { resolveNotionStatus } = require("./pipeline-statuses");
const { buildFeedbackProperties } = require("./lib/notion-feedback");
const { runReinsExtract } = require("./stages/01-reins-extract");
const { runImagesDownload } = require("./stages/02-images-download");
const { runImagesClassify } = require("./stages/03-images-classify");
const { runTextsGenerate } = require("./stages/04-texts-generate");
const { runForrentFill } = require("./stages/05-forrent-fill");
const { runForrentRegister } = require("./stages/06-forrent-register");

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
// REINS は headless chromium を bot 検出するため必ず headed で起動 (project convention)。
// NYUKO_HEADLESS=1 を明示的に立てた場合のみ headless (debug 用、本番非推奨)。
const HEADLESS = process.env.NYUKO_HEADLESS === "1";
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
// statusName 単独 update (旧 API) + 失敗系の feedback (入稿失敗理由 + 失敗カテゴリ) を同送。
// "入稿失敗理由" / "失敗カテゴリ" プロパティが Notion DB に未追加でも parts に分けて
// 段階的に試すことで、Status update は確実に通すよう設計。
async function updateNotionStatus(pageId, statusName, result = null) {
  const baseProps = { Status: { status: { name: statusName } } };
  const feedback = result && statusName === "入稿失敗" ? buildFeedbackProperties(result) : {};

  // 1) Status + feedback を一括で試す
  try {
    await notion.pages.update({
      page_id: pageId,
      properties: { ...baseProps, ...feedback },
    });
    return;
  } catch (e) {
    // 失敗カテゴリ / 入稿失敗理由 が DB に未追加 (Notion 側で kento の初期セットアップ未済)
    // または select option 名の不一致だと properties 一括 update が拒否される。
    // その場合は Status だけは確実に反映する。
    if (Object.keys(feedback).length === 0) throw e;
    console.error(
      `[notion] feedback プロパティ書き込み失敗 → Status のみで再試行: ${e.message.slice(0, 120)}`
    );
  }

  // 2) Status だけで再試行 (feedback プロパティが未整備のフォールバック)
  await notion.pages.update({
    page_id: pageId,
    properties: baseProps,
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

function printRunHeader(reinsId, index, total) {
  console.error(`\n${"━".repeat(50)}`);
  console.error(`  [${index + 1}/${total}] ${reinsId}`);
  console.error(`${"━".repeat(50)}`);
}

// ── Process single property (full pipeline) ──────────────
// 各 stage は scripts/stages/ 配下。設計: docs/refactor/stages.md
// 不変条件 (contract.md §8): Step 1-4 例外は伝播 → main で TIMEOUT、
// Step 5-6 例外は内部 try-catch で ERROR ラベルに変換。
async function processProperty(context, reinsPage, reinsId, index, total, runLog) {
  const downloadDir = path.join(os.homedir(), "Desktop", "suumo-nyuko", reinsId);
  fs.mkdirSync(downloadDir, { recursive: true });
  printRunHeader(reinsId, index, total);

  const logStep = runLog ? runLog.step : () => {};
  const runDir = runLog ? runLog.dir : undefined;

  // ── Step 1-4: try 外。例外は伝播 → main の Promise.race catch で TIMEOUT ──
  const r1 = await runReinsExtract({ reinsPage, reinsId, index, logStep, runDir });
  if (r1.status === "NOT_FOUND") return { reinsId, status: "NOT_FOUND", propertyName: "N/A" };
  if (r1.status === "REG_FAIL") {
    return { reinsId, status: "REG_FAIL", propertyName: r1.propertyName, reason: r1.reason };
  }
  const reinsData = r1.reinsData;
  if (runLog) runLog.data.propertyName = r1.propertyName;

  const r2 = await runImagesDownload({ reinsPage, downloadDir, logStep, runDir, context, reinsData });
  if (r2.imageInsufficient) {
    return {
      reinsId,
      status: "IMAGE_INSUFFICIENT",
      propertyName: reinsData.建物名 || reinsId,
      rawCount: r2.rawCount,
    };
  }
  const r3 = await runImagesClassify({
    context, reinsData, downloaded: r2.downloaded, downloadDir, logStep,
    launchOpts: LAUNCH_OPTS, runDir,
  });
  const texts = await runTextsGenerate({ reinsData, logStep, runDir });

  // ── Step 5-6: try で覆い、例外は ERROR ラベル ──
  let r5;
  try {
    r5 = await runForrentFill({
      context, reinsData,
      processedImages: r3.processedImages,
      initialCostData: r3.initialCostData,
      texts, logStep, runDir,
    });
    if (r5.status === "FORRENT_LOGIN_FAIL") {
      return { reinsId, status: "FORRENT_LOGIN_FAIL", propertyName: reinsData.建物名 };
    }

    const r6 = await runForrentRegister({
      forrentPage: r5.forrentPage, mainFrame: r5.mainFrame,
      runDir, logStep,
      reinsId,
      propertyName: reinsData.建物名 || reinsId,
    });

    return {
      reinsId,
      propertyName: reinsData.建物名 || reinsId,
      status: r6.status,
      score: r6.score,
      registrationType: r6.registrationType,
      escalated: !!r6.escalated,
      filledFields: Object.keys(r5.filled).length,
      uploadedImages: r5.uploaded.length,
      transport: r5.transport.filled.length,
      shuhen: r5.shuhen.filled.length,
      errors: r6.errors,
      formFillErrors: r5.allErrors.length,
    };
  } catch (err) {
    console.error(`  -> エラー: ${err.message.slice(0, 150)}`);
    logStep("pipeline_exception", { error: err.message.slice(0, 300) });
    return {
      reinsId,
      propertyName: reinsData?.建物名 || reinsId,
      status: "ERROR",
      error: err.message.slice(0, 200),
    };
  } finally {
    await r5?.forrentPage?.close().catch(() => {});
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
    result.pageId = pageId;
    runLog.finish({
      status: result.status,
      propertyName: result.propertyName,
      score: result.score || null,
      duration: result.duration,
      errors: result.errors || (result.error ? [result.error] : []),
      registrationType: result.registrationType || null,
    });

    // Notion 遷移: 遷移先 (掲載保留 / 入稿失敗 / null=広告待ち維持) は
    // resolveNotionStatus に集約 (scripts/pipeline-statuses.js)。
    // null は transient 失敗 (FORRENT_LOGIN_FAIL / TIMEOUT / ERROR) で
    // 「広告待ち」のまま次サイクルでリトライさせる。
    const notionStatus = resolveNotionStatus(result);
    if (notionStatus) {
      try {
        // 「入稿失敗」のときは入稿失敗理由 + 失敗カテゴリも書き戻す (Phase 7.5)
        await updateNotionStatus(pageId, notionStatus, result);
        if (result.status === "SUCCESS") {
          console.error(`  [notion] Status → ${notionStatus}`);
        } else {
          console.error(`  [notion] Status → ${notionStatus} (${result.status})`);
        }
      } catch (e) {
        console.error(`  [notion] Status更新失敗: ${e.message}`);
        if (result.status === "SUCCESS") result.notionUpdateFailed = true;
      }
    }

    // Slack 通知 + succeeded/failed カウント
    if (result.status === "SUCCESS") {
      succeeded++;
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

module.exports = { processProperty, createRunLog, loginReins };
