/**
 * test-capacity-fallback-message.js
 *
 * Verifies formatCapacityFallbackMessage in skills/score-escalation.js.
 *
 * Test perspectives: happy path, boundary values (score=0, missing field),
 * config fallback paths (no slackCfg, custom string template).
 *
 * 5 cases total.
 */

"use strict";

const test = require("node:test");
const assert = require("node:assert");

const {
  formatCapacityFallbackMessage,
  clearCache,
} = require("../../skills/score-escalation");

// Case 1: all fields present — full substitution
test("全フィールド埋め: template 全置換が正しく完了する", () => {
  const out = formatCapacityFallbackMessage(
    { propertyName: "信濃町Ⅱ番館", kishaCode: "fng100139151756", score: 41, threshold: 34 },
    { capacityFallbackTemplate:
        "[capacity fallback] 掲載指示できず保留にしました\n物件名: {propertyName}\n貴社物件コード: {kishaCode}\n名寄せスコア: {score} (閾値 {threshold} 以上だが forrent 掲載枠フル)" }
  );
  assert.ok(out.includes("信濃町Ⅱ番館"), "propertyName が出力に含まれる");
  assert.ok(out.includes("fng100139151756"), "kishaCode が出力に含まれる");
  assert.ok(out.includes("41"), "score が出力に含まれる");
  assert.ok(out.includes("34"), "threshold が出力に含まれる");
  assert.ok(out.includes("掲載指示できず保留にしました"), "固定文言が含まれる");
});

// Case 2: score = 0 — falsy value must not be suppressed
test("score 0: falsy だが \"0\" として埋まる", () => {
  const out = formatCapacityFallbackMessage(
    { propertyName: "X", kishaCode: "fngY", score: 0, threshold: 34 },
    { capacityFallbackTemplate: "名寄せスコア: {score}" }
  );
  assert.ok(out.includes("名寄せスコア: 0"), "score=0 が '0' として出力に含まれる");
});

// Case 3: propertyName missing — placeholder replaced with empty string, no throw
test("propertyName 欠落: {propertyName} が空文字に置換され throw しない", () => {
  let out;
  assert.doesNotThrow(() => {
    out = formatCapacityFallbackMessage(
      { kishaCode: "fngZ", score: 35, threshold: 34 },
      { capacityFallbackTemplate: "物件名: {propertyName}\nコード: {kishaCode}" }
    );
  });
  assert.ok(out.includes("物件名: \n"), "propertyName が空文字に置換されている");
});

// Case 4: no slackCfg argument — default template used via getEscalationConfig()
test("slackCfg 引数なし: default template から掲載指示できず文言が含まれる", () => {
  clearCache();
  const out = formatCapacityFallbackMessage({
    propertyName: "A物件",
    kishaCode: "fngB",
    score: 40,
    threshold: 34,
  });
  assert.ok(out.includes("掲載指示できず保留にしました"), "default template の固定文言が含まれる");
});

// Case 5: slackCfg as string — custom template takes precedence
test("slackCfg を文字列で渡す: カスタム template が優先される", () => {
  const out = formatCapacityFallbackMessage(
    { propertyName: "X", kishaCode: "Y", score: 1, threshold: 2 },
    "custom: {propertyName} {kishaCode} {score} {threshold}"
  );
  assert.strictEqual(out, "custom: X Y 1 2");
});
