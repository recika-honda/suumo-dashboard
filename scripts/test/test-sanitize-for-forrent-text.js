#!/usr/bin/env node
/**
 * test-sanitize-for-forrent-text.js — sanitizeForForrentText の単体テスト
 *
 * forrent.jp の「半角カナ・半角英数字・半角記号禁止」かつ「N 文字以内」の
 * text フィールド (catchCopy / freeComment / netCatch / netFreeMemo 等) 向け
 * 多段 sanitizer。NFKD + strip diacritics + toFullWidth + 改行置換 + length cap。
 *
 * 実 incident:
 *   - 100139121297 (2026-05-14) "フリーコメントには、100文字以内で入力してください"
 *     原因: text-ai が "Grandé Nakaochai" を生成 → "é" が HTML entity "&#233;" (8 chars)
 *     に展開されて 100 文字 slice しても サーバ側で N+5 chars になり overflow。
 *     合わせて 「禁止文字 (半角英数字)」も発火していた。
 */

const assert = require("assert");
const { sanitizeForForrentText } = require("../../skills/forrent");

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

// ── Real incident reproduction ────────────────────────────
check("real case: 'Grandé' (NFC) → 'Ｇｒａｎｄｅ' (diacritic 除去 + full-width)", () => {
  // The é here is U+00E9 (precomposed). NFKD decomposes to e + U+0301 combining acute.
  // We strip combining marks then full-width.
  const out = sanitizeForForrentText("Grandé", 100);
  assert.strictEqual(out, "Ｇｒａｎｄｅ");
});
check("real case: 121297 freeComment 151chars w/ Grandé → 100 chars all full-width, no entity expansion", () => {
  const input = "東京都新宿区中落合に位置する『Grandé Nakaochai』は、2022年8月に築された新しい物件です。西武新宿線 中井駅から徒歩5分でアクセス良好です。21.63㎡の広さのあるワンルームは、お一人暮らしに最適です。東向きのバルコニーからは朝日が差し込み、明るい気持ちで毎日をお過ごしいただけます。";
  const out = sanitizeForForrentText(input, 100);
  assert.strictEqual(out.length, 100, `expected 100 chars, got ${out.length}`);
  // No half-width ASCII left
  assert.ok(!/[\x21-\x7E]/.test(out), `half-width ASCII remains: ${out}`);
  // No Latin combining marks
  assert.ok(!/[̀-ͯ]/.test(out), `Latin combining marks remain: ${out}`);
  // No Japanese combining marks (U+3099 dakuten / U+309A handakuten)
  assert.ok(!out.includes("゙") && !out.includes("゚"), `Japanese combining marks remain: ${out}`);
  // No precomposed "é"
  assert.ok(!out.includes("é"), `precomposed é remains: ${out}`);
});

check("real case: 127191 freeComment w/ ヴィヴェール → ヴ 保持 (NFC recompose)", () => {
  // 127191 で発生: NFKD で ヴ → ウ+U+3099 (濁点) に分解、Latin diacritics 用の strip
  // は通らず、HTML entity "&#12441;" に展開されてサーバ側で 100 → 155 char overflow
  // + 禁止文字エラー。NFC recompose 修正で ヴ 保持。
  const input = "東京都世田谷区北沢の『ヴィヴェール笹塚』は、京王線の笹塚駅から徒歩6分の好立地です。面積46.58㎡の1室LDKは、2012年築で快適な居住空間を提供します。";
  const out = sanitizeForForrentText(input, 100);
  // 100 char cap 以内、かつ全文収まる範囲では length 微変動を許容 (㎡ → m² NFKD で +1)
  assert.ok(out.length <= 100, `expected ≤ 100, got ${out.length}`);
  // ヴ が precomposed のまま保持されている
  assert.ok(out.includes("ヴ"), `ヴ should be preserved (got: ${out})`);
  // 濁点 U+3099 が単独で残っていない
  assert.ok(!out.includes("゙"), `combining dakuten U+3099 remains: ${out}`);
  // 半濁点 U+309A も残っていない
  assert.ok(!out.includes("゚"), `combining handakuten U+309A remains: ${out}`);
});

check("濁点付き hiragana (が・ば・ぱ等) も保持される", () => {
  // ば = U+3070 (precomposed) → NFKD → は + U+3099 → strip Latin only → NFC → ば
  const out = sanitizeForForrentText("ばがぱ", 100);
  assert.strictEqual(out, "ばがぱ");
  assert.ok(!out.includes("゙") && !out.includes("゚"));
});

// ── Diacritics ────────────────────────────────────────────
check("diacritics: 'café' → 'ｃａｆｅ' (é → e)", () => {
  assert.strictEqual(sanitizeForForrentText("café", 100), "ｃａｆｅ");
});
check("diacritics: 'naïve résumé' → 'ｎａｉｖｅ　ｒｅｓｕｍｅ'", () => {
  assert.strictEqual(sanitizeForForrentText("naïve résumé", 100), "ｎａｉｖｅ　ｒｅｓｕｍｅ");
});
check("diacritics: 'Á' (precomposed) → 'Ａ'", () => {
  assert.strictEqual(sanitizeForForrentText("Á", 100), "Ａ");
});

// ── Half-width handling ───────────────────────────────────
check("半角数字 → 全角数字", () => {
  assert.strictEqual(sanitizeForForrentText("123", 100), "１２３");
});
check("半角カナ → 全角カナ", () => {
  assert.strictEqual(sanitizeForForrentText("ｱｲｳ", 100), "アイウ");
});

// ── Length cap ────────────────────────────────────────────
check("'a' × 200 → 100 chars (全角)", () => {
  const out = sanitizeForForrentText("a".repeat(200), 100);
  assert.strictEqual(out.length, 100);
  assert.strictEqual(out, "ａ".repeat(100));
});

// ── Newline handling ──────────────────────────────────────
check("改行 (\\n) → 全角スペース", () => {
  const out = sanitizeForForrentText("行1\n行2", 100);
  assert.ok(!out.includes("\n"));
  assert.ok(out.includes("　"));
});
check("CRLF (\\r\\n) → 全角スペース", () => {
  const out = sanitizeForForrentText("行1\r\n行2", 100);
  assert.ok(!out.includes("\r") && !out.includes("\n"));
});

// ── Edge cases ────────────────────────────────────────────
check("null → 空文字", () => {
  assert.strictEqual(sanitizeForForrentText(null, 100), "");
});
check("undefined → 空文字", () => {
  assert.strictEqual(sanitizeForForrentText(undefined, 100), "");
});
check("maxLen=0 → 空文字", () => {
  assert.strictEqual(sanitizeForForrentText("abc", 0), "");
});
check("非string → 空文字", () => {
  assert.strictEqual(sanitizeForForrentText(123, 100), "");
});

// ── Idempotency: pure Japanese unchanged ──────────────────
check("純日本語 → 不変", () => {
  assert.strictEqual(sanitizeForForrentText("家賃と管理費", 100), "家賃と管理費");
});

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
