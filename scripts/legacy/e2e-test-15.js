/**
 * E2E Test — 15 properties through the full SUUMO listing pipeline
 *
 * Extends batch-test.js with:
 *   - Step 3.7: Shuhen (surrounding environment) photos via Google Maps + AI validation
 *   - Score breakdown by 9 categories via readNayoseScore()
 *   - Error classification (form/upload/transport/shuhen/text/validation)
 *   - CLI options: --phase smoke, --ids xxx,yyy, --verbose, --fresh
 *
 * Usage:
 *   node scripts/e2e-test-15.js                        # full 15 properties
 *   node scripts/e2e-test-15.js --phase smoke --fresh   # smoke test (3 properties)
 *   node scripts/e2e-test-15.js --ids 100138227796,100138229508
 *   node scripts/e2e-test-15.js --verbose --fresh
 */

const path = require("path");
const os = require("os");
const fs = require("fs");
require("dotenv").config({ path: path.join(__dirname, "..", "..", ".env.local") });

const { chromium } = require("playwright");
const reins = require("../../skills/reins");
const forrent = require("../../skills/forrent");
const { analyzeAndCropImages, cropMissingCategories } = require("../../skills/image-ai");
const { generateTexts } = require("../../skills/text-ai");
const { checkImageSufficiency, fetchBukakuImages } = require("../../skills/bukaku-images");
const { fetchShuhenPhotos } = require("../../skills/google-images");
const { readNayoseScore } = require("../../skills/score-checker");

// ── CLI args ──
const args = process.argv.slice(2);
const fresh = args.includes("--fresh");
const verbose = args.includes("--verbose");
const phaseIdx = args.indexOf("--phase");
const phase = phaseIdx !== -1 ? args[phaseIdx + 1] : null;
const idsIdx = args.indexOf("--ids");
const idsArg = idsIdx !== -1 ? args[idsIdx + 1] : null;

// ── Property IDs ──
const ALL_IDS = [
  "100138227796", "100138228746", "100138227301", "100138228400", "100138227721",
  "100138229508", "100138232077", "100138232263", "100138230439", "100138229160",
  "100138232623", "100138234102", "100138234131", "100138232270", "100138234101",
];

const SMOKE_IDS = ["100138227796", "100138229508", "100138234102"];

function getPropertyIds() {
  if (idsArg) return idsArg.split(",").map(s => s.trim());
  if (phase === "smoke") return SMOKE_IDS;
  return ALL_IDS;
}

const PROPERTY_IDS = getPropertyIds();

// ── Error classification ──
function classifyError(errorStr) {
  const s = errorStr.toLowerCase();
  if (s.includes("upload") || s.includes("画像") || s.includes("file") || s.includes("アップロード")) return "upload";
  if (s.includes("transport") || s.includes("交通") || s.includes("沿線") || s.includes("駅")) return "transport";
  if (s.includes("shuhen") || s.includes("周辺") || s.includes("環境")) return "shuhen";
  if (s.includes("text") || s.includes("キャッチ") || s.includes("コメント") || s.includes("catch")) return "text";
  if (s.includes("validation") || s.includes("バリデーション") || s.includes("error")) return "validation";
  return "form";
}

function classifyErrors(errors) {
  return errors.map(e => {
    const msg = typeof e === "string" ? e : (e.message || JSON.stringify(e));
    return { message: msg, category: classifyError(msg) };
  });
}

// ── Results ──
const results = [];

