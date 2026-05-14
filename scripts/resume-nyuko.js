#!/usr/bin/env node
/**
 * resume-nyuko.js — 既存 run の途中から再実行
 *
 * 使い方:
 *   bun run scripts/resume-nyuko.js <runId> --from <stageName>
 *
 * 例:
 *   bun run scripts/resume-nyuko.js 20260512-090000_100139015499 --from 05-forrent-fill
 *
 * 対応 stageName:
 *   01-reins-extract / 02-images-download / 03-images-classify
 *   04-texts-generate / 05-forrent-fill / 06-forrent-register
 *
 * 動作:
 *   1. logs/runs/<runId>/{stage}/output.json を読み込んで、--from より前の stage 出力を復元
 *   2. --from 以降の stage を再実行
 *
 * 想定ユースケース (最も実用的):
 *   - 入稿が REG_FAIL になり、Notion 等で建物名を手動補完したあと
 *     同じ runId を `--from 05-forrent-fill` で再実行 → forrent 入稿だけ再試行
 *
 * 制約:
 *   --from 02 以降を指定する場合、REINS ログイン済みの reinsPage が必要 (内部で新規取得)
 *   --from 05 以降を指定する場合、forrentPage を新規 Page で取得するため
 *   stage 05 を必ず再実行 (forrentPage は serialize できないため)
 *   → `--from 06-forrent-register` は実質「stage 05 から再実行」と同等。明示的にエラーにする。
 */

const path = require("path");
const fs = require("fs");

const envPath = path.join(__dirname, "..", ".env.local");
if (fs.existsSync(envPath)) {
  require("dotenv").config({ path: envPath });
}

const { chromium } = require("playwright");
const reins = require("../skills/reins");
const { readStageInput, readStageOutput } = require("./lib/artifact");
const { runReinsExtract } = require("./stages/01-reins-extract");
const { runImagesDownload } = require("./stages/02-images-download");
const { runImagesClassify } = require("./stages/03-images-classify");
const { runTextsGenerate } = require("./stages/04-texts-generate");
const { runForrentFill } = require("./stages/05-forrent-fill");
const { runForrentRegister } = require("./stages/06-forrent-register");

const STAGES = [
  "01-reins-extract",
  "02-images-download",
  "03-images-classify",
  "04-texts-generate",
  "05-forrent-fill",
  "06-forrent-register",
];

const LAUNCH_OPTS = {
  headless: process.env.NYUKO_HEADLESS === "1",
  args: [
    "--disable-blink-features=AutomationControlled",
    "--disable-features=IsolateOrigins,site-per-process",
  ],
};

function usage(extra) {
  if (extra) console.error(extra);
  console.error("Usage: bun run scripts/resume-nyuko.js <runId> --from <stageName>");
  console.error("Stages: " + STAGES.join(" / "));
  process.exit(1);
}

function parseArgs(argv) {
  const args = argv.slice(2);
  const runId = args[0];
  const fromIdx = args.indexOf("--from");
  const stage = fromIdx >= 0 ? args[fromIdx + 1] : null;
  if (!runId || !stage) usage();
  if (!STAGES.includes(stage)) usage(`unknown stage: ${stage}`);
  return { runId, stage };
}

async function loadPriorOutputs(runDir, startIdx) {
  const cache = {};
  for (let i = 0; i < startIdx; i++) {
    const stage = STAGES[i];
    const out = readStageOutput(runDir, stage);
    if (!out) {
      throw new Error(
        `Missing artifact ${stage}/output.json — cannot resume from a later stage. Run the full pipeline first.`
      );
    }
    cache[stage] = out;
  }
  return cache;
}

const logStep = (name, extra) => {
  console.error(`[resume-step] ${name} ${extra ? JSON.stringify(extra) : ""}`);
};

