#!/usr/bin/env node
/**
 * test-extract-feature-codes.js — extract-feature-codes.js + forrent-feature-codes.json のテスト
 *
 * 検証対象:
 *   - config/forrent-feature-codes.json の構造 / 件数 / 重複ゼロ
 *   - allowlist 10 個の存在と allowlist:true フラグ
 *   - searchable:true が正確に 140 件
 *   - 全 entry の label が非 null / 非空
 *   - idempotent: スクリプトを 2 回 spawn して codes 配列が完全一致
 *
 * Phase 4 (2026-05-16): extract-feature-codes.js (132 行、regex parse、cheerio 未使用)
 * と config/forrent-feature-codes.json (150 entry) を固定する regression guard。
 */

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const PROJECT_ROOT = path.resolve(__dirname, "../..");
const CONFIG_PATH = path.join(PROJECT_ROOT, "config", "forrent-feature-codes.json");
const SCRIPT_PATH = path.join(PROJECT_ROOT, "scripts", "extract-feature-codes.js");

const ALLOWLIST_CODES = [
  "0102", // 2駅利用可
  "0103", // 2沿線利用可
  "0104", // 3駅以上利用可
  "0105", // 3沿線以上利用可
  "0201", // 耐震構造
  "0202", // 制震構造
  "0203", // 免震構造
  "0701", // 築2年以内
  "0702", // 築3年以内
  "0703", // 築5年以内
];

let pass = 0;
let fail = 0;
function check(label, fn) {
  try {
    fn();
    console.log(`ok ${label}`);
    pass++;
  } catch (e) {
    console.error(`FAIL ${label}: ${e.message}`);
    fail++;
  }
}

// ── Fixture: load config JSON ─────────────────────────────
const config = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));

// ── (a) total が 150 ─────────────────────────────────────
check("(a) config.total === 150", () => {
  assert.strictEqual(config.total, 150, `expected total=150, got ${config.total}`);
});

// ── (b) codes.length === 150、code 重複ゼロ ──────────────
check("(b) codes.length === 150", () => {
  assert.strictEqual(
    config.codes.length,
    150,
    `expected codes.length=150, got ${config.codes.length}`
  );
});

check("(b) code 重複ゼロ", () => {
  const seen = new Set();
  const dupes = [];
  for (const entry of config.codes) {
    if (seen.has(entry.code)) dupes.push(entry.code);
    seen.add(entry.code);
  }
  assert.strictEqual(dupes.length, 0, `duplicate codes: ${dupes.join(", ")}`);
});

// ── (c) allowlist 10 個が全部含まれ allowlist:true を持つ ─
check("(c) allowlist 10 個が全部存在する", () => {
  const codeSet = new Set(config.codes.map((c) => c.code));
  const missing = ALLOWLIST_CODES.filter((code) => !codeSet.has(code));
  assert.strictEqual(missing.length, 0, `allowlist codes not found: ${missing.join(", ")}`);
});

check("(c) allowlist 10 個が allowlist:true を持つ", () => {
  const codeMap = new Map(config.codes.map((c) => [c.code, c]));
  const failures = [];
  for (const code of ALLOWLIST_CODES) {
    const entry = codeMap.get(code);
    if (!entry || entry.allowlist !== true) {
      failures.push(`${code} (allowlist=${entry ? entry.allowlist : "missing"})`);
    }
  }
  assert.strictEqual(failures.length, 0, `allowlist flag missing or false: ${failures.join(", ")}`);
});

// ── (d) searchable:true のエントリ数が正確に 140 ──────────
check("(d) searchable:true のエントリ数 === 140", () => {
  const searchableCount = config.codes.filter((c) => c.searchable).length;
  assert.strictEqual(
    searchableCount,
    140,
    `expected searchable=140, got ${searchableCount}`
  );
});

check("(d) config.searchable_total === 140 (summary field consistency)", () => {
  assert.strictEqual(config.searchable_total, 140, `expected searchable_total=140, got ${config.searchable_total}`);
});

// ── (e) 全 entry の label が非 null かつ非空文字 ──────────
// allowlist 10 個について: 現在の最新 HTML で全て label が取得できているかを確認する。
// label が null の allowlist entry が存在する場合は別 case として扱う。
check("(e) searchable:true エントリの label が全て非 null かつ非空", () => {
  const searchableEntries = config.codes.filter((c) => c.searchable);
  const badEntries = searchableEntries.filter((c) => !c.label || c.label.trim() === "");
  assert.strictEqual(
    badEntries.length,
    0,
    `searchable entries with null/empty label: ${badEntries.map((c) => c.code).join(", ")}`
  );
});

check("(e) allowlist エントリの label が全て非 null かつ非空 (現在の HTML 入力下)", () => {
  // 現在の最新 HTML (2026-05-16) では allowlist 10 個の label が全て取得できている。
  // もし将来の HTML で label が取れなくなった場合、このテストが fail して発見できる。
  const codeMap = new Map(config.codes.map((c) => [c.code, c]));
  const nullLabelAllowlist = ALLOWLIST_CODES.filter((code) => {
    const entry = codeMap.get(code);
    return !entry || !entry.label || entry.label.trim() === "";
  });
  // 現時点では 0 件を期待する
  assert.strictEqual(
    nullLabelAllowlist.length,
    0,
    `allowlist entries with null/empty label: ${nullLabelAllowlist.join(", ")}` +
      " (if HTML changed, update this test to reflect expected null entries)"
  );
});

// ── (f) idempotent: script を 2 回 spawn して codes 配列が完全一致 ────────────────
// generated_at / source_html / parsed_total を除いた構造 (total / searchable_total /
// allowlist_total / codes) が一致することを確認する。
// timestamp が変わっても codes の内容は不変であることを保証する。
function runScript() {
  const stdout = execFileSync(process.execPath, [SCRIPT_PATH], {
    cwd: PROJECT_ROOT,
    encoding: "utf8",
  });
  // スクリプト実行後に config/forrent-feature-codes.json が更新されるので読む
  return JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
}

function stripVolatile(config) {
  // timestamp 等の実行毎に変わるフィールドを除外してから比較
  const { generated_at, source_html, ...rest } = config;
  return rest;
}

check("(f) idempotent: script を 2 回 spawn して codes 配列が完全一致 (generated_at 除外)", () => {
  const result1 = runScript();
  const result2 = runScript();

  const comparable1 = stripVolatile(result1);
  const comparable2 = stripVolatile(result2);

  // deep equal で全フィールド (total / searchable_total / allowlist_total / codes[]) を比較
  assert.deepStrictEqual(
    comparable2,
    comparable1,
    "second run produced different output (non-idempotent)"
  );
});

check("(f) idempotent: 各 run の codes 配列の code 順序が一致", () => {
  const result1 = runScript();
  const result2 = runScript();

  const codes1 = result1.codes.map((c) => c.code);
  const codes2 = result2.codes.map((c) => c.code);
  assert.deepStrictEqual(codes2, codes1, "code ordering differs between runs");
});

// ── Summary ──────────────────────────────────────────────
console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
