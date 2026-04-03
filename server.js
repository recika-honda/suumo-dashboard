const path = require("path");
const os = require("os");
const fs = require("fs");
require("dotenv").config({ path: path.join(__dirname, ".env.local") });

const express = require("express");
const { createServer } = require("http");
const { Server } = require("socket.io");
const next = require("next");
const { chromium } = require("playwright");

const reins = require("./skills/reins");
const forrent = require("./skills/forrent");
const { analyzeAndCropImages } = require("./skills/image-ai");
const { generateTexts } = require("./skills/text-ai");
const { checkImageSufficiency, fetchBukakuData } = require("./skills/bukaku");
const { fetchShuhenPhotos } = require("./skills/google-images");
// atbb removed — initial costs now fetched via bukaku platforms

const dev = process.env.NODE_ENV !== "production";
const nextApp = next({ dev });
const handle = nextApp.getRequestHandler();

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ══════════════════════════════════════════════════════════
//  ORCHESTRATOR: runNyuko — SUUMO listing pipeline (multi-page)
// ══════════════════════════════════════════════════════════
async function runNyuko(socket, reinsId) {
  const emit = (stepIndex, status, detail = "") =>
    socket.emit("step-update", { stepIndex, status, detail });
  const done = (payload) => socket.emit("done", payload);
  const fail = (msg) => socket.emit("error", { message: msg });

  // Desktop保存（永続化）
  const downloadDir = path.join(os.homedir(), "Desktop", "suumo-nyuko", reinsId);
  if (!fs.existsSync(downloadDir)) {
    fs.mkdirSync(downloadDir, { recursive: true });
  }

  let browser;

  // 15-minute global timeout
  const globalTimeout = setTimeout(() => {
    fail("タイムアウト（15分）- 自動化を中断しました");
    if (browser) browser.close().catch(() => {});
  }, 15 * 60 * 1000);

  try {
    browser = await chromium.launch({ headless: false });
    const context = await browser.newContext({
      viewport: { width: 1280, height: 900 },
    });

    // REINS用ページ: デフォルトの空白タブを再利用（不要タブが開かないように）
    // forrent.jp用はStep 5で作成 — 早期作成だとブラウザのメモリ圧迫でクラッシュする
    const reinsPage = context.pages()[0] || await context.newPage();

    // ── Step 0: REINS ログイン ──
    emit(0, "running", "system.reins.jpにログイン中...");
    const reinsLoginOk = await reins.login(reinsPage, {
      id: process.env.REINS_LOGIN_ID,
      pass: process.env.REINS_LOGIN_PASS,
    });
    if (!reinsLoginOk) {
      fail("REINSログインに失敗しました。ID/パスワードを確認してください。");
      return;
    }
    emit(0, "done", "ログイン成功");

    // ── Step 1: データ抽出 ──
    emit(1, "running", `物件番号 ${reinsId} を検索中...`);
    const found = await reins.searchByNumber(reinsPage, reinsId);
    if (!found) {
      fail(`物件番号 ${reinsId} が見つかりませんでした。番号を確認してください。`);
      return;
    }
    const reinsData = await reins.extractPropertyData(reinsPage);
    emit(1, "done", reinsData.建物名 || reinsId);

    // ── 物確: 初期費用 + 画像取得（Step 2-4と並行実行） ──
    const bukakuDataPromise = fetchBukakuData(context, reinsData, downloadDir).catch((e) => {
      console.error(`[bukaku] Pipeline error (non-blocking): ${e.message}`);
      return { initialCosts: null, images: [] };
    });

    // ── Step 2: 画像スクリーンショット ──
    emit(2, "running", "画像セクションに移動中...");
    const imagesMeta = await reins.extractImageData(reinsPage);
    emit(2, "running", `${imagesMeta.length}枚の画像をスクリーンショット中...`);
    const downloaded = await reins.screenshotAllImages(reinsPage, imagesMeta, downloadDir);
    emit(2, "done", `${downloaded.length}枚スクリーンショット完了 → ~/Desktop/suumo-nyuko/${reinsId}/`);
    // REINSタイトルをログ
    for (const d of downloaded) {
      if (d.title) console.log(`  画像${d.index}: "${d.title}"`);
    }

    // ── Step 3: AI画像処理 ──
    emit(3, "running", "画像をカテゴリ分類中...");
    const processedImages = await analyzeAndCropImages(downloaded, downloadDir);
    emit(3, "done", `${processedImages.length}枚のカテゴリ画像を生成`);

    // ── Step 3.5: 物確プラットフォームから初期費用 + 追加画像 ──
    const bukakuResult = await bukakuDataPromise;
    const initialCostData = bukakuResult.initialCosts;
    if (initialCostData) {
      emit(3, "running", `物確初期費用: ${Object.keys(initialCostData).length}項目取得`);
    }

    const sufficiency = checkImageSufficiency(processedImages);
    if (sufficiency.insufficient && bukakuResult.images.length > 0) {
      emit(3, "running", `5ptカテゴリ不足(${sufficiency.missing5pt.join(",")}) → 物確画像を分類中...`);
      try {
        const existingCats = processedImages.map(img => img.categoryId);
        const bukakuProcessed = await analyzeAndCropImages(bukakuResult.images, downloadDir, existingCats);
        processedImages.push(...bukakuProcessed);
        emit(3, "running", `物確から${bukakuProcessed.length}枚追加`);
      } catch (e) {
        console.error("[bukaku] Image classification error:", e.message);
      }
    }
    emit(3, "done", `${processedImages.length}枚`);

    // ── Step 3.7: 周辺環境写真をGoogle Mapsから取得 ──
    // Use a separate browser to isolate heavy Google Maps pages from the main pipeline.
    // Google Maps can crash the browser due to memory pressure, which would kill forrentPage.
    emit(3, "running", "周辺環境写真をGoogle Maps + 画像検索で取得中...");
    let shuhenBrowser;
    try {
      shuhenBrowser = await chromium.launch({ headless: false });
      const shuhenContext = await shuhenBrowser.newContext({
        viewport: { width: 1280, height: 900 },
      });
      const shuhenPhotos = await fetchShuhenPhotos(shuhenContext, reinsData, downloadDir);
      if (shuhenPhotos.length > 0) {
        // Add shuhen photos as "周辺環境" category
        for (const photo of shuhenPhotos) {
          processedImages.push({
            localPath: photo.localPath,
            categoryId: "SH",
            categoryLabel: "周辺環境",
            facilityType: photo.facilityType,
            facilityName: photo.facilityName,
            sourceIndex: 200 + shuhenPhotos.indexOf(photo),
          });
        }
        emit(3, "done", `${processedImages.length}枚（周辺環境${shuhenPhotos.length}枚含む）`);
      } else {
        emit(3, "done", `${processedImages.length}枚`);
      }
    } catch (e) {
      console.error("[shuhen] Error:", e.message);
      emit(3, "done", `${processedImages.length}枚`);
    } finally {
      if (shuhenBrowser) await shuhenBrowser.close().catch(() => {});
    }

    // ── Step 4: AIテキスト生成 ──
    emit(4, "running", "キャッチコピーとコメントを生成中...");
    const texts = await generateTexts(reinsData);
    emit(4, "done", `"${texts.catchCopy}"`);

    // ── Step 5: forrent.jp 入稿 ──
    const forrentPage = await context.newPage();
    emit(5, "running", "fn.forrent.jpにログイン中...");
    const forrentLoginOk = await forrent.login(forrentPage, {
      id: process.env.SUUMO_LOGIN_ID,
      pass: process.env.SUUMO_LOGIN_PASS,
    });
    if (!forrentLoginOk) {
      fail("forrent.jpログインに失敗しました。");
      return;
    }

    emit(5, "running", "新規物件登録フォームに移動中...");
    let { mainFrame } = await forrent.navigateToNewProperty(forrentPage);

    if (initialCostData) {
      console.log(`[bukaku] Pipeline: ${JSON.stringify(initialCostData)}`);
    } else {
      console.log("[bukaku] Pipeline: 初期費用データなし（REINSフォールバック）");
    }

    emit(5, "running", "フォームフィールドを入力中...");
    const { filled, errors: formErrors } = await forrent.fillPropertyForm(
      mainFrame,
      reinsData,
      initialCostData
    );

    // キャッチコピー・コメント（交通より前に実行 — 交通がフレーム離脱を起こす可能性があるため）
    emit(5, "running", "キャッチコピー・コメントを入力中...");
    const textErrors = await forrent.fillTexts(
      mainFrame,
      texts.catchCopy,
      texts.freeComment,
      reinsData,
      initialCostData
    );

    // 画像アップロード
    emit(5, "running", `${processedImages.length}枚の画像をアップロード中...`);
    const { uploaded, errors: uploadErrors } = await forrent.uploadImages(
      mainFrame,
      processedImages
    );

    // 特徴項目チェック
    emit(5, "running", "特徴項目をチェック中...");
    const tokuchoResult = await forrent.fillTokucho(mainFrame, reinsData);

    // 交通入力（地図修正 + らくらく交通）
    emit(5, "running", "交通情報を入力中...");
    const transportResult = await forrent.fillTransportViaMap(forrentPage, mainFrame, reinsData.交通);

    // ポップアップ操作後にmainFrameを再取得（フレーム参照が無効化される場合がある）
    mainFrame = forrentPage.frame({ name: "main" }) || mainFrame;

    // 周辺環境入力（らくらく周辺環境）
    emit(5, "running", "周辺環境を入力中...");
    const shuhenResult = await forrent.fillShuhenKankyo(forrentPage, mainFrame);

    // ポップアップ操作後にmainFrameを再取得
    mainFrame = forrentPage.frame({ name: "main" }) || mainFrame;

    // 周辺環境の施設名をポップアップ結果から画像メタデータへ同期
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
      console.log("[server] 周辺環境名称を画像メタデータに同期完了");
    } catch (e) {
      console.log(`[server] 周辺環境名称同期スキップ: ${e.message.slice(0, 60)}`);
    }

    const allErrors = [
      ...formErrors,
      ...transportResult.errors,
      ...textErrors,
      ...uploadErrors,
      ...shuhenResult.errors,
    ];
    emit(5, "done", `入力${Object.keys(filled).length}件, 画像${uploaded.length}枚, 交通${transportResult.filled.length}件, 周辺${shuhenResult.filled.length}件`);

    // ── Step 6: 登録（一時登録 or 登録ボタンを押す） ──
    emit(6, "running", "登録中...");
    let regResult = { saved: false, registrationType: null };
    try {
      regResult = await forrent.registerProperty(forrentPage, mainFrame);

      if (regResult.saved) {
        const scoreText = regResult.score ? `（名寄せスコア: ${regResult.score}点 / 43点）` : "";
        emit(6, "done", `${regResult.registrationType}完了${scoreText}`);
      } else {
        emit(6, "done", regResult.error || "登録ボタンが見つかりません");
      }
    } catch (e) {
      emit(6, "done", `登録エラー: ${e.message.slice(0, 100)}`);
    }

    done({
      catchCopy: texts.catchCopy,
      comment: texts.freeComment,
      propertyName: reinsData.建物名 || reinsId,
      filledFields: Object.keys(filled).length,
      uploadedImages: uploaded.length,
      transport: transportResult.filled,
      tokucho: tokuchoResult,
      shuhen: shuhenResult.filled,
      registered: regResult.saved,
      registrationType: regResult.registrationType,
      score: regResult.score,
      errors: allErrors,
      savedTo: downloadDir,
    });
  } catch (err) {
    console.error("[runNyuko] Error:", err);
    fail(`予期しないエラー: ${err.message}`);
  } finally {
    clearTimeout(globalTimeout);
    // ブラウザは閉じない（ユーザーが確認できるように）
    // 手動で閉じるまで開いたまま
    // if (browser) await browser.close().catch(() => {});

    // Desktop保存なので /tmp のクリーンアップは不要
  }
}

// ══════════════════════════════════════════════════════════
//  SERVER STARTUP
// ══════════════════════════════════════════════════════════
nextApp.prepare().then(() => {
  const app = express();
  app.use(express.json());
  const server = createServer(app);
  const io = new Server(server, {
    cors: { origin: "*" },
    maxHttpBufferSize: 5 * 1024 * 1024,
  });

  // ── Socket.io ──
  io.on("connection", (socket) => {
    socket.on("start-nyuko", async (data) => {
      const reinsId = data.reinsId?.trim();
      if (!reinsId) {
        socket.emit("error", { message: "物件番号が入力されていません" });
        return;
      }
      await runNyuko(socket, reinsId);
    });
  });

  // ── Next.js handler (catch-all) ──
  app.all("*", (req, res) => handle(req, res));

  const PORT = process.env.PORT || 3456;
  server.listen(PORT, () => {
    console.log(`\n  SUUMO Auto-Nyuko ready -> http://localhost:${PORT}\n`);
  });
});