async function main() {
  const { runId, stage: fromStage } = parseArgs(process.argv);
  const startIdx = STAGES.indexOf(fromStage);

  // forrentPage は serialize 不能 → stage 06 単独 resume は不可 (run dir 検証より前)
  if (fromStage === "06-forrent-register") {
    console.error(
      "[resume] --from 06-forrent-register は forrentPage を復元できないため不可。\n" +
        "         代わりに --from 05-forrent-fill を使ってください (stage 05 + 06 を同時実行)。"
    );
    process.exit(1);
  }

  const RUNS_DIR = path.join(__dirname, "..", "logs", "runs");
  const runDir = path.join(RUNS_DIR, runId);
  if (!fs.existsSync(runDir)) {
    console.error(`Run not found: ${runDir}`);
    process.exit(1);
  }

  console.error(`[resume] runId=${runId}, --from ${fromStage} (idx=${startIdx})`);

  const cache = await loadPriorOutputs(runDir, startIdx);
  console.error(`[resume] cached prior stages: ${Object.keys(cache).join(", ")}`);

  // reinsId は stage 01 input.json (artifact が正典) を優先、無ければ runId 末尾から復元
  const stage01Input = readStageInput(runDir, "01-reins-extract");
  const reinsId = stage01Input?.reinsId || runId.split("_").slice(1).join("_");

  // downloadDir も同様に stage 02 input.json を優先 (過去 run と完全整合させる)
  const stage02Input = readStageInput(runDir, "02-images-download");
  const downloadDir =
    stage02Input?.downloadDir ||
    path.join(require("os").homedir(), "Desktop", "suumo-nyuko", reinsId);
  fs.mkdirSync(downloadDir, { recursive: true });

  // ── ブラウザ準備 (stage が必要とする場合のみ) ──
  // needsReinsPage: stage 01 / 02 を再実行する場合 (REINS Page が要る)
  // needsContext:   stage 03 (bukaku 検索) または stage 05/06 (forrent) を再実行する場合
  //                  → stage 04 単独 resume では chromium を起動しない
  let browser, context, reinsPage;
  const needsReinsPage = startIdx <= STAGES.indexOf("02-images-download");
  const needsContext =
    startIdx <= STAGES.indexOf("03-images-classify") ||
    startIdx === STAGES.indexOf("05-forrent-fill");

  if (needsContext) {
    browser = await chromium.launch(LAUNCH_OPTS);
    context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  }

  if (needsReinsPage) {
    reinsPage = await context.newPage();
    const reinsOk = await reins.login(reinsPage, {
      id: process.env.REINS_LOGIN_ID,
      pass: process.env.REINS_LOGIN_PASS,
    });
    if (!reinsOk) {
      console.error("[resume] REINS ログイン失敗");
      await browser.close();
      process.exit(1);
    }
  }

  try {
    // ── 必要に応じて各 stage 再実行 ──
    let r1 = cache["01-reins-extract"];
    if (startIdx <= 0) {
      r1 = await runReinsExtract({ reinsPage, reinsId, index: 0, logStep, runDir });
      if (r1.status !== "OK") return console.log(JSON.stringify({ resumed: true, result: r1 }));
    }

    let r2 = cache["02-images-download"];
    if (startIdx <= 1) {
      r2 = await runImagesDownload({ reinsPage, downloadDir, logStep, runDir, context, reinsData: r1.reinsData });
    }

    let r3 = cache["03-images-classify"];
    if (startIdx <= 2) {
      r3 = await runImagesClassify({
        context,
        reinsData: r1.reinsData,
        downloaded: r2.downloaded,
        downloadDir,
        logStep,
        launchOpts: LAUNCH_OPTS,
        runDir,
      });
    }

    let r4 = cache["04-texts-generate"];
    if (startIdx <= 3) {
      r4 = await runTextsGenerate({ reinsData: r1.reinsData, logStep, runDir });
    }

    // ── stage 05 + 06 (forrentPage を新規取得) ──
    let r5;
    try {
      r5 = await runForrentFill({
        context,
        reinsData: r1.reinsData,
        processedImages: r3.processedImages,
        initialCostData: r3.initialCostData,
        texts: r4,
        logStep,
        runDir,
      });
      if (r5.status === "FORRENT_LOGIN_FAIL") {
        return console.log(JSON.stringify({ resumed: true, result: r5 }));
      }
      const r6 = await runForrentRegister({
        forrentPage: r5.forrentPage,
        mainFrame: r5.mainFrame,
        runDir,
        logStep,
        reinsId: r1.reinsId || r1.reinsData?.物件番号,
        propertyName: r1.reinsData?.建物名,
      });
      console.log(JSON.stringify({ resumed: true, r5: { status: r5.status }, r6 }));
    } finally {
      await r5?.forrentPage?.close().catch(() => {});
    }
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error(`[resume] ERROR: ${err.message}`);
    process.exit(1);
  });
}
