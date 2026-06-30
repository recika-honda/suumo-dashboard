/**
 * test-nyuko-record.js — skills/nyuko-record.js のテスト
 *
 * 検証対象 (純粋関数のみ。Notion 書き込みは副作用なので対象外):
 *   - parseMoveInTiming: 入居可能時期文字列 → {年, 月, 時期}
 *   - buildRecordProps: reinsData + status → Notion properties payload
 */

const assert = require("assert");
const {
  parseMoveInTiming,
  buildRecordProps,
} = require("../../skills/nyuko-record");

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

// ── parseMoveInTiming ─────────────────────────────────────
check("parseMoveInTiming: 年月+上旬", () => {
  assert.deepStrictEqual(parseMoveInTiming("2026年7月上旬"), {
    年: 2026, 月: 7, 時期: "上旬",
  });
});
check("parseMoveInTiming: 年月+下旬", () => {
  assert.deepStrictEqual(parseMoveInTiming("2027年12月下旬"), {
    年: 2027, 月: 12, 時期: "下旬",
  });
});
check("parseMoveInTiming: 年月のみ (時期なし)", () => {
  assert.deepStrictEqual(parseMoveInTiming("2026年7月"), { 年: 2026, 月: 7 });
});
check("parseMoveInTiming: 年のみ", () => {
  assert.deepStrictEqual(parseMoveInTiming("2026年"), { 年: 2026 });
});
check("parseMoveInTiming: 全角数字も拾う", () => {
  assert.deepStrictEqual(parseMoveInTiming("２０２６年７月中旬"), {
    年: 2026, 月: 7, 時期: "中旬",
  });
});
check("parseMoveInTiming: 即時/相談 → 空", () => {
  assert.deepStrictEqual(parseMoveInTiming("即時"), {});
  assert.deepStrictEqual(parseMoveInTiming("相談"), {});
  assert.deepStrictEqual(parseMoveInTiming("期日指定"), {});
});
check("parseMoveInTiming: 空/null → 空オブジェクト", () => {
  assert.deepStrictEqual(parseMoveInTiming(""), {});
  assert.deepStrictEqual(parseMoveInTiming(null), {});
  assert.deepStrictEqual(parseMoveInTiming(undefined), {});
});
check("parseMoveInTiming: 結合文字列 (入居年月 / 入居時期) からも拾う", () => {
  assert.deepStrictEqual(parseMoveInTiming("2026年8月下旬 / 期日指定"), {
    年: 2026, 月: 8, 時期: "下旬",
  });
});

// ── buildRecordProps ──────────────────────────────────────
const SAMPLE = {
  物件番号: "126513",
  物件種目: "マンション",
  現況: "空室",
  入居時期: "期日指定",
  入居年月: "2026年9月上旬",
  賃料: "12.5万円",
  使用部分面積: "25.5㎡",
  間取タイプ: "ＬＤＫ",
  間取部屋数: "1",
  都道府県名: "東京都",
  所在地名１: "渋谷区",
  所在地名２: "神南",
  建物名: "テストマンション",
};

check("buildRecordProps: title は REINS ID (物件番号優先)", () => {
  const p = buildRecordProps(SAMPLE, "OK", "FALLBACK");
  assert.strictEqual(p["REINS ID"].title[0].text.content, "126513");
});
check("buildRecordProps: 物件番号欠落時は引数 reinsId を title に", () => {
  const p = buildRecordProps({}, "NOT_FOUND", "999");
  assert.strictEqual(p["REINS ID"].title[0].text.content, "999");
});
check("buildRecordProps: 抽出ステータスは select", () => {
  assert.strictEqual(buildRecordProps(SAMPLE, "OK", "x")["抽出ステータス"].select.name, "OK");
  assert.strictEqual(buildRecordProps({}, "REG_FAIL", "x")["抽出ステータス"].select.name, "REG_FAIL");
});
check("buildRecordProps: 現況は許可値のみ select 化", () => {
  assert.strictEqual(buildRecordProps(SAMPLE, "OK", "x")["現況"].select.name, "空室");
  // 許可外の値は現況プロパティを付けない
  assert.ok(!("現況" in buildRecordProps({ 現況: "謎の状態" }, "OK", "x")));
});
check("buildRecordProps: 入居可能時期を年/月/時期に分解", () => {
  const p = buildRecordProps(SAMPLE, "OK", "x");
  assert.strictEqual(p["入居可能_年"].number, 2026);
  assert.strictEqual(p["入居可能_月"].number, 9);
  assert.strictEqual(p["入居可能_時期"].select.name, "上旬");
  // 原文は入居年月+入居時期を結合
  assert.ok(p["入居時期(原文)"].rich_text[0].text.content.includes("2026年9月上旬"));
  assert.ok(p["入居時期(原文)"].rich_text[0].text.content.includes("期日指定"));
});
check("buildRecordProps: 賃料・面積を数値化", () => {
  const p = buildRecordProps(SAMPLE, "OK", "x");
  assert.strictEqual(p["賃料(万)"].number, 12.5);
  assert.strictEqual(p["専有面積(㎡)"].number, 25.5);
});
check("buildRecordProps: 間取りは部屋数+全角タイプ正規化", () => {
  assert.strictEqual(buildRecordProps(SAMPLE, "OK", "x")["間取り"].rich_text[0].text.content, "1LDK");
});
check("buildRecordProps: 所在地は都道府県+所在地名を連結", () => {
  assert.strictEqual(buildRecordProps(SAMPLE, "OK", "x")["所在地"].rich_text[0].text.content, "東京都渋谷区神南");
});
check("buildRecordProps: 抽出テキスト全文は常に rich_text (JSON)", () => {
  const p = buildRecordProps(SAMPLE, "OK", "x");
  assert.ok(Array.isArray(p["抽出テキスト全文"].rich_text));
  assert.ok(p["抽出テキスト全文"].rich_text[0].text.content.includes("126513"));
});
check("buildRecordProps: 2000字超の全文を chunk 分割 (各≤2000)", () => {
  const huge = { 備考1: "あ".repeat(5000) };
  const chunks = buildRecordProps(huge, "OK", "x")["抽出テキスト全文"].rich_text;
  assert.ok(chunks.length >= 2);
  chunks.forEach((c) => assert.ok(c.text.content.length <= 2000));
});
check("buildRecordProps: NOT_FOUND (空データ) でも壊れない", () => {
  const p = buildRecordProps({}, "NOT_FOUND", "999");
  assert.strictEqual(p["抽出ステータス"].select.name, "NOT_FOUND");
  assert.ok(!("現況" in p));
  assert.ok(!("入居可能_年" in p));
});

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