async function processProperty(context, reinsPage, reinsId, index) {
  const downloadDir = path.join(os.homedir(), "Desktop", "suumo-nyuko", reinsId);
  fs.mkdirSync(downloadDir, { recursive: true });
  const cacheFile = path.join(downloadDir, "test-cache.json");

  console.log(`\n${"█".repeat(60)}`);
  console.log(`  [${index + 1}/${PROPERTY_IDS.length}] ${reinsId}`);
  console.log(`${"█".repeat(60)}`);

  let reinsData, processedImages, texts;
  let shuhenDetails = [];
  let imageClassification = [];
  let cache = null;

  // Cache check
  if (!fresh && fs.existsSync(cacheFile)) {
    try {
      cache = JSON.parse(fs.readFileSync(cacheFile, "utf-8"));
      console.log(`  Cache hit: ${cache.reinsData.建物名}`);
    } catch {
      cache = null;
    }
  }

  if (cache) {
    reinsData = cache.reinsData;
    processedImages = (cache.processedImages || []).filter(
      img => !img.localPath.includes("map_surrounding")
    );
    texts = cache.texts;

    // Bukaku supplement if needed
    const sufficiency = checkImageSufficiency(processedImages);
    if (sufficiency.insufficient && !cache.bukakuDone) {
      console.log(`  [cache+bukaku] Fetching (missing: ${sufficiency.missingCategories.join(",")})...`);
      try {
        const bukakuImages = await fetchBukakuImages(context, reinsData, downloadDir);
        if (bukakuImages.length > 0) {
          const existingCats = processedImages.map(img => img.categoryId);
          const bukakuProcessed = await analyzeAndCropImages(bukakuImages, downloadDir, existingCats);
          processedImages.push(...bukakuProcessed);
          console.log(`  Bukaku: +${bukakuProcessed.length} -> total ${processedImages.length}`);
        }
        cache.processedImages = processedImages;
        cache.bukakuDone = true;
        fs.writeFileSync(cacheFile, JSON.stringify(cache, null, 2));
      } catch (e) {
        console.log(`  Bukaku error: ${e.message.slice(0, 80)}`);
      }
    }

    // Shuhen from cache if available
    if (cache.shuhenDetails) {
      shuhenDetails = cache.shuhenDetails;
    }
  } else {
    // ── Step 1: REINS search ──
    console.log("  [1/7] REINS search...");
    if (index > 0) {
      await reinsPage.goto("https://system.reins.jp/main/KG/GKG003100", {
        waitUntil: "networkidle",
        timeout: 20000,
      });
      await reinsPage.waitForTimeout(3000);
    }

    const found = await reins.searchByNumber(reinsPage, reinsId);
    if (!found) {
      console.log(`  x Property not found`);
      return {
        reinsId, status: "NOT_FOUND", score: null, propertyName: "N/A",
        scoreBreakdown: {}, errors: 0, errorDetails: [], validationErrors: 0,
        validationDetails: [], imageClassification: [], shuhenDetails: [],
      };
    }

    reinsData = await reins.extractPropertyData(reinsPage);
    console.log(`  Property: ${reinsData.建物名}`);
    console.log(`  Address: ${[reinsData.都道府県名, reinsData.所在地名１, reinsData.所在地名２, reinsData.所在地名３].join("")}`);

    // ── Step 2: Image screenshots ──
    console.log("  [2/7] Image screenshots...");
    const imagesMeta = await reins.extractImageData(reinsPage);
    const downloaded = await reins.screenshotAllImages(reinsPage, imagesMeta, downloadDir);
    console.log(`  ${downloaded.length} images captured`);

    // ── Step 3: AI image classification ──
    console.log("  [3/7] AI image classification...");
    processedImages = await analyzeAndCropImages(downloaded, downloadDir);
    console.log(`  ${processedImages.length} images classified`);

    // Record classification details
    imageClassification = processedImages.map(img => ({
      file: path.basename(img.localPath),
      categoryId: img.categoryId,
      categoryLabel: img.categoryLabel,
      sourceIndex: img.sourceIndex,
    }));

    // ── Step 3.5: Bukaku supplement ──
    const sufficiency = checkImageSufficiency(processedImages);
    if (sufficiency.insufficient) {
      console.log(`  [3.5/7] Bukaku images (missing: ${sufficiency.missingCategories.join(",")})...`);
      try {
        const bukakuImages = await fetchBukakuImages(context, reinsData, downloadDir);
        if (bukakuImages.length > 0) {
          const existingCats = processedImages.map(img => img.categoryId);
          const bukakuProcessed = await analyzeAndCropImages(bukakuImages, downloadDir, existingCats);
          processedImages.push(...bukakuProcessed);
          console.log(`  Bukaku: +${bukakuProcessed.length} -> total ${processedImages.length}`);
        } else {
          console.log(`  Bukaku: no images`);
        }
      } catch (e) {
        console.log(`  Bukaku error: ${e.message.slice(0, 80)}`);
      }
    }

    // ── Step 3.6: 既存画像から不足カテゴリを切り抜き補完 ──
    const sufficiency2 = checkImageSufficiency(processedImages);
    if (sufficiency2.missing5pt.length > 0) {
      console.log(`  [3.6/7] Crop missing categories (${sufficiency2.missing5pt.join(",")})...`);
      try {
        const cropped = await cropMissingCategories(processedImages, downloaded, downloadDir);
        if (cropped.length > 0) {
          processedImages.push(...cropped);
          console.log(`  Cropped: +${cropped.length} images`);
        }
      } catch (e) {
        console.log(`  Crop error: ${e.message.slice(0, 80)}`);
      }
    }

    // ── Step 3.7: Shuhen photos (Google Maps + AI validation) ──
    console.log("  [3.7/7] Shuhen photos (Google Maps + AI)...");
    try {
      const shuhenPhotos = await fetchShuhenPhotos(context, reinsData, downloadDir);
      if (shuhenPhotos.length > 0) {
        for (const photo of shuhenPhotos) {
          processedImages.push({
            localPath: photo.localPath,
            categoryId: "SH",
            categoryLabel: "周辺環境",
            facilityType: photo.facilityType,
            facilityName: photo.facilityName,
            sourceIndex: 200 + shuhenPhotos.indexOf(photo),
          });
          shuhenDetails.push({
            facilityName: photo.facilityName,
            facilityType: photo.facilityType,
            localPath: photo.localPath,
          });
        }
        console.log(`  Shuhen: ${shuhenPhotos.length} photos acquired`);
      } else {
        console.log(`  Shuhen: 0 photos`);
      }
    } catch (e) {
      console.log(`  Shuhen photo error: ${e.message.slice(0, 80)}`);
    }

    // ── Step 4: AI text generation ──
    console.log("  [4/7] AI text generation...");
    texts = await generateTexts(reinsData);
    console.log(`  Catch copy: "${texts.catchCopy}"`);

    // Save cache
    const cacheData = {
      reinsData, processedImages, texts, shuhenDetails,
      bukakuDone: true, cachedAt: new Date().toISOString(),
    };
    fs.writeFileSync(cacheFile, JSON.stringify(cacheData, null, 2));
  }

  // ── Step 5: forrent.jp submission ──
  console.log("  [5/7] forrent.jp submission...");
  const forrentPage = await context.newPage();

  try {
    const forrentOk = await forrent.login(forrentPage, {
      id: process.env.SUUMO_LOGIN_ID,
      pass: process.env.SUUMO_LOGIN_PASS,
    });
    if (!forrentOk) {
      console.log("  x forrent.jp login failed");
      await forrentPage.close();
      return {
        reinsId, status: "LOGIN_FAIL", score: null,
        propertyName: reinsData.建物名,
        scoreBreakdown: {}, errors: 1, errorDetails: [{ message: "forrent.jp login failed", category: "form" }],
        validationErrors: 0, validationDetails: [],
        imageClassification, shuhenDetails,
      };
    }

    let { mainFrame } = await forrent.navigateToNewProperty(forrentPage);

    const { filled, errors: formErrors } = await forrent.fillPropertyForm(mainFrame, reinsData);
    const textErrors = await forrent.fillTexts(mainFrame, texts.catchCopy, texts.freeComment, reinsData);
    const { uploaded, errors: uploadErrors } = await forrent.uploadImages(mainFrame, processedImages);
    const tokuchoResult = await forrent.fillTokucho(mainFrame, reinsData);
    const transportResult = await forrent.fillTransportViaMap(forrentPage, mainFrame, reinsData.交通);

    // ポップアップ操作後にmainFrameを再取得
    mainFrame = forrentPage.frame({ name: "main" }) || mainFrame;

    const shuhenResult = await forrent.fillShuhenKankyo(forrentPage, mainFrame);

    // ポップアップ操作後にmainFrameを再取得
    mainFrame = forrentPage.frame({ name: "main" }) || mainFrame;

    // 周辺環境の施設名を画像メタデータへ同期
    try {
      await mainFrame.evaluate(() => {
        for (let i = 0; i < 6; i++) {
          const nameEl = document.querySelector(`input[name="bukkenInputForm.shuhenKankyoInputForm[${i}].shuhenKankyoNm"]`);
          const destEl = document.getElementById(`destination${i + 1}`);
          if (nameEl && nameEl.value && destEl) {
            destEl.value = nameEl.value;
            destEl.dispatchEvent(new Event("input", { bubbles: true }));
          }
        }
      });
    } catch (e) {
      console.log(`  Shuhen name sync skip: ${e.message.slice(0, 60)}`);
    }

    const allErrors = [...formErrors, ...transportResult.errors, ...textErrors, ...uploadErrors, ...shuhenResult.errors];
    const errorDetails = classifyErrors(allErrors);

    console.log(`  OK: ${Object.keys(filled).length}, NG: ${allErrors.length}, images: ${uploaded.length}, transport: ${transportResult.filled.length}, shuhen: ${shuhenResult.filled.length}`);

    if (verbose && allErrors.length > 0) {
      for (const ed of errorDetails) {
        console.log(`    [${ed.category}] ${ed.message}`);
      }
    }

    // ── Step 6: Score check ──
    console.log("  [6/7] Score check...");
    let score = null;
    let scoreBreakdown = {};
    let validationErrors = [];

    try {
      await mainFrame.evaluate(() => window.scrollTo(0, 0));
      await mainFrame.waitForTimeout(500);

      const dialogs = [];
      forrentPage.on("dialog", async (dialog) => {
        dialogs.push({ type: dialog.type(), message: dialog.message() });
        await dialog.accept();
      });

      await mainFrame.evaluate(() => {
        const btn = document.getElementById("regButton2");
        if (btn) btn.click();
      });

      await mainFrame.waitForTimeout(10000);

      // Try readNayoseScore for detailed breakdown
      try {
        const nayose = await readNayoseScore(forrentPage);
        if (nayose.total > 0) {
          score = nayose.total;
          scoreBreakdown = nayose.breakdown;
        }
      } catch (e) {
        if (verbose) console.log(`  readNayoseScore error: ${e.message.slice(0, 60)}`);
      }

      // Fallback: extract from page directly
      if (score === null) {
        const confirmFrame = forrentPage.frame({ name: "main" }) || mainFrame;
        const pageInfo = await confirmFrame.evaluate(() => {
          const body = document.body?.innerText || "";
          const errorEls = document.querySelectorAll('.errorMessage, .error, [class*="error"], [class*="Error"]');
          const errors = [...errorEls].map(el => el.textContent.trim()).filter(Boolean);
          const redTexts = [...document.querySelectorAll('span[style*="color"], font[color="red"], .red')];
          const redErrors = redTexts.map(el => el.textContent.trim()).filter(t => t.length > 2 && t.length < 200);
          const scorePatterns = [
            /名寄せスコア[：:\s]*(\d+)/, /スコア[：:\s]*(\d+)/,
            /合計[：:\s]*(\d+)\s*点/, /(\d+)\s*点\s*\/\s*\d+\s*点/,
          ];
          let score = null;
          for (const re of scorePatterns) {
            const m = body.match(re);
            if (m) { score = parseInt(m[1]); break; }
          }
          return { errors, redErrors, score, bodySnippet: body.slice(0, 1000) };
        });

        score = pageInfo.score;
        validationErrors = [...pageInfo.errors, ...pageInfo.redErrors];
      }

      if (dialogs.length > 0) {
        validationErrors.push(...dialogs.map(d => `[${d.type}] ${d.message}`));
      }
    } catch (e) {
      console.log(`  Confirmation screen error: ${e.message.slice(0, 100)}`);
    }

    // Screenshot
    const ssPath = path.join(downloadDir, "batch-result.png");
    await forrentPage.screenshot({ path: ssPath, fullPage: false });

    const status = score !== null ? (score >= 40 ? "PASS" : "FAIL") : "NO_SCORE";
    const icon = status === "PASS" ? "+" : status === "FAIL" ? "x" : "?";
    console.log(`  ${icon} Score: ${score ?? "N/A"} / 43 (${status})`);
    if (scoreBreakdown && Object.keys(scoreBreakdown).length > 0 && verbose) {
      console.log(`    Breakdown: ${Object.entries(scoreBreakdown).map(([k, v]) => `${k}=${v}`).join(", ")}`);
    }
    if (validationErrors.length > 0) {
      console.log(`  Validation errors: ${validationErrors.slice(0, 3).join(", ")}`);
    }

    await forrentPage.close();

    return {
      reinsId,
      propertyName: reinsData.建物名 || reinsId,
      status,
      score,
      scoreBreakdown,
      filled: Object.keys(filled).length,
      images: uploaded.length,
      transport: transportResult.filled.length,
      shuhen: shuhenResult.filled.length,
      tokucho: tokuchoResult,
      errors: allErrors.length,
      errorDetails,
      validationErrors: validationErrors.length,
      validationDetails: validationErrors,
      imageClassification,
      shuhenDetails,
      screenshotPath: ssPath,
    };
  } catch (err) {
    console.log(`  x Error: ${err.message.slice(0, 150)}`);
    try { await forrentPage.close(); } catch {}
    return {
      reinsId,
      propertyName: reinsData?.建物名 || reinsId,
      status: "ERROR",
      score: null,
      scoreBreakdown: {},
      error: err.message.slice(0, 200),
      errors: 1,
      errorDetails: [{ message: err.message.slice(0, 200), category: "form" }],
      validationErrors: 0,
      validationDetails: [],
      imageClassification,
      shuhenDetails,
    };
  }
}

