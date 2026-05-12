#!/usr/bin/env node
/**
 * migrate-nyuko-status.js — 既存「掲載指示済み」(旧 登録済み) を実態ベースで再分類
 *
 * リネーム後は 旧「登録済み」== 現「掲載指示済み」。
 * 大木さんの確認を経ていないレコードも含まれているため、forrent.jp の
 * 掲載終了日の有無で分類し直す:
 *   - forrent.jp に存在 & 掲載終了日あり → 掲載指示済み のまま (no-op)
 *   - forrent.jp に存在 & 掲載終了日なし → 掲載保留 に戻す
 *   - forrent.jp に存在しない             → 要確認 にフラグ
 *
 * kishaCode = "fng" + REINS_ID で forrent 側と突合。
 *
 * Usage:
 *   bun run scripts/migrate-nyuko-status.js --dry-run
 *   bun run scripts/migrate-nyuko-status.js
 *   HEADLESS=false bun run scripts/migrate-nyuko-status.js --dry-run
 */

const path = require("path");
const fs = require("fs");
require("dotenv").config({ path: path.join(__dirname, "..", ".env.local") });

const { chromium } = require("playwright");
const { Client: NotionClient } = require("@notionhq/client");
const forrent = require("../skills/forrent");
const reader = require("../skills/forrent-reader");

const notion = new NotionClient({ auth: process.env.NOTION_TOKEN });
const DB_ID = process.env.NOTION_DATABASE_ID;

const CACHE_FILE = path.join(__dirname, "..", ".cache", "bukken-kisha-map.json");
const MAX_LOGIN_RETRIES = 3;
const TIER2_HARD_CAP = 200; // safety: don't Tier2 more than this

const args = process.argv.slice(2);
const DRY_RUN = args.includes("--dry-run");
const HEADLESS = process.env.HEADLESS !== "false";

// ── Notion helpers ────────────────────────────────────────
async function fetchShijiSumiPages() {
  const out = [];
  let cursor;
  do {
    const res = await notion.databases.query({
      database_id: DB_ID,
      filter: { property: "Status", status: { equals: "掲載指示済み" } },
      page_size: 100,
      ...(cursor && { start_cursor: cursor }),
    });
    for (const p of res.results) {
      const reinsId = p.properties.REINS_ID?.title?.[0]?.plain_text || "";
      if (reinsId) out.push({ pageId: p.id, reinsId, kishaCode: `fng${reinsId}` });
    }
    cursor = res.has_more ? res.next_cursor : undefined;
  } while (cursor);
  return out;
}

async function updateStatus(pageId, statusName) {
  await notion.pages.update({
    page_id: pageId,
    properties: { Status: { status: { name: statusName } } },
  });
}

// ── Cache ─────────────────────────────────────────────────
function loadCache() {
  try {
    return JSON.parse(fs.readFileSync(CACHE_FILE, "utf-8"));
  } catch {
    return {};
  }
}
function saveCache(obj) {
  try {
    fs.mkdirSync(path.dirname(CACHE_FILE), { recursive: true });
    fs.writeFileSync(CACHE_FILE, JSON.stringify(obj, null, 2));
  } catch (err) {
    console.error(`cache save failed: ${err.message}`);
  }
}

// ── forrent login ─────────────────────────────────────────
async function loginWithRetry(page) {
  for (let attempt = 1; attempt <= MAX_LOGIN_RETRIES; attempt++) {
    try {
      const ok = await forrent.login(page, {
        id: process.env.SUUMO_LOGIN_ID,
        pass: process.env.SUUMO_LOGIN_PASS,
      });
      if (ok) return true;
      console.error(`Login attempt ${attempt}: redirected to wrong page`);
    } catch (err) {
      console.error(`Login attempt ${attempt}: ${err.message}`);
    }
    if (attempt < MAX_LOGIN_RETRIES) await page.waitForTimeout(3000);
  }
  return false;
}

