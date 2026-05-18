/**
 * test-capacity-fallback-detection.js
 *
 * Verifies isCapacityExceededOnly in skills/forrent/register.js.
 *
 * Test perspectives:
 *   - Happy path: all errors are capacity-exceeded messages (1, 2, 8)
 *   - Error path: mixed errors, null, non-array, non-string element (3, 5, 6, 7)
 *   - Boundary values: empty array (4)
 *
 * 8 cases total.
 */

"use strict";

const test = require("node:test");
const assert = require("node:assert");

const { isCapacityExceededOnly } = require("../../skills/forrent/register");

// Case 1: 3 patterns exact match (production errors example) -> true
test("3 種類の掲載枠超過メッセージのみ: true を返す", () => {
  const errors = [
    "ネット掲載可能件数を超えているため、掲載指示をOFFにしました。",
    "スマピク掲載可能件数を超えているため、掲載指示をOFFにしました。",
    "店舗案内ピックアップ掲載可能件数を超えているため、掲載指示をOFFにしました。",
  ];
  assert.strictEqual(isCapacityExceededOnly(errors), true);
});

// Case 2: only ネット error -> true (subset is also pure capacity)
test("ネット掲載枠超過のみ 1 件: true を返す", () => {
  const errors = [
    "ネット掲載可能件数を超えているため、掲載指示をOFFにしました。",
  ];
  assert.strictEqual(isCapacityExceededOnly(errors), true);
});

// Case 3: capacity + real error mixed -> false
test("掲載枠超過 + 本物エラー混在: false を返す", () => {
  const errors = [
    "ネット掲載可能件数を超えているため、掲載指示をOFFにしました。",
    "ほか初期費用詳細に禁止文字が含まれています(半角カナ、記号等)",
  ];
  assert.strictEqual(isCapacityExceededOnly(errors), false);
});

// Case 4: empty array -> false
test("空配列: false を返す", () => {
  assert.strictEqual(isCapacityExceededOnly([]), false);
});

// Case 5: null -> false
test("null: false を返す", () => {
  assert.strictEqual(isCapacityExceededOnly(null), false);
});

// Case 6: non-array (string) -> false
test("非配列 (文字列): false を返す", () => {
  assert.strictEqual(isCapacityExceededOnly("not-array"), false);
});

// Case 7: non-string element in array -> false
test("配列要素に非文字列 (数値) が含まれる: false を返す", () => {
  const errors = [123, "ネット掲載可能件数を超えているため、掲載指示をOFFにしました。"];
  assert.strictEqual(isCapacityExceededOnly(errors), false);
});

// Case 8: partial-match phrase tolerance -> true (regex 部分一致で文言改定に耐性あり)
test("前後に余分な文字を含む掲載枠超過メッセージ: 部分一致で true を返す", () => {
  const errors = [
    "[error] ネット掲載可能件数を超えているため (revised wording)",
  ];
  assert.strictEqual(isCapacityExceededOnly(errors), true);
});
