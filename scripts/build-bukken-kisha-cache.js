#!/usr/bin/env node
/**
 * build-bukken-kisha-cache.js — forrent 全物件の bukkenCd → kishaCode (=fng+REINS_ID) を
 * 詳細ページから取得し .cache/bukken-kisha-map.json に保存する。
 *
 * Usage:
 *   bun run scripts/build-bukken-kisha-cache.js          # 既存キャッシュを尊重し未取得分のみ
 *   bun run scripts/build-bukken-kisha-cache.js --force  # 全件再取得
 */
const path = require("path");
const fs = require("fs");
require("dotenv").config({ path: path.join(__dirname, "..", ".env.local") });
const { chromium } = require("playwright");
const forrent = require("../skills/forrent");
const reader = require("../skills/forrent-reader");

const FORCE = process.argv.includes("--force");
const CACHE = path.join(__dirname, "..", ".cache", "bukken-kisha-map.json");

(async () => {
  fs.mkdirSync(path.dirname(CACHE), { recursive: true });
  const cache = (() => {
    try { return JSON.parse(fs.readFileSync(CACHE, "utf-8")); }
    catch { return {}; }
  })();
  console.error(`existing cache: ${Object.keys(cache).length} entries`);

  const browser = await chromium.launch({ headless: process.env.HEADLESS !== "false" });
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();
  page.on("dialog", async d => { try { await d.accept(); } catch {} });

  let ok = false;
  for (let i = 1; i <= 3; i++) {
    try { ok = await forrent.login(page, { id: process.env.SUUMO_LOGIN_ID, pass: process.env.SUUMO_LOGIN_PASS }); if (ok) break; } catch (e) {}
    await page.waitForTimeout(3000);
  }
  if (!ok) { await browser.close(); throw new Error("login failed"); }
  console.error("login ok");

  // Tier1: 一覧取得
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
  console.error(`tier1: ${all.length} properties`);

  const targets = FORCE ? all : all.filter(t => !cache[t.bukkenCd]);
  console.error(`detail navigations needed: ${targets.length}`);

  let ok2 = 0, ng = 0;
  for (let i = 0; i < targets.length; i++) {
    const t = targets[i];
    try {
      const fr = await reader.navigateToDetail(page, null, t.bukkenCd);
      const detail = await reader.extractPropertyDetail(page, fr);
      const kc = (detail.kishaCode || "").trim();
      if (kc) {
        cache[t.bukkenCd] = kc;
        ok2++;
        if (i % 10 === 0 || i === targets.length - 1) {
          fs.writeFileSync(CACHE, JSON.stringify(cache, null, 2));
        }
        console.error(`[${i + 1}/${targets.length}] ${t.bukkenCd} → ${kc}`);
      } else {
        ng++;
        console.error(`[${i + 1}/${targets.length}] ${t.bukkenCd} → (kishaCode 不在)`);
      }
    } catch (e) {
      ng++;
      console.error(`[${i + 1}/${targets.length}] ${t.bukkenCd} ERR: ${e.message}`);
    }
    await page.waitForTimeout(300);
  }
  fs.writeFileSync(CACHE, JSON.stringify(cache, null, 2));
  await browser.close();
  console.error(`done: ok=${ok2}, ng=${ng}, cache=${Object.keys(cache).length}`);
})().catch(e => { console.error(e); process.exit(1); });
