#!/usr/bin/env node
/**
 * audit-zmnflmi-rate.js
 *
 * Aggregate maisoku (zmnFlmi) ownership rate from T002 sweep jsonl.
 * Data source: .claude/do/findings/zmnflmi-sweep.jsonl (read-only)
 *
 * Usage:
 *   node scripts/audit-zmnflmi-rate.js [--jsonl <path>] [--help]
 *
 * Options:
 *   --jsonl <path>  Path to sweep jsonl (default: .claude/do/findings/zmnflmi-sweep.jsonl)
 *   --help          Show this help
 */

"use strict";

const fs = require("fs");
const path = require("path");

const PROJECT_ROOT = path.resolve(__dirname, "../../..");
const DEFAULT_JSONL = path.join(
  PROJECT_ROOT,
  ".claude/do/findings/zmnflmi-sweep.jsonl"
);

function parseArgs() {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) {
    console.log(
      [
        "Usage: node scripts/audit-zmnflmi-rate.js [--jsonl <path>]",
        "",
        "Options:",
        "  --jsonl <path>  Path to sweep jsonl (default: .claude/do/findings/zmnflmi-sweep.jsonl)",
        "  --help          Show this help",
      ].join("\n")
    );
    process.exit(0);
  }
  const jsonlIdx = args.indexOf("--jsonl");
  const jsonlPath =
    jsonlIdx >= 0 && args[jsonlIdx + 1] ? args[jsonlIdx + 1] : DEFAULT_JSONL;
  return { jsonlPath };
}

function loadRecords(jsonlPath) {
  if (!fs.existsSync(jsonlPath)) {
    console.error(`ERROR: jsonl not found: ${jsonlPath}`);
    process.exit(1);
  }
  return fs
    .readFileSync(jsonlPath, "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l));
}

function pct(n, d) {
  if (d === 0) return "N/A";
  return ((n / d) * 100).toFixed(1) + "%";
}

function main() {
  const { jsonlPath } = parseArgs();
  const records = loadRecords(jsonlPath);

  const total = records.length;
  const present = records.filter((r) => r.zmnFlmiPresent).length;
  const found = records.filter((r) => r.searchFound).length;
  const notFound = total - found;
  const presentAndFound = records.filter(
    (r) => r.zmnFlmiPresent && r.searchFound
  ).length;

  // motozuke breakdown
  const byMotozuke = {};
  for (const r of records) {
    const key = r.motozuke || "<unknown>";
    if (!byMotozuke[key]) byMotozuke[key] = { total: 0, present: 0, found: 0 };
    byMotozuke[key].total++;
    if (r.zmnFlmiPresent) byMotozuke[key].present++;
    if (r.searchFound) byMotozuke[key].found++;
  }

  const sorted = Object.entries(byMotozuke).sort(
    (a, b) => b[1].total - a[1].total
  );

  console.log("=============================================================");
  console.log("  audit-zmnflmi-rate.js — Maisoku Ownership Rate (T002 data)");
  console.log("=============================================================");
  console.log(`  JSONL     : ${jsonlPath}`);
  console.log(`  Total rows: ${total}`);
  console.log("");

  console.log("--- Overall Rates ---");
  console.log(
    `  Raw ownership rate   : ${present} / ${total} = ${pct(present, total)}`
  );
  console.log(
    `  REINS-resolved rate  : ${presentAndFound} / ${found} = ${pct(presentAndFound, found)}`
  );
  console.log(
    `  NOT_FOUND rate       : ${notFound} / ${total} = ${pct(notFound, total)}`
  );
  console.log("");

  console.log("--- Motozuke Breakdown (top entries, sorted by sample size) ---");
  const header = [
    "motozuke".padEnd(45),
    "sample".padStart(7),
    "found".padStart(6),
    "zmnFlmi".padStart(8),
    "rate".padStart(7),
  ].join(" ");
  console.log("  " + header);
  console.log("  " + "-".repeat(78));

  for (const [name, stat] of sorted) {
    const label = name.length > 43 ? name.slice(0, 42) + "..." : name;
    const line = [
      label.padEnd(45),
      String(stat.total).padStart(7),
      String(stat.found).padStart(6),
      String(stat.present).padStart(8),
      pct(stat.present, stat.total).padStart(7),
    ].join(" ");
    console.log("  " + line);
  }

  console.log("");
  console.log("--- Notes ---");
  console.log("  Sample: T002 sweep, 25 properties, SAMPLE_SEED=42 deterministic shuffle");
  console.log("  NOT_FOUND rows have zmnFlmiPresent:false because REINS page was unreachable.");
  console.log("  REINS-resolved-only rate is the operative metric for Phase 4 planning.");
}

main();
