/**
 * Stage 05: forrent.jp login + form fill
 *
 * 1. context から新しい Page を作成し forrent.jp にログイン
 * 2. 新規物件登録ページに遷移
 * 3. 物件フォーム / テキスト / 画像 / 特徴 / 交通 / 周辺環境を入力
 * 4. shuhen ポップアップ後の destination フィールド同期
 *
 * 設計: docs/refactor/stages.md §05-forrent-fill
 *
 * 戻り値の forrentPage / mainFrame は Stage 06 (登録) で消費される。
 * caller (processProperty) は OK 経路で Stage 06 を呼んだ後、必ず forrentPage を
 * close する責務を負う。FORRENT_LOGIN_FAIL では本 stage 内で close 済みのため
 * forrentPage を戻り値に含めない。
 */

const forrent = require("../../skills/forrent");
const { writeStageInput, writeStageOutput } = require("../lib/artifact");

const STAGE = "05-forrent-fill";

/**
 * @param {object} opts
 * @param {import("playwright").BrowserContext} opts.context
 * @param {object} opts.reinsData
 * @param {Array<object>} opts.processedImages
 * @param {object | null} opts.initialCostData
 * @param {{ catchCopy: string, freeComment: string }} opts.texts
 * @param {(name: string, extra?: object) => void} opts.logStep
 * @returns {Promise<
 *   | { status: "OK", forrentPage, mainFrame, filled, uploaded, transport, shuhen, allErrors }
 *   | { status: "FORRENT_LOGIN_FAIL" }
 * >}
 */
async function runForrentFill({
  context,
  reinsData,
  processedImages,
  initialCostData,
  texts,
  logStep,
  runDir,
}) {
  writeStageInput(runDir, STAGE, {
    reinsData,
    processedImagesCount: processedImages?.length ?? 0,
    hasInitialCostData: !!initialCostData,
    texts,
  });
  console.error("  [5/6] forrent.jp入稿...");
  const forrentPage = await context.newPage();

  const forrentOk = await forrent.login(forrentPage, {
    id: process.env.SUUMO_LOGIN_ID,
    pass: process.env.SUUMO_LOGIN_PASS,
  });
  if (!forrentOk) {
    console.error("  -> forrent.jpログイン失敗");
    await forrentPage.close();
    const out = { status: "FORRENT_LOGIN_FAIL" };
    writeStageOutput(runDir, STAGE, out);
    return out;
  }

  let { mainFrame } = await forrent.navigateToNewProperty(forrentPage);

  const { filled, errors: formErrors } = await forrent.fillPropertyForm(
    mainFrame,
    reinsData,
    initialCostData
  );

  const textErrors = await forrent.fillTexts(
    mainFrame,
    texts.catchCopy,
    texts.freeComment,
    reinsData,
    initialCostData
  );

  const { uploaded, errors: uploadErrors } = await forrent.uploadImages(
    mainFrame,
    processedImages
  );
  const tokuchoResult = await forrent.fillTokucho(mainFrame, reinsData);
  const transportResult = await forrent.fillTransportViaMap(
    forrentPage,
    mainFrame,
    reinsData.交通
  );

  mainFrame = forrentPage.frame({ name: "main" }) || mainFrame;

  const shuhenResult = await forrent.fillShuhenKankyo(forrentPage, mainFrame);
  mainFrame = forrentPage.frame({ name: "main" }) || mainFrame;

  await forrent.syncShuhenDestinationFields(forrentPage, mainFrame);

  const allErrors = [
    ...formErrors,
    ...transportResult.errors,
    ...textErrors,
    ...uploadErrors,
    ...shuhenResult.errors,
  ];

  console.error(
    `  入力: ${Object.keys(filled).length}件, 画像: ${uploaded.length}枚, 交通: ${transportResult.filled.length}件, 周辺: ${shuhenResult.filled.length}件`
  );
  logStep("form_filled", {
    filledFields: Object.keys(filled).length,
    uploadedImages: uploaded.length,
    transport: transportResult.filled.length,
    shuhen: shuhenResult.filled.length,
    formFillErrors: allErrors.length,
  });

  const out = {
    status: "OK",
    forrentPage,
    mainFrame,
    filled,
    uploaded,
    transport: transportResult,
    shuhen: shuhenResult,
    allErrors,
  };
  // forrentPage / mainFrame は safeReplacer で `[Page]` / `[Frame]` に置換される
  writeStageOutput(runDir, STAGE, out);
  return out;
}

module.exports = { runForrentFill };
