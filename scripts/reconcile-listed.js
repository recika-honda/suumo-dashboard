#!/usr/bin/env node
/**
 * reconcile-listed.js — REINS_ID ベースで Notion 広告DB と forrent を突合する。
 *
 *   Notion 行 (status):
 *     掲載指示済み | 要取り下げ | 掲載保留 | …
 *   forrent 状態 (kishaCode 由来 REINS_ID):
 *     - present + isPublished=true        → forrent_listed
 *     - present + isPublished=false      → forrent_unpublished
 *     - absent                           → forrent_absent
 *
 *   判定ルール:
 *     [add]    forrent_listed かつ Notion(掲載指示済み + 要取り下げ + 掲載保留)に無い
 *              → 新規ページを掲載指示済みで作成
 *     [demote] Notion 要取り下げ かつ forrent_unpublished or forrent_absent
 *              → 取下済み に変更
 *
 *   その他 (Notion 掲載指示済みで forrent から消えてる等) は今回スコープ外でレポートのみ。
 *
 * Usage:
 *   bun run scripts/reconcile-listed.js                # dry run
 *   bun run scripts/reconcile-listed.js --apply        # write
 *   bun run scripts/reconcile-listed.js --apply-add    # add のみ
 *   bun run scripts/reconcile-listed.js --apply-demote # demote のみ
 */
const fs = require("fs");
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", ".env.local") });

const NOTION_TOKEN = process.env.NOTION_TOKEN;
const DS_ID = "3171c197-4dad-80a7-994c-000b14b1cee9";
const SNAP = path.join(__dirname, "..", "logs", "forrent-list-snapshot.json");
const CACHE = path.join(__dirname, "..", ".cache", "bukken-kisha-map.json");

const APPLY_ADD = process.argv.includes("--apply") || process.argv.includes("--apply-add");
const APPLY_DEMOTE = process.argv.includes("--apply") || process.argv.includes("--apply-demote");

