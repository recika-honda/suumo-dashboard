/**
 * test-image-fallback.js — skills/image-ai.js#pickFallbackCategory のテスト
 *
 * 検証対象:
 *   - Vision が null を返した時の fallback カテゴリ選択
 *   - 04 (間取り図) / 05 (建物外観) は不可逆カテゴリのため fallback 候補から除外
 *   - 優先順: 5pt 安全枠 → 21 (その他) → 04/05 以外の先頭 → null
 *
 * 背景: 2026-05-13 に Vision がシンク写真を 04 (間取り図) に誤分類した bug
 *       (もしくは Vision が null → fallback で 5pt の 04 を強制充填した可能性)。
 *       不可逆カテゴリ (04/05) は確信が持てる時のみ採用すべきという原則を
 *       fallback ロジックに反映させたもの。
 */

const assert = require("assert");
const { pickFallbackCategory, IRREVERSIBLE_CATS, SUUMO_CATEGORIES } = require("../../skills/image-ai");

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

// ── IRREVERSIBLE_CATS 定義の整合性 ──────────────────────────
check("IRREVERSIBLE_CATS contains 04 and 05", () => {
  assert.strictEqual(IRREVERSIBLE_CATS.has("04"), true);
  assert.strictEqual(IRREVERSIBLE_CATS.has("05"), true);
  assert.strictEqual(IRREVERSIBLE_CATS.size, 2);
});

// ── pickFallbackCategory: 04/05 除外 ───────────────────────
check("pickFallbackCategory: all categories available → 5pt safe (01)", () => {
  // 04/05 を含む全カテゴリが available の時、04/05 はスキップして 01 が返る
  const result = pickFallbackCategory(SUUMO_CATEGORIES);
  assert.strictEqual(result, "01");
});

check("pickFallbackCategory: only 5pt categories (01-05) → 01", () => {
  const available = SUUMO_CATEGORIES.filter((c) => c.score === 5);
  // 01,02,03,04,05 の中から 04/05 を除外 → 01 が最初の 5pt 安全枠
  const result = pickFallbackCategory(available);
  assert.strictEqual(result, "01");
});

check("pickFallbackCategory: only 04 and 05 → null (不可逆カテゴリだけは選ばない)", () => {
  const available = SUUMO_CATEGORIES.filter((c) => c.id === "04" || c.id === "05");
  const result = pickFallbackCategory(available);
  assert.strictEqual(result, null);
});

check("pickFallbackCategory: 04 + 05 + 21 → 21 (safe fallback)", () => {
  const available = SUUMO_CATEGORIES.filter((c) => c.id === "04" || c.id === "05" || c.id === "21");
  const result = pickFallbackCategory(available);
  assert.strictEqual(result, "21");
});

check("pickFallbackCategory: only 21 → 21", () => {
  const available = SUUMO_CATEGORIES.filter((c) => c.id === "21");
  const result = pickFallbackCategory(available);
  assert.strictEqual(result, "21");
});

check("pickFallbackCategory: only 1pt categories (no 5pt, no 21) → safeFirst", () => {
  // 06 (その他部屋), 07 (トイレ), 08 (洗面) など 1pt のみ → 06 が先頭
  const available = SUUMO_CATEGORIES.filter((c) => c.score === 1 && c.id !== "21");
  const result = pickFallbackCategory(available);
  assert.strictEqual(result, "06");
});

check("pickFallbackCategory: empty array → null", () => {
  const result = pickFallbackCategory([]);
  assert.strictEqual(result, null);
});

check("pickFallbackCategory: 5pt safe (02 only) + 21 → 02 (5pt 優先)", () => {
  // 02 (キッチン) + 21 (その他) → 02 が先 (5pt 安全枠優先)
  const available = SUUMO_CATEGORIES.filter((c) => c.id === "02" || c.id === "21");
  const result = pickFallbackCategory(available);
  assert.strictEqual(result, "02");
});

// ── サマリー ────────────────────────────────────────────────
console.log(`\n${pass} pass, ${fail} fail`);
if (fail > 0) process.exit(1);
