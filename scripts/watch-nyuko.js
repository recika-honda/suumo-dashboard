#!/usr/bin/env node
// ════════════════════════════════════════════════════════
//  watch-nyuko.js — Notion DB ポーリング常駐
// ════════════════════════════════════════════════════════
//
// Notion DB を 1 分間隔でポーリングし、Status="広告待ち"
// の物件が存在すれば batch-nyuko.js を起動して入稿する。
//
// 設計方針:
// - ブラウザ起動は batch-nyuko.js 側に任せる（物件がある時だけ）
// - 子プロセス実行で本体の状態を汚さない
// - 同時実行防止: 実行中は次のポーリングをスキップ
// - REINS 稼働時間 (07:00-23:00 JST) 外はスキップ
//
// Usage:
//   bun run scripts/watch-nyuko.js                # 常駐（60秒間隔）
//   POLL_INTERVAL_SEC=30 bun run scripts/watch-nyuko.js
//   SKIP_HOURS_CHECK=1 bun run scripts/watch-nyuko.js  # 時間制約無視

const path = require("path");
const fs = require("fs");
const { spawn } = require("child_process");
const { Client: NotionClient } = require("@notionhq/client");

const envPath = path.join(__dirname, "..", ".env.local");
if (fs.existsSync(envPath)) {
  require("dotenv").config({ path: envPath });
}

const {
  findResumeStage,
  readRetryHistory,
  hasOpenRetry,
  recordRetry,
} = require("./lib/run-inspect");
const { buildFeedbackProperties } = require("./lib/notion-feedback");

const notion = new NotionClient({ auth: process.env.NOTION_TOKEN });
const DB_ID = process.env.NOTION_DATABASE_ID;
const POLL_INTERVAL_MS = (parseInt(process.env.POLL_INTERVAL_SEC, 10) || 60) * 1000;
const SKIP_HOURS_CHECK = process.env.SKIP_HOURS_CHECK === "1";

const LOGS_DIR = path.join(__dirname, "..", "logs");

let running = false;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// JST 07:00-23:00 稼働（REINS営業時間に合わせる）
function isWithinWorkHours() {
  if (SKIP_HOURS_CHECK) return true;
  const now = new Date();
  const jstHour = (now.getUTCHours() + 9) % 24;
  return jstHour >= 7 && jstHour < 23;
}

async function countPending() {
  const db = await notion.databases.query({
    database_id: DB_ID,
    filter: { property: "Status", status: { equals: "広告待ち" } },
    page_size: 1,
  });
  // has_more を使うが、最小限の件数取得のため再クエリで数える
  if (db.results.length === 0) return 0;
  let total = db.results.length;
  let cursor = db.has_more ? db.next_cursor : undefined;
  while (cursor) {
    const next = await notion.databases.query({
      database_id: DB_ID,
      filter: { property: "Status", status: { equals: "広告待ち" } },
      page_size: 100,
      start_cursor: cursor,
    });
    total += next.results.length;
    cursor = next.has_more ? next.next_cursor : undefined;
  }
  return total;
}

function runBatch() {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(__dirname, "batch-nyuko.js")], {
      cwd: path.join(__dirname, ".."),
      stdio: ["ignore", "pipe", "inherit"],
      env: process.env,
    });

    let stdout = "";
    child.stdout.on("data", (d) => {
      stdout += d.toString();
      process.stdout.write(d);
    });

    child.on("close", (code) => {
      let report = null;
      try {
        const lastLine = stdout.trim().split("\n").filter(Boolean).pop();
        if (lastLine) report = JSON.parse(lastLine);
      } catch {}
      resolve({ code, report });
    });
  });
}

function now() {
  return new Date().toLocaleString("ja-JP", { timeZone: "Asia/Tokyo" });
}

// ── Notion update (batch-nyuko の updateNotionStatus と同 semantic) ──
// "入稿失敗" のときは feedback (入稿失敗理由 + 失敗カテゴリ) も同送。
// Notion DB に該当プロパティが未追加の場合は Status のみで再試行する graceful フォールバック。
async function updateNotionStatus(pageId, statusName, result = null) {
  const baseProps = { Status: { status: { name: statusName } } };
  const feedback = result && statusName === "入稿失敗" ? buildFeedbackProperties(result) : {};
  try {
    await notion.pages.update({
      page_id: pageId,
      properties: { ...baseProps, ...feedback },
    });
    return;
  } catch (e) {
    if (Object.keys(feedback).length === 0) throw e;
    console.error(
      `[notion] feedback プロパティ書き込み失敗 → Status のみで再試行: ${e.message.slice(0, 120)}`
    );
  }
  await notion.pages.update({
    page_id: pageId,
    properties: baseProps,
  });
}

// ── resume-nyuko を spawn して stdout 最終行の JSON を返す ──
function runResume(runId, fromStage) {
  return new Promise((resolve) => {
    const child = spawn(
      process.execPath,
      [path.join(__dirname, "resume-nyuko.js"), runId, "--from", fromStage],
      {
        cwd: path.join(__dirname, ".."),
        stdio: ["ignore", "pipe", "inherit"],
        env: process.env,
      }
    );
    let stdout = "";
    child.stdout.on("data", (d) => {
      stdout += d.toString();
      process.stdout.write(d);
    });
    child.on("close", (code) => {
      let report = null;
      try {
        const lastLine = stdout.trim().split("\n").filter(Boolean).pop();
        if (lastLine) report = JSON.parse(lastLine);
      } catch {}
      resolve({ code, report });
    });
  });
}

