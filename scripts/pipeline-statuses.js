/**
 * pipeline-statuses.js
 *
 * processProperty が返す result status と、Notion 「広告待ち」DB の Status カラム
 * (掲載保留 / 入稿失敗 / 広告待ち維持) との対応を一元管理する。
 *
 * 失敗系の分類:
 *   - データ起因 (REG_FAIL / NOT_FOUND): retry しても結果が変わらないので
 *     Notion を「入稿失敗」にフリップして retry loop を止める。
 *   - 環境 / transient (FORRENT_LOGIN_FAIL / TIMEOUT / ERROR): 「広告待ち」のまま
 *     維持して次のポーリングサイクルで自動リトライさせる。
 */

/** processProperty 系が返しうる result.status の全列挙。 */
const RESULT_STATUSES = [
  "SUCCESS",
  "NOT_FOUND",
  "REG_FAIL",
  "FORRENT_LOGIN_FAIL",
  "TIMEOUT",
  "ERROR",
];

/**
 * result.status を Notion Status カラムの遷移先名に解決する。
 *
 * 未知の status は `null` (= 広告待ち維持) を返すが、サイレントに無限リトライ
 * ループへ落ちる温床になるため、`console.warn` で必ず痕跡を残す。
 *
 * @param {string} resultStatus - processProperty / main の戻り値 status
 * @returns {string | null}
 *   - "掲載保留": 入稿成功 → Notion を更新
 *   - "入稿失敗": データ起因の恒久失敗 → Notion を更新して retry loop 停止
 *   - null:      transient 失敗 → Notion を更新せず「広告待ち」維持で次サイクルにリトライ
 */
function resolveNotionStatus(resultStatus) {
  if (resultStatus === "SUCCESS") return "掲載保留";
  if (resultStatus === "REG_FAIL" || resultStatus === "NOT_FOUND") return "入稿失敗";
  if (!RESULT_STATUSES.includes(resultStatus)) {
    console.warn(`[pipeline-statuses] unknown result status: ${resultStatus} → 広告待ち維持で扱う`);
  }
  return null;
}

module.exports = {
  RESULT_STATUSES,
  resolveNotionStatus,
};
