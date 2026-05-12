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

const notion = new NotionClient({ auth: process.env.NOTION_TOKEN });
const DB_ID = process.env.NOTION_DATABASE_ID;
const POLL_INTERVAL_MS = (parseInt(process.env.POLL_INTERVAL_SEC, 10) || 60) * 1000;
const SKIP_HOURS_CHECK = process.env.SKIP_HOURS_CHECK === "1";

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
