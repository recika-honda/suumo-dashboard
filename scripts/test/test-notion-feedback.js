/**
 * test-notion-feedback.js — scripts/lib/notion-feedback.js のテスト
 *
 * 検証対象:
 *   - categorizeError: status / errors / reason から失敗カテゴリへの分類
 *   - buildReasonText: result から Notion Rich text 用テキスト構築
 *   - buildFeedbackProperties: Notion properties payload 形状
 */

const assert = require("assert");
const {
  CATEGORY,
  categorizeError,
  buildReasonText,
  buildFeedbackProperties,
} = require("../lib/notion-feedback");

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

// ── categorizeError ───────────────────────────────────────
check("categorizeError: NOT_FOUND → データ不備", () => {
  assert.strictEqual(categorizeError({ status: "NOT_FOUND" }), CATEGORY.DATA);
});
check("categorizeError: REG_FAIL with reason (no errors) → データ不備", () => {
  assert.strictEqual(
    categorizeError({ status: "REG_FAIL", reason: "REINSデータに建物名がありません" }),
    CATEGORY.DATA
  );
});
check("categorizeError: REG_FAIL with errors[] → forrent 検証失敗", () => {
  assert.strictEqual(
    categorizeError({ status: "REG_FAIL", errors: ["桁数チェック: 賃料"] }),
    CATEGORY.FORRENT
  );
});
check("categorizeError: TIMEOUT → タイムアウト", () => {
  assert.strictEqual(categorizeError({ status: "TIMEOUT" }), CATEGORY.TIMEOUT);
});
check("categorizeError: ERROR → 想定外エラー", () => {
  assert.strictEqual(categorizeError({ status: "ERROR" }), CATEGORY.ERROR);
});
check("categorizeError: SUCCESS → null (書き戻し不要)", () => {
  assert.strictEqual(categorizeError({ status: "SUCCESS" }), null);
});
check("categorizeError: FORRENT_LOGIN_FAIL → null (transient)", () => {
  assert.strictEqual(categorizeError({ status: "FORRENT_LOGIN_FAIL" }), null);
});
check("categorizeError: IMAGE_INSUFFICIENT → データ不備", () => {
  assert.strictEqual(
    categorizeError({ status: "IMAGE_INSUFFICIENT", rawCount: 0 }),
    CATEGORY.DATA
  );
});
check("categorizeError: null/undefined → null", () => {
  assert.strictEqual(categorizeError(null), null);
  assert.strictEqual(categorizeError(undefined), null);
  assert.strictEqual(categorizeError({}), null);
});

// ── buildReasonText ───────────────────────────────────────
check("buildReasonText: NOT_FOUND は固定文言", () => {
  const t = buildReasonText({ status: "NOT_FOUND" });
  assert.ok(t.includes("REINS"));
  assert.ok(t.length > 0);
});
check("buildReasonText: REG_FAIL with reason → reason そのまま", () => {
  const t = buildReasonText({ status: "REG_FAIL", reason: "建物名がありません" });
  assert.strictEqual(t, "建物名がありません");
});
check("buildReasonText: REG_FAIL with errors → 行頭・連結", () => {
  const t = buildReasonText({
    status: "REG_FAIL",
    errors: ["桁数チェック: 賃料", "必須項目: 住所"],
  });
  assert.ok(t.includes("・桁数チェック: 賃料"));
  assert.ok(t.includes("・必須項目: 住所"));
});
check("buildReasonText: errors 4 件以上 → 3 件 + 件数表記", () => {
  const t = buildReasonText({
    status: "REG_FAIL",
    errors: ["a", "b", "c", "d", "e"],
  });
  assert.ok(t.includes("・a"));
  assert.ok(t.includes("・b"));
  assert.ok(t.includes("・c"));
  assert.ok(t.includes("(他 2 件)"));
  assert.ok(!t.includes("・d"));
});
check("buildReasonText: TIMEOUT は error 文 or 固定", () => {
  assert.strictEqual(buildReasonText({ status: "TIMEOUT", error: "15分超過" }), "15分超過");
  assert.ok(buildReasonText({ status: "TIMEOUT" }).includes("15"));
});
check("buildReasonText: 1500 char 上限で clamp", () => {
  const longErr = "a".repeat(3000);
  const t = buildReasonText({ status: "ERROR", error: longErr });
  assert.ok(t.length <= 1500);
});
check("buildReasonText: IMAGE_INSUFFICIENT → rawCount を含む", () => {
  const t = buildReasonText({ status: "IMAGE_INSUFFICIENT", rawCount: 2 });
  assert.ok(t.includes("REINS"));
  assert.ok(t.includes("2 枚"));
  assert.ok(t.includes("素材依頼"));
});
check("buildReasonText: IMAGE_INSUFFICIENT rawCount 欠落 → '?' で埋める", () => {
  const t = buildReasonText({ status: "IMAGE_INSUFFICIENT" });
  assert.ok(t.includes("? 枚"));
});

// ── buildFeedbackProperties ───────────────────────────────
check("buildFeedbackProperties: SUCCESS → {}", () => {
  assert.deepStrictEqual(buildFeedbackProperties({ status: "SUCCESS" }), {});
});
check("buildFeedbackProperties: REG_FAIL with errors → 失敗カテゴリ + 入稿失敗理由", () => {
  const p = buildFeedbackProperties({
    status: "REG_FAIL",
    errors: ["bukkenCatch: 31 char (max 30)"],
  });
  assert.ok(p["失敗カテゴリ"]);
  assert.strictEqual(p["失敗カテゴリ"].select.name, CATEGORY.FORRENT);
  assert.ok(p["入稿失敗理由"]);
  assert.strictEqual(p["入稿失敗理由"].rich_text[0].text.content.includes("bukkenCatch"), true);
});
check("buildFeedbackProperties: NOT_FOUND → データ不備 + 固定 reason", () => {
  const p = buildFeedbackProperties({ status: "NOT_FOUND" });
  assert.strictEqual(p["失敗カテゴリ"].select.name, CATEGORY.DATA);
  assert.ok(p["入稿失敗理由"].rich_text[0].text.content.length > 0);
});
check("buildFeedbackProperties: IMAGE_INSUFFICIENT → データ不備 + rawCount 入り reason", () => {
  const p = buildFeedbackProperties({ status: "IMAGE_INSUFFICIENT", rawCount: 0 });
  assert.strictEqual(p["失敗カテゴリ"].select.name, CATEGORY.DATA);
  const reason = p["入稿失敗理由"].rich_text[0].text.content;
  assert.ok(reason.includes("0 枚"));
});

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
