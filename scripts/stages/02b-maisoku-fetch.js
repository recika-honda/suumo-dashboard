/**
 * Stage 02b: maisoku fetch — Phase γ T002
 *
 * REINS 詳細ページの「図面参照」ボタン経由で募集図面 (マイソク) PDF を取得し、
 * runDir 直下に `maisoku.pdf` として保存する。reinsPage は Stage 01 から
 * 引き継ぎ済 (詳細画面に到達済) の前提で、本 stage では login や navigation は
 * 一切行わない (Phase α finding 01 / phase-gamma-design.md §2 / §10)。
 *
 * 設計 SSOT: code/suumo-dashboard/docs/refactor/phase-gamma-design.md §1, §2, §5, §10
 * 実装基底: .claude/do/findings/01-zumen-button-behavior.md (downloadMaisokuPdf snippet)
 *
 * 02b/02c の責務分離 (gamma-design §4 rationale):
 *   - 02b: browser I/O のみ (PDF 取得 + artifact 書き出し)
 *   - 02c: pure I/O (pdftotext / Vision OCR) — T003 の責務
 * 本 stage は 02c を呼ばない。pipeline 配線は T003 が行う。
 *
 * 失敗時の振る舞い: throw しない (gamma-design §7 invariant)。
 *   - zmnFlmi 空 or 「図面参照」ボタン無 → downloadEvent="skipped"
 *   - download event 未発火 or 保存失敗 → downloadEvent="error"
 *   - 後続 03 stage は通常通り走らせ、03b/03c maisoku 経路は no-op で degrade
 *
 * Env switch: process.env.PHASE_GAMMA_MAISOKU は orchestrator (batch-nyuko.js)
 * 側で参照する。stage 自体は env を見ない (test-stage-03b の (7) と同じ契約)。
 */

const fs = require("fs");
const path = require("path");
const { writeStageInput, writeStageOutput } = require("../lib/artifact");

const STAGE = "02b-maisoku-fetch";

// gamma-design §1: zmnFlmi が空 or null → "no maisoku" を skip 経路で返す。
// 既存 reinsData / getInitData の zmnFlmi は string ("XXXX.pdf") か空文字 ""。
function isZmnFlmiPresent(v) {
  return typeof v === "string" && v.trim().length > 0;
}

/**
 * Click 「図面参照」 and save the maisoku PDF.
 * Phase α finding-01 の snippet を verbatim で内製化したもの (実装が他所と
 * 共有されないよう、ここに閉じる)。snippet との差分:
 *   - timeout を env (MAISOKU_DOWNLOAD_TIMEOUT_MS) で上書き可能化 (default 15000ms)
 *   - reason 文字列を error / skip 経路で安定 schema 化
 *
 * Pre-conditions:
 *   - `page` is on property detail (Stage 01 で reinsPage が詳細画面に到達済)
 *   - `acceptDownloads: true` で context 起動 (Playwright default true)
 *
 * @param {import("playwright").Page} page
 * @param {string} savePath  absolute filesystem path
 * @returns {Promise<{ saved: boolean, bytes?: number, url?: string, filename?: string, reason?: string }>}
 */
async function downloadMaisokuPdf(page, savePath) {
  const TIMEOUT_MS = (() => {
    const raw = process.env.MAISOKU_DOWNLOAD_TIMEOUT_MS;
    if (raw == null || raw === "") return 15000;
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : 15000;
  })();

  // 1) 画像・図面 section を開く (図面参照 button を DOM に露出させる)
  try {
    await page.click('button:has-text("画像・図面")', { timeout: 5000 });
    await page.waitForTimeout(1500);
  } catch {
    // already open / button absent — fall through to existence check
  }

  // 2) 図面参照 button の DOM 存在確認 (zmnFlmi 空 = 図面参照 button 無)
  const hasBtn = await page.evaluate(() =>
    [...document.querySelectorAll("button")].some((b) => /図面参照/.test(b.textContent || ""))
  );
  if (!hasBtn) return { saved: false, reason: "図面参照 button not present" };

  // 3) download listener を click より前に仕込む (Playwright recommended idiom)
  const downloadPromise = page.waitForEvent("download", { timeout: TIMEOUT_MS });
  await page.click('button:has-text("図面参照")');

  let dl;
  try {
    dl = await downloadPromise;
  } catch (e) {
    return { saved: false, reason: `download event not fired: ${e.message}` };
  }

  const url = dl.url();
  const filename = dl.suggestedFilename();
  try {
    await dl.saveAs(savePath);
  } catch (e) {
    return { saved: false, reason: `saveAs failed: ${e.message}` };
  }

  let bytes = 0;
  try {
    bytes = fs.statSync(savePath).size;
  } catch (e) {
    return { saved: false, reason: `stat failed: ${e.message}` };
  }
  if (bytes === 0) return { saved: false, reason: "saved file is empty" };

  return { saved: true, bytes, url, filename };
}

/**
 * Stage 02b: maisoku fetch (gamma-design §2 signature).
 *
 * @param {object} opts
 * @param {import("playwright").Page} opts.reinsPage   Stage 01 から引き継いだ詳細画面 page
 * @param {string}   opts.runDir                       logs/runs/{ts}_{reinsId}/
 * @param {(name: string, extra?: object) => void} opts.logStep
 * @param {object}   [opts.reinsData]                  Stage 01 output (zmnFlmi 早期判定用)
 * @returns {Promise<{
 *   maisokuPdfPath: string|null,
 *   zmnFlmi: string|null,
 *   downloaded: boolean,
 *   downloadEvent: "download"|"skipped"|"error",
 *   error?: string,
 *   generated_at: string
 * }>}
 */