async function main() {
  const phaseLabel = phase === "smoke" ? "SMOKE (3)" : idsArg ? `CUSTOM (${PROPERTY_IDS.length})` : `FULL (${PROPERTY_IDS.length})`;

  console.log("=".repeat(60));
  console.log("  SUUMO E2E Test");
  console.log(`  Phase: ${phaseLabel}`);
  console.log(`  Properties: ${PROPERTY_IDS.length}`);
  console.log(`  Cache: ${fresh ? "disabled" : "enabled"}`);
  console.log(`  Verbose: ${verbose}`);
  console.log("=".repeat(60));

  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });

  try {
    // ── Step 0: REINS login ──
    const reinsPage = await context.newPage();
    console.log("\n  REINS login...");
    const reinsOk = await reins.login(reinsPage, {
      id: process.env.REINS_LOGIN_ID,
      pass: process.env.REINS_LOGIN_PASS,
    });
    if (!reinsOk) {
      console.error("REINS login failed");
      await browser.close();
      process.exit(1);
    }
    console.log("  REINS login OK\n");

    // ── Process each property ──
    for (let i = 0; i < PROPERTY_IDS.length; i++) {
      const startTime = Date.now();
      try {
        const result = await processProperty(context, reinsPage, PROPERTY_IDS[i], i);
        result.duration = Math.round((Date.now() - startTime) / 1000);
        results.push(result);
      } catch (err) {
        console.error(`  FATAL: ${err.message}`);
        results.push({
          reinsId: PROPERTY_IDS[i],
          propertyName: "N/A",
          status: "FATAL",
          score: null,
          scoreBreakdown: {},
          duration: Math.round((Date.now() - startTime) / 1000),
          error: err.message.slice(0, 200),
          errors: 1,
          errorDetails: [{ message: err.message.slice(0, 200), category: "form" }],
          validationErrors: 0,
          validationDetails: [],
          imageClassification: [],
          shuhenDetails: [],
        });
      }
    }

    // ══ Final Report ══
    printReport();

    // Save JSON report
    const reportPath = path.join(os.homedir(), "Desktop", "suumo-nyuko", `e2e-report-${Date.now()}.json`);
    fs.writeFileSync(reportPath, JSON.stringify({ meta: { phase: phaseLabel, fresh, verbose, timestamp: new Date().toISOString(), propertyCount: PROPERTY_IDS.length }, results, summary: buildSummary() }, null, 2));
    console.log(`\n  Report saved: ${reportPath}`);

  } catch (err) {
    console.error("Fatal:", err);
  } finally {
    await browser.close();
  }
}

