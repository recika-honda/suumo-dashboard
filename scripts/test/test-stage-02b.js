#!/usr/bin/env node
/**
 * test-stage-02b.js — Phase γ T002 stage contract test
 *
 * scripts/stages/02b-maisoku-fetch.js を mock Playwright page で end-to-end
 * 検証。設計 SSOT は code/suumo-dashboard/docs/refactor/phase-gamma-design.md
 * §1 (output schema) / §2 (signature) / §10 (no new login)。
 *
 * 検証する不変条件 (gamma-design §1):
 *   - downloadEvent === "skipped" → maisokuPdfPath === null && downloaded === false
 *   - downloadEvent === "error"   → downloaded === false && error is present
 *   - downloadEvent === "download" → downloaded === true && maisokuPdfPath is path to existing file
 *
 * 検証ケース (mock Playwright page で網羅):
 *   (1) zmnFlmi 非空 + button 有 + download fire → downloadEvent="download", PDF 保存
 *   (2) zmnFlmi 空 (空文字) → downloadEvent="skipped", reinsPage に触らずに早期 return
 *   (3) zmnFlmi なし (reinsData にプロパティ無し) → 同上 skipped
 *   (4) zmnFlmi 非空 + button 無 (DOM 不在) → downloadEvent="skipped", reason に button 無
 *   (5) zmnFlmi 非空 + button 有 + download event timeout → downloadEvent="error"
 *   (6) downloadMaisokuPdf 内で Playwright handle が throw → downloadEvent="error"
 *   (7) artifact: input.json / output.json が runDir 下に書かれる (gamma-design §5)
 *   (8) runDir 未指定 → 安全に skipped (artifact 書かない)
 *   (9) logStep events: start / done / skipped / error がそれぞれ正しく発火
 *  (10) reinsPage が API filter (bare /getInitData) を誤捕捉しないことの回帰確認
 *       → API 経路には依存せず DOM 経路で判定するため、bare /getInitData が
 *          dashboard menu を返しても 02b の挙動は変わらない (Phase α T001 bug regression)
 *
 * mock Playwright page は本物の API を模した最小実装。本物 Playwright を立ち
 * 上げない (test runner で headless browser を spawn しない)。
 */

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { runMaisokuFetch } = require("../stages/02b-maisoku-fetch");

let pass = 0;
let fail = 0;
function check(label, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => {
      console.log(`ok ${label}`);
      pass++;
    })
    .catch((e) => {
      console.error(`FAIL ${label}: ${e.message}`);
      fail++;
    });
}

function mkTmpRunDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "fango-stage02b-"));
}

function mkLogStep() {
  const events = [];
  const fn = (name, extra = {}) => events.push({ name, extra });
  fn.events = events;
  return fn;
}

/**
 * Build a mock Playwright Page that simulates "図面参照" button + download event.
 *
 * @param {object} opts
 * @param {boolean} opts.hasButton             DOM 上に「図面参照」button が存在するか
 * @param {("fire"|"timeout"|"throw")} opts.downloadBehavior  download event の挙動
 * @param {string}  [opts.pdfContent]          fire 時に保存される擬似 PDF バイト列
 * @param {string}  [opts.filename]            dl.suggestedFilename() が返す値
 * @returns {{ page: object, calls: object }}
 */
function mkMockPage(opts) {
  const calls = {
    clicked: [], // button 名のリスト
    evaluateCount: 0,
    waitForEventArgs: [],
    saveAsCalled: 0,
  };
  const pdfBytes = Buffer.from(opts.pdfContent || "%PDF-1.4\nMOCK\n%%EOF\n");

  const page = {
    async click(selector) {
      calls.clicked.push(selector);
      // 画像・図面 button click は no-op (本物では section 展開だが mock では DOM 操作不要)
      return;
    },
    async waitForTimeout(_ms) {
      // mock: no-op
      return;
    },
    async evaluate(_fn) {
      calls.evaluateCount += 1;
      // downloadMaisokuPdf 内の hasBtn 判定: button 存在チェックの evaluate のみ
      return opts.hasButton;
    },
    async waitForEvent(eventName, eventOpts) {
      calls.waitForEventArgs.push({ eventName, eventOpts });
      if (opts.downloadBehavior === "timeout") {
        throw new Error("Timeout 1000ms exceeded waiting for event 'download'");
      }
      if (opts.downloadBehavior === "throw") {
        throw new Error("page closed unexpectedly");
      }
      // fire: simulate a download object
      return {
        url() {
          return "https://system.reins.jp/main/api/BK/GBK003200/downloadZmn?bkknId=test&etag=mock";
        },
        suggestedFilename() {
          return opts.filename || "mock-maisoku.pdf";
        },
        async saveAs(savePath) {
          calls.saveAsCalled += 1;
          fs.mkdirSync(path.dirname(savePath), { recursive: true });
          fs.writeFileSync(savePath, pdfBytes);
        },
      };
    },
  };
  return { page, calls };
}

