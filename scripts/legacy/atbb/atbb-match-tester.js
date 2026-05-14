#!/usr/bin/env node
/**
 * ATBB Match Tester - REINS 物件群を ATBB で検索してマッチ精度を測定する
 *
 * Usage:
 *   bun run scripts/atbb-match-tester.js                      # 直近 30 run を使用
 *   bun run scripts/atbb-match-tester.js --limit 10           # 直近 10 run のみ
 *   bun run scripts/atbb-match-tester.js --runs id1,id2,id3   # 特定 run を指定
 *
 * Output: logs/atbb-matching/{YYYYMMDD-HHMMSS}.jsonl + summary.md
 */

const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright");

require("dotenv").config({ path: path.join(__dirname, "..", ".env.local") });

const atbb = require("../skills/atbb");
const matcher = require("../skills/atbb-matcher");

const RUNS_DIR = path.join(__dirname, "..", "logs", "runs");
const OUTPUT_DIR = path.join(__dirname, "..", "logs", "atbb-matching");
// storageState 方式: cookies を JSON で保存 → profile 破損リスク無し
//   旧: launchPersistentContext + .playwright-data/atbb/  (Chromium profile 全体を永続化、破損頻発)
//   新: chromium.launch + newContext({ storageState: ... })  (cookies のみ JSON 永続化、破損リスク無し)
const STORAGE_STATE_PATH = path.join(__dirname, "..", ".playwright-data", "atbb-storage.json");
const STORAGE_STATE_DIR = path.dirname(STORAGE_STATE_PATH);

// ── CLI argv parsing ───────────────────────────────────────────
function parseArgs() {
  const args = process.argv.slice(2);
  const opts = { limit: 30, runs: null };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--limit") opts.limit = parseInt(args[++i], 10);
    else if (args[i] === "--runs") opts.runs = args[++i].split(",").map((s) => s.trim());
  }
  return opts;
}

// ── Pick run IDs from logs/runs/ ───────────────────────────────
function pickRunIds({ limit, runs }) {
  if (runs) return runs;
  const dirs = fs.readdirSync(RUNS_DIR)
    .filter((d) => /^\d{8}-\d{6}_\d+$/.test(d))
    .sort()
    .reverse();
  return dirs.slice(0, limit);
}

// ── Load reinsData for a single run ────────────────────────────
// 新形式 (Phase 1+ refactor): logs/runs/{id}/01-reins-extract/output.json の .reinsData
// 旧形式 (pre-refactor):       logs/runs/{id}/reins-data.json (root level, 同スキーマ)
function loadReinsData(runId) {
  const v2Path = path.join(RUNS_DIR, runId, "01-reins-extract", "output.json");
  const v1Path = path.join(RUNS_DIR, runId, "reins-data.json");

  if (fs.existsSync(v2Path)) {
    try {
      const data = JSON.parse(fs.readFileSync(v2Path, "utf-8"));
      return data.reinsData ?? null;
    } catch { return null; }
  }
  if (fs.existsSync(v1Path)) {
    try {
      return JSON.parse(fs.readFileSync(v1Path, "utf-8"));
    } catch { return null; }
  }
  return null;
}

// ── Output file paths ──────────────────────────────────────────
function makeOutputPaths() {
  if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  const ts = new Date()
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\..*/, "")
    .replace("T", "-");
  return {
    jsonl: path.join(OUTPUT_DIR, `${ts}.jsonl`),
    summary: path.join(OUTPUT_DIR, `${ts}-summary.md`),
  };
}

