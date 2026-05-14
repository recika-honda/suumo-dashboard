/**
 * test-score-escalation.js — skills/score-escalation のテスト
 *
 * 検証対象:
 *   - shouldEscalate の境界値 (33/34/35)
 *   - shouldEscalate の null/undefined/NaN/非数 安全側 (false)
 *   - loadConfigFromDisk の default / env override / 不正値 fallback
 *   - formatSlackMessage のプレースホルダ置換
 *
 * 背景: 2026-05-14 escalation 路線 (score >= threshold → 掲載指示) 導入。
 *       閾値はユーザ要望で 34 (config/score-escalation.json 既定値)。
 *       純関数 + lazy init で test 容易性を担保。
 */

const assert = require("assert");
const path = require("path");
const fs = require("fs");
const os = require("os");
const {
  DEFAULT_CONFIG,
  loadConfigFromDisk,
  shouldEscalate,
  formatSlackMessage,
} = require("../../skills/score-escalation");

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

const cfg34 = { threshold: 34 };

// ── shouldEscalate: 境界値 ─────────────────────────────────
check("shouldEscalate(33, threshold=34) === false", () => {
  assert.strictEqual(shouldEscalate(33, cfg34), false);
});
check("shouldEscalate(34, threshold=34) === true", () => {
  assert.strictEqual(shouldEscalate(34, cfg34), true);
});
check("shouldEscalate(35, threshold=34) === true", () => {
  assert.strictEqual(shouldEscalate(35, cfg34), true);
});
check("shouldEscalate(43, threshold=34) === true (上限)", () => {
  assert.strictEqual(shouldEscalate(43, cfg34), true);
});
check("shouldEscalate(0, threshold=34) === false", () => {
  assert.strictEqual(shouldEscalate(0, cfg34), false);
});

// ── shouldEscalate: 安全側 ─────────────────────────────────
check("shouldEscalate(null) === false (score 不明は昇格しない)", () => {
  assert.strictEqual(shouldEscalate(null, cfg34), false);
});
check("shouldEscalate(undefined) === false", () => {
  assert.strictEqual(shouldEscalate(undefined, cfg34), false);
});
check("shouldEscalate(NaN) === false", () => {
  assert.strictEqual(shouldEscalate(NaN, cfg34), false);
});
check("shouldEscalate(\"34\") === false (文字列は弾く)", () => {
  assert.strictEqual(shouldEscalate("34", cfg34), false);
});
check("shouldEscalate(34, null) === false (cfg なし)", () => {
  assert.strictEqual(shouldEscalate(34, null), false);
});
check("shouldEscalate(34, {}) === false (threshold なし)", () => {
  assert.strictEqual(shouldEscalate(34, {}), false);
});

// ── loadConfigFromDisk: default + env override ─────────────
check("loadConfigFromDisk: 通常読込で threshold = 34 (config 既定)", () => {
  const c = loadConfigFromDisk({ env: {} });
  assert.strictEqual(c.threshold, 34);
  assert.strictEqual(c.slack.channel, "C09B0527NSF");
  assert.strictEqual(c.slack.channelName, "ex_fango");
});
check("loadConfigFromDisk: env SCORE_ESCALATION_THRESHOLD=40 で override", () => {
  const c = loadConfigFromDisk({ env: { SCORE_ESCALATION_THRESHOLD: "40" } });
  assert.strictEqual(c.threshold, 40);
});
check("loadConfigFromDisk: env SLACK_ESCALATION_CHANNEL で channel override", () => {
  const c = loadConfigFromDisk({ env: { SLACK_ESCALATION_CHANNEL: "C_TEST_999" } });
  assert.strictEqual(c.slack.channel, "C_TEST_999");
});
check("loadConfigFromDisk: 不正な env (非数値) は無視 → default 維持", () => {
  const c = loadConfigFromDisk({ env: { SCORE_ESCALATION_THRESHOLD: "abc" } });
  assert.strictEqual(c.threshold, 34);
});
check("loadConfigFromDisk: 存在しない configPath → DEFAULT_CONFIG fallback", () => {
  const tmp = path.join(os.tmpdir(), `nonexistent-${Date.now()}.json`);
  const c = loadConfigFromDisk({ configPath: tmp, env: {} });
  assert.strictEqual(c.threshold, DEFAULT_CONFIG.threshold);
});
check("loadConfigFromDisk: 壊れた JSON → DEFAULT_CONFIG fallback (graceful)", () => {
  const tmp = path.join(os.tmpdir(), `broken-${Date.now()}.json`);
  fs.writeFileSync(tmp, "{not valid json");
  const c = loadConfigFromDisk({ configPath: tmp, env: {} });
  assert.strictEqual(c.threshold, DEFAULT_CONFIG.threshold);
  fs.unlinkSync(tmp);
});

// ── formatSlackMessage ────────────────────────────────────
check("formatSlackMessage: 全プレースホルダ置換", () => {
  const out = formatSlackMessage(
    { propertyName: "テスト物件", kishaCode: "fng100139999999", score: 38 },
    DEFAULT_CONFIG.slack
  );
  assert.ok(out.includes("🤖完全自動入稿完了"));
  assert.ok(out.includes("物件名: テスト物件"));
  assert.ok(out.includes("貴社物件コード: fng100139999999"));
  assert.ok(out.includes("最終名寄せスコア: 38"));
});
check("formatSlackMessage: 欠損値は空文字に置換 (throw しない)", () => {
  const out = formatSlackMessage(
    { propertyName: null, kishaCode: undefined, score: null },
    DEFAULT_CONFIG.slack
  );
  assert.ok(typeof out === "string");
  assert.ok(out.includes("物件名: "));
});
check("formatSlackMessage: custom template を尊重", () => {
  const out = formatSlackMessage(
    { propertyName: "AAA", kishaCode: "BBB", score: 9 },
    { messageTemplate: "[{score}] {propertyName} / {kishaCode}" }
  );
  assert.strictEqual(out, "[9] AAA / BBB");
});

// ── 出力 ─────────────────────────────────────────────────
console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