function todayJst() {
  const now = new Date();
  const jst = new Date(now.getTime() + 9 * 3600 * 1000);
  return jst.toISOString().slice(0, 10);
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

async function notionQueryAll(filter) {
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

async function notionPatchStatus(pageId, statusName) {
  const r = await fetch(`https://api.notion.com/v1/pages/${pageId}`, {
    method: "PATCH",
    headers: {
      Authorization: `Bearer ${NOTION_TOKEN}`,
      "Notion-Version": "2025-09-03",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ properties: { Status: { status: { name: statusName } } } }),
  }).then(r => r.json());
  if (r.object === "error") throw new Error(r.message);
  return r;
}

async function notionCreatePage(props) {
  const r = await fetch(`https://api.notion.com/v1/pages`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${NOTION_TOKEN}`,
      "Notion-Version": "2025-09-03",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      parent: { type: "data_source_id", data_source_id: DS_ID },
      properties: props,
    }),
  }).then(r => r.json());
  if (r.object === "error") throw new Error(r.message);
  return r;
}

(async () => {
  const today = todayJst();
  console.log(`mode: add=${APPLY_ADD ? "APPLY" : "DRY"}, demote=${APPLY_DEMOTE ? "APPLY" : "DRY"}`);
  console.log(`today: ${today}`);

  // 1. forrent snapshot + cache → REINS_ID map
  const snap = JSON.parse(fs.readFileSync(SNAP, "utf-8"));
  const cache = JSON.parse(fs.readFileSync(CACHE, "utf-8")); // bukkenCd -> kishaCode

  const forrentByReins = new Map(); // reinsId -> forrent row
  const forrentNonFng = []; // kishaCode が fng+REINS でない物件
  for (const r of snap) {
    const kc = (cache[r.bukkenCd] || "").trim();
    const m = kc.match(/^fng(\d+)$/);
    if (m) {
      const reins = m[1];
      // dedupe: keep one with isPublished priority
      const existing = forrentByReins.get(reins);
      if (!existing || (!existing.isPublished && r.isPublished)) {
        forrentByReins.set(reins, { ...r, kishaCode: kc, reinsId: reins });
      }
    } else {
      forrentNonFng.push({ bukkenCd: r.bukkenCd, kishaCode: kc, name: r.name, isPublished: r.isPublished });
    }
  }
  console.log(`forrent total: ${snap.length}, with fng+REINS: ${forrentByReins.size}, non-fng: ${forrentNonFng.length}`);
  console.log(`forrent isPublished=true (fng系): ${[...forrentByReins.values()].filter(v => v.isPublished).length}`);

  // 2. Notion: 掲載指示済み + 要取り下げ + 掲載保留 を取得
  const notionRows = await notionQueryAll({
    or: [
      { property: "Status", status: { equals: "掲載指示済み" } },
      { property: "Status", status: { equals: "要取り下げ" } },
      { property: "Status", status: { equals: "掲載保留" } },
    ],
  });
  const notionByReins = new Map(); // reinsId -> [pages]
  let nShiji = 0, nYouTorisage = 0, nHoryu = 0;
  for (const p of notionRows) {
    const reins = p.properties["REINS_ID"]?.title?.[0]?.plain_text || "";
    const name = p.properties["物件名"]?.rich_text?.[0]?.plain_text || "";
    const status = p.properties["Status"]?.status?.name || "";
    if (status === "掲載指示済み") nShiji++;
    else if (status === "要取り下げ") nYouTorisage++;
    else if (status === "掲載保留") nHoryu++;
    if (!reins) continue;
    if (!notionByReins.has(reins)) notionByReins.set(reins, []);
    notionByReins.get(reins).push({ pageId: p.id, name, status });
  }
  console.log(`Notion: 掲載指示済み=${nShiji}, 要取り下げ=${nYouTorisage}, 掲載保留=${nHoryu} (合計 ${notionRows.length})`);

  // 3. [add] forrent_listed で Notion に無い (掲載指示済み + 要取り下げ + 掲載保留 のいずれにも) → 追加候補
  const addCandidates = [];
  for (const [reins, fr] of forrentByReins.entries()) {
    if (!fr.isPublished) continue;
    if (notionByReins.has(reins)) continue; // already in Notion (any of the 3 statuses)
    const { name, room } = splitNameAndRoom(fr.name || "");
    addCandidates.push({ reinsId: reins, propertyName: name, room, endDate: fr.endDate || null, bukkenCd: fr.bukkenCd });
  }
  // 4. [demote] Notion 要取り下げ で forrent_unpublished or absent → 取下済み
  const demoteCandidates = [];
  for (const [reins, pages] of notionByReins.entries()) {
    for (const pg of pages) {
      if (pg.status !== "要取り下げ") continue;
      const fr = forrentByReins.get(reins);
      if (!fr || !fr.isPublished) {
        demoteCandidates.push({
          pageId: pg.pageId,
          reinsId: reins,
          propertyName: pg.name,
          forrent: fr ? `unpublished (col11=${(fr.rawCells?.col11 || "").slice(0,30)})` : "absent",
        });
      }
    }
  }

  // 5. Report
  console.log("");
  console.log(`=== [ADD] forrent掲載中なのに Notionに無い: ${addCandidates.length}件 ===`);
  addCandidates.forEach((c, i) => {
    console.log(`${i + 1}\t${c.reinsId}\t${c.propertyName}\t${c.room}\t${c.endDate || "-"}`);
  });
  console.log("");
  console.log(`=== [DEMOTE] Notion 要取り下げ で forrent掲載なし: ${demoteCandidates.length}件 ===`);
  demoteCandidates.slice(0, 60).forEach((c, i) => {
    console.log(`${i + 1}\t${c.reinsId}\t${c.propertyName}\t${c.forrent}`);
  });
  if (demoteCandidates.length > 60) console.log(`  ... and ${demoteCandidates.length - 60} more`);

  // Save log
  fs.writeFileSync(
    path.join(__dirname, "..", "logs", `reconcile-${APPLY_ADD || APPLY_DEMOTE ? "apply" : "dryrun"}-${Date.now()}.json`),
    JSON.stringify({ today, addCandidates, demoteCandidates, forrentNonFng, summary: { forrentTotal: snap.length, forrentFng: forrentByReins.size, forrentListed: [...forrentByReins.values()].filter(v => v.isPublished).length, nShiji, nYouTorisage, nHoryu, addCount: addCandidates.length, demoteCount: demoteCandidates.length } }, null, 2)
  );

  if (!APPLY_ADD && !APPLY_DEMOTE) {
    console.log("\n[dry run] use --apply / --apply-add / --apply-demote to write");
    return;
  }

  // 6. Apply
  if (APPLY_ADD) {
    console.log(`\n=== APPLY add (${addCandidates.length}件) ===`);
    let ok = 0, ng = 0;
    for (const c of addCandidates) {
      try {
        const titleText = c.reinsId;
        const propsName = c.room ? `${c.propertyName} ${c.room}` : c.propertyName;
        await notionCreatePage({
          REINS_ID: { title: [{ type: "text", text: { content: titleText } }] },
          物件名: { rich_text: [{ type: "text", text: { content: propsName } }] },
          Status: { status: { name: "掲載指示済み" } },
          ...(c.endDate ? { 公開日時: { date: { start: c.endDate } } } : {}),
        });
        console.log(`  OK  ${c.reinsId} ${c.propertyName}`);
        ok++;
      } catch (e) {
        console.error(`  NG  ${c.reinsId} ${c.propertyName}: ${e.message}`);
        ng++;
      }
    }
    console.log(`add: ok=${ok}, ng=${ng}`);
  }
  if (APPLY_DEMOTE) {
    console.log(`\n=== APPLY demote (${demoteCandidates.length}件) ===`);
    let ok = 0, ng = 0;
    for (const c of demoteCandidates) {
      try {
        await notionPatchStatus(c.pageId, "取下済み");
        console.log(`  OK  ${c.reinsId} ${c.propertyName} → 取下済み`);
        ok++;
      } catch (e) {
        console.error(`  NG  ${c.reinsId} ${c.propertyName}: ${e.message}`);
        ng++;
      }
    }
    console.log(`demote: ok=${ok}, ng=${ng}`);
  }
})().catch(e => { console.error(e); process.exit(1); });
