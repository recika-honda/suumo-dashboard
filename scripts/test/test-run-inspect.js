/**
 * test-run-inspect.js — scripts/lib/run-inspect.js の単体テスト
 *
 * 検証対象:
 *   1. findResumeStage が「次に再実行すべき stage」を正しく返す
 *      - 全 stage 未完了 → "01-reins-extract"
 *      - 01-04 まで output.json あり → "05-forrent-fill"
 *      - 05 まで output.json あり → "05-forrent-fill" (06 単独不可で 05 から)
 *      - 全 stage 完了 → null
 *      - runDir 不在 → "01-reins-extract" (新規 run 扱い)
 *   2. recordRetry / readRetryHistory / hasOpenRetry の整合性
 *
 * bun test で実行。
 */

const fs = require("fs");
const path = require("path");
const os = require("os");
const assert = require("assert");

const {
  STAGES,
  findResumeStage,
  readRetryHistory,
  hasOpenRetry,
  recordRetry,
} = require("../lib/run-inspect");

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "run-inspect-test-"));
}

function writeStageOutput(runDir, stage, body) {
  const dir = path.join(runDir, stage);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "output.json"), JSON.stringify(body));
}

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

// ── findResumeStage ────────────────────────────────────────
check("findResumeStage: runDir 不在 → 01-reins-extract", () => {
  assert.strictEqual(findResumeStage("/nonexistent/path/xyz"), "01-reins-extract");
});

check("findResumeStage: 空 runDir → 01-reins-extract", () => {
  const d = tmpDir();
  assert.strictEqual(findResumeStage(d), "01-reins-extract");
});

check("findResumeStage: 01 完了 → 02-images-download", () => {
  const d = tmpDir();
  writeStageOutput(d, "01-reins-extract", { status: "OK" });
  assert.strictEqual(findResumeStage(d), "02-images-download");
});

check("findResumeStage: 01-04 完了 → 05-forrent-fill", () => {
  const d = tmpDir();
  for (const s of STAGES.slice(0, 4)) writeStageOutput(d, s, {});
  assert.strictEqual(findResumeStage(d), "05-forrent-fill");
});

check("findResumeStage: 01-05 完了 → 05-forrent-fill (06 単独不可)", () => {
  const d = tmpDir();
  for (const s of STAGES.slice(0, 5)) writeStageOutput(d, s, {});
  assert.strictEqual(findResumeStage(d), "05-forrent-fill");
});

check("findResumeStage: 全 stage 完了 → null", () => {
  const d = tmpDir();
  for (const s of STAGES) writeStageOutput(d, s, {});
  assert.strictEqual(findResumeStage(d), null);
});

check("findResumeStage: 02 だけ存在 (01 抜け) → 01-reins-extract (穴は遡及不可)", () => {
  const d = tmpDir();
  writeStageOutput(d, "02-images-download", {});
  // 01 が無いので「先頭から」= 01 から再開が正しい
  assert.strictEqual(findResumeStage(d), "01-reins-extract");
});

// ── recordRetry / readRetryHistory / hasOpenRetry ─────────
check("recordRetry → readRetryHistory で復元できる", () => {
  const d = tmpDir();
  recordRetry(d, {
    reinsId: "100139000001",
    originalRunDir: "/some/run/dir",
    fromStage: "05-forrent-fill",
    result: { status: "SUCCESS", score: 33, errors: [] },
  });
  const h = readRetryHistory(d);
  assert.ok(h.has("100139000001"));
  assert.strictEqual(h.get("100139000001").result.status, "SUCCESS");
});

check("hasOpenRetry: SUCCESS 履歴は open ではない (再 retry 許可)", () => {
  const d = tmpDir();
  recordRetry(d, {
    reinsId: "100139000002",
    originalRunDir: "/run/a",
    result: { status: "SUCCESS" },
  });
  const h = readRetryHistory(d);
  assert.strictEqual(hasOpenRetry(h, "100139000002", "/run/a"), false);
});

check("hasOpenRetry: REG_FAIL 履歴で同一 runDir は open (再 retry 拒否)", () => {
  const d = tmpDir();
  recordRetry(d, {
    reinsId: "100139000003",
    originalRunDir: "/run/b",
    result: { status: "REG_FAIL" },
  });
  const h = readRetryHistory(d);
  assert.strictEqual(hasOpenRetry(h, "100139000003", "/run/b"), true);
});

check("hasOpenRetry: 別 runDir なら open ではない", () => {
  const d = tmpDir();
  recordRetry(d, {
    reinsId: "100139000004",
    originalRunDir: "/run/old",
    result: { status: "REG_FAIL" },
  });
  const h = readRetryHistory(d);
  // 同 reinsId だが別 run なら別タイミング扱いで retry 可
  assert.strictEqual(hasOpenRetry(h, "100139000004", "/run/new"), false);
});

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
