#!/usr/bin/env node
/**
 * diff-listed.js — forrent 掲載指示済み (isPublished=true) 60件 と
 * Notion 広告DB の Status in [掲載指示済み, 要取り下げ] を物件名で照合し、
 * Notion 側に存在しない (= 追加すべき) 物件を洗い出す。
 *
 * Usage:
 *   bun run scripts/diff-listed.js
 */
const fs = require("fs");
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", ".env.local") });

const NOTION_TOKEN = process.env.NOTION_TOKEN;
const DS_ID = "3171c197-4dad-80a7-994c-000b14b1cee9";
const SNAP = path.join(__dirname, "..", "logs", "forrent-list-snapshot.json");

function normalizeName(s) {
  if (!s) return "";
  return String(s).normalize("NFKC").replace(/\s+/g, "").toLowerCase();
}
function splitNameAndRoom(col3) {
  if (!col3) return { name: "", room: "" };
  const s = col3.trim();
  const lastSp = s.lastIndexOf(" ");
  if (lastSp > 0) {
    const tail = s.slice(lastSp + 1);
    if (/[0-9０-９]/.test(tail) || /号室|号|室/.test(tail)) {
      return { name: s.slice(0, lastSp).trim(), room: tail.trim() };
    }
  }
  const m = s.match(/^(.*?)([0-9０-９]+\s*(?:号室|号|室)?)$/);
  if (m) return { name: m[1].trim(), room: m[2].trim() };
  return { name: s, room: "" };
}

async function queryNotionAll(filter) {
  const out = [];
  let cursor;
  do {
    const r = await fetch(`https://api.notion.com/v1/data_sources/${DS_ID}/query`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${NOTION_TOKEN}`,
        "Notion-Version": "2025-09-03",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ page_size: 100, filter, ...(cursor && { start_cursor: cursor }) }),
    }).then(r => r.json());
    if (!r.results) { console.error(JSON.stringify(r)); throw new Error("notion query failed"); }
    out.push(...r.results);
    cursor = r.has_more ? r.next_cursor : null;
  } while (cursor);
  return out;
}

(async () => {
  const snap = JSON.parse(fs.readFileSync(SNAP, "utf-8"));
  const published = snap.filter(r => r.isPublished);
  console.log(`forrent isPublished: ${published.length} 件`);

  const notionListed = await queryNotionAll({
    or: [
      { property: "Status", status: { equals: "掲載指示済み" } },
      { property: "Status", status: { equals: "要取り下げ" } },
    ],
  });
  console.log(`Notion (掲載指示済み + 要取り下げ): ${notionListed.length} 件`);

  // index Notion by normalized name
  const notionIndex = new Map();
  for (const p of notionListed) {
    const name = p.properties["物件名"]?.rich_text?.[0]?.plain_text || "";
    const reins = p.properties["REINS_ID"]?.title?.[0]?.plain_text || "";
    const status = p.properties["Status"]?.status?.name || "";
    const key = normalizeName(name);
    if (!key) continue;
    if (!notionIndex.has(key)) notionIndex.set(key, []);
    notionIndex.get(key).push({ pageId: p.id, name, reins, status });
  }
  console.log(`Notion 物件名キー数 (normalized unique): ${notionIndex.size}`);

  // forrent published, find names missing in Notion
  const missing = [];
  const matched = [];
  const seenForrentBuilding = new Set();
  for (const r of published) {
    const { name, room } = splitNameAndRoom(r.name || "");
    const key = normalizeName(name);
    if (!key) continue;
    seenForrentBuilding.add(key);

    let nMatches = notionIndex.get(key) || [];
    // fallback substring match
    if (nMatches.length === 0) {
      for (const [k, v] of notionIndex.entries()) {
        if (k.includes(key) || key.includes(k)) nMatches = nMatches.concat(v);
      }
    }
    if (nMatches.length > 0) matched.push({ forrent: r, building: name, room, notion: nMatches });
    else missing.push({ forrent: r, building: name, room });
  }

  console.log(`\nforrent published 物件 unique buildings: ${seenForrentBuilding.size}`);
  console.log(`  → Notionでマッチ: ${matched.length}`);
  console.log(`  → Notionに無い: ${missing.length}`);

  console.log(`\n=== Notion に追加候補 (forrent published で Notion にない) ===`);
  missing.forEach((m, i) => {
    console.log(`${i + 1}\t${m.forrent.bukkenCd}\t${m.building}\t${m.room}\t${m.forrent.endDate || "-"}`);
  });

  // also: Notion 掲載指示済み or 要取り下げ にあるが forrent にない (= forrent から消えてる) の検出
  const ghost = [];
  for (const [key, arr] of notionIndex.entries()) {
    if (!seenForrentBuilding.has(key)) {
      // fallback substring
      let hit = false;
      for (const f of seenForrentBuilding) if (f.includes(key) || key.includes(f)) { hit = true; break; }
      if (!hit) ghost.push(...arr);
    }
  }
  console.log(`\n=== Notion にあるが forrent published にない (要レビュー) ===`);
  ghost.forEach((g, i) => {
    console.log(`${i + 1}\t${g.reins}\t${g.name}\t[${g.status}]`);
  });

  fs.writeFileSync(
    path.join(__dirname, "..", "logs", "diff-listed.json"),
    JSON.stringify({ missing, ghost, matched: matched.map(m => ({ name: m.building, room: m.room, end: m.forrent.endDate })) }, null, 2)
  );
  console.log(`\nlog: logs/diff-listed.json`);
})().catch(e => { console.error(e); process.exit(1); });