// ── Main ──────────────────────────────────────────────────
async function run() {
  if (!DB_ID) {
    console.error("NOTION_DATABASE_ID 未設定");
    process.exit(1);
  }

  console.error(`=== migrate-nyuko-status (dry-run=${DRY_RUN}) ===\n`);

  // 1. Notion から対象レコードを取得
  console.error("[notion] 掲載指示済みレコード取得...");
  const targets = await fetchShijiSumiPages();
  console.error(`  対象: ${targets.length}件\n`);
  if (targets.length === 0) {
    console.error("対象なし、終了");
    return;
  }

  const targetByKisha = new Map(targets.map((t) => [t.kishaCode, t]));

  // 2. forrent にログイン
  console.error("[forrent] ログイン中...");
  const browser = await chromium.launch({ headless: HEADLESS });
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  page.on("dialog", async (d) => { await d.accept(); });

  const loginOk = await loginWithRetry(page);
  if (!loginOk) {
    await browser.close();
    console.error("forrent ログイン失敗");
    process.exit(1);
  }
  console.error("  OK\n");

  // 3. Tier1: 掲載管理一覧を全ページ取得
  console.error("[forrent] Tier1 一覧取得...");
  let mainFrame = await reader.navigateToListPage(page);
  let listData = await reader.parseListPage(mainFrame);
  const allProps = [...listData.properties];
  console.error(`  ページ1: ${listData.properties.length}件 (total: ${listData.total})`);
  while (allProps.length < listData.total) {
    mainFrame = page.frame({ name: "main" });
    const hasNext = await reader.goToNextPage(page, mainFrame);
    if (!hasNext) break;
    mainFrame = page.frame({ name: "main" });
    const nextPage = await reader.parseListPage(mainFrame);
    allProps.push(...nextPage.properties);
    console.error(`  +${nextPage.properties.length}件 (合計: ${allProps.length})`);
  }
  console.error(`  Tier1 合計: ${allProps.length}件\n`);

  // 4. kishaCode → Tier1 property を構築 (cache + Tier2 fallback)
  const cache = loadCache(); // bukkenCd → kishaCode
  const kishaToTier1 = new Map();
  const uncachedCandidates = [];

  for (const t1 of allProps) {
    const cachedKisha = cache[t1.bukkenCd];
    if (cachedKisha) {
      kishaToTier1.set(cachedKisha, t1);
    } else {
      uncachedCandidates.push(t1);
    }
  }
  console.error(`[match] cache hit: ${kishaToTier1.size}件 / 未キャッシュ: ${uncachedCandidates.length}件`);

  // 5. 未マッチの target があれば、未キャッシュ Tier1 を Tier2 scan して kishaCode を確定
  const unresolvedTargets = targets.filter((t) => !kishaToTier1.has(t.kishaCode));
  if (unresolvedTargets.length > 0 && uncachedCandidates.length > 0) {
    console.error(`[tier2] 未解決 ${unresolvedTargets.length}件 → 未キャッシュ ${uncachedCandidates.length}件を走査`);
    const scanLimit = Math.min(uncachedCandidates.length, TIER2_HARD_CAP);
    const stillNeeded = new Set(unresolvedTargets.map((t) => t.kishaCode));

    for (let i = 0; i < scanLimit; i++) {
      if (stillNeeded.size === 0) break;
      const t1 = uncachedCandidates[i];
      try {
        mainFrame = await reader.navigateToDetail(page, null, t1.bukkenCd);
        const t2 = await reader.extractPropertyDetail(page, mainFrame);
        const kishaCode = t2.kishaCode;
        if (kishaCode) {
          cache[t1.bukkenCd] = kishaCode;
          kishaToTier1.set(kishaCode, t1);
          if (stillNeeded.has(kishaCode)) {
            stillNeeded.delete(kishaCode);
            console.error(`  [${i + 1}/${scanLimit}] match: ${kishaCode} (残: ${stillNeeded.size})`);
          }
        }
        await page.waitForTimeout(500);
      } catch (err) {
        console.error(`  [${i + 1}/${scanLimit}] err bukkenCd=${t1.bukkenCd}: ${err.message}`);
      }
    }
    saveCache(cache);
  }

  await browser.close();

  // 6. 分類
  const plan = { stay: [], toHoryu: [], toKakunin: [] };
  for (const t of targets) {
    const hit = kishaToTier1.get(t.kishaCode);
    if (!hit) {
      plan.toKakunin.push({ ...t, reason: "forrent未検出" });
    } else if (hit.endDate) {
      plan.stay.push({ ...t, endDate: hit.endDate, name: hit.name });
    } else {
      plan.toHoryu.push({ ...t, name: hit.name });
    }
  }

  // 7. レポート
  console.error("\n=== 分類結果 ===");
  console.error(`  掲載指示済み (据置): ${plan.stay.length}件`);
  console.error(`  掲載保留へ変更     : ${plan.toHoryu.length}件`);
  console.error(`  要確認へ変更       : ${plan.toKakunin.length}件`);

  if (plan.toHoryu.length > 0) {
    console.error("\n[→ 掲載保留]");
    for (const p of plan.toHoryu) console.error(`  ${p.reinsId}  ${p.name || ""}`);
  }
  if (plan.toKakunin.length > 0) {
    console.error("\n[→ 要確認]");
    for (const p of plan.toKakunin) console.error(`  ${p.reinsId}  (${p.reason})`);
  }
  if (plan.stay.length > 0) {
    console.error("\n[据置]");
    for (const p of plan.stay) console.error(`  ${p.reinsId}  end=${p.endDate}  ${p.name || ""}`);
  }

  // 8. 実行
  if (DRY_RUN) {
    console.error("\n=== DRY RUN — Notion更新なし ===");
    return;
  }

  console.error("\n=== Notion 更新実行 ===");
  let okCount = 0, failCount = 0;
  const errors = [];
  for (const p of plan.toHoryu) {
    try { await updateStatus(p.pageId, "掲載保留"); okCount++; console.error(`  ✓ ${p.reinsId} → 掲載保留`); }
    catch (e) { failCount++; errors.push({ reinsId: p.reinsId, error: e.message }); console.error(`  ✗ ${p.reinsId}: ${e.message}`); }
  }
  for (const p of plan.toKakunin) {
    try { await updateStatus(p.pageId, "要確認"); okCount++; console.error(`  ✓ ${p.reinsId} → 要確認`); }
    catch (e) { failCount++; errors.push({ reinsId: p.reinsId, error: e.message }); console.error(`  ✗ ${p.reinsId}: ${e.message}`); }
  }
  console.error(`\n更新成功: ${okCount}件 / 失敗: ${failCount}件`);
  if (errors.length > 0) console.error(JSON.stringify(errors, null, 2));
}

run().catch((err) => {
  console.error(`FATAL: ${err.message}`);
  console.error(err.stack);
  process.exit(1);
});
