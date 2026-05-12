#!/usr/bin/env node
/**
 * dryrun-keisai-hoyu.js
 * Notion 広告DB で Status="掲載保留" のレコードを取り出し、
 * forrent.jp の一覧から物件名で照合し、掲載終了日の値で
 * 新ステータスを判定する。デフォルトはドライラン (--apply で実書込)。
 *
 *   掲載終了日 空            → 変更なし
 *   掲載終了日 >= 今日(JST)  → 掲載指示済み
 *   掲載終了日 <  今日(JST)  → 取下済み
 *
 * Usage:
 *   bun run scripts/dryrun-keisai-hoyu.js              # dry run
 *   bun run scripts/dryrun-keisai-hoyu.js --apply      # write back
 */

const path = require("path");
const fs = require("fs");
require("dotenv").config({ path: path.join(__dirname, "..", "..", ".env.local") });

const { chromium } = require("playwright");
const { Client } = require("@notionhq/client");
const forrent = require("../../skills/forrent");
const reader = require("../../skills/forrent-reader");

const APPLY = process.argv.includes("--apply");
const NOTION_TOKEN = process.env.NOTION_TOKEN;
const AD_DB_ID = "3171c1974dad80439367df13aa67f012";
const TARGET_STATUS = "掲載保留";
const STATUS_KEEP_LISTED = "掲載指示済み";
const STATUS_TAKEN_DOWN = "取下済み";

// JST today (date only, YYYY-MM-DD)
function todayJst() {
  const now = new Date();
  const jst = new Date(now.getTime() + 9 * 3600 * 1000);
  return jst.toISOString().slice(0, 10);
}

// Normalize Japanese property names for fuzzy matching:
// strip whitespace, normalize 全角→半角 digits/spaces, drop trailing room # patterns
function normalizeName(s) {
  if (!s) return "";
  return String(s)
    .normalize("NFKC")
    .replace(/\s+/g, "")
    .toLowerCase();
}

// Extract building name from forrent col3 ("物件名 部屋番号" concatenated, ws collapsed → still has space).
// Heuristic: "ヴィアグランデ若林 101号室" → name="ヴィアグランデ若林", room="101号室"
function splitNameAndRoom(col3) {
  if (!col3) return { name: "", room: "" };
  const s = col3.trim();
  // Try last whitespace split first
  const lastSp = s.lastIndexOf(" ");
  if (lastSp > 0) {
    const tail = s.slice(lastSp + 1);
    if (/[0-9０-９]/.test(tail) || /号室|号|室/.test(tail)) {
      return { name: s.slice(0, lastSp).trim(), room: tail.trim() };
    }
  }
  // Try regex: "...名前(数字号室)"
  const m = s.match(/^(.*?)([0-9０-９]+\s*(?:号室|号|室)?)$/);
  if (m) return { name: m[1].trim(), room: m[2].trim() };
  return { name: s, room: "" };
}

async function fetchNotionTargets() {
  const notion = new Client({ auth: NOTION_TOKEN });
  // Use the 2025-09-03 data_sources query that we confirmed works
  const DS_ID = "3171c197-4dad-80a7-994c-000b14b1cee9";
  const targets = [];
  let cursor;
  do {
    const res = await fetch(`https://api.notion.com/v1/data_sources/${DS_ID}/query`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${NOTION_TOKEN}`,
        "Notion-Version": "2025-09-03",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        page_size: 100,
        filter: { property: "Status", status: { equals: TARGET_STATUS } },
        ...(cursor && { start_cursor: cursor }),
      }),
    }).then(r => r.json());
    if (!res.results) {
      console.error("Notion query error:", JSON.stringify(res));
      throw new Error("notion query failed");
    }
    for (const p of res.results) {
      if (p.archived || p.in_trash) continue;
      const reins = p.properties["REINS_ID"]?.title?.[0]?.plain_text || "";
      const name = p.properties["物件名"]?.rich_text?.[0]?.plain_text || "";
      targets.push({ pageId: p.id, reinsId: reins, propertyName: name });
    }
    cursor = res.has_more ? res.next_cursor : null;
  } while (cursor);
  return targets;
}

async function fetchForrentList() {
  const headless = process.env.HEADLESS !== "false";
  const browser = await chromium.launch({ headless });
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();
  page.on("dialog", async d => { try { await d.accept(); } catch {} });

  let ok = false;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      ok = await forrent.login(page, {
        id: process.env.SUUMO_LOGIN_ID,
        pass: process.env.SUUMO_LOGIN_PASS,
      });
      if (ok) break;
    } catch (e) {
      console.error(`login ${attempt}: ${e.message}`);
    }
    await page.waitForTimeout(3000);
  }
  if (!ok) {
    await browser.close();
    throw new Error("forrent login failed");
  }
  console.error("forrent login ok");

  let mainFrame = await reader.navigateToListPage(page);
  let listData = await reader.parseListPage(mainFrame);
  const all = [...listData.properties];
  console.error(`forrent: ${all.length}/${listData.total} 件 (page 1)`);
  while (all.length < listData.total) {
    mainFrame = page.frame({ name: "main" });
    const hasNext = await reader.goToNextPage(page, mainFrame);
    if (!hasNext) break;
    mainFrame = page.frame({ name: "main" });
    const next = await reader.parseListPage(mainFrame);
    all.push(...next.properties);
    console.error(`forrent: ${all.length}/${listData.total} 件`);
  }
  await browser.close();
  return all;
}

function decideNewStatus(endDate, today) {
  if (!endDate) return null; // no change
  if (endDate >= today) return STATUS_KEEP_LISTED;
  return STATUS_TAKEN_DOWN;
}

async function applyStatus(pageId, statusName) {
  const res = await fetch(`https://api.notion.com/v1/pages/${pageId}`, {
    method: "PATCH",
    headers: {
      Authorization: `Bearer ${NOTION_TOKEN}`,
      "Notion-Version": "2025-09-03",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      properties: { Status: { status: { name: statusName } } },
    }),
  }).then(r => r.json());
  if (res.object === "error") throw new Error(res.message);
  return res;
}

