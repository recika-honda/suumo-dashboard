/**
 * probe-zumen-button.js — Phase 4 feasibility probe (a)
 *
 * Determines what happens when the REINS "図面参照" button is clicked:
 *   - download event   (Playwright page.on('download'))
 *   - new tab/popup    (context.on('page'))
 *   - iframe attach    (page.on('frameattached'))
 *   - PDF over network (page.on('request') filtered by .pdf)
 *
 * Reuses skills/reins.js login + searchByNumber (no new login code).
 * Listens to /getInitData API response to discover zmnFlmi non-empty
 * candidates before clicking. Iterates over a list until the first
 * candidate yields a fired capture event.
 *
 * Usage: node scripts/probe-zumen-button.js
 *   (optional) REINS_IDS="100139151756,100139150048,..." to override list.
 *
 * IMPORTANT: caller MUST `launchctl unload jp.fango.watch-nyuko` first.
 * This script does NOT touch launchd itself (separation of concerns; the
 * shell wrapper in the run section of the findings doc handles it).
 */

const path = require("path");
const fs = require("fs");
require("dotenv").config({ path: path.join(__dirname, "..", ".env.local") });
const { chromium } = require("playwright");
const reins = require("../skills/reins");

// Output destination — .claude/do/findings/ (one level up from suumo-dashboard, then sibling)
const FINDINGS_DIR = path.resolve(__dirname, "..", "..", "..", ".claude", "do", "findings");
const PDF_OUT = path.join(FINDINGS_DIR, "sample-maisoku.pdf");
const LOG_OUT = path.join(FINDINGS_DIR, "probe-zumen-button.log.json");

// Candidate reinsIds (most recent processed first; pick from `ls -td logs/runs/`)
const DEFAULT_CANDIDATES = [
  "100139151756", "100139150048", "100139149178", "100139148386",
  "100139147971", "100139147756", "100139147648", "100139147640",
  "100139147638", "100139147208",
];
const CANDIDATES = (process.env.REINS_IDS || "").trim()
  ? process.env.REINS_IDS.split(",").map((s) => s.trim()).filter(Boolean)
  : DEFAULT_CANDIDATES;

function ts() { return new Date().toISOString(); }
function log(msg) { console.error(`[${ts()}] ${msg}`); }

