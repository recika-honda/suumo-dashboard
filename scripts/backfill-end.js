#!/usr/bin/env node
/**
 * backfill-end.js — Notion 広告管理DB で end(掲載終了日) が未設定のレコードを
 * forrent.jp 一覧ページ (Tier1) の td[13] から再取得して埋める。
 *
 * reader.parseListPage が 2桁年を受理するようになった後の一回限り遡及処理。
 * Tier2 不要 (一覧ページのみ) なので高速。
 *
 * Usage: bun run scripts/backfill-end.js [--dry-run]
 */

const path = require("path");
const fs = require("fs");
require("dotenv").config({ path: path.join(__dirname, "..", ".env.local") });

const { chromium } = require("playwright");
const { Client } = require("@notionhq/client");
const forrent = require("../skills/forrent");
const reader = require("../skills/forrent-reader");

const notion = new Client({ auth: process.env.NOTION_TOKEN });
const DB = process.env.NOTION_NYUKO_DB_ID;
const CACHE_FILE = path.join(__dirname, "..", ".cache", "bukken-kisha-map.json");

const dryRun = process.argv.includes("--dry-run");

(async () => {
  // 1. Reverse cache: kishaCode → bukkenCd
  const cache = JSON.parse(fs.readFileSync(CACHE_FILE, "utf-8"));
  const reverseCache = new Map();
  for (const [bukken, kisha] of Object.entries(cache)) reverseCache.set(kisha, bukken);
  console.error(`cache: ${reverseCache.size}件`);

  // 2. Playwright → Tier1 で bukkenCd → endDate マップ構築
  const headless = process.env.HEADLESS !== "false";
  const browser = await chromium.launch({ headless });
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();
  page.on("dialog", async d => { await d.accept(); });

  let ok = false;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      ok = await forrent.login(page, { id: process.env.SUUMO_LOGIN_ID, pass: process.env.SUUMO_LOGIN_PASS });
      if (ok) break;
    } catch (e) { console.error(`login ${attempt}: ${e.message}`); }
    await page.waitForTimeout(3000);
  }
  if (!ok) { await browser.close(); throw new Error("login failed"); }
  console.error("login ok");

  let mainFrame = await reader.navigateToListPage(page);
  let listData = await reader.parseListPage(mainFrame);
  const all = [...listData.properties];
  while (all.length < listData.total) {
    mainFrame = page.frame({ name: "main" });
    const hasNext = await reader.goToNextPage(page, mainFrame);
    if (!hasNext) break;
    mainFrame = page.frame({ name: "main" });
    const next = await reader.parseListPage(mainFrame);
    all.push(...next.properties);
  }
  await browser.close();

  const endByBukken = new Map();
  for (const t1 of all) {
    if (t1.endDate) endByBukken.set(t1.bukkenCd, t1.endDate);
  }
  console.error(`Tier1: ${all.length}件中 endDate抽出成功 ${endByBukken.size}件`);

  // 3. Notion: end=null のページを取得
  const targets = [];
  let cursor;
  do {
    const r = await notion.databases.query({
      database_id: DB, page_size: 100,
      ...(cursor && { start_cursor: cursor }),
    });
    for (const p of r.results) {
      if (p.archived || p.in_trash) continue;
      const code = p.properties["貴社物件コード"]?.title?.[0]?.plain_text || "";
      const end = p.properties["end"]?.date?.start;
      if (code && !end) {
        const bukkenCd = reverseCache.get(code);
        const endDate = bukkenCd && endByBukken.get(bukkenCd);
        if (endDate) targets.push({ pageId: p.id, code, bukkenCd, endDate });
      }
    }
    cursor = r.has_more ? r.next_cursor : null;
  } while (cursor);
  console.error(`更新対象: ${targets.length}件`);

  let updated = 0, errors = 0;
  for (const t of targets) {
    console.error(`  ${t.code} → ${t.endDate}${dryRun ? " [dry]" : ""}`);
    if (dryRun) continue;
    try {
      await notion.pages.update({
        page_id: t.pageId,
        properties: { end: { date: { start: t.endDate } } },
      });
      updated++;
    } catch (e) {
      console.error(`    ERROR: ${e.message}`);
      errors++;
    }
  }
  console.log(JSON.stringify({ agent: "backfill-end", target: targets.length, updated, errors, dryRun }));
})().catch(e => { console.error(e); process.exit(1); });