(async () => {
  console.error(`mode: ${APPLY ? "APPLY (実書込)" : "DRY RUN"}`);
  const today = todayJst();
  console.error(`today (JST): ${today}`);

  console.error("Notion: 掲載保留 を取得中...");
  const targets = await fetchNotionTargets();
  console.error(`Notion 掲載保留: ${targets.length} 件`);

  if (targets.length === 0) {
    console.log(JSON.stringify({ targets: 0 }));
    return;
  }

  console.error("forrent: 一覧スクレイプ中...");
  const forrentRows = await fetchForrentList();
  console.error(`forrent: 合計 ${forrentRows.length} 件取得`);

  // Build name index
  const nameIndex = new Map(); // normalizedName -> array of rows
  for (const r of forrentRows) {
    const { name, room } = splitNameAndRoom(r.name || "");
    const norm = normalizeName(name);
    if (!norm) continue;
    if (!nameIndex.has(norm)) nameIndex.set(norm, []);
    nameIndex.get(norm).push({ ...r, _name: name, _room: room });
  }

  // Save raw debug dump
  const debugDir = path.join(__dirname, "..", "..", "logs");
  fs.mkdirSync(debugDir, { recursive: true });
  fs.writeFileSync(
    path.join(debugDir, "forrent-list-snapshot.json"),
    JSON.stringify(forrentRows, null, 2)
  );

  const decisions = [];
  for (const t of targets) {
    const norm = normalizeName(t.propertyName);
    let matches = nameIndex.get(norm) || [];

    // Fallback: substring match
    if (matches.length === 0 && norm) {
      for (const [k, v] of nameIndex.entries()) {
        if (k.includes(norm) || norm.includes(k)) matches = matches.concat(v);
      }
    }

    let endDate = null;
    let matchInfo = "";
    if (matches.length === 0) {
      matchInfo = "未ヒット";
    } else if (matches.length === 1) {
      endDate = matches[0].endDate;
      matchInfo = `1件 (${matches[0]._room || "-"})`;
    } else {
      // Multiple → pick latest endDate (most recent listing)
      const withEnd = matches.filter(m => m.endDate);
      if (withEnd.length > 0) {
        withEnd.sort((a, b) => (b.endDate || "").localeCompare(a.endDate || ""));
        endDate = withEnd[0].endDate;
      }
      matchInfo = `${matches.length}件 (rooms: ${matches.map(m => m._room || "-").join(",")})`;
    }

    const newStatus = decideNewStatus(endDate, today);
    decisions.push({
      pageId: t.pageId,
      reinsId: t.reinsId,
      propertyName: t.propertyName,
      forrentMatches: matches.length,
      matchInfo,
      endDate: endDate || "",
      newStatus: newStatus || "(変更なし)",
    });
  }

  // Print table
  console.log("");
  console.log("=== ドライラン判定結果 ===");
  console.log("");
  const header = ["#", "REINS_ID", "物件名", "match", "endDate", "新ステータス"];
  console.log(header.join("\t"));
  let cKeep = 0, cTake = 0, cNone = 0, cUnmatched = 0;
  decisions.forEach((d, i) => {
    if (d.forrentMatches === 0) cUnmatched++;
    if (d.newStatus === STATUS_KEEP_LISTED) cKeep++;
    else if (d.newStatus === STATUS_TAKEN_DOWN) cTake++;
    else cNone++;
    console.log(
      [
        i + 1,
        d.reinsId,
        d.propertyName,
        d.matchInfo,
        d.endDate || "-",
        d.newStatus,
      ].join("\t")
    );
  });
  console.log("");
  console.log(
    `summary: 掲載指示済み=${cKeep}, 取下済み=${cTake}, 変更なし=${cNone} (うち未ヒット=${cUnmatched})`
  );

  // Write json log
  fs.writeFileSync(
    path.join(debugDir, `keisai-hoyu-${APPLY ? "apply" : "dryrun"}-${Date.now()}.json`),
    JSON.stringify({ today, decisions }, null, 2)
  );

  if (!APPLY) {
    console.log("\n[dry run] --apply を付けると Notion に書き込みます");
    return;
  }

  console.log("\n=== APPLY: Notion 書込開始 ===");
  let okCount = 0, ngCount = 0;
  for (const d of decisions) {
    if (d.newStatus === "(変更なし)") continue;
    try {
      await applyStatus(d.pageId, d.newStatus);
      console.log(`  OK  ${d.reinsId} ${d.propertyName} → ${d.newStatus}`);
      okCount++;
    } catch (e) {
      console.error(`  NG  ${d.reinsId} ${d.propertyName}: ${e.message}`);
      ngCount++;
    }
  }
  console.log(`\napplied: ${okCount}, errors: ${ngCount}`);
})().catch(e => {
  console.error(e);
  process.exit(1);
});
