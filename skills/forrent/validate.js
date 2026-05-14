/**
 * skills/forrent/validate.js — 純粋関数: REINS データの forrent 入稿前 validation
 *
 * 元: skills/forrent.js (Phase 7 分割前)
 *
 * Public surface:
 *   - resolvePropertyTypeCode(shumoku)
 *   - validateBySpec(reinsData, spec)
 *   - appliesToMatches(appliesTo, reinsData)
 *   - checkRequiredFromReinsData(reinsData)
 *
 * 設計の正典: config/forrent-required.spec.json + docs/refactor/adding-required-field.md
 */

// 物件種別 code
// REINSは "タウン" / "戸建" 等の短縮形を返すことがあるため略称も許容する。
// どれにもマッチしない場合のフォールバックは下の resolvePropertyTypeCode() で。
const PROPERTY_TYPE_CODE = {
  マンション: "01", アパート: "02", "一戸建て": "11", "一戸建": "11", 戸建: "11",
  "テラス・タウンハウス": "16", テラスハウス: "16", タウンハウス: "16", タウン: "16", テラス: "16",
  その他: "99",
};

// REINSの物件種目 → forrent物件種別コード。dict miss 時は部分一致でフォールバック。
function resolvePropertyTypeCode(shumoku) {
  if (!shumoku) return null;
  const key = String(shumoku).trim();
  const exact = PROPERTY_TYPE_CODE[key];
  if (exact) return exact;
  if (/タウン|テラス/.test(key)) return "16";
  if (/マンション|ＭＳ/i.test(key)) return "01";
  if (/アパート/.test(key)) return "02";
  if (/戸建|一戸/.test(key)) return "11";
  return null;
}

/**
 * spec を使って reinsData の必須項目をバリデートする汎用 evaluator。
 *
 * spec 形式 (config/forrent-required.spec.json):
 *   {
 *     "fields": [
 *       {
 *         "key": "建物名",                      // reinsData の field name
 *         "appliesTo": "ALL",                  // または { "<key>": ["値1", "値2"] }
 *         "rejectReason": "..."                // missingField 時に返す reason
 *       }
 *     ]
 *   }
 *
 * 値の欠落判定は `trim + falsy` で統一 (空文字 / 全空白 / null / undefined を欠落扱い)。
 * 元コードでは 建物名 のみ trim していたが、spec 化に伴い 部屋番号 にも適用される
 * (より strict な方向の小さな挙動変更、forrent サーバ側でどちらにせよ弾かれる)。
 *
 * @param {object} reinsData
 * @param {object} spec - config/forrent-required.spec.json の中身
 * @returns {{ok: true} | {ok: false, missingField: string, reason: string}}
 */
function validateBySpec(reinsData, spec) {
  if (!spec || !Array.isArray(spec.fields)) return { ok: true };

  for (const field of spec.fields) {
    if (!appliesToMatches(field.appliesTo, reinsData)) continue;
    const value = reinsData[field.key];
    const trimmed = value ? String(value).trim() : "";
    if (!trimmed) {
      return {
        ok: false,
        missingField: field.key,
        reason: field.rejectReason,
      };
    }
  }
  return { ok: true };
}

/**
 * spec の appliesTo 条件が reinsData にマッチするか判定。
 *  - "ALL"                            → 常にマッチ
 *  - { "物件種目": ["マンション"] }   → reinsData.物件種目 が配列に含まれるならマッチ
 */
function appliesToMatches(appliesTo, reinsData) {
  if (appliesTo === "ALL") return true;
  if (!appliesTo || typeof appliesTo !== "object") {
    console.warn(`[forrent.spec] malformed appliesTo: ${JSON.stringify(appliesTo)} → skipped`);
    return false;
  }
  // 複数キーは AND 合成 (将来 OR が必要なら spec を `[{...}, {...}]` 形式にする)
  for (const [key, allowedValues] of Object.entries(appliesTo)) {
    if (!Array.isArray(allowedValues)) {
      console.warn(
        `[forrent.spec] malformed appliesTo entry "${key}": expected array, got ${typeof allowedValues} → skipped`
      );
      return false;
    }
    if (!allowedValues.includes(reinsData[key])) return false;
  }
  return true;
}

const REQUIRED_SPEC = require("../../config/forrent-required.spec.json");

/**
 * REINS から抽出した物件データが forrent.jp の必須項目を満たすかチェックする。
 *
 * 実装はすべて `validateBySpec` + `config/forrent-required.spec.json` に集約。
 * 新しい必須項目を踏んだら spec JSON に 1 entry 追加するだけで早期ショートサーキットが
 * 有効になる (skills/forrent.js のコードは触らない)。
 *
 * @param {object} reinsData
 * @returns {{ok: true} | {ok: false, missingField: string, reason: string}}
 */
function checkRequiredFromReinsData(reinsData) {
  return validateBySpec(reinsData, REQUIRED_SPEC);
}

module.exports = {
  PROPERTY_TYPE_CODE,
  resolvePropertyTypeCode,
  validateBySpec,
  appliesToMatches,
  checkRequiredFromReinsData,
};
