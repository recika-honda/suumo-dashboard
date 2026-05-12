#!/usr/bin/env node
/**
 * forrent.jp 掲載管理 — 一覧ページ構造調査
 *
 * 掲載管理(#menu_3)の物件一覧テーブルをダンプし、
 * 一覧ページで取得可能なフィールドを特定する。
 *
 * Usage:
 *   bun run scripts/discover-list-page.js
 *
 * Output:
 *   ~/Desktop/suumo-nyuko/research/list-page-structure.json
 *   ~/Desktop/suumo-nyuko/research/list-page.png
 */

const path = require("path");
const os = require("os");
const fs = require("fs");
require("dotenv").config({ path: path.join(__dirname, "..", ".env.local") });
const { chromium } = require("playwright");
const forrent = require("../skills/forrent");

const outDir = path.join(os.homedir(), "Desktop", "suumo-nyuko", "research");

async function main() {
  fs.mkdirSync(outDir, { recursive: true });

  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  page.on("dialog", async (d) => { await d.accept(); });

  // Login
  const creds = {
    id: process.env.SUUMO_LOGIN_ID,
    pass: process.env.SUUMO_LOGIN_PASS,
  };
  console.log("=== ログイン ===");
  const ok = await forrent.login(page, creds);
  if (!ok) {
    console.error("ログイン失敗");
    await page.screenshot({ path: path.join(outDir, "login-fail.png") });
    process.exit(1);
  }
  console.log("ログイン成功");

  // Navigate to 掲載管理
  console.log("\n=== 掲載管理へ遷移 ===");
  const naviFrame = page.frame({ name: "navi" });
  await naviFrame.click("#menu_3");
  await page.waitForTimeout(5000);

  let mainFrame = page.frame({ name: "main" });

  // Dump search form structure
  console.log("\n=== 検索フォーム構造 ===");
  const searchFormInfo = await mainFrame.evaluate(() => {
    const form = document.querySelector("form[name='searchForm']") || document.querySelector("form");
    if (!form) return { error: "form not found" };
    const fields = [];
    for (const el of form.querySelectorAll("input, select, textarea")) {
      fields.push({
        tag: el.tagName.toLowerCase(),
        type: el.type || "",
        name: el.name || "",
        id: el.id || "",
        value: (el.value || "").slice(0, 100),
      });
    }
    return { action: form.action, method: form.method, fieldCount: fields.length, fields };
  });
  console.log(`  フォーム: action=${searchFormInfo.action}, fields=${searchFormInfo.fieldCount}`);

  // Submit search (全物件)
  console.log("\n=== 全物件検索 ===");
  await mainFrame.evaluate(() => {
    const form = document.querySelector("form[name='searchForm']") || document.querySelector("form");
    if (form) form.submit();
  });
  await page.waitForTimeout(8000);
  mainFrame = page.frame({ name: "main" });

  // Screenshot
  await page.screenshot({ path: path.join(outDir, "list-page.png"), fullPage: false });
  console.log(`  スクリーンショット: ${path.join(outDir, "list-page.png")}`);

  // Dump the full page body text (first 5000 chars) for context
  const bodySnippet = await mainFrame.evaluate(() => document.body?.innerText?.slice(0, 5000) || "");
  console.log("\n=== ページテキスト (先頭5000文字) ===");
  console.log(bodySnippet);

  // Analyze table structure
  console.log("\n=== テーブル構造分析 ===");
  const tableData = await mainFrame.evaluate(() => {
    // Find all tables
    const tables = document.querySelectorAll("table");
    const result = { tableCount: tables.length, tables: [] };

    for (let i = 0; i < tables.length; i++) {
      const table = tables[i];
      const rows = table.querySelectorAll("tr");
      if (rows.length === 0) continue;

      const tableInfo = {
        index: i,
        className: table.className,
        id: table.id,
        rowCount: rows.length,
        headers: [],
        sampleRows: [],
      };

      // Extract headers
      const headerRow = table.querySelector("tr");
      if (headerRow) {
        for (const th of headerRow.querySelectorAll("th, td")) {
          tableInfo.headers.push(th.textContent.trim().replace(/\s+/g, " ").slice(0, 50));
        }
      }

      // Extract first 3 data rows
      const dataRows = Array.from(rows).slice(1, 4);
      for (const row of dataRows) {
        const cells = [];
        for (const td of row.querySelectorAll("td")) {
          const text = td.textContent.trim().replace(/\s+/g, " ").slice(0, 100);
          // Check for links and onclick handlers
          const links = Array.from(td.querySelectorAll("a")).map(a => ({
            text: a.textContent.trim().slice(0, 50),
            href: (a.href || "").slice(0, 100),
            onclick: (a.getAttribute("onclick") || "").slice(0, 150),
          }));
          const inputs = Array.from(td.querySelectorAll("input")).map(inp => ({
            type: inp.type,
            name: inp.name,
            value: (inp.value || "").slice(0, 50),
          }));
          cells.push({ text, links, inputs });
        }
        tableInfo.sampleRows.push(cells);
      }

      if (tableInfo.rowCount > 1 || tableInfo.headers.length > 2) {
        result.tables.push(tableInfo);
      }
    }

    return result;
  });
  console.log(`  テーブル数: ${tableData.tableCount}`);
  for (const t of tableData.tables) {
    console.log(`  Table[${t.index}] id=${t.id} class=${t.className} rows=${t.rowCount}`);
    console.log(`    Headers: ${t.headers.join(" | ")}`);
    if (t.sampleRows.length > 0) {
      for (let r = 0; r < t.sampleRows.length; r++) {
        const row = t.sampleRows[r];
        console.log(`    Row[${r}]: ${row.map(c => c.text.slice(0, 30)).join(" | ")}`);
        for (const cell of row) {
          if (cell.links.length > 0) {
            for (const link of cell.links) {
              console.log(`      Link: "${link.text}" onclick="${link.onclick}"`);
            }
          }
        }
      }
    }
  }

  // Extract all onclick handlers containing dispChangeShousai or bukkenCd
  console.log("\n=== JavaScript関数・物件コード抽出 ===");
  const jsData = await mainFrame.evaluate(() => {
    const result = { dispCalls: [], hiddenInputs: [], allOnclicks: [] };

    // Find all onclick handlers
    const allElements = document.querySelectorAll("[onclick]");
    for (const el of allElements) {
      const onclick = el.getAttribute("onclick") || "";
      result.allOnclicks.push({
        tag: el.tagName.toLowerCase(),
        text: el.textContent.trim().slice(0, 50),
        onclick: onclick.slice(0, 200),
      });
      if (onclick.includes("dispChange") || onclick.includes("bukken")) {
        result.dispCalls.push({
          text: el.textContent.trim().slice(0, 50),
          onclick: onclick.slice(0, 300),
        });
      }
    }

    // Find all hidden inputs with bukken-related names
    const hiddens = document.querySelectorAll("input[type='hidden']");
    for (const h of hiddens) {
      if (h.name.toLowerCase().includes("bukken") || h.value.match(/^\d{10,}/)) {
        result.hiddenInputs.push({ name: h.name, value: h.value.slice(0, 50) });
      }
    }

    return result;
  });
  console.log(`  dispChange系呼び出し: ${jsData.dispCalls.length}件`);
  for (const call of jsData.dispCalls.slice(0, 5)) {
    console.log(`    "${call.text}" → ${call.onclick}`);
  }
  console.log(`  onclick全体: ${jsData.allOnclicks.length}件`);
  console.log(`  bukken系hidden: ${jsData.hiddenInputs.length}件`);
  for (const h of jsData.hiddenInputs.slice(0, 5)) {
    console.log(`    ${h.name}=${h.value}`);
  }

  // Check for pagination
  console.log("\n=== ページネーション確認 ===");
  const pagination = await mainFrame.evaluate(() => {
    const body = document.body.innerText;
    const pageMatch = body.match(/(\d+)件.*?(\d+)ページ/) || body.match(/全(\d+)件/) || body.match(/(\d+)\s*件/);
    const pageLinks = document.querySelectorAll("a[href*='page'], a[onclick*='page'], .pager a, .pagination a");
    return {
      totalText: pageMatch ? pageMatch[0] : null,
      pageLinksCount: pageLinks.length,
      pageLinksText: Array.from(pageLinks).slice(0, 5).map(a => a.textContent.trim()),
    };
  });
  console.log(`  件数表示: ${pagination.totalText || "なし"}`);
  console.log(`  ページリンク: ${pagination.pageLinksCount}件 ${pagination.pageLinksText.join(", ")}`);

  // Save all data
  const output = {
    timestamp: new Date().toISOString(),
    searchForm: searchFormInfo,
    tables: tableData,
    jsFunctions: jsData,
    pagination,
    bodySnippet: bodySnippet.slice(0, 3000),
  };

  const jsonPath = path.join(outDir, "list-page-structure.json");
  fs.writeFileSync(jsonPath, JSON.stringify(output, null, 2));
  console.log(`\n  JSON保存: ${jsonPath}`);

  console.log("\n  ブラウザは開いたままです。Ctrl+C で終了。");
  await new Promise(() => {});
}

main().catch(console.error);
