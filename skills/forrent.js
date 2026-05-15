/**
 * forrent.jp (SUUMO入稿) Skill — Phase 7 facade
 *
 * 元 3,136 LOC を skills/forrent/ 配下 11 モジュールに分割した後の thin facade。
 * 既存呼び出し側 (scripts/stages/*, api-server.js, runNyuko.js 等) は `skills/forrent` から
 * これまで通り import するだけで動く (public API 変更なし)。
 *
 * 分割の正典: docs/refactor/phase7-forrent-split.md
 *
 * 各モジュールの責務:
 *   - constants.js       URLs / Selectors / コード変換表 (STRUCTURE_CODE / MADORI_TYPE_CODE 等)
 *   - validate.js        REINS データの forrent 入稿前 validation (純粋関数)
 *   - form-helpers.js    fillById / fillByName / selectByName / setCheckbox 等の低レベル操作
 *   - session.js         login / navigateToNewProperty
 *   - fill-texts.js      fillTexts + norm / toFullWidth / sanitizeForLength
 *   - fill-tokucho.js    特徴項目チェックボックス + SETSUBI_TO_TOKUCHO mapping
 *   - fill-transport.js  fillTransportViaMap / fillTransportCascade / fillTransportRakuraku
 *   - fill-images.js     setFileInput / setImageCategory / uploadImages
 *   - fill-shuhen.js     fillShuhenKankyo / syncShuhenDestinationFields
 *   - fill-form.js       fillPropertyForm (棟情報/所在地/お金/間取り)
 *   - register.js        scrapeValidation / saveFrameArtifacts / registerProperty
 *
 * フォーム構造（入力順序）:
 * 1. 棟情報: 物件名, 階建, 部屋番号, 物件種別, 構造, 築年月
 * 2. 所在地: 都道府県→市郡区→町村(cascade)→字丁(cascade)→番地
 * 3. 会社間流通チェックボックス OFF
 * 4. 交通: らくらく交通入力 (id=rakurakuKotsu)
 * 5. お金: 賃料(万+千), 管理費(万+円), 敷金(ヶ月/万), 礼金(ヶ月/万)
 * 6. 間取り: 部屋数 + タイプ(select) + 面積(整数+小数)
 * 7. テキスト: bukkenCatch, netCatch, netFreeMemo, freeMemo
 * 8. 画像: 外観(gaikan), パース(perth), 室内(shitsunai), 写真1-3, 追加画像1-8
 */

const { validateBySpec, checkRequiredFromReinsData } = require("./forrent/validate");
const { login, navigateToNewProperty } = require("./forrent/session");
const { sanitizeForLength, toFullWidth, sanitizeForForrentText, fillTexts } = require("./forrent/fill-texts");
const { fillTokucho } = require("./forrent/fill-tokucho");
const {
  fillTransportViaMap,
  fillTransportCascade,
  fillTransportRakuraku,
} = require("./forrent/fill-transport");
const { uploadImages } = require("./forrent/fill-images");
const {
  fillShuhenKankyo,
  syncShuhenDestinationFields,
} = require("./forrent/fill-shuhen");
const { fillPropertyForm } = require("./forrent/fill-form");
const { registerProperty } = require("./forrent/register");

module.exports = {
  login,
  navigateToNewProperty,
  fillPropertyForm,
  fillTransportViaMap,
  fillTransportCascade,
  fillTransportRakuraku,
  fillTexts,
  uploadImages,
  fillTokucho,
  fillShuhenKankyo,
  syncShuhenDestinationFields,
  registerProperty,
  checkRequiredFromReinsData,
  validateBySpec,
  sanitizeForLength,
  toFullWidth,
  sanitizeForForrentText,
};