function buildSummary() {
  let passCount = 0;
  let totalScore = 0;
  let scoredCount = 0;
  let totalErrors = 0;
  let totalValidationErrors = 0;
  const categoryTotals = {};
  const categoryCounts = {};
  const errorFreq = {};

  for (const r of results) {
    if (r.status === "PASS") passCount++;
    if (r.score !== null) {
      totalScore += r.score;
      scoredCount++;
    }
    totalErrors += r.errors || 0;
    totalValidationErrors += r.validationErrors || 0;

    // Category breakdown aggregation
    if (r.scoreBreakdown) {
      for (const [cat, pts] of Object.entries(r.scoreBreakdown)) {
        categoryTotals[cat] = (categoryTotals[cat] || 0) + pts;
        categoryCounts[cat] = (categoryCounts[cat] || 0) + 1;
      }
    }

    // Error frequency
    if (r.errorDetails) {
      for (const ed of r.errorDetails) {
        errorFreq[ed.category] = (errorFreq[ed.category] || 0) + 1;
      }
    }
  }

  const categoryAverages = {};
  for (const cat of Object.keys(categoryTotals)) {
    categoryAverages[cat] = Number((categoryTotals[cat] / categoryCounts[cat]).toFixed(1));
  }

  const avgScore = scoredCount > 0 ? Number((totalScore / scoredCount).toFixed(1)) : null;
  const minScore = results.filter(r => r.score !== null).reduce((min, r) => Math.min(min, r.score), 99);
  const passRate = `${passCount}/${results.length}`;

  // Auto-detect issues
  const issues = [];
  for (const [cat, avg] of Object.entries(categoryAverages)) {
    if (avg < 3) issues.push({ severity: "Critical", message: `${cat} average ${avg}pt (< 3pt)` });
    else if (avg < 5) issues.push({ severity: "Minor", message: `${cat} average ${avg}pt (< 5pt)` });
  }
  if (totalErrors > 0) issues.push({ severity: "Major", message: `Total pipeline errors: ${totalErrors}` });
  if (totalValidationErrors > 0) issues.push({ severity: "Major", message: `Total validation errors: ${totalValidationErrors}` });
  if (avgScore !== null && avgScore < 40) issues.push({ severity: "Major", message: `Average score ${avgScore} (< 40)` });
  const fatalCount = results.filter(r => r.status === "FATAL").length;
  if (fatalCount > 0) issues.push({ severity: "Critical", message: `${fatalCount} FATAL failures` });

  return {
    passCount, passRate, avgScore, minScore: minScore < 99 ? minScore : null,
    totalErrors, totalValidationErrors, categoryAverages, errorFreq, issues,
  };
}