// ── TIMEOUT 物件の自動 resume (1 物件 1 回まで) ──
// 設計:
//   - batch-nyuko の report.results から status="TIMEOUT" を抽出
//   - runDir に残る {stage}/output.json から「次に再実行すべき stage」を判定
//   - logs/retries.jsonl で同一 runDir の retry が未終了なら skip (loop 防止)
//   - resume 成功 → Notion を「掲載保留」に更新
//   - resume 失敗 → Notion を「入稿失敗」に更新 (= 次サイクルでの再エントリを止める)
//   - 履歴は logs/retries.jsonl に append
async function processTimeouts(report) {
  if (!report || !Array.isArray(report.results)) return;
  const timeouts = report.results.filter(
    (r) => r.status === "TIMEOUT" && r.runDir && r.pageId
  );
  if (timeouts.length === 0) return;

  const history = readRetryHistory(LOGS_DIR);

  for (const r of timeouts) {
    const runId = path.basename(r.runDir);
    if (hasOpenRetry(history, r.reinsId, r.runDir)) {
      console.error(`[${now()}] [retry] skip ${r.reinsId} — 既に retry 済`);
      continue;
    }
    const fromStage = findResumeStage(r.runDir);
    if (!fromStage) {
      console.error(`[${now()}] [retry] ${r.reinsId} — 全 stage 完了済 (=resume 不要)`);
      continue;
    }
    console.error(`[${now()}] [retry] ${r.reinsId} runId=${runId} --from ${fromStage}`);

    const { code, report: resumeReport } = await runResume(runId, fromStage);

    // resume-nyuko の戻り値形: { resumed:true, r5?:{status}, r6?:{status, score, errors}, result? }
    const success =
      resumeReport?.r6?.status === "SUCCESS" ||
      resumeReport?.result?.status === "SUCCESS";
    const failPermanent =
      resumeReport?.r6?.status === "REG_FAIL" ||
      resumeReport?.r5?.status === "FORRENT_LOGIN_FAIL" ||
      resumeReport?.result?.status === "REG_FAIL" ||
      resumeReport?.result?.status === "NOT_FOUND";

    let notionStatus = null;
    if (success) notionStatus = "掲載保留";
    else if (failPermanent || code !== 0) notionStatus = "入稿失敗";
    // それ以外 (transient な失敗) は Notion を更新せず「広告待ち」維持

    if (notionStatus) {
      // 「入稿失敗」のときは feedback も書き戻す。reason 系の元情報は resumeReport から構築。
      const resultForFeedback = notionStatus === "入稿失敗"
        ? {
            status:
              resumeReport?.r6?.status ||
              resumeReport?.r5?.status ||
              resumeReport?.result?.status ||
              "TIMEOUT",
            errors: resumeReport?.r6?.errors || [],
            reason: resumeReport?.result?.reason,
            error: "resume 試行後も入稿失敗 (元 TIMEOUT)",
          }
        : null;
      try {
        await updateNotionStatus(r.pageId, notionStatus, resultForFeedback);
        console.error(`[${now()}] [retry] notion → ${notionStatus} (${r.reinsId})`);
      } catch (e) {
        console.error(`[${now()}] [retry] notion 更新失敗: ${e.message}`);
      }
    }

    recordRetry(LOGS_DIR, {
      reinsId: r.reinsId,
      originalRunDir: r.runDir,
      runId,
      fromStage,
      exitCode: code,
      result: {
        status: success
          ? "SUCCESS"
          : resumeReport?.r6?.status ||
            resumeReport?.r5?.status ||
            resumeReport?.result?.status ||
            "UNKNOWN",
        score: resumeReport?.r6?.score || null,
        errors: resumeReport?.r6?.errors || [],
      },
      notionStatus,
    });
  }
}

async function tick() {
  if (running) {
    console.error(`[${now()}] バッチ実行中 — スキップ`);
    return;
  }
  if (!isWithinWorkHours()) {
    console.error(`[${now()}] 稼働時間外 (JST 07:00-23:00) — スキップ`);
    return;
  }

  let pending;
  try {
    pending = await countPending();
  } catch (e) {
    console.error(`[${now()}] Notionクエリ失敗: ${e.message}`);
    return;
  }

  if (pending === 0) {
    console.error(`[${now()}] pending=0`);
    return;
  }

  console.error(`\n[${now()}] pending=${pending} → バッチ起動`);
  running = true;
  try {
    const { code, report } = await runBatch();
    const summary = report
      ? `processed=${report.processed} succeeded=${report.succeeded} failed=${report.failed}`
      : `exit=${code}`;
    console.error(`[${now()}] バッチ完了 ${summary}\n`);

    // TIMEOUT 物件の自動 resume (1 物件 1 回まで)
    try {
      await processTimeouts(report);
    } catch (e) {
      console.error(`[${now()}] TIMEOUT resume 処理失敗: ${e.message}`);
    }
  } catch (e) {
    console.error(`[${now()}] バッチ例外: ${e.message}`);
  } finally {
    running = false;
  }
}

async function main() {
  if (!process.env.NOTION_TOKEN || !DB_ID) {
    console.error("NOTION_TOKEN / NOTION_DATABASE_ID が未設定");
    process.exit(1);
  }
  console.error(`═`.repeat(50));
  console.error(`  watch-nyuko 起動`);
  console.error(`  DB: ${DB_ID}`);
  console.error(`  interval: ${POLL_INTERVAL_MS / 1000}s`);
  console.error(`  work hours: ${SKIP_HOURS_CHECK ? "無視" : "JST 07:00-23:00"}`);
  console.error(`═`.repeat(50));

  while (true) {
    await tick();
    await sleep(POLL_INTERVAL_MS);
  }
}

process.on("SIGINT", () => {
  console.error("\n[watch] SIGINT 受信 — 終了");
  process.exit(0);
});

main().catch((err) => {
  console.error("fatal:", err);
  process.exit(1);
});
