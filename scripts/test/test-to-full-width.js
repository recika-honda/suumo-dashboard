#!/usr/bin/env node
/**
 * test-to-full-width.js — toFullWidth の単体テスト
 *
 * forrent.jp の「ほか初期費用詳細」「その他諸費用詳細」など、
 * 半角カナ・半角数字・半角記号が禁止文字としてバリデーション弾きされるフィールド
 * 向けの正規化関数。
 *
 * 実 incident (2026-05-15):
 *   - 100139127191 Phase 3a end-to-end smoke で REG_FAIL
 *     "ほか初期費用詳細に禁止文字が含まれています(半角カナ、記号等)"
 *     原因: costItems.toLocaleString() が "70,840" を返したため半角混入
 *   - 100139119717 前回バッチ同症状
 */

const assert = require("assert");
const { toFullWidth } = require("../../skills/forrent");

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

// ── 半角 ASCII → 全角 ──────────────────────────────────────
check("半角数字 → 全角数字", () => {
  assert.strictEqual(toFullWidth("70840"), "７０８４０");
});
check("半角カンマ → 全角カンマ", () => {
  assert.strictEqual(toFullWidth(","), "，");
});
check("半角コロン → 全角コロン", () => {
  assert.strictEqual(toFullWidth(":"), "：");
});
check("半角ピリオド → 全角ピリオド", () => {
  assert.strictEqual(toFullWidth("."), "．");
});
check("半角英字 → 全角英字", () => {
  assert.strictEqual(toFullWidth("abcABC"), "ａｂｃＡＢＣ");
});
check("半角スペース → 全角スペース", () => {
  assert.strictEqual(toFullWidth(" "), "　");
});

// ── 実 incident 由来の hard case ──────────────────────────
check("real case: クリーニング代70,840円 (127191 REG_FAIL の元) → 全部全角", () => {
  const out = toFullWidth("クリーニング代70,840円");
  // 半角数字・半角カンマが残っていないこと
  assert.ok(!/[0-9,]/.test(out), `半角が残存: ${out}`);
  assert.ok(out.includes("クリーニング代"));
  assert.ok(out.includes("円"));
  assert.ok(out.includes("，") || out.includes("、"));
});
check("real case: 鍵交換代22,000円、消毒代11,000円 (複合) → 半角文字なし", () => {
  const out = toFullWidth("鍵交換代22,000円、消毒代11,000円");
  assert.ok(!/[\x21-\x7E]/.test(out), `半角 ASCII が残存: ${out}`);
});

// ── 半角カナ → 全角カナ (forrent 禁止文字の典型) ─────────────
check("半角カナ (清音) → 全角カナ", () => {
  assert.strictEqual(toFullWidth("ｱｲｳｴｵ"), "アイウエオ");
});
check("半角カナ (濁点) → 全角カナ (1 char に縮約)", () => {
  // ｶﾞ (2 chars) → ガ (1 char)
  assert.strictEqual(toFullWidth("ｶﾞｷﾞ"), "ガギ");
});
check("半角カナ (半濁点) → 全角カナ", () => {
  assert.strictEqual(toFullWidth("ﾊﾟﾋﾟ"), "パピ");
});
check("半角カナ + 半角数字 混合 → 全部全角", () => {
  const out = toFullWidth("ｸﾘｰﾆﾝｸﾞ70840");
  assert.ok(!/[a-zA-Z0-9ｱ-ﾝ]/.test(out), `半角残存: ${out}`);
});

// ── 既に全角 / 漢字 / ひらがな → 不変 ───────────────────────
check("既に全角の文字列 → 変化なし (idempotent)", () => {
  const input = "鍵交換代７０，８４０円";
  assert.strictEqual(toFullWidth(input), input);
});
check("漢字 → 不変", () => {
  assert.strictEqual(toFullWidth("家賃管理費"), "家賃管理費");
});
check("ひらがな → 不変", () => {
  assert.strictEqual(toFullWidth("ひらがな"), "ひらがな");
});

// ── エッジケース ─────────────────────────────────────────
check("null → 空文字", () => {
  assert.strictEqual(toFullWidth(null), "");
});
check("undefined → 空文字", () => {
  assert.strictEqual(toFullWidth(undefined), "");
});
check("空文字 → 空文字", () => {
  assert.strictEqual(toFullWidth(""), "");
});

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
