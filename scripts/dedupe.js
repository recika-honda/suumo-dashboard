#!/usr/bin/env node
/**
 * dedupe.js — 同一「貴社物件コード」の重複ページのうち、
 * 新しい方 (created_time 降順の先頭) を archive(=delete) する。
 *
 * 通常は backfill と hourly の並行実行で発生する一過性の重複を掃除する用途。
 * Usage: bun run scripts/dedupe.js [--dry-run]
 */

const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", ".env.local") });
const { Client } = require("@notionhq/client");
const notion = new Client({ auth: process.env.NOTION_TOKEN });
const DB = process.env.NOTION_NYUKO_DB_ID;
const dryRun = process.argv.includes("--dry-run");

(async () => {
  let cursor;
  const byCode = new Map();
  do {
    const r = await notion.databases.query({
      database_id: DB, page_size: 100,
      ...(cursor && { start_cursor: cursor }),
    });
    for (const p of r.results) {
      const code = p.properties["貴社物件コード"]?.title?.[0]?.plain_text || "";
      if (!code) continue;
      if (!byCode.has(code)) byCode.set(code, []);
      byCode.get(code).push({
        id: p.id,
        created: p.created_time,
        score: p.properties["score"]?.number,
      });
    }
    cursor = r.has_more ? r.next_cursor : null;
  } while (cursor);

  const dups = [...byCode.entries()].filter(([, v]) => v.length > 1);
  console.error(`重複コード: ${dups.length}件`);

  let archived = 0, errors = 0;
  for (const [code, pages] of dups) {
    // keep oldest, archive the rest
    pages.sort((a, b) => new Date(a.created) - new Date(b.created));
    const keep = pages[0];
    const toRemove = pages.slice(1);
    console.error(`  ${code}: keep ${keep.id.slice(-6)} (score=${keep.score}), remove ${toRemove.length}件`);
    for (const r of toRemove) {
      console.error(`    - ${r.id.slice(-6)} created=${r.created} score=${r.score}${dryRun ? " [dry]" : ""}`);
      if (dryRun) continue;
      try {
        await notion.pages.update({ page_id: r.id, archived: true });
        archived++;
      } catch (err) {
        console.error(`      ERROR: ${err.message}`);
        errors++;
      }
    }
  }
  console.log(JSON.stringify({ agent: "dedupe", dupCodes: dups.length, archived, errors, dryRun }));
})().catch((err) => { console.error(err); process.exit(1); });
