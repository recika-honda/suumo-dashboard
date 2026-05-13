#!/usr/bin/env node
/**
 * runNyuko.js — 単一物件の手動入稿 CLI
 *
 * 使い方:
 *   node runNyuko.js <reinsId>
 *
 * 役割:
 *   api-server.js から spawn される。最初の stdout 行に `runId=...` を出すので
 *   parent はそこから runId を抽出してクライアントに返す。
 *
 *   進捗は logs/runs/{runId}/run.json (createRunLog の append-as-you-go) で UI が polling 取得する。
 *   ブラウザは閉じない (kento 確認用、CLAUDE.md 「ブラウザは閉じない」方針踏襲)。
 */
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, ".env.local") });

// runNyuko は手動 UI 起動が前提なので headed をデフォルトにする。
// 一方 batch-nyuko 経由 (Notion 駆動の本番ループ) は既定 headless。
// batch-nyuko の LAUNCH_OPTS は process.env.NYUKO_HEADED 駆動なので、ここで明示的に
// "1" を立てて Stage 03 内部の shuhen 用 chromium も headed に揃える
// (極性が反転している既知のミスマッチを runNyuko 側で吸収)。
if (process.env.NYUKO_HEADED === undefined) {
  process.env.NYUKO_HEADED = "1";
}

const { chromium } = require("playwright");
const {
  processProperty,
  createRunLog,
  loginReins,
} = require("./scripts/batch-nyuko");

const HEADLESS = process.env.NYUKO_HEADED === "0";

async function runOne(reinsId) {
  const runLog = createRunLog(reinsId);
  const runId = path.basename(runLog.dir);
  // 最初の stdout 行で runId を api-server に渡す
  process.stdout.write(`runId=${runId}\n`);

  const browser = await chromium.launch({
    headless: HEADLESS,
    args: [
      "--disable-blink-features=AutomationControlled",
      "--disable-features=IsolateOrigins,site-per-process",
    ],
  });
  const context = await browser.newContext({
    viewport: { width: 1280, height: 900 },
  });
  const reinsPage = context.pages()[0] || (await context.newPage());

  runLog.step("reins_login_start");
  const ok = await loginReins(reinsPage);
  if (!ok) {
    runLog.step("reins_login_fail");
    runLog.finish({ status: "REINS_LOGIN_FAIL", reinsId });
    process.exit(1);
  }
  runLog.step("reins_login_done");

  const result = await processProperty(context, reinsPage, reinsId, 0, 1, runLog);
  runLog.finish(result);
  // browser は閉じない (UI 確認用)
}

const reinsId = (process.argv[2] || "").trim();
if (!/^\d+$/.test(reinsId)) {
  console.error("Usage: node runNyuko.js <reinsId-digits-only>");
  process.exit(2);
}

runOne(reinsId).catch((e) => {
  console.error("[runNyuko] fatal:", e);
  process.exit(3);
});
