/**
 * notion-feedback.js — 入稿結果を Notion DB に書き戻すためのフィードバック構築
 *
 * Phase 7.5 (2026-05-14): REG_FAIL / TIMEOUT / ERROR を Notion で「入稿失敗」に
 * フリップするとき、failure reason と category も同時に書き込めるよう設計。
 *
 * Phase 2 (2026-05-15): IMAGE_INSUFFICIENT (Stage 02 早期 exit) も
 * 失敗カテゴリ="データ不備" + 入稿失敗理由="REINS 画像 N 枚..." で同居させる
 * (Notion Status 自体は "画像欠落" にフリップ、resolveNotionStatus 側で判定)。
 *
 * 必要な Notion DB プロパティ (kento が手動で追加):
 *   - 入稿失敗理由  (Rich text)   失敗理由の生テキスト
 *   - 失敗カテゴリ  (Select)      "データ不備" / "forrent 検証失敗" / "想定外エラー" / "タイムアウト"
 *
 * 該当プロパティが Notion DB に存在しない場合、batch-nyuko 側で try/catch して
 * パイプライン自体は止めない (graceful degradation)。
 *
 * Public surface:
 *   - categorizeError(result)      result.status / reason / errors からカテゴリを判定 (純粋関数)
 *   - buildReasonText(result)      reason 表示用テキスト (改行区切り、1500 char clamp)
 *   - buildFeedbackProperties(result)  Notion properties payload を組み立てる
 */

const CATEGORY = {
  DATA: "データ不備",
  FORRENT: "forrent 検証失敗",
  ERROR: "想定外エラー",
  TIMEOUT: "タイムアウト",
};

/**
 * processProperty の戻り値からカテゴリを判定する。
 *
 *   REG_FAIL with reason (Stage 01 早期 reject) → データ不備
 *   REG_FAIL with errors[] (Stage 06 forrent server reject) → forrent 検証失敗
 *   NOT_FOUND (REINS 検索 0 件) → データ不備
 *   IMAGE_INSUFFICIENT (Stage 02 早期 exit) → データ不備
 *   TIMEOUT → タイムアウト
 *   ERROR → 想定外エラー
 *   その他 (SUCCESS / FORRENT_LOGIN_FAIL) → null (Notion 書き込まない)
 */
function categorizeError(result) {
  if (!result || !result.status) return null;
  switch (result.status) {
    case "NOT_FOUND":
      return CATEGORY.DATA;
    case "REG_FAIL":
      // Stage 01 早期 reject は reason フィールドのみ、forrent 検証失敗は errors[] が伴う
      if (Array.isArray(result.errors) && result.errors.length > 0) {
        return CATEGORY.FORRENT;
      }
      // 元コードでは reinsData 欠落系も REG_FAIL (reason 付き) で返るのでデータ不備に倒す
      return CATEGORY.DATA;
    case "IMAGE_INSUFFICIENT":
      return CATEGORY.DATA;
    case "TIMEOUT":
      return CATEGORY.TIMEOUT;
    case "ERROR":
      return CATEGORY.ERROR;
    default:
      return null;
  }
}

/**
 * Notion Rich text に書く failure reason テキストを組み立てる。
 *
 *   - REG_FAIL (Stage 01) → result.reason (例: "REINSデータに建物名がありません")
 *   - REG_FAIL (Stage 06) → result.errors[].join("\n") (max 3 件)
 *   - TIMEOUT / ERROR → result.error
 *   - NOT_FOUND → "REINS検索 0 件"
 *
 * 1500 char で clamp (Notion API は 2000 char/text block。マージン込み)。
 */
function buildReasonText(result) {
  if (!result || !result.status) return "";
  let text = "";
  if (result.status === "NOT_FOUND") {
    text = "REINS検索 0 件 (物件番号が REINS に存在しない)";
  } else if (result.status === "REG_FAIL") {
    if (Array.isArray(result.errors) && result.errors.length > 0) {
      const lines = result.errors.slice(0, 3).map((e) => `・${e}`);
      if (result.errors.length > 3) lines.push(`...(他 ${result.errors.length - 3} 件)`);
      text = lines.join("\n");
    } else {
      text = result.reason || "(理由不明)";
    }
  } else if (result.status === "IMAGE_INSUFFICIENT") {
    const n = typeof result.rawCount === "number" ? result.rawCount : "?";
    text = `REINS 画像 ${n} 枚 (閾値以下) — 元付業者の画像未登録、または REINS 側の登録漏れ。素材依頼が必要。`;
  } else if (result.status === "TIMEOUT") {
    text = result.error || "15 分以内に処理が完了しなかった";
  } else if (result.status === "ERROR") {
    text = result.error || "想定外の例外が発生";
  }
  return text.slice(0, 1500);
}

/**
 * batch-nyuko / watch-nyuko から Notion を「入稿失敗」にフリップするときの
 * properties payload を組み立てる。
 *
 * 戻り値は notion.pages.update({ properties }) にそのまま渡せる形。
 * Status プロパティは含めない (呼び出し側で先に決定済みなので)。
 */
function buildFeedbackProperties(result) {
  const category = categorizeError(result);
  if (!category) return {};

  const reason = buildReasonText(result);
  const props = {
    "失敗カテゴリ": { select: { name: category } },
  };
  if (reason) {
    props["入稿失敗理由"] = {
      rich_text: [{ type: "text", text: { content: reason } }],
    };
  }
  return props;
}

module.exports = {
  CATEGORY,
  categorizeError,
  buildReasonText,
  buildFeedbackProperties,
};
