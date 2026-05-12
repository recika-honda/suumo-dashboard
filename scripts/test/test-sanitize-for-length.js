#!/usr/bin/env node
/**
 * test-sanitize-for-length.js — sanitizeForLength の単体テスト
 *
 * 目的: forrent.jp の文字数制限フィールド向け sanitizer が
 *   - 改行 (LF/CRLF) を全角スペースに置換し、
 *   - その後 slice(0, maxLen) する
 *   - null/undefined/非string/maxLen=0 をすべて空文字に正規化する
 * ことを保証する。
 *
 * 重要: HTML form 送信時に textarea の \n は \r\n (2 chars) に展開され、
 *       forrent サーバ側の文字数バリデータが展開後の長さで判定するため、
 *       slice 前に改行を 1 char (全角スペース) に置換しないと
 *       N 文字 slice しても N+1 chars で REG_FAIL する anti-pattern が発生する。
 *
 * 実行: `bun run scripts/test/test-sanitize-for-length.js`
 */

const { sanitizeForLength } = require("../../skills/forrent");

const tests = [
  {
    name: "plain string within limit → unchanged",
    input: ["abcdefghij", 30],
    expect: "abcdefghij",
  },
  {
    name: "plain string over limit → sliced",
    input: ["0123456789ABCDEFGHIJ", 10],
    expect: "0123456789",
  },
  {
    name: "LF only → replaced with full-width space",
    input: ["hello\nworld", 30],
    expect: "hello　world",
  },
  {
    name: "CRLF → replaced with full-width space (single char)",
    input: ["hello\r\nworld", 30],
    expect: "hello　world",
  },
  {
    name: "multiple consecutive newlines collapse to single full-width space",
    input: ["a\n\n\nb", 30],
    expect: "a　b",
  },
  {
    name: "null → empty string",
    input: [null, 30],
    expect: "",
  },
  {
    name: "undefined → empty string",
    input: [undefined, 30],
    expect: "",
  },
  {
    name: "number → empty string (only string accepted)",
    input: [123, 30],
    expect: "",
  },
  {
    name: "object → empty string",
    input: [{ foo: "bar" }, 30],
    expect: "",
  },
  {
    name: "maxLen=0 → empty string (no throw)",
    input: ["anything", 0],
    expect: "",
  },
  {
    name: "maxLen=undefined → empty string (no throw)",
    input: ["anything", undefined],
    expect: "",
  },
  {
    name: "CRLF anti-pattern: 30-char window with embedded newline still fits in 30 chars after sanitize",
    input: ["A".repeat(28) + "\n" + "B", 30],
    expect: "A".repeat(28) + "　" + "B",
  },
  {
    name: "CRLF anti-pattern: oversize string with newline truncated to exactly maxLen",
    input: ["A".repeat(50) + "\n" + "B".repeat(50), 30],
    expect: "A".repeat(30),
  },
  {
    name: "Japanese full-width text within limit unchanged",
    input: ["お電話番号記載のお客様限定", 30],
    expect: "お電話番号記載のお客様限定",
  },
];

let pass = 0;
let fail = 0;
const failures = [];

for (const t of tests) {
  const result = sanitizeForLength(...t.input);
  if (result === t.expect) {
    pass++;
    console.log(`PASS: ${t.name}`);
  } else {
    fail++;
    failures.push({ test: t.name, expected: t.expect, got: result });
    console.log(`FAIL: ${t.name}`);
    console.log(`  expected: ${JSON.stringify(t.expect)}`);
    console.log(`  got:      ${JSON.stringify(result)}`);
  }
}

console.log(`\nTotal: ${pass}/${pass + fail}`);
if (fail > 0) {
  console.error("\nFailures:");
  for (const f of failures) {
    console.error(`  - ${f.test}`);
    console.error(`    expected: ${JSON.stringify(f.expected)}`);
    console.error(`    got:      ${JSON.stringify(f.got)}`);
  }
  process.exit(1);
}
