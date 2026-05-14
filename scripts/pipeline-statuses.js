/**
 * pipeline-statuses.js
 *
 * processProperty が返す result status と、Notion 「広告待ち」DB の Status カラム
 * (掲載保留 / 入稿失敗 / 画像欠落 / 広告待ち維持) との対応を一元管理する。
 *
 * 失敗系の分類:
 *   - データ起因 (REG_FAIL / NOT_FOUND): retry しても結果が変わらないので
 *     Notion を「入稿失敗」にフリップして retry loop を止める。
 *   - 素材不足 (IMAGE_INSUFFICIENT): REINS 元データの画像枚数が閾値以下で
 *     残り stage を走らせる価値がない。Notion を「画像欠落」にフリップして
 *     素材依頼ワークフローへハンドオフ。Phase 3 (物確 cascade) 実装後は
 *     cascade 試行後の最終 fallback としても使う。
 *   - 環境 / transient (FORRENT_LOGIN_FAIL / TIMEOUT / ERROR): 「広告待ち」のまま
 *     維持して次のポーリングサイクルで自動リトライさせる。
 */

/** processProperty 系が返しうる result.status の全列挙。 */
const RESULT_STATUSES = [
  "SUCCESS",
  "NOT_FOUND",
  "REG_FAIL",
  "IMAGE_INSUFFICIENT",
  "FORRENT_LOGIN_FAIL",
  "TIMEOUT",
  "ERROR",
];

/**
 * result.status / result.escalated を Notion Status カラムの遷移先名に解決する。
 *
 * 後方互換: 第1引数に string を渡した場合は従来通り status 文字列として扱う
 * (escalated 情報は不明として 掲載保留 にフォールバック)。result object を
 * 渡せば escalated:true で SUCCESS のときは 掲載指示済み を返す。
 *
 * 未知の status は `null` (= 広告待ち維持) を返すが、サイレントに無限リトライ
 * ループへ落ちる温床になるため、`console.warn` で必ず痕跡を残す。
 *
 * @param {string|object} resultOrStatus - status 文字列 or { status, escalated }
 * @returns {string | null}
 *   - "掲載指示済み": SUCCESS かつ escalated:true (score >= threshold で昇格成功)
 *   - "掲載保留":     SUCCESS かつ escalated:false (通常 掲載保留 登録)
 *   - "入稿失敗":     データ起因の恒久失敗 → Notion を更新して retry loop 停止
 *   - "画像欠落":     REINS 画像が閾値以下 → 素材依頼ワークフローへハンドオフ
 *   - null:           transient 失敗 → Notion を更新せず「広告待ち」維持で次サイクルにリトライ
 */
function resolveNotionStatus(resultOrStatus) {
  const isObj = resultOrStatus && typeof resultOrStatus === "object";
  const status = isObj ? resultOrStatus.status : resultOrStatus;
  const escalated = isObj ? !!resultOrStatus.escalated : false;

  if (status === "SUCCESS") return escalated ? "掲載指示済み" : "掲載保留";
  if (status === "REG_FAIL" || status === "NOT_FOUND") return "入稿失敗";
  if (status === "IMAGE_INSUFFICIENT") return "画像欠落";
  if (!RESULT_STATUSES.includes(status)) {
    console.warn(`[pipeline-statuses] unknown result status: ${status} → 広告待ち維持で扱う`);
  }
  return null;
}

module.exports = {
  RESULT_STATUSES,
  resolveNotionStatus,
};
