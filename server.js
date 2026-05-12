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
// atbb removed — initial costs now fetched via bukaku platforms

// 2026-05 refactor: pipeline は 6 stage に分割済み。ダッシュボード経由でも同じ stages を使う
// ことで、spec-driven validation (config/forrent-required.spec.json) や sanitizeForLength の
// CRLF anti-pattern 予防が一元的に効くようにする。stages の正典は docs/refactor/stages.md。
const { runReinsExtract } = require("./scripts/stages/01-reins-extract");
const { runImagesDownload } = require("./scripts/stages/02-images-download");
const { runImagesClassify } = require("./scripts/stages/03-images-classify");
const { runTextsGenerate } = require("./scripts/stages/04-texts-generate");
const { runForrentFill } = require("./scripts/stages/05-forrent-fill");
const { runForrentRegister } = require("./scripts/stages/06-forrent-register");

const dev = process.env.NODE_ENV !== "production";
const nextApp = next({ dev });
const handle = nextApp.getRequestHandler();

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ══════════════════════════════════════════════════════════
//  STAGE EVENT → UI bridge
// ══════════════════════════════════════════════════════════
// stages の logStep("event_name", payload) を UI の step-update emit に変換するマップ。
// step は 0-6 (Step 0: REINS login は server.js で直接 emit するためここに含めない)。
// msg は string か (payload) => string。null は emit スキップ。
// 完了系の event (images_downloaded / form_filled / register_success 等) は server.js 側で
// stage 直後に done emit するため、ここでブリッジしない (二重発火回避)。
// 定数なので runNyuko 外に置く (同期接続ごとの再生成を避ける)。
const STAGE_EVENT_TO_UI = {
  // Step 1
  reins_search_start:        { step: 1, msg: "REINS で物件番号を検索中..." },
  // Step 2
  extract_image_meta_start:  { step: 2, msg: "画像セクションに移動中..." },
  screenshot_start:          { step: 2, msg: (p) => `${p.count || 0}枚の画像をスクリーンショット中...` },
  // Step 3
  ai_classify_start:         { step: 3, msg: "画像をカテゴリ分類中..." },
  bukaku_supplement_start:   { step: 3, msg: (p) => `5pt不足カテゴリ補完中 (${(p.missing || []).join(",")})` },
  shuhen_fetch_start:        { step: 3, msg: "周辺環境写真を取得中..." },
  // Step 4
  text_ai_start:             { step: 4, msg: "AI でキャッチコピー・コメント生成中..." },
  // Step 5
  forrent_login_start:       { step: 5, msg: "fn.forrent.jpにログイン中..." },
  navigate_form_start:       { step: 5, msg: "新規物件登録フォームに移動中..." },
  fill_property_form_start:  { step: 5, msg: "フォームフィールドを入力中..." },
  fill_texts_start:          { step: 5, msg: "キャッチコピー・コメントを入力中..." },
  upload_images_start:       { step: 5, msg: (p) => `${p.count || 0}枚の画像をアップロード中...` },
  fill_tokucho_start:        { step: 5, msg: "特徴項目をチェック中..." },
  fill_transport_start:      { step: 5, msg: "交通情報を入力中..." },
  fill_shuhen_start:         { step: 5, msg: "周辺環境を入力中..." },
  // Step 6
  register_start:            { step: 6, msg: "登録ボタンを押下中..." },
};

