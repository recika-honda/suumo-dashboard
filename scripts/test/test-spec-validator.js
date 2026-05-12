#!/usr/bin/env node
/**
 * test-spec-validator.js — config/forrent-required.spec.json + validateBySpec の単体テスト
 *
 * 実行: `bun run scripts/test/test-spec-validator.js` または `node scripts/test/test-spec-validator.js`
 */

const path = require("path");
const fs = require("fs");

const envPath = path.join(__dirname, "..", "..", ".env.local");
if (fs.existsSync(envPath)) {
  require("dotenv").config({ path: envPath });
}

const forrent = require("../../skills/forrent");

const tests = [
  {
    name: "建物名 empty → REG_FAIL",
    data: { 建物名: "", 物件種目: "マンション", 部屋番号: "101" },
    expectOk: false,
    expectField: "建物名",
    expectReason: "REINSデータに建物名がありません",
  },
  {
    name: "建物名 whitespace → REG_FAIL (trim+falsy)",
    data: { 建物名: "   ", 物件種目: "マンション", 部屋番号: "101" },
    expectOk: false,
    expectField: "建物名",
  },
  {
    name: "建物名 null → REG_FAIL",
    data: { 建物名: null, 物件種目: "マンション", 部屋番号: "101" },
    expectOk: false,
    expectField: "建物名",
  },
  {
    name: "建物名 undefined → REG_FAIL",
    data: { 物件種目: "マンション", 部屋番号: "101" },
    expectOk: false,
    expectField: "建物名",
  },
  {
    name: "マンション 部屋番号 missing → REG_FAIL",
    data: { 建物名: "テスト", 物件種目: "マンション" },
    expectOk: false,
    expectField: "部屋番号",
    expectReason: "REINSデータに部屋番号がありません",
  },
  {
    name: "アパート 部屋番号 missing → REG_FAIL",
    data: { 建物名: "テスト", 物件種目: "アパート" },
    expectOk: false,
    expectField: "部屋番号",
  },
  {
    name: "戸建 部屋番号 missing → OK (appliesTo フィルタ)",
    data: { 建物名: "テスト", 物件種目: "一戸建て" },
    expectOk: true,
  },
  {
    name: "タウンハウス 部屋番号 missing → OK",
    data: { 建物名: "テスト", 物件種目: "テラス・タウンハウス" },
    expectOk: true,
  },
  {
    name: "マンション 使用部分面積 missing → REG_FAIL",
    data: { 建物名: "テスト", 物件種目: "マンション", 部屋番号: "101" },
    expectOk: false,
    expectField: "使用部分面積",
    expectReason: "REINSデータに面積（使用部分面積）がありません",
  },
  {
    name: "戸建 使用部分面積 missing → OK (appliesTo フィルタ)",
    data: { 建物名: "テスト", 物件種目: "一戸建て" },
    expectOk: true,
  },
  {
    name: "全 field 揃う → OK",
    data: { 建物名: "テストマンション", 物件種目: "マンション", 部屋番号: "101", 使用部分面積: "30.5㎡" },
    expectOk: true,
  },
];

let pass = 0;
let fail = 0;
const failures = [];

for (const t of tests) {
  const result = forrent.checkRequiredFromReinsData(t.data);
  const errors = [];
  if (result.ok !== t.expectOk) {
    errors.push(`expected ok=${t.expectOk}, got ok=${result.ok}`);
  }
  if (!t.expectOk && t.expectField && result.missingField !== t.expectField) {
    errors.push(`expected missingField=${t.expectField}, got ${result.missingField}`);
  }
  if (!t.expectOk && t.expectReason && result.reason !== t.expectReason) {
    errors.push(`expected reason=${t.expectReason}, got ${result.reason}`);
  }
  if (errors.length === 0) {
    pass++;
    console.log(`PASS: ${t.name}`);
  } else {
    fail++;
    failures.push({ test: t.name, errors });
    console.log(`FAIL: ${t.name}`);
    for (const e of errors) console.log(`  - ${e}`);
  }
}

console.log(`\nTotal: ${pass}/${pass + fail}`);
if (fail > 0) {
  console.error("\nFailures:");
  for (const f of failures) console.error(`  - ${f.test}: ${f.errors.join("; ")}`);
  process.exit(1);
}
