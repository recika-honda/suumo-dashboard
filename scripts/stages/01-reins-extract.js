/**
 * Stage 01: REINS data extraction + early validation
 *
 * REINS で物件番号を検索し、物件詳細データを抽出する。
 * forrent.jp の必須項目 (建物名 / マンション・アパートの部屋番号) が
 * 欠落していれば、ブラウザ起動・画像取得・AI 分類を全スキップして
 * 早期に REG_FAIL を返す。
 *
 * 設計: docs/refactor/stages.md §01-reins-extract
 * 不変条件: docs/refactor/contract.md §3 (NOT_FOUND / REG_FAIL の戻り値)
 *
 * 副作用:
 *   - 終了時 reinsPage は物件詳細ページに遷移済み (Stage 02 の前提)
 *   - runDir 指定時、reinsPage 抽出データを `runDir/reins-data.json` に書き出す
 */

const fs = require("fs");
const path = require("path");
const reins = require("../../skills/reins");
const forrent = require("../../skills/forrent");
const nyukoRecord = require("../../skills/nyuko-record");
const { writeStageInput, writeStageOutput } = require("../lib/artifact");

const STAGE = "01-reins-extract";

/**
 * 抽出テキストを「入稿記録」Notion DB に追記する (監査ログ)。
 * 失敗・env 未設定でもパイプラインは絶対に止めない (catch + logStep のみ)。
 */
async function recordToNotion({ reinsId, reinsData, status, logStep }) {
  try {
    const r = await nyukoRecord.recordExtraction({ reinsId, reinsData, status });
    logStep("nyuko_record", { ok: r.ok, skipped: r.skipped, reason: r.reason });
    if (!r.ok && !r.skipped) {
      console.error(`  [入稿記録] Notion追記失敗: ${r.error}`);
    }
  } catch (err) {
    logStep("nyuko_record", { ok: false, error: err.message });
    console.error(`  [入稿記録] 例外: ${err.message}`);
  }
}

/**
 * @param {object} opts
 * @param {import("playwright").Page} opts.reinsPage  REINS ログイン済みページ
 * @param {string} opts.reinsId                      REINS 物件番号
 * @param {number} opts.index                        バッチ内 index (0 以外なら検索ページに再 navigate)
 * @param {(name: string, extra?: object) => void} opts.logStep
 * @param {string} [opts.runDir]                     reins-data.json artifact 書き出し先
 * @returns {Promise<
 *   | { status: "OK", reinsData: object, propertyName: string }
 *   | { status: "NOT_FOUND" }
 *   | { status: "REG_FAIL", propertyName: string, reason: string }
 * >}
 */
async function runReinsExtract({ reinsPage, reinsId, index, logStep, runDir }) {
  writeStageInput(runDir, STAGE, { reinsId, index });

  // 2件目以降は検索ページに戻る (前回の物件詳細ページから遷移するため)
  if (index > 0) {
    await reinsPage.goto("https://system.reins.jp/main/KG/GKG003100", {
      waitUntil: "networkidle",
      timeout: 20000,
    });
    await reinsPage.waitForTimeout(3000);
  }

  console.error("  [1/6] REINS検索...");
  logStep("reins_search_start");

  const found = await reins.searchByNumber(reinsPage, reinsId);
  if (!found) {
    console.error("  -> 物件が見つかりませんでした");
    logStep("reins_search_not_found");
    await recordToNotion({ reinsId, reinsData: {}, status: "NOT_FOUND", logStep });
    const out = { status: "NOT_FOUND" };
    writeStageOutput(runDir, STAGE, out);
    return out;
  }

  const reinsData = await reins.extractPropertyData(reinsPage);
  console.error(`  物件名: ${reinsData.建物名}`);
  logStep("reins_extracted", {
    propertyName: reinsData.建物名,
    fieldCount: Object.keys(reinsData).length,
  });

  // reins-data.json artifact (runDir 指定時のみ)
  if (runDir) {
    try {
      fs.writeFileSync(
        path.join(runDir, "reins-data.json"),
        JSON.stringify(reinsData, null, 2)
      );
    } catch {}
  }

  // 早期バリデーション: forrent.jp 必須項目欠落のショートサーキット。
  // ルール本体は skills/forrent.js#checkRequiredFromReinsData。
  const required = forrent.checkRequiredFromReinsData(reinsData);

  // 入稿記録: 抽出したテキスト(現況・入居可能時期など)を Notion DB に追記。
  // forrent 必須チェック後の OK/REG_FAIL を status として残す。
  await recordToNotion({
    reinsId,
    reinsData,
    status: required.ok ? "OK" : "REG_FAIL",
    logStep,
  });

  if (!required.ok) {
    console.error(`  -> ${required.missingField}未取得（forrent必須） → REG_FAIL早期確定`);
    logStep("missing_required_field", {
      field: required.missingField,
      物件種目: reinsData.物件種目,
    });
    const out = {
      status: "REG_FAIL",
      propertyName: required.missingField === "建物名" ? reinsId : reinsData.建物名,
      reason: required.reason,
    };
    writeStageOutput(runDir, STAGE, out);
    return out;
  }

  const out = {
    status: "OK",
    reinsData,
    propertyName: reinsData.建物名,
  };
  writeStageOutput(runDir, STAGE, out);
  return out;
}

module.exports = { runReinsExtract };
