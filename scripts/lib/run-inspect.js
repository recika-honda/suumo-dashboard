/**
 * run-inspect.js — run dir 構造を読み取る純粋ヘルパー
 *
 * watch-nyuko の TIMEOUT 自動 resume で使用。
 *   - findResumeStage: runDir に残る {stage}/output.json を元に「次に再実行すべき stage」を返す
 *   - readRetryHistory / recordRetry: logs/retries.jsonl の I/O
 *
 * 関連:
 *   - 各 stage の出力規約: scripts/lib/artifact.js
 *   - 6 stage の順序定義: scripts/resume-nyuko.js#STAGES と必ず一致させる
 *   - resume の制約: docs/refactor/stages.md
 */

const fs = require("fs");
const path = require("path");

const STAGES = [
  "01-reins-extract",
  "02-images-download",
  "03-images-classify",
  "04-texts-generate",
  "05-forrent-fill",
  "06-forrent-register",
];

/**
 * runDir に存在する {stage}/output.json を順に確認し、次に再実行すべき stage 名を返す。
 *
 *   - 全 stage に output.json があれば「06 まで完了済 = resume 不要」→ null
 *   - 1 つも無ければ stage 01 から
 *   - 05-forrent-fill の output.json があっても forrentPage は復元不能なので
 *     06 単独 resume はできない → resume-nyuko 側の制約に合わせ stage 05 から再実行
 *
 * @param {string} runDir
 * @returns {string | null}
 */
function findResumeStage(runDir) {
  if (!runDir || !fs.existsSync(runDir)) return STAGES[0];

  let lastCompletedIdx = -1;
  for (let i = 0; i < STAGES.length; i++) {
    const outPath = path.join(runDir, STAGES[i], "output.json");
    if (fs.existsSync(outPath)) lastCompletedIdx = i;
    else break;
  }

  if (lastCompletedIdx === STAGES.length - 1) return null;
  let resumeIdx = lastCompletedIdx + 1;
  // 06 単独 resume は forrentPage 復元不能 → 05 から再実行
  if (resumeIdx === STAGES.length - 1) resumeIdx = STAGES.length - 2;
  return STAGES[resumeIdx];
}

function retriesPath(logsDir) {
  return path.join(logsDir, "retries.jsonl");
}

/**
 * logs/retries.jsonl を読み込み、reinsId をキーに「最後に retry した記録」を返す map。
 */
function readRetryHistory(logsDir) {
  const file = retriesPath(logsDir);
  const map = new Map();
  if (!fs.existsSync(file)) return map;
  const lines = fs.readFileSync(file, "utf8").split("\n").filter(Boolean);
  for (const line of lines) {
    try {
      const entry = JSON.parse(line);
      if (entry.reinsId) map.set(entry.reinsId, entry);
    } catch {}
  }
  return map;
}

/**
 * 同一 reinsId に対する「未終了 retry」が既に記録されていれば true。
 *
 * 「未終了」= result.status が "SUCCESS" 以外。SUCCESS まで届いたら過去履歴は無効化
 * (= 別タイミングで同じ物件が再度 TIMEOUT したら、もう 1 回は retry を許す)。
 */
function hasOpenRetry(history, reinsId, originalRunDir) {
  const prev = history.get(reinsId);
  if (!prev) return false;
  if (prev.originalRunDir !== originalRunDir) return false;
  return prev.result?.status !== "SUCCESS";
}

function recordRetry(logsDir, entry) {
  const file = retriesPath(logsDir);
  const line = JSON.stringify({ ts: new Date().toISOString(), ...entry }) + "\n";
  fs.appendFileSync(file, line);
}

module.exports = {
  STAGES,
  findResumeStage,
  readRetryHistory,
  hasOpenRetry,
  recordRetry,
};