async function main() {
  fs.mkdirSync(FINDINGS_DIR, { recursive: true });

  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext({
    viewport: { width: 1280, height: 900 },
    acceptDownloads: true,
  });
  const page = await context.newPage();

  const events = []; // unified event log across all 4 capture channels

  // ── 4-channel capture (registered BEFORE click) ───────────
  page.on("download", async (dl) => {
    const url = dl.url();
    const suggested = dl.suggestedFilename();
    events.push({ t: ts(), channel: "download", url, suggestedFilename: suggested });
    log(`[download] url=${url} filename=${suggested}`);
    try {
      await dl.saveAs(PDF_OUT);
      const size = fs.statSync(PDF_OUT).size;
      events.push({ t: ts(), channel: "download:saved", path: PDF_OUT, bytes: size });
      log(`[download:saved] ${PDF_OUT} (${size} bytes)`);
    } catch (e) {
      events.push({ t: ts(), channel: "download:error", error: e.message });
      log(`[download:error] ${e.message}`);
    }
  });

  context.on("page", async (newPage) => {
    const url = newPage.url();
    events.push({ t: ts(), channel: "newpage", url });
    log(`[newpage] url=${url}`);
    // If the popup URL itself is a PDF, fetch via context.request and save.
    if (/\.pdf(\?|$)/i.test(url)) {
      try {
        const resp = await context.request.get(url);
        const buf = await resp.body();
        fs.writeFileSync(PDF_OUT, buf);
        events.push({ t: ts(), channel: "newpage:saved", path: PDF_OUT, bytes: buf.length });
        log(`[newpage:saved] ${PDF_OUT} (${buf.length} bytes)`);
      } catch (e) {
        events.push({ t: ts(), channel: "newpage:error", error: e.message });
      }
    }
  });

  page.on("frameattached", (frame) => {
    events.push({ t: ts(), channel: "frameattached", url: frame.url(), name: frame.name() });
    log(`[frameattached] url=${frame.url()} name=${frame.name()}`);
  });

  page.on("request", (req) => {
    const u = req.url();
    if (/\.pdf(\?|$)/i.test(u) || /pdf/i.test(req.headers().accept || "")) {
      events.push({ t: ts(), channel: "request:pdf", url: u, method: req.method() });
      log(`[request:pdf] ${req.method()} ${u}`);
    }
  });

  // ── REINS login (reused from skills/reins.js) ─────────────
  log("REINS login…");
  const ok = await reins.login(page, {
    id: process.env.REINS_LOGIN_ID,
    pass: process.env.REINS_LOGIN_PASS,
  });
  if (!ok) {
    throw new Error("REINS login failed (check .env.local REINS_LOGIN_ID/REINS_LOGIN_PASS)");
  }
  log("login OK");

  let succeeded = false;
  let usedReinsId = null;
  let zmnFlmi = null;

  for (let idx = 0; idx < CANDIDATES.length; idx++) {
    const reinsId = CANDIDATES[idx];
    log(`── candidate ${idx + 1}/${CANDIDATES.length}: ${reinsId} ──`);

    // Re-navigate to dashboard for 2nd+ attempt (skills/reins pattern)
    if (idx > 0) {
      await page.goto("https://system.reins.jp/main/KG/GKG003100", {
        waitUntil: "networkidle", timeout: 20000,
      });
      await page.waitForTimeout(2500);
    }

    // One-shot listener for property-detail getInitData (URL contains GBK003200).
    // Plain "/getInitData" matches dashboard menu init data too — must scope to BK/GBK003200.
    let initDataPromise = page.waitForResponse(
      (r) => /\/BK\/GBK003200\/getInitData/.test(r.url()) && r.status() === 200,
      { timeout: 20000 }
    ).catch(() => null);

    const found = await reins.searchByNumber(page, reinsId);
    if (!found) { log(`  not found on REINS`); continue; }

    // Click "詳細" to enter property detail
    await page.click('button:has-text("詳細")');
    await page.waitForTimeout(4500);

    const initResp = await initDataPromise;
    if (initResp) {
      try {
        const j = await initResp.json();
        // Dump full structure once (first candidate or when env DEBUG_DUMP_INIT=1)
        if (process.env.DEBUG_DUMP_INIT === "1" || idx === 0) {
          const dumpPath = path.join(FINDINGS_DIR, `getInitData-${reinsId}.json`);
          fs.writeFileSync(dumpPath, JSON.stringify(j, null, 2));
          log(`  [debug] full getInitData dump → ${dumpPath}`);
        }
        // Walk every property at any depth that mentions "zmn" / "Flmi" / "図面" / ".pdf"
        const hits = [];
        (function walk(o, p) {
          if (!o || typeof o !== "object") return;
          for (const [k, v] of Object.entries(o)) {
            const pn = p ? `${p}.${k}` : k;
            if (typeof v === "string") {
              if (/^zmn|Flmi$/i.test(k) || /\.pdf/i.test(v) || /図面/.test(v)) {
                hits.push({ path: pn, value: v.slice(0, 200) });
              }
            } else if (typeof v === "object") walk(v, pn);
          }
        })(j, "");
        if (hits.length) {
          log(`  zmn/pdf hits in JSON: ${JSON.stringify(hits).slice(0, 400)}`);
        }
        zmnFlmi = j?.zmnFlmi || j?.data?.zmnFlmi || j?.result?.zmnFlmi || (hits.find(h => /zmnFlmi/i.test(h.path)) || {}).value || "";
        log(`  zmnFlmi="${zmnFlmi}"`);
      } catch (e) { log(`  getInitData JSON parse error: ${e.message}`); }
    } else {
      log(`  getInitData response not captured (continuing anyway)`);
    }

    // Open "画像・図面" section → expose "図面参照" button. The image section
    // also reveals whether a 図面参照 button exists in DOM (ground truth, even
    // if zmnFlmi was empty in the API).
    try {
      await page.click('button:has-text("画像・図面")', { timeout: 5000 });
      await page.waitForTimeout(2000);
    } catch (e) {
      log(`  image section button not clickable: ${e.message}`);
    }

    const hasZumenRefBtn = await page.evaluate(() => {
      return [...document.querySelectorAll("button")].some(b => /図面参照/.test(b.textContent || ""));
    });
    log(`  DOM has 図面参照 button: ${hasZumenRefBtn}`);

    if (!zmnFlmi && !hasZumenRefBtn) {
      log(`  zmnFlmi empty AND no 図面参照 button → skip (no maisoku for this property)`);
      continue;
    }

    // Click "図面参照" — this is the moment of truth.
    const beforeCount = events.length;
    try {
      await page.click('button:has-text("図面参照")', { timeout: 8000 });
      log(`  zumenRefBtn clicked, waiting 8s for events…`);
    } catch (e) {
      log(`  zumenRefBtn click failed: ${e.message}`);
      events.push({ t: ts(), channel: "click:error", reinsId, error: e.message });
      continue;
    }

    // Wait for one of the channels to fire
    await page.waitForTimeout(8000);

    const newEvents = events.slice(beforeCount);
    if (newEvents.length > 0 && fs.existsSync(PDF_OUT) && fs.statSync(PDF_OUT).size > 0) {
      succeeded = true;
      usedReinsId = reinsId;
      log(`✓ captured PDF on candidate ${reinsId} via channels: ${[...new Set(newEvents.map(e=>e.channel))].join(",")}`);
      break;
    }
    log(`  no PDF saved this round (events fired: ${newEvents.length}) — trying next candidate`);
  }

  // ── Summary ────────────────────────────────────────────────
  const summary = {
    succeeded,
    usedReinsId,
    zmnFlmi,
    candidateCount: CANDIDATES.length,
    events,
    pdfPath: succeeded ? PDF_OUT : null,
    pdfBytes: succeeded && fs.existsSync(PDF_OUT) ? fs.statSync(PDF_OUT).size : 0,
  };
  fs.writeFileSync(LOG_OUT, JSON.stringify(summary, null, 2));
  log(`log written → ${LOG_OUT}`);

  await browser.close();
  process.exit(succeeded ? 0 : 2);
}

main().catch((e) => { log(`FATAL: ${e.stack || e.message}`); process.exit(1); });