function printReport() {
  const summary = buildSummary();

  console.log(`\n\n${"=".repeat(90)}`);
  console.log("  E2E Test Results");
  console.log(`${"=".repeat(90)}`);
  console.log("");
  console.log("  #  | REINS ID       | Property                     | Score | Err | Val | Status     | Time");
  console.log("  " + "-".repeat(86));

  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    const name = (r.propertyName || "").slice(0, 24).padEnd(24);
    const scoreStr = r.score !== null ? `${r.score}/43` : "  N/A";
    const errStr = String(r.errors || 0).padStart(3);
    const valStr = String(r.validationErrors || 0).padStart(3);
    const statusIcon = r.status === "PASS" ? "+" : r.status === "FAIL" ? "x" : r.status === "NOT_FOUND" ? "?" : "!";
    const dur = r.duration ? `${r.duration}s` : "";
    console.log(`  ${String(i + 1).padStart(2)} | ${r.reinsId} | ${name} | ${scoreStr.padStart(5)} | ${errStr} | ${valStr} | ${statusIcon} ${(r.status || "").padEnd(10)} | ${dur}`);
  }

  console.log("  " + "-".repeat(86));
  console.log(`  Pass: ${summary.passRate} (score >= 40)    Average: ${summary.avgScore ?? "N/A"}pt    Min: ${summary.minScore ?? "N/A"}pt`);
  console.log(`  Pipeline errors: ${summary.totalErrors}    Validation errors: ${summary.totalValidationErrors}`);

  // Category averages
  if (Object.keys(summary.categoryAverages).length > 0) {
    const catStr = Object.entries(summary.categoryAverages).map(([k, v]) => `${k}=${v}`).join("  ");
    console.log(`  Category avg: ${catStr}`);
  }

  // Error frequency
  if (Object.keys(summary.errorFreq).length > 0) {
    const errStr = Object.entries(summary.errorFreq).map(([k, v]) => `${k}:${v}`).join("  ");
    console.log(`  Error breakdown: ${errStr}`);
  }

  // Auto-detected issues
  if (summary.issues.length > 0) {
    console.log("");
    console.log("  Issues detected:");
    for (const issue of summary.issues) {
      const icon = issue.severity === "Critical" ? "!!!" : issue.severity === "Major" ? " ! " : " . ";
      console.log(`    [${icon}] ${issue.severity}: ${issue.message}`);
    }
  }

  // Failed property IDs for re-run
  const failedIds = results.filter(r => r.status !== "PASS").map(r => r.reinsId);
  if (failedIds.length > 0) {
    console.log(`\n  Re-run failed: node scripts/e2e-test-15.js --ids ${failedIds.join(",")} --fresh`);
  }

  console.log(`${"=".repeat(90)}\n`);
}

main();