async function runMaisokuFetch({ reinsPage, runDir, logStep, reinsData }) {
  const log = typeof logStep === "function" ? logStep : () => {};
  const zmnFlmi = reinsData && typeof reinsData === "object" ? reinsData.zmnFlmi || null : null;

  writeStageInput(runDir, STAGE, {
    hasZmnFlmi: isZmnFlmiPresent(zmnFlmi),
    zmnFlmi: zmnFlmi || null,
  });
  console.error("  [2b/6] マイソク取得...");
  log("maisoku_fetch_start", { hasZmnFlmi: isZmnFlmiPresent(zmnFlmi) });

  // gamma-design §1 guaranteed invariants: skip when zmnFlmi is empty.
  // ただし reinsData が渡されない / zmnFlmi 抽出未済の場合は DOM 側の
  // 「図面参照」ボタン存在判定 (downloadMaisokuPdf 内) にフォールバック。
  // Phase α finding-01 で「zmnFlmi 非空 ⇔ DOM 存在」が実測一致したため、
  // どちらか片方が判定できれば一貫した結果になる。
  if (reinsData && typeof reinsData === "object" && !isZmnFlmiPresent(zmnFlmi)) {
    const out = {
      maisokuPdfPath: null,
      zmnFlmi: null,
      downloaded: false,
      downloadEvent: "skipped",
      reason: "no maisoku (zmnFlmi empty)",
      generated_at: new Date().toISOString(),
    };
    console.error("  zmnFlmi 空 → マイソク無し物件として skip");
    log("maisoku_fetch_skipped", { reason: "zmnFlmi empty" });
    writeStageOutput(runDir, STAGE, out);
    return out;
  }

  // runDir が無い (test 環境等) でも安全に動くようにしたい。
  // gamma-design §5: maisoku.pdf は runDir root (binary asset) に置く。
  // runDir 未指定なら一時パスでも保存可能だが、artifact が残らないので
  // skipped 扱いにする (本番では batch-nyuko.js が必ず runDir を渡す前提)。
  if (!runDir) {
    const out = {
      maisokuPdfPath: null,
      zmnFlmi: zmnFlmi || null,
      downloaded: false,
      downloadEvent: "skipped",
      reason: "runDir not provided",
      generated_at: new Date().toISOString(),
    };
    log("maisoku_fetch_skipped", { reason: "no runDir" });
    return out;
  }

  // gamma-design §5: maisoku.pdf at runDir root (matches downloadDir pattern).
  // 02b artifact subdir には input.json / output.json のみ書く (binary は除外)。
  const savePath = path.join(runDir, "maisoku.pdf");

  let dl;
  try {
    dl = await downloadMaisokuPdf(reinsPage, savePath);
  } catch (e) {
    // downloadMaisokuPdf 内部の予期せぬ throw (Playwright handle 破損等)。
    // pipeline を止めないため、ここで catch して error 経路に倒す。
    const out = {
      maisokuPdfPath: null,
      zmnFlmi: zmnFlmi || null,
      downloaded: false,
      downloadEvent: "error",
      error: `downloadMaisokuPdf threw: ${e.message.slice(0, 200)}`,
      generated_at: new Date().toISOString(),
    };
    console.error(`  ✗ マイソク取得失敗: ${out.error}`);
    log("maisoku_fetch_error", { error: out.error });
    writeStageOutput(runDir, STAGE, out);
    return out;
  }

  if (dl.saved) {
    const out = {
      maisokuPdfPath: savePath,
      zmnFlmi: zmnFlmi || null,
      downloaded: true,
      downloadEvent: "download",
      bytes: dl.bytes,
      filename: dl.filename || null,
      generated_at: new Date().toISOString(),
    };
    console.error(`  ✓ マイソク取得 (${dl.bytes} bytes)`);
    log("maisoku_fetch_done", { bytes: dl.bytes, filename: dl.filename || null });
    writeStageOutput(runDir, STAGE, out);
    return out;
  }

  // saved:false — reason により skipped / error を振り分け。
  // 「図面参照 button not present」は zmnFlmi 抽出ができなかった (reinsData 未渡し)
  // ケースに該当する skipped。それ以外は download event 未発火 / 保存失敗の error。
  const isSkip = /not present/.test(dl.reason || "");
  const out = {
    maisokuPdfPath: null,
    zmnFlmi: zmnFlmi || null,
    downloaded: false,
    downloadEvent: isSkip ? "skipped" : "error",
    [isSkip ? "reason" : "error"]: dl.reason || "unknown",
    generated_at: new Date().toISOString(),
  };
  if (isSkip) {
    console.error(`  図面参照 button 不在 → マイソク無し物件として skip`);
    log("maisoku_fetch_skipped", { reason: dl.reason });
  } else {
    console.error(`  ✗ マイソク取得失敗: ${dl.reason}`);
    log("maisoku_fetch_error", { error: dl.reason });
  }
  writeStageOutput(runDir, STAGE, out);
  return out;
}

module.exports = { runMaisokuFetch };
