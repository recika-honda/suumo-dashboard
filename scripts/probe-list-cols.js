#!/usr/bin/env node
// Probe: dump all td text + check if "fng" appears anywhere on list page
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", ".env.local") });
const { chromium } = require("playwright");
const forrent = require("../skills/forrent");
const reader = require("../skills/forrent-reader");

(async () => {
  const browser = await chromium.launch({ headless: process.env.HEADLESS !== "false" });
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();
  page.on("dialog", async d => { try { await d.accept(); } catch {} });
  await forrent.login(page, { id: process.env.SUUMO_LOGIN_ID, pass: process.env.SUUMO_LOGIN_PASS });
  console.error("login ok");
  let mainFrame = await reader.navigateToListPage(page);

  const out = await mainFrame.evaluate(() => {
    const body = document.body.innerText;
    const fngMatches = [...body.matchAll(/fng\d+/g)].map(m => m[0]).slice(0, 5);
    const allLinks = document.querySelectorAll("a[href*='dispChangeShousai']");
    const sample = [];
    for (let i = 0; i < Math.min(3, allLinks.length); i++) {
      const tr = allLinks[i].closest("tr");
      const cells = Array.from(tr.querySelectorAll("td")).map((td, idx) => ({ idx, text: (td.textContent || "").trim().replace(/\s+/g, " ").slice(0, 80) }));
      sample.push({ row: i, cells });
    }
    return { fngMatches, sample, bodyLen: body.length };
  });
  console.log(JSON.stringify(out, null, 2));
  await browser.close();
})().catch(e => { console.error(e); process.exit(1); });
