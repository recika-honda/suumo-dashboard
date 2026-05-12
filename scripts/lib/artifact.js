/**
 * artifact.js — stage の入出力をファイルに残すユーティリティ
 *
 * パイプラインの中間状態をファイル化することで:
 *  - 途中で落ちたとき指定 stage から resume 可能 (`scripts/resume-nyuko.js`)
 *  - プロンプト変更時に同じ artifact に対する A/B 比較が可能
 *  - 障害時の事後解析が容易
 *
 * ファイル配置:
 *   {runDir}/{stageName}/input.json   stage 入力 (Playwright ハンドル等は除外)
 *   {runDir}/{stageName}/output.json  stage 出力 (同上)
 *
 * Playwright ハンドル (Page / Frame / BrowserContext / Browser / ElementHandle) と
 * 関数、循環参照はシリアライズから除外する。Buffer は標準 toJSON でそのまま展開される
 * (実 stage 出力に Buffer は含めない前提)。
 */

const fs = require("fs");
const path = require("path");

/**
 * Stage の入力/出力に含まれるシリアライズ不可な値 (Playwright Page/Frame/Context、
 * Buffer、循環参照を作る関数) を null 置換する replacer。
 */
function safeReplacer() {
  const seen = new WeakSet();
  return function (key, value) {
    if (value === null || value === undefined) return value;
    const t = typeof value;
    if (t === "function") return null;
    if (t !== "object") return value;

    // 既知の Playwright ハンドル相当 (関数を持つ複雑 object) を除外
    // Page / Frame / BrowserContext は constructor 名で識別
    const ctor = value.constructor && value.constructor.name;
    if (
      ctor === "Page" ||
      ctor === "Frame" ||
      ctor === "BrowserContext" ||
      ctor === "Browser" ||
      ctor === "ElementHandle"
    ) {
      return `[${ctor}]`;
    }
    if (seen.has(value)) return "[Circular]";
    seen.add(value);
    return value;
  };
}

function ensureStageDir(runDir, stageName) {
  const dir = path.join(runDir, stageName);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function writeStageJson(runDir, stageName, fileName, data) {
  if (!runDir) return; // runDir 未指定時は no-op
  try {
    const dir = ensureStageDir(runDir, stageName);
    const json = JSON.stringify(data, safeReplacer(), 2);
    fs.writeFileSync(path.join(dir, fileName), json);
  } catch (e) {
    // artifact 書き込みは non-critical。落ちても pipeline は止めない
    console.error(`[artifact] write failed (${stageName}/${fileName}): ${e.message}`);
  }
}

function readStageJson(runDir, stageName, fileName) {
  if (!runDir) return null;
  try {
    const filePath = path.join(runDir, stageName, fileName);
    if (!fs.existsSync(filePath)) return null;
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (e) {
    console.error(`[artifact] read failed (${stageName}/${fileName}): ${e.message}`);
    return null;
  }
}

function writeStageInput(runDir, stageName, data) {
  writeStageJson(runDir, stageName, "input.json", data);
}

function writeStageOutput(runDir, stageName, data) {
  writeStageJson(runDir, stageName, "output.json", data);
}

function readStageInput(runDir, stageName) {
  return readStageJson(runDir, stageName, "input.json");
}

function readStageOutput(runDir, stageName) {
  return readStageJson(runDir, stageName, "output.json");
}

module.exports = {
  writeStageInput,
  writeStageOutput,
  readStageInput,
  readStageOutput,
};
