#!/usr/bin/env node
/**
 * fix-scores.js — 一度だけ実行する修復スクリプト。
 * score > 99 のレコード (旧バグで "1941" のように4桁書き込まれたもの) を
 * `score % 100` (下2桁) に更新する。
 *
 * Usage: bun run scripts/fix-scores.js [--dry-run]
 */

const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", ".env.local") });

const { Client: NotionClient } = require("@notionhq/client");
const notion = new NotionClient({ auth: process.env.NOTION_TOKEN });
const DB_ID = process.env.NOTION_NYUKO_DB_ID;
const dryRun = process.argv.includes("--dry-run");

(async () => {
  let cursor;
  const bad = [];
  do {
    const res = await notion.databases.query({
      database_id: DB_ID,
      page_size: 100,
      ...(cursor && { start_cursor: cursor }),
    });
    for (const p of res.results) {
      const score = p.properties["score"]?.number;
      const code = p.properties["貴社物件コード"]?.title?.[0]?.plain_text || "";
      if (typeof score === "number" && score > 99) {
        bad.push({ pageId: p.id, code, score });
      }
    }
    cursor = res.has_more ? res.next_cursor : undefined;
  } while (cursor);

  console.error(`対象: ${bad.length}件`);
  let fixed = 0, errors = 0;
  for (const b of bad) {
    const newScore = b.score % 100;
    console.error(`  ${b.code}: ${b.score} → ${newScore}${dryRun ? " [dry]" : ""}`);
    if (dryRun) continue;
    try {
      await notion.pages.update({
        page_id: b.pageId,
        properties: { score: { number: newScore } },
      });
      fixed++;
    } catch (err) {
      console.error(`    ERROR: ${err.message}`);
      errors++;
    }
  }
  console.log(JSON.stringify({ agent: "fix-scores", total: bad.length, fixed, errors, dryRun }));
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
