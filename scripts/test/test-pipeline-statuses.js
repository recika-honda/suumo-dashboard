/**
 * test-pipeline-statuses.js — scripts/pipeline-statuses.js のテスト
 *
 * 検証対象:
 *   - resolveNotionStatus: result.status / escalated → Notion Status カラム遷移先
 *   - RESULT_STATUSES: 全 status の列挙が網羅されているか
 *
 * Phase 2 (2026-05-15): IMAGE_INSUFFICIENT → 画像欠落 を新規追加。
 */

const assert = require("assert");
const { RESULT_STATUSES, resolveNotionStatus } = require("../pipeline-statuses");

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

// ── RESULT_STATUSES 列挙 ───────────────────────────────────
check("RESULT_STATUSES: SUCCESS / NOT_FOUND / REG_FAIL を含む (regression guard)", () => {
  for (const s of ["SUCCESS", "NOT_FOUND", "REG_FAIL", "FORRENT_LOGIN_FAIL", "TIMEOUT", "ERROR"]) {
    assert.ok(RESULT_STATUSES.includes(s), `${s} missing`);
  }
});
check("RESULT_STATUSES: IMAGE_INSUFFICIENT (Phase 2)", () => {
  assert.ok(RESULT_STATUSES.includes("IMAGE_INSUFFICIENT"));
});

// ── resolveNotionStatus: SUCCESS path ──────────────────────
check("resolveNotionStatus: SUCCESS + escalated:true → 掲載指示済み", () => {
  assert.strictEqual(resolveNotionStatus({ status: "SUCCESS", escalated: true }), "掲載指示済み");
});
check("resolveNotionStatus: SUCCESS + escalated:false → 掲載保留", () => {
  assert.strictEqual(resolveNotionStatus({ status: "SUCCESS", escalated: false }), "掲載保留");
});
check("resolveNotionStatus: SUCCESS (no escalated key) → 掲載保留 (default)", () => {
  assert.strictEqual(resolveNotionStatus({ status: "SUCCESS" }), "掲載保留");
});

// ── resolveNotionStatus: 失敗系 ────────────────────────────
check("resolveNotionStatus: REG_FAIL → 入稿失敗", () => {
  assert.strictEqual(resolveNotionStatus({ status: "REG_FAIL" }), "入稿失敗");
});
check("resolveNotionStatus: NOT_FOUND → 入稿失敗", () => {
  assert.strictEqual(resolveNotionStatus({ status: "NOT_FOUND" }), "入稿失敗");
});
check("resolveNotionStatus: IMAGE_INSUFFICIENT → 画像欠落 (Phase 2)", () => {
  assert.strictEqual(resolveNotionStatus({ status: "IMAGE_INSUFFICIENT", rawCount: 0 }), "画像欠落");
});
check("resolveNotionStatus: IMAGE_INSUFFICIENT (string 引数でも) → 画像欠落", () => {
  assert.strictEqual(resolveNotionStatus("IMAGE_INSUFFICIENT"), "画像欠落");
});

// ── resolveNotionStatus: transient ─────────────────────────
check("resolveNotionStatus: FORRENT_LOGIN_FAIL → null (広告待ち維持)", () => {
  assert.strictEqual(resolveNotionStatus({ status: "FORRENT_LOGIN_FAIL" }), null);
});
check("resolveNotionStatus: TIMEOUT → null", () => {
  assert.strictEqual(resolveNotionStatus({ status: "TIMEOUT" }), null);
});
check("resolveNotionStatus: ERROR → null", () => {
  assert.strictEqual(resolveNotionStatus({ status: "ERROR" }), null);
});

// ── 後方互換 + 異常系 ─────────────────────────────────────
check("resolveNotionStatus: string 引数 'SUCCESS' → 掲載保留 (escalated 不明)", () => {
  assert.strictEqual(resolveNotionStatus("SUCCESS"), "掲載保留");
});
check("resolveNotionStatus: 未知 status は null + warn (テストは null だけ確認)", () => {
  // suppress console.warn for this case
  const origWarn = console.warn;
  console.warn = () => {};
  try {
    assert.strictEqual(resolveNotionStatus("UNKNOWN_STATUS"), null);
  } finally {
    console.warn = origWarn;
  }
});

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