// ── Main ───────────────────────────────────────────────────────
async function main() {
  const opts = parseArgs();
  const runIds = pickRunIds(opts);
  if (runIds.length === 0) {
    console.error("対象 run ID が見つかりません");
    process.exit(1);
  }

  const { jsonl, summary } = makeOutputPaths();
  const append = (obj) => fs.appendFileSync(jsonl, JSON.stringify(obj) + "\n");

  console.log(`[tester] target runs: ${runIds.length}`);
  console.log(`[tester] output: ${jsonl}`);

  const loginId = process.env.ATBB_LOGIN_ID;
  const loginPass = process.env.ATBB_LOGIN_PASS;
  if (!loginId || !loginPass) {
    console.error("ATBB_LOGIN_ID / ATBB_LOGIN_PASS が .env.local に未設定");
    process.exit(1);
  }

  // storageState 方式: profile 破損を避ける
  if (!fs.existsSync(STORAGE_STATE_DIR)) fs.mkdirSync(STORAGE_STATE_DIR, { recursive: true });
  const hasStorage = fs.existsSync(STORAGE_STATE_PATH);
  console.log(`[tester] storageState exists: ${hasStorage} (${STORAGE_STATE_PATH})`);

  // anti-bot 措置: ATBB の reCAPTCHA v3 / bot 検出を回避
  //   2026-05-14 検証で「ヴァンテジオ世田谷」が手動で出るのに自動で 0 件だった
  //   → navigator.webdriver, UA, chrome args の組合せで bot 判定 → 結果ゼロ返却
  //   → 下記措置で「該当物件数3件」を取得できることを scripts/atbb-vantage-test.js で確認
  const browser = await chromium.launch({
    headless: false,
    args: ["--disable-blink-features=AutomationControlled"],
  });
  const context = await browser.newContext({
    viewport: { width: 1280, height: 900 },
    userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    ...(hasStorage ? { storageState: STORAGE_STATE_PATH } : {}),
  });
  // navigator.webdriver 等を隠蔽 (init script で全 page に適用)
  await context.addInitScript(() => {
    Object.defineProperty(navigator, "webdriver", { get: () => undefined });
    if (!window.chrome) window.chrome = { runtime: {} };
    Object.defineProperty(navigator, "languages", { get: () => ["ja-JP", "ja", "en-US", "en"] });
    Object.defineProperty(navigator, "plugins", {
      get: () => [1, 2, 3, 4, 5].map(() => ({ description: "", filename: "", name: "" })),
    });
  });
  // ATBB の ConcurrentLoginException 等で confirm dialog が出る → 常に accept
  context.on("page", (page) => {
    page.on("dialog", (d) => d.accept().catch(() => {}));
  });
  const portalPage = await context.newPage();
  portalPage.on("dialog", (d) => d.accept().catch(() => {}));

  try {
    console.log("[tester] ATBB ensure logged in (reuse session if available)...");
    const ok = await atbb.ensureLoggedIn(portalPage, { id: loginId, pass: loginPass });
    if (!ok) throw new Error("ATBB login failed");

    console.log("[tester] navigate to search form...");
    const searchPage = await atbb.navigateToSearchForm(context, portalPage);

    const results = [];
    let idx = 0;
    for (const runId of runIds) {
      idx++;
      const reinsData = loadReinsData(runId);
      if (!reinsData) {
        const entry = { runId, status: "no_reins_data" };
        append(entry);
        results.push(entry);
        console.log(`[${idx}/${runIds.length}] ${runId} - no reinsData (skip)`);
        continue;
      }

      const reinsId = reinsData.物件番号 ?? runId;
      const building = reinsData.建物名 ?? "(no name)";
      const room = reinsData.部屋番号 ?? "(no room)";
      console.log(`[${idx}/${runIds.length}] ${reinsId} ${building}/${room}`);

      const startMs = Date.now();
      try {
        const match = await matcher.matchProperty(searchPage, reinsData, {
          logger: (msg) => console.log(`  ${msg}`),
        });
        const elapsedMs = Date.now() - startMs;
        const entry = {
          runId,
          reinsId,
          building,
          room,
          shumoku: reinsData.物件種目,
          company: reinsData.商号,
          ...match,
          elapsedMs,
        };
        append(entry);
        results.push(entry);
        console.log(
          `  → ${match.verdict ?? match.reason} (confidence=${match.confidence}, strategy=${match.strategy}, ${elapsedMs}ms)`
        );
      } catch (e) {
        const entry = { runId, reinsId, building, room, status: "tester_error", error: e.message };
        append(entry);
        results.push(entry);
        console.error(`  → ERROR: ${e.message}`);
      }
    }

    // ── Summary ──
    const counts = {
      matched: 0,
      ambiguous: 0,
      not_matched: 0,
      not_found: 0,
      no_data: 0,
      error: 0,
    };
    const byStrategy = {};
    for (const r of results) {
      if (r.status === "no_reins_data") counts.no_data++;
      else if (r.status === "tester_error") counts.error++;
      else if (r.verdict === "matched") counts.matched++;
      else if (r.verdict === "ambiguous") counts.ambiguous++;
      else if (r.verdict === "not_matched") counts.not_matched++;
      else if (r.reason === "ATBB_NOT_FOUND") counts.not_found++;

      if (r.strategy) {
        byStrategy[r.strategy] = (byStrategy[r.strategy] || 0) + 1;
      }
    }

    const total = results.length;
    const matchRate = total ? ((counts.matched / total) * 100).toFixed(1) : "0";
    const summaryText = [
      "# ATBB Match Tester Summary",
      "",
      `- Total runs: ${total}`,
      `- Output: \`${path.basename(jsonl)}\``,
      "",
      "## Verdict distribution",
      "",
      `| Verdict | Count | % |`,
      `|---------|-------|---|`,
      `| matched | ${counts.matched} | ${((counts.matched / total) * 100).toFixed(1)}% |`,
      `| ambiguous | ${counts.ambiguous} | ${((counts.ambiguous / total) * 100).toFixed(1)}% |`,
      `| not_matched (low confidence) | ${counts.not_matched} | ${((counts.not_matched / total) * 100).toFixed(1)}% |`,
      `| not_found (0 hits) | ${counts.not_found} | ${((counts.not_found / total) * 100).toFixed(1)}% |`,
      `| no_reins_data | ${counts.no_data} | ${((counts.no_data / total) * 100).toFixed(1)}% |`,
      `| tester_error | ${counts.error} | ${((counts.error / total) * 100).toFixed(1)}% |`,
      "",
      `**Match rate: ${matchRate}%**`,
      "",
      "## Best strategy distribution",
      "",
      `| Strategy | Count |`,
      `|----------|-------|`,
      ...Object.entries(byStrategy)
        .sort((a, b) => b[1] - a[1])
        .map(([k, v]) => `| ${k} | ${v} |`),
      "",
    ].join("\n");

    fs.writeFileSync(summary, summaryText);
    console.log("\n" + summaryText);
    console.log(`\n[tester] done. jsonl=${jsonl}\nsummary=${summary}`);
  } finally {
    // storageState 方式: 終了前に cookies を JSON 保存 (次回起動で復元 → 再ログイン不要)
    try {
      await context.storageState({ path: STORAGE_STATE_PATH });
      console.log(`[tester] storageState saved → ${STORAGE_STATE_PATH}`);
    } catch (e) {
      console.warn(`[tester] storageState save failed: ${e.message}`);
    }
    await context.close().catch(() => {});
    await browser.close().catch(() => {});
  }
}

main().catch((e) => {
  console.error("Fatal error:", e);
  process.exit(1);
});
