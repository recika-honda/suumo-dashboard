/**
 * skills/forrent/constants.js — forrent.jp 関連の定数 (URLs / Selectors / コード変換表)
 *
 * 元: skills/forrent.js (Phase 7 分割前)
 *
 * これらの定数は forrent.js 内の複数モジュール (fill-form / fill-images / fill-shuhen 等)
 * から参照されるため、独立モジュールに切り出して single source of truth とする。
 *
 * - S: Struts form name prefix (HTML上のリテラル文字列)
 * - FORRENT_URLS / FORRENT_SELECTORS: ログイン・ナビゲーション用
 * - STRUCTURE_CODE: REINS の構造 → forrent コード
 * - MADORI_TYPE_CODE: REINS の間取タイプ → forrent コード
 * - SHUHEN_CATEGORY_CODES: 周辺環境カテゴリコード単一ソース
 */

// ── URLs & Selectors ──

const FORRENT_URLS = {
  login: "https://www.fn.forrent.jp/fn/",
};

const FORRENT_SELECTORS = {
  login: {
    idInput: 'input[type="text"]',
    passInput: 'input[type="password"]',
    submitBtn: 'input[type="image"]',
  },
  navi: {
    menuNewProperty: "#menu_2",
  },
};

// ── REINS → forrent.jp 値マッピング ──

// Struts form name prefix (HTML上のリテラル文字列)
const S = "${bukkenInputForm.";

// 構造 code
const STRUCTURE_CODE = {
  RC: "01", ＲＣ: "01", 鉄筋コンクリート: "01", "鉄筋コン": "01",
  SRC: "02", ＳＲＣ: "02", 鉄骨鉄筋コンクリート: "02", "鉄骨鉄筋": "02",
  PC: "03", "プレコン": "03",
  HPC: "04", "鉄骨プレ": "04",
  W: "05", 木造: "05",
  S: "06", Ｓ: "06", 鉄骨: "06",
  LS: "07", 軽量鉄骨: "07",
  ALC: "08", "気泡コン": "08",
  CB: "09", ブロック: "09",
  その他: "99",
};

// 間取りタイプ code
const MADORI_TYPE_CODE = {
  ワンルーム: "01", K: "02", Ｋ: "02", DK: "03", ＤＫ: "03",
  SDK: "04", LDK: "05", ＬＤＫ: "05", SLDK: "06",
  LK: "07", SK: "08", SLK: "09",
};

// ── 周辺環境カテゴリコード（単一ソース） ──
const SHUHEN_CATEGORY_CODES = {
  "060201": "ショッピングセンター",
  "060202": "スーパー",
  "060203": "コンビニ",
  "060204": "ドラッグストア",
  "060207": "学校",
  "060210": "病院",
  "060211": "郵便局",
  "060218": "飲食店",
};

module.exports = {
  FORRENT_URLS,
  FORRENT_SELECTORS,
  S,
  STRUCTURE_CODE,
  MADORI_TYPE_CODE,
  SHUHEN_CATEGORY_CODES,
};
