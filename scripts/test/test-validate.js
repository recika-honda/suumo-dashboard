/**
 * test-validate.js — skills/forrent/validate.js の純粋関数テスト
 *
 * resolvePropertyTypeCode / appliesToMatches の挙動を確認する。
 * validateBySpec / checkRequiredFromReinsData は既に test-spec-validator.js が
 * カバーしているのでここでは触らない。
 */

const assert = require("assert");
const {
  resolvePropertyTypeCode,
  appliesToMatches,
} = require("../../skills/forrent/validate");

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

// ── resolvePropertyTypeCode ────────────────────────────────
check("resolvePropertyTypeCode: 完全一致 マンション → 01", () => {
  assert.strictEqual(resolvePropertyTypeCode("マンション"), "01");
});
check("resolvePropertyTypeCode: 完全一致 アパート → 02", () => {
  assert.strictEqual(resolvePropertyTypeCode("アパート"), "02");
});
check("resolvePropertyTypeCode: 完全一致 一戸建て → 11", () => {
  assert.strictEqual(resolvePropertyTypeCode("一戸建て"), "11");
});
check("resolvePropertyTypeCode: 略形 戸建 → 11", () => {
  assert.strictEqual(resolvePropertyTypeCode("戸建"), "11");
});
check("resolvePropertyTypeCode: 略形 タウン → 16", () => {
  assert.strictEqual(resolvePropertyTypeCode("タウン"), "16");
});
check("resolvePropertyTypeCode: 部分一致 タウンハウス系 → 16", () => {
  assert.strictEqual(resolvePropertyTypeCode("テラスハウス（賃貸）"), "16");
});
check("resolvePropertyTypeCode: 部分一致 ＭＳ → 01 (全角MS)", () => {
  assert.strictEqual(resolvePropertyTypeCode("ＭＳ"), "01");
});
check("resolvePropertyTypeCode: trim される", () => {
  assert.strictEqual(resolvePropertyTypeCode("  マンション  "), "01");
});
check("resolvePropertyTypeCode: null → null", () => {
  assert.strictEqual(resolvePropertyTypeCode(null), null);
});
check("resolvePropertyTypeCode: undefined → null", () => {
  assert.strictEqual(resolvePropertyTypeCode(undefined), null);
});
check("resolvePropertyTypeCode: 空文字 → null", () => {
  assert.strictEqual(resolvePropertyTypeCode(""), null);
});
check("resolvePropertyTypeCode: 未知 → null", () => {
  assert.strictEqual(resolvePropertyTypeCode("謎の物件種目"), null);
});

// ── appliesToMatches ────────────────────────────────────────
check("appliesToMatches: ALL は常に true", () => {
  assert.strictEqual(appliesToMatches("ALL", {}), true);
  assert.strictEqual(appliesToMatches("ALL", { 物件種目: "マンション" }), true);
});
check("appliesToMatches: 物件種目 マンション → true", () => {
  assert.strictEqual(
    appliesToMatches({ 物件種目: ["マンション", "アパート"] }, { 物件種目: "マンション" }),
    true
  );
});
check("appliesToMatches: 物件種目 戸建 (リストに無い) → false", () => {
  assert.strictEqual(
    appliesToMatches({ 物件種目: ["マンション", "アパート"] }, { 物件種目: "戸建" }),
    false
  );
});
check("appliesToMatches: 複数キー AND 合成", () => {
  const cond = { 物件種目: ["マンション"], 取引態様: ["仲介"] };
  assert.strictEqual(appliesToMatches(cond, { 物件種目: "マンション", 取引態様: "仲介" }), true);
  assert.strictEqual(appliesToMatches(cond, { 物件種目: "マンション", 取引態様: "売主" }), false);
});
check("appliesToMatches: 不正な構造 → false (警告のみ)", () => {
  // suppress console.warn for clean test output
  const orig = console.warn;
  console.warn = () => {};
  try {
    assert.strictEqual(appliesToMatches(null, {}), false);
    assert.strictEqual(appliesToMatches({ 物件種目: "not-array" }, {}), false);
  } finally {
    console.warn = orig;
  }
});

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