(async function main() {
  // ──────────────────────────────────────────────────────────
  // (1) Happy path: zmnFlmi 非空 + button 有 + download fire
  // ──────────────────────────────────────────────────────────
  await check("(1) happy: zmnFlmi 非空 + button 有 → downloadEvent='download', PDF saved", async () => {
    const runDir = mkTmpRunDir();
    const logStep = mkLogStep();
    const { page, calls } = mkMockPage({ hasButton: true, downloadBehavior: "fire" });
    const out = await runMaisokuFetch({
      reinsPage: page,
      runDir,
      logStep,
      reinsData: { zmnFlmi: "6983027882XX.pdf" },
    });
    assert.strictEqual(out.downloadEvent, "download");
    assert.strictEqual(out.downloaded, true);
    assert.ok(out.maisokuPdfPath, "maisokuPdfPath should be set");
    assert.ok(fs.existsSync(out.maisokuPdfPath), "PDF file should exist at maisokuPdfPath");
    assert.ok(fs.statSync(out.maisokuPdfPath).size > 0, "PDF file should be non-empty");
    assert.strictEqual(out.zmnFlmi, "6983027882XX.pdf");
    assert.strictEqual(calls.saveAsCalled, 1, "saveAs must be called once");
    // gamma-design §5: maisoku.pdf at runDir root (not in stage subdir)
    assert.strictEqual(out.maisokuPdfPath, path.join(runDir, "maisoku.pdf"));
  });

  // ──────────────────────────────────────────────────────────
  // (2) zmnFlmi 空文字 → skipped 早期 return (reinsPage に触らない)
  // ──────────────────────────────────────────────────────────
  await check("(2) skip: zmnFlmi='' → downloadEvent='skipped', reinsPage に触らず", async () => {
    const runDir = mkTmpRunDir();
    const logStep = mkLogStep();
    const { page, calls } = mkMockPage({ hasButton: false, downloadBehavior: "fire" });
    const out = await runMaisokuFetch({
      reinsPage: page,
      runDir,
      logStep,
      reinsData: { zmnFlmi: "" },
    });
    assert.strictEqual(out.downloadEvent, "skipped");
    assert.strictEqual(out.downloaded, false);
    assert.strictEqual(out.maisokuPdfPath, null);
    assert.strictEqual(out.zmnFlmi, null);
    assert.strictEqual(calls.clicked.length, 0, "reinsPage.click must not be called for empty zmnFlmi");
    assert.strictEqual(calls.evaluateCount, 0, "reinsPage.evaluate must not be called for empty zmnFlmi");
  });

  // ──────────────────────────────────────────────────────────
  // (3) zmnFlmi プロパティ無し → 同じく skipped
  // ──────────────────────────────────────────────────────────
  await check("(3) skip: reinsData に zmnFlmi 無 → downloadEvent='skipped'", async () => {
    const runDir = mkTmpRunDir();
    const logStep = mkLogStep();
    const { page } = mkMockPage({ hasButton: false, downloadBehavior: "fire" });
    const out = await runMaisokuFetch({
      reinsPage: page,
      runDir,
      logStep,
      reinsData: { 建物名: "テスト物件" }, // zmnFlmi key absent
    });
    assert.strictEqual(out.downloadEvent, "skipped");
    assert.strictEqual(out.downloaded, false);
  });

  // ──────────────────────────────────────────────────────────
  // (4) zmnFlmi 非空 + button 不在 (DOM 経路) → skipped
  // reinsData を渡さなければ zmnFlmi 早期 skip は走らず、DOM 経路に進む。
  // ──────────────────────────────────────────────────────────
  await check("(4) skip: reinsData 未渡し + button 無 → downloadEvent='skipped'", async () => {
    const runDir = mkTmpRunDir();
    const logStep = mkLogStep();
    const { page, calls } = mkMockPage({ hasButton: false, downloadBehavior: "fire" });
    const out = await runMaisokuFetch({
      reinsPage: page,
      runDir,
      logStep,
      // reinsData 未渡し → DOM 経路で判定
    });
    assert.strictEqual(out.downloadEvent, "skipped");
    assert.strictEqual(out.downloaded, false);
    assert.strictEqual(out.maisokuPdfPath, null);
    assert.ok(/not present/.test(out.reason || ""), `reason must mention 'not present', got: ${out.reason}`);
    assert.strictEqual(calls.evaluateCount, 1, "evaluate (hasBtn check) must be called");
    assert.strictEqual(calls.saveAsCalled, 0, "saveAs must not be called when button is absent");
  });

  // ──────────────────────────────────────────────────────────
  // (5) zmnFlmi 非空 + button 有 + download event timeout → error
  // ──────────────────────────────────────────────────────────
  await check("(5) error: download event timeout → downloadEvent='error', error present", async () => {
    const runDir = mkTmpRunDir();
    const logStep = mkLogStep();
    const { page } = mkMockPage({ hasButton: true, downloadBehavior: "timeout" });
    const out = await runMaisokuFetch({
      reinsPage: page,
      runDir,
      logStep,
      reinsData: { zmnFlmi: "test.pdf" },
    });
    assert.strictEqual(out.downloadEvent, "error");
    assert.strictEqual(out.downloaded, false);
    assert.strictEqual(out.maisokuPdfPath, null);
    assert.ok(out.error, "error field must be present");
    assert.ok(/download event not fired/.test(out.error), `error should describe timeout, got: ${out.error}`);
  });

  // ──────────────────────────────────────────────────────────
  // (6) Playwright handle が予期せず throw → graceful error
  // ──────────────────────────────────────────────────────────
  await check("(6) error: Playwright handle throw → error 経路、throw 伝播せず", async () => {
    const runDir = mkTmpRunDir();
    const logStep = mkLogStep();
    const { page } = mkMockPage({ hasButton: true, downloadBehavior: "throw" });
    const out = await runMaisokuFetch({
      reinsPage: page,
      runDir,
      logStep,
      reinsData: { zmnFlmi: "test.pdf" },
    });
    // downloadMaisokuPdf 内で waitForEvent throw を catch → "download event not fired" を返す。
    // (downloadMaisokuPdf より外側で throw された場合は "downloadMaisokuPdf threw" 経路)
    assert.strictEqual(out.downloadEvent, "error");
    assert.strictEqual(out.downloaded, false);
    assert.ok(out.error, "error field must be present");
  });

  // ──────────────────────────────────────────────────────────
  // (7) Artifact persistence: input.json / output.json under runDir/STAGE
  // ──────────────────────────────────────────────────────────
  await check("(7) artifact: input.json / output.json が書かれる", async () => {
    const runDir = mkTmpRunDir();
    const logStep = mkLogStep();
    const { page } = mkMockPage({ hasButton: true, downloadBehavior: "fire" });
    await runMaisokuFetch({
      reinsPage: page,
      runDir,
      logStep,
      reinsData: { zmnFlmi: "art.pdf" },
    });
    const stageDir = path.join(runDir, "02b-maisoku-fetch");
    assert.ok(fs.existsSync(path.join(stageDir, "input.json")), "input.json must exist");
    assert.ok(fs.existsSync(path.join(stageDir, "output.json")), "output.json must exist");
    const input = JSON.parse(fs.readFileSync(path.join(stageDir, "input.json"), "utf8"));
    assert.strictEqual(input.hasZmnFlmi, true);
    assert.strictEqual(input.zmnFlmi, "art.pdf");
    const output = JSON.parse(fs.readFileSync(path.join(stageDir, "output.json"), "utf8"));
    assert.strictEqual(output.downloaded, true);
    assert.strictEqual(output.downloadEvent, "download");
    assert.match(output.generated_at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  });

  // ──────────────────────────────────────────────────────────
  // (8) runDir 未指定 → 安全に skipped (artifact 書かない)
  // ──────────────────────────────────────────────────────────
  await check("(8) safety: runDir=undefined → skipped で安全終了, throw しない", async () => {
    const logStep = mkLogStep();
    const { page, calls } = mkMockPage({ hasButton: true, downloadBehavior: "fire" });
    const out = await runMaisokuFetch({
      reinsPage: page,
      logStep,
      reinsData: { zmnFlmi: "test.pdf" },
      // runDir 未指定
    });
    assert.strictEqual(out.downloadEvent, "skipped");
    assert.strictEqual(out.downloaded, false);
    assert.strictEqual(out.maisokuPdfPath, null);
    assert.strictEqual(calls.saveAsCalled, 0, "saveAs must not be called without runDir");
  });

  // ──────────────────────────────────────────────────────────
  // (9) logStep events: start / done / skipped / error の発火確認
  // ──────────────────────────────────────────────────────────
  await check("(9a) logStep: happy path → start + done を順番に発火", async () => {
    const runDir = mkTmpRunDir();
    const logStep = mkLogStep();
    const { page } = mkMockPage({ hasButton: true, downloadBehavior: "fire" });
    await runMaisokuFetch({
      reinsPage: page,
      runDir,
      logStep,
      reinsData: { zmnFlmi: "test.pdf" },
    });
    const names = logStep.events.map((e) => e.name);
    assert.deepStrictEqual(names, ["maisoku_fetch_start", "maisoku_fetch_done"]);
    const done = logStep.events[1];
    assert.strictEqual(typeof done.extra.bytes, "number");
    assert.ok(done.extra.bytes > 0);
  });

  await check("(9b) logStep: skipped path → start + skipped を発火", async () => {
    const runDir = mkTmpRunDir();
    const logStep = mkLogStep();
    const { page } = mkMockPage({ hasButton: false, downloadBehavior: "fire" });
    await runMaisokuFetch({
      reinsPage: page,
      runDir,
      logStep,
      reinsData: { zmnFlmi: "" },
    });
    const names = logStep.events.map((e) => e.name);
    assert.deepStrictEqual(names, ["maisoku_fetch_start", "maisoku_fetch_skipped"]);
  });

  await check("(9c) logStep: error path → start + error を発火", async () => {
    const runDir = mkTmpRunDir();
    const logStep = mkLogStep();
    const { page } = mkMockPage({ hasButton: true, downloadBehavior: "timeout" });
    await runMaisokuFetch({
      reinsPage: page,
      runDir,
      logStep,
      reinsData: { zmnFlmi: "test.pdf" },
    });
    const names = logStep.events.map((e) => e.name);
    assert.deepStrictEqual(names, ["maisoku_fetch_start", "maisoku_fetch_error"]);
    const errEv = logStep.events[1];
    assert.ok(errEv.extra.error, "error event must carry error string");
  });

  // ──────────────────────────────────────────────────────────
  // (10) Phase α T001 bug regression: 02b stage は API filter に依存せず
  // DOM 経路 + reinsData.zmnFlmi で判定する。bare /getInitData が
  // dashboard menu を返したとしても 02b の skip / fetch 判定は変わらない。
  // ──────────────────────────────────────────────────────────
  await check("(10) regression: API filter scoping bug は 02b には影響しない (zmnFlmi prop 経路)", async () => {
    // 仮に dashboard menu の getInitData レスポンスを intercept した結果として
    // zmnFlmi が空文字 / undefined だったとしても、reinsData 経由でしか
    // 02b は読まない設計。「bare /getInitData が間違って捕まる」状況は
    // 02b 内部では発生しない (intercept 自体しないため)。
    // この test は「02b が intercept しない」契約を pin する目的。
    const runDir = mkTmpRunDir();
    const logStep = mkLogStep();
    const { page, calls } = mkMockPage({ hasButton: true, downloadBehavior: "fire" });
    // reinsData.zmnFlmi 非空 → 詳細画面なので download すべき (button 有)
    const out = await runMaisokuFetch({
      reinsPage: page,
      runDir,
      logStep,
      reinsData: { zmnFlmi: "real-property.pdf" },
    });
    assert.strictEqual(out.downloadEvent, "download");
    // page.waitForResponse が呼ばれていない (API intercept しない契約)
    assert.strictEqual(
      typeof page.waitForResponse,
      "undefined",
      "02b stage must not call page.waitForResponse — getInitData intercept is the orchestrator's responsibility"
    );
    assert.strictEqual(calls.saveAsCalled, 1);
  });

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
})();
