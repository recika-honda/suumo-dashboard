#!/usr/bin/env node
/**
 * dry-run-stage-02b.js — Phase γ T002 single-property dry-run
 *
 * 02b-maisoku-fetch.js を REINS にログインした 1 物件で実際に動かす検証 script。
 * Phase α T001 で取得実績のある 100139151756 (信濃町Ⅱ番館) を default 物件として使う。
 *
 * Pre-condition (caller responsibility):
 *   launchctl unload ~/Library/LaunchAgents/jp.fango.watch-nyuko.plist
 *
 * Workflow:
 *   1. REINS login (skills/reins.login)
 *   2. searchByNumber + 詳細 click で property detail に到達
 *   3. /BK/GBK003200/getInitData レスポンスを intercept して zmnFlmi を取得
 *      → reinsData に詰めて 02b に渡す (本番 pipeline では Stage 01 が抽出)
 *   4. runMaisokuFetch を呼び output を確認
 *   5. PDF size > 0 をログに記録
 *
 * Usage:
 *   node scripts/dry-run-stage-02b.js              # default reinsId 100139151756
 *   REINS_ID=100139xxxxxx node scripts/dry-run-stage-02b.js
 */

const path = require("path");
const fs = require("fs");
require("dotenv").config({ path: path.join(__dirname, "..", ".env.local") });
const { chromium } = require("playwright");
const reins = require("../skills/reins");
const { runMaisokuFetch } = require("./stages/02b-maisoku-fetch");

const DEFAULT_REINS_ID = "100139151756";
const REINS_ID = process.env.REINS_ID || DEFAULT_REINS_ID;

const FINDINGS_DIR = path.resolve(__dirname, "..", "..", "..", ".claude", "do", "findings");
const RUN_DIR = path.join(__dirname, "..", "logs", "diag", `dryrun-T002-${Date.now()}_${REINS_ID}`);

function ts() { return new Date().toISOString(); }
function log(msg) { console.error(`[${ts()}] ${msg}`); }

async function main() {
  fs.mkdirSync(RUN_DIR, { recursive: true });
  fs.mkdirSync(FINDINGS_DIR, { recursive: true });
  log(`run dir: ${RUN_DIR}`);
  log(`reinsId: ${REINS_ID}`);

  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext({
    viewport: { width: 1280, height: 900 },
    acceptDownloads: true,
  });
  const page = await context.newPage();

  // logStep mock — record all events to a JSON array
  const events = [];
  const logStep = (name, extra = {}) => {
    const entry = { t: ts(), name, ...extra };
    events.push(entry);
    log(`logStep: ${name} ${JSON.stringify(extra)}`);
  };

  let outcome = { ok: false };
  try {
    log("REINS login...");
    const ok = await reins.login(page, {
      id: process.env.REINS_LOGIN_ID,
      pass: process.env.REINS_LOGIN_PASS,
    });
    if (!ok) throw new Error("REINS login failed (check REINS_LOGIN_ID / REINS_LOGIN_PASS)");
    log("login OK");

    // Intercept getInitData to obtain zmnFlmi before clicking 詳細
    // Phase α T001 bug: bare /getInitData filter would match the dashboard menu API.
    // Must scope to /BK/GBK003200/getInitData (property detail endpoint).
    const initDataPromise = page.waitForResponse(
      (r) => /\/BK\/GBK003200\/getInitData/.test(r.url()) && r.status() === 200,
      { timeout: 25000 }
    ).catch(() => null);

    log(`searchByNumber ${REINS_ID}...`);
    const found = await reins.searchByNumber(page, REINS_ID);
    if (!found) throw new Error(`searchByNumber returned false for ${REINS_ID}`);

    log("clicking 詳細...");
    await page.click('button:has-text("詳細")');
    await page.waitForTimeout(3500);

    let zmnFlmi = "";
    const initResp = await initDataPromise;
    if (initResp) {
      const j = await initResp.json();
      const walk = (o) => {
        if (!o || typeof o !== "object") return "";
        if (typeof o.zmnFlmi === "string") return o.zmnFlmi;
        for (const v of Object.values(o)) {
          const r = walk(v);
          if (r) return r;
        }
        return "";
      };
      zmnFlmi = j.zmnFlmi || walk(j) || "";
      log(`getInitData OK, zmnFlmi="${zmnFlmi}"`);
    } else {
      log("getInitData response not captured — fallback to DOM-based detection in 02b");
    }

    // Build minimal reinsData (only fields 02b consumes)
    const reinsData = { zmnFlmi };

    log("invoking runMaisokuFetch...");
    const t0 = Date.now();
    const result = await runMaisokuFetch({
      reinsPage: page,
      runDir: RUN_DIR,
      logStep,
      reinsData,
    });
    const elapsed = Date.now() - t0;
    log(`runMaisokuFetch done in ${elapsed}ms`);
    log(`result: ${JSON.stringify(result, null, 2)}`);

    // Verify PDF if downloaded
    if (result.downloaded) {
      const stat = fs.statSync(result.maisokuPdfPath);
      log(`PDF saved: ${result.maisokuPdfPath} (${stat.size} bytes)`);
      outcome = { ok: stat.size > 0, bytes: stat.size, pdfPath: result.maisokuPdfPath, downloadEvent: result.downloadEvent };
    } else {
      outcome = { ok: false, downloadEvent: result.downloadEvent, reason: result.reason || result.error || "unknown" };
    }

    // Verify artifact files
    const stageDir = path.join(RUN_DIR, "02b-maisoku-fetch");
    outcome.inputJsonExists = fs.existsSync(path.join(stageDir, "input.json"));
    outcome.outputJsonExists = fs.existsSync(path.join(stageDir, "output.json"));
    log(`artifact: input.json=${outcome.inputJsonExists} output.json=${outcome.outputJsonExists}`);
  } catch (e) {
    log(`FATAL: ${e.stack || e.message}`);
    outcome = { ok: false, error: e.message };
  } finally {
    try { await browser.close(); } catch { /* noop */ }
  }

  const summary = {
    reinsId: REINS_ID,
    runDir: RUN_DIR,
    events,
    outcome,
    finishedAt: ts(),
  };
  const summaryPath = path.join(RUN_DIR, "dry-run-summary.json");
  fs.writeFileSync(summaryPath, JSON.stringify(summary, null, 2));
  log(`summary written: ${summaryPath}`);

  process.exit(outcome.ok ? 0 : 2);
}

main().catch((e) => {
  log(`FATAL: ${e.stack || e.message}`);
  process.exit(1);
});
