/**
 * Stage 06: forrent.jp register (確認画面 → 登録 → スコア検証)
 *
 * 設計: docs/refactor/stages.md §06-forrent-register
 *
 * 失敗の種類:
 *   - 登録試行が走ったが forrent バリデーションで蹴られた → REG_FAIL (errors 配列付き)
 *   - registerProperty 自体が throw した → REG_FAIL (errors 空、log のみ)
 *     ※ stage 内で catch して soft fail に変換 (元コードの semantic 維持、外側 try で
 *        ERROR ラベルにしない)
 *
 * caller (processProperty) は OK 経路で本 stage を呼んだ後、必ず forrentPage を
 * close する責務を負う。
 */

const forrent = require("../../skills/forrent");
const { writeStageInput, writeStageOutput } = require("../lib/artifact");

const STAGE = "06-forrent-register";

/**
 * @param {object} opts
 * @param {import("playwright").Page} opts.forrentPage
 * @param {import("playwright").Frame} opts.mainFrame
 * @param {string} [opts.runDir]
 * @param {(name: string, extra?: object) => void} opts.logStep
 * @returns {Promise<{
 *   status: "SUCCESS" | "REG_FAIL",
 *   score: number | null,
 *   registrationType: string | null,
 *   errors: Array<string>,
 * }>}
 */
async function runForrentRegister({ forrentPage, mainFrame, runDir, logStep }) {
  writeStageInput(runDir, STAGE, { hasForrentPage: !!forrentPage, hasMainFrame: !!mainFrame });
  console.error("  [6/6] 登録...");
  logStep("register_start");
  let regResult = { saved: false, registrationType: null };
  let exceptionMessage = null;
  try {
    regResult = await forrent.registerProperty(forrentPage, mainFrame, {
      artifactDir: runDir,
    });
    if (regResult.saved) {
      const scoreText = regResult.score ? ` (${regResult.score}pt/43pt)` : "";
      console.error(`  -> ${regResult.registrationType}完了${scoreText}`);
      logStep("register_success", { score: regResult.score });
    } else {
      const firstErr = (regResult.errors || [])[0] || regResult.error || "不明";
      console.error(`  -> 登録失敗: ${firstErr}`);
      if (regResult.errors && regResult.errors.length) {
        for (const e of regResult.errors.slice(0, 8)) console.error(`       - ${e}`);
      }
      logStep("register_failed", {
        error: regResult.error || null,
        errors: regResult.errors || [],
        score: regResult.score || null,
      });
    }
  } catch (e) {
    exceptionMessage = e.message.slice(0, 200);
    console.error(`  -> 登録エラー: ${exceptionMessage}`);
    logStep("register_exception", { error: exceptionMessage });
  }

  const out = {
    status: regResult.saved ? "SUCCESS" : "REG_FAIL",
    score: regResult.score || null,
    registrationType: regResult.registrationType,
    errors: regResult.errors || [],
    exceptionMessage,
  };
  writeStageOutput(runDir, STAGE, out);
  return out;
}

module.exports = { runForrentRegister };