// ══════════════════════════════════════════════════════════
//  ORCHESTRATOR: runNyuko — SUUMO listing pipeline (multi-page)
// ══════════════════════════════════════════════════════════
async function runNyuko(socket, reinsId) {
  const emit = (stepIndex, status, detail = "") =>
    socket.emit("step-update", { stepIndex, status, detail });
  const done = (payload) => socket.emit("done", payload);
  const fail = (msg) => socket.emit("error", { message: msg });

  // stages 内のイベントを console.log + UI emit にブリッジ。
  // runDir は未指定で artifact 永続化スキップ — ad-hoc 実行のためファイル化不要。
  // UI emit は STAGE_EVENT_TO_UI で定義された event のみ。stage 完了系の event は
  // server.js 側で別途 done emit するためここでは流さない (二重発火回避)。
  const logStep = (event, payload) => {
    if (payload && Object.keys(payload).length > 0) {
      console.log(`[stage] ${event}`, JSON.stringify(payload).slice(0, 200));
    } else {
      console.log(`[stage] ${event}`);
    }
    const mapping = STAGE_EVENT_TO_UI[event];
    if (mapping) {
      const detail = typeof mapping.msg === "function" ? mapping.msg(payload || {}) : mapping.msg;
      if (detail) emit(mapping.step, "running", detail);
    }
  };

  // Desktop 保存 (永続化)
  const downloadDir = path.join(os.homedir(), "Desktop", "suumo-nyuko", reinsId);
  fs.mkdirSync(downloadDir, { recursive: true });

  let browser;
  let r5;

  // 15-minute global timeout
  const globalTimeout = setTimeout(() => {
    fail("タイムアウト（15分）- 自動化を中断しました");
    if (browser) browser.close().catch(() => {});
  }, 15 * 60 * 1000);

  try {
    browser = await chromium.launch({ headless: false });
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const reinsPage = context.pages()[0] || await context.newPage();

    // ── Step 0: REINS ログイン (stages 化されていないため server.js 側に残す) ──
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

    // ── Step 1: REINS データ抽出 + spec-driven 早期 validation (stage 01) ──
    emit(1, "running", `物件番号 ${reinsId} を検索中...`);
    const r1 = await runReinsExtract({ reinsPage, reinsId, index: 0, logStep });
    if (r1.status === "NOT_FOUND") {
      fail(`物件番号 ${reinsId} が見つかりませんでした。番号を確認してください。`);
      return;
    }
    if (r1.status === "REG_FAIL") {
      emit(1, "done", `必須項目欠落: ${r1.reason}`);
      fail(`必須項目欠落により入稿不可: ${r1.reason}`);
      return;
    }
    const reinsData = r1.reinsData;
    emit(1, "done", r1.propertyName);

    // ── Step 2: 画像スクリーンショット (stage 02) ──
    emit(2, "running", "画像を取得中...");
    const r2 = await runImagesDownload({ reinsPage, downloadDir, logStep });
    emit(2, "done", `${r2.downloaded.length}枚スクリーンショット完了 → ~/Desktop/suumo-nyuko/${reinsId}/`);

    // ── Step 3: AI 画像分類 + 物確補完 + 周辺環境 (stage 03) ──
    emit(3, "running", "AI画像分類・物確補完・周辺環境取得中...");
    const r3 = await runImagesClassify({
      context,
      reinsData,
      downloaded: r2.downloaded,
      downloadDir,
      logStep,
      launchOpts: { headless: false },
    });
    emit(3, "done", `${r3.processedImages.length}枚`);

    // ── Step 4: AI テキスト生成 (stage 04) ──
    emit(4, "running", "キャッチコピーとコメントを生成中...");
    const texts = await runTextsGenerate({ reinsData, logStep });
    emit(4, "done", `"${texts.catchCopy}"`);

    // ── Step 5: forrent.jp ログイン + フォーム入力 (stage 05) ──
    emit(5, "running", "fn.forrent.jpにログイン・入稿中...");
    r5 = await runForrentFill({
      context,
      reinsData,
      processedImages: r3.processedImages,
      initialCostData: r3.initialCostData,
      texts,
      logStep,
    });
    if (r5.status === "FORRENT_LOGIN_FAIL") {
      fail("forrent.jpログインに失敗しました。");
      return;
    }
    emit(
      5,
      "done",
      `入力${Object.keys(r5.filled).length}件, 画像${r5.uploaded.length}枚, 交通${r5.transport.filled.length}件, 周辺${r5.shuhen.filled.length}件`
    );

    // ── Step 6: 登録 + スコア検証 (stage 06) ──
    emit(6, "running", "登録中...");
    const r6 = await runForrentRegister({
      forrentPage: r5.forrentPage,
      mainFrame: r5.mainFrame,
      logStep,
    });
    if (r6.status === "SUCCESS") {
      const scoreText = r6.score ? `（名寄せスコア: ${r6.score}点 / 43点）` : "";
      emit(6, "done", `${r6.registrationType}完了${scoreText}`);
    } else if (r6.exceptionMessage) {
      emit(6, "done", `登録エラー: ${r6.exceptionMessage}`);
    } else {
      const firstErr = (r6.errors && r6.errors[0]) || "登録ボタンが見つかりません";
      emit(6, "done", firstErr);
    }

    done({
      catchCopy: texts.catchCopy,
      comment: texts.freeComment,
      propertyName: r1.propertyName || reinsId,
      filledFields: Object.keys(r5.filled).length,
      uploadedImages: r5.uploaded.length,
      transport: r5.transport.filled,
      shuhen: r5.shuhen.filled,
      registered: r6.status === "SUCCESS",
      registrationType: r6.registrationType,
      score: r6.score,
      errors: [...(r5.allErrors || []), ...(r6.errors || [])],
      savedTo: downloadDir,
    });
  } catch (err) {
    console.error("[runNyuko] Error:", err);
    fail(`予期しないエラー: ${err.message}`);
  } finally {
    clearTimeout(globalTimeout);
    // ブラウザは閉じない（ユーザーが確認できるように）- 旧版踏襲
    // forrentPage も同様に閉じない (旧版踏襲: batch とは異なり UI で確認するため)
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
