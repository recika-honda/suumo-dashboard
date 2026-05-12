/**
 * Stage 04: AI text generation (キャッチコピー + フリーコメント)
 *
 * 設計: docs/refactor/stages.md §04-texts-generate
 */

const { generateTexts } = require("../../skills/text-ai");
const { writeStageInput, writeStageOutput } = require("../lib/artifact");

const STAGE = "04-texts-generate";

/**
 * @param {object} opts
 * @param {object} opts.reinsData
 * @param {(name: string, extra?: object) => void} opts.logStep
 * @param {string} [opts.runDir]
 * @returns {Promise<{ catchCopy: string, freeComment: string }>}
 */
async function runTextsGenerate({ reinsData, logStep, runDir }) {
  writeStageInput(runDir, STAGE, { reinsData });
  console.error("  [4/6] AIテキスト生成...");
  logStep("text_ai_start");
  const texts = await generateTexts(reinsData);
  console.error(`  キャッチ: "${texts.catchCopy}"`);
  logStep("texts_generated", {
    catchCopy: texts.catchCopy,
    hasFreeComment: !!texts.freeComment,
  });
  writeStageOutput(runDir, STAGE, texts);
  return texts;
}

module.exports = { runTextsGenerate };
