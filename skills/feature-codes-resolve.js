/**
 * skills/feature-codes-resolve.js — Phase β 03b: Feature code resolution (SSOT)
 *
 * Resolve forrent.jp 特徴コード (categoryTokuchoCd) candidates from REINS data
 * and (optionally, Phase γ-δ) maisoku OCR text. Returns the final checkedCodes
 * array plus an evidence trail per code.
 *
 * SSOT FILTER POLICY (kento decision 2026-05-16, design doc Section 2):
 *   - The 150-code SSOT (config/forrent-feature-codes.json) filter is applied
 *     ONLY to the maisoku path. It exists to suppress OCR noise from the
 *     Phase γ-δ maisoku-text route.
 *   - The three legacy paths (setsubi keyword / building inference / FANGO
 *     defaults) emit codes WITHOUT the SSOT filter, so checkedCodes is bitwise
 *     identical to the legacy fillTokucho() output in skills/forrent/fill-tokucho.js.
 *   - Example: 2201 (クロゼット) is a FANGO default outside the 150 SSOT.
 *     Phase β must still emit it (legacy parity), and the maisoku path must
 *     reject it (SSOT filter, when Phase γ-δ is implemented).
 *
 * Pure function: no I/O, no side effects. All inputs must be passed explicitly.
 * Config (150-code SSOT) is passed as featureCodesConfig to enable unit testing
 * without filesystem access. lazy-init compliant (no env / FS at require time).
 *
 * The three existing paths (SETSUBI_TO_TOKUCHO keyword match,
 * inferTokuchoFromBuilding structural inference, DEFAULT_TOKUCHO_CODES FANGO
 * defaults) are migrated behavior-preserving from skills/forrent/fill-tokucho.js.
 * The maisoku path is a placeholder in Phase β and is materialised in Phase γ-δ.
 *
 * @typedef {Object} FeatureCodeEvidence
 * @property {"setsubi"|"building"|"default"|"maisoku"} source
 * @property {string} reason
 * @property {string} [matched]
 * @property {string} [snippet]  - maisoku source only; ~50-char context around match (Phase δ T003)
 *
 * @typedef {Object} ResolveFeatureCodesResult
 * @property {string[]} checkedCodes
 * @property {Object.<string, FeatureCodeEvidence[]>} evidence
 * @property {string} generated_at
 * @property {string[]} source_files
 */

const { norm } = require("./forrent/fill-texts");
const { isNegated } = require("./negation-filter");

// ── Phase δ T003: maisoku-route helpers ────────────────────
// Short labels (BS / CS / LAN / 駐輪場 etc) need word-boundary anchoring to
// avoid false positives in noisy OCR text. Phase-δ design Decision 1 threshold:
// labels whose NFC-folded length is < 4 use regex anchoring; longer labels
// use plain substring match (CJK has no spaces, so substring is the natural
// boundary above 4 chars).
const MAISOKU_SHORT_LABEL_LEN = 4;
const SNIPPET_WINDOW_EACH = 25; // chars before / after the match for the evidence snippet

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Extract a ~50-char snippet around the first occurrence of `normLabel`
 * inside `normText`. Whitespace runs are folded to a single space; edges
 * trimmed. Returns "" when the label is absent.
 */
function extractSnippet(normText, normLabel, windowEach) {
  const each = Number.isFinite(windowEach) ? windowEach : SNIPPET_WINDOW_EACH;
  const idx = normText.indexOf(normLabel);
  if (idx === -1) return "";
  const start = Math.max(0, idx - each);
  const end = Math.min(normText.length, idx + normLabel.length + each);
  return normText.slice(start, end).replace(/\s+/g, " ").trim();
}

/**
 * Match a single SSOT label against the normalised maisoku text.
 * Short labels (< MAISOKU_SHORT_LABEL_LEN) use word-boundary regex to avoid
 * substring noise (e.g. "BS" hitting inside "ABStract"). Longer multi-byte
 * labels rely on plain `includes()` since they are CJK and unlikely to be
 * accidental substrings of unrelated tokens.
 */
function maisokuLabelHit(normText, normLabel) {
  if (normLabel.length === 0) return false;
  if (normLabel.length < MAISOKU_SHORT_LABEL_LEN) {
    // Anchor with non-word, non-fullwidth-ASCII characters on both sides.
    // U+FF01-FF5E is the full-width ASCII range. \w covers a-z/A-Z/0-9/_
    // (after width-fold). We also treat preceding / trailing CJK chars as
    // non-word boundaries, which is the natural behaviour for short Latin
    // labels (BS, CS, LAN) appearing inside Japanese sentences.
    const re = new RegExp(`(?<![\\w\\uFF01-\\uFF5E])${escapeRegex(normLabel)}(?![\\w\\uFF01-\\uFF5E])`);
    return re.test(normText);
  }
  return normText.includes(normLabel);
}

// ══════════════════════════════════════════════════════════
//  3 経路定数 — behavior-preserving copy from
//  skills/forrent/fill-tokucho.js (do not edit semantics).
// ══════════════════════════════════════════════════════════

// Path C: FANGO デフォルト (REINS データに依らず常時投入)
const DEFAULT_TOKUCHO_CODES = [
  "0527", // 敷地内ごみ置き場
  "1436", // 都市ガス
  "2201", // クロゼット
  "2207", // シューズボックス
  "2724", // 保証人不要
  "2737", // IT重説 対応物件
];

// Path A: REINS 設備フリーテキスト → forrent.jp categoryTokuchoCd
const SETSUBI_TO_TOKUCHO = {
  // ── 交通・立地 ──
  "始発駅":             ["0101"],
  "駅前":               ["0110"],
  "閑静":               ["0122"],
  "オーシャンビュー":   ["0118"],
  "リバーサイド":       ["0119"],

  // ── 構造・建物 ──
  "耐震":               ["0201"],
  "制震":               ["0202"],
  "免震":               ["0203"],
  "二重床":             ["0208"],
  "二重天井":           ["0209"],
  "高気密":             ["0217"],
  "高断熱":             ["0218"],
  "タワー":             ["0231"],
  "デザイナーズ":       ["0233"],
  "分譲賃貸":           ["0256"],
  "分譲":               ["0256"],
  "バリアフリー":       ["0252"],
  "メゾネット":         ["1327"],
  "ロフト":             ["1326"],
  "平屋":               ["0230"],
  "吹抜":               ["0246"],
  "天井高2.5":          ["0247"],

  // ── 共用部 ──
  "エレベーター":       ["0501"],
  "エレベータ":         ["0501"],
  "宅配ボックス":       ["0517"],
  "24時間ゴミ":         ["0516"],
  "コインランドリー":   ["0520"],
  "駐輪場":             ["0816"],
  "バイク置場":         ["0817"],
  "平面駐車":           ["0813"],
  "トランクルーム":     ["2223"],
  "敷地内ごみ":         ["0527"],

  // ── セキュリティ ──
  "オートロック":       ["1201"],
  "ダブルロック":       ["1202"],
  "ディンプルキー":     ["1203"],
  "ディンプル":         ["1203"],
  "カードキー":         ["1204"],
  "電子ロック":         ["1205"],
  "電子キー":           ["1206"],
  "防犯カメラ":         ["1211"],
  "防犯ガラス":         ["1212"],
  "セキュリティ":       ["1218"],
  "セキュリティ会社":   ["1218"],
  "24時間管理":         ["1215"],
  "TVインターホン":     ["2414"],
  "モニター付きインターホン": ["2414"],
  "TVモニタ":           ["2414"],
  "モニタ付":           ["2414"],
  "インターホン":       ["2414"],

  // ── 居室 ──
  "角部屋":             ["1007"],
  "角住戸":             ["1007"],
  "振分":               ["1331"],
  "全居室洋室":         ["1333"],
  "和室":               ["1311"],
  "サンルーム":         ["1324"],
  "書斎":               ["1323"],
  "防音室":             ["1320"],
  "玄関ポーチ":         ["1328"],

  // ── キッチン ──
  "システムキッチン":   ["1401"],
  "独立型キッチン":     ["1402"],
  "独立キッチン":       ["1402"],
  "カウンターキッチン": ["1403"],
  "対面式キッチン":     ["1403"],
  "対面式":             ["1403"],
  "アイランドキッチン": ["1408"],
  "ガスコンロ":         ["1412"],
  "ガスレンジ":         ["1413"],
  "ガスコンロ（３口以上）": ["1415"],
  "3口以上":            ["1415"],
  "3口":                ["1415"],
  "ＩＨ":               ["1416"],
  "IH":                 ["1416"],
  "グリル":             ["1418"],
  "ガラストップ":       ["1421"],
  "食器洗":             ["1430"],
  "食洗":               ["1430"],
  "食洗機":             ["1430"],
  "浄水器":             ["1433"],
  "ディスポーザー":     ["1434"],
  "都市ガス":           ["1436"],
  "プロパン":           ["1437"],

  // ── バス・トイレ・洗面 ──
  "バストイレ別":       ["1501"],
  "BT別":               ["1501"],
  "浴室1坪":            ["1502"],
  "脱衣所":             ["1503"],
  "脱衣":               ["1503"],
  "オートバス":         ["1504"],
  "自動湯張":           ["1504"],
  "追い焚き":           ["1505"],
  "追焚":               ["1505"],
  "浴室乾燥機":         ["1507"],
  "浴室乾燥":           ["1507"],
  "ミストサウナ":       ["1513"],
  "シャワールーム":     ["1518"],
  "温水洗浄便座":       ["1603"],
  "ウォシュレット":     ["1603"],
  "タンクレス":         ["1604"],
  "トイレ2ヶ所":        ["1601"],
  "独立洗面":           ["1701"],
  "洗面所独立":         ["1701"],
  "洗面化粧台":         ["1707"],
  "三面鏡":             ["1708"],
  "シャワー付洗面":     ["1710"],

  // ── 冷暖房・換気 ──
  "24時間換気":         ["1801"],
  "床暖房":             ["1806"],
  "蓄熱":               ["1808"],
  "エアコン":           ["2801"],

  // ── 電気・エネルギー ──
  "オール電化":         ["1901"],
  "太陽光":             ["1902"],
  "エコキュート":       ["1904"],
  "エコジョーズ":       ["1905"],

  // ── バルコニー ──
  "バルコニー":         ["2001"],
  "ベランダ":           ["2001"],
  "ルーフバルコニー":   ["2002"],
  "ワイドバルコニー":   ["2003"],
  "ウッドデッキ":       ["2011"],
  "テラス":             ["2012"],

  // ── 室内設備 ──
  "フローリング":       ["2101"],
  "クッションフロア":   ["2105"],
  "無垢材":             ["2107"],
  "琉球畳":             ["2110"],
  "雨戸":               ["2116"],
  "シャッター":         ["2117"],
  "複層ガラス":         ["2122"],
  "ペアガラス":         ["2122"],
  "室内洗濯":           ["2129"],
  "洗濯機置場":         ["2129"],
  "室内物干":           ["2130"],
  "シーリングファン":   ["2132"],

  // ── 収納 ──
  "クロゼット":         ["2201"],
  "ウォークインクロゼット": ["2204"],
  "ウォークイン":       ["2204"],
  "WIC":                ["2204"],
  "シューズボックス":   ["2207"],
  "シューズクローゼット": ["2209"],
  "納戸":               ["2215"],
  "床下収納":           ["2221"],

  // ── 通信 ──
  "BS":                 ["2401"],
  "CS":                 ["2401"],
  "CATV":               ["2404"],
  "ネット使用料不要":   ["2406"],
  "光ファイバー":       ["2410"],
  "インターネット":     ["2408"],
  "高速ネット":         ["2408"],
  "LAN":                ["2413"],

  // ── リフォーム ──
  "リフォーム済":       ["2601"],
  "リノベーション":     ["2609"],
  "リノベ":             ["2609"],

  // ── 条件 ──
  "即入居":             ["2701"],
  "ペット":             ["2705"],
  "ペット可":           ["2705"],
  "ペット相談":         ["2705"],
  "楽器":               ["2711"],
  "楽器可":             ["2711"],
  "楽器相談":           ["2711"],
  "事務所":             ["2710"],
  "ルームシェア":       ["2709"],
  "保証人不要":         ["2724"],
  "保証会社":           ["2725"],
  "フリーレント":       ["2732"],
  "DIY":                ["2736"],
  "家具付":             ["2815"],
  "家具":               ["2815"],
  "照明付":             ["2817"],
  "眺望":               ["2901"],
  "通風":               ["2902"],
  "陽当り":             ["2903"],
  "日当たり":           ["2903"],
  "南向き":             ["1001"],

  // ── Additional mappings for coverage ──
  // 交通・立地
  "2沿線":              ["0103"],
  "3沿線":              ["0105"],
  "2駅":                ["0102"],
  "3駅":                ["0104"],

  // セキュリティ追加
  "管理人":             ["1215"],
  "コンシェルジュ":     ["1216"],
  "管理人常駐":         ["1215"],

  // キッチン追加
  "2口コンロ":          ["1414"],
  "2口":                ["1414"],
  "コンロ2口":          ["1414"],
  "食器棚":             ["1431"],

  // バス追加
  "追い炊き":           ["1505"],
  "おいだき":           ["1505"],

  // 室内設備追加
  "二重サッシ":         ["2122"],
  "ペアサッシ":         ["2122"],
  "出窓":               ["2115"],
  "ルームクリーニング": ["2601"],
  "クリーニング済":     ["2601"],

  // 収納追加
  "W.I.C":              ["2204"],
  "W.I.C.":             ["2204"],
  "ウォークスルー":     ["2205"],
  "パントリー":         ["2216"],

  // 通信追加
  "Wi-Fi":              ["2408"],
  "WiFi":               ["2408"],
  "無料インターネット": ["2406"],
  "ネット無料":         ["2406"],

  // 共用部追加
  "ゲストルーム":       ["0524"],
  "ラウンジ":           ["0525"],
  "フィットネス":       ["0523"],
  "ジム":               ["0523"],
  "キッズルーム":       ["0526"],
  "屋上":               ["0528"],

  // 条件追加
  "2人入居可":          ["2704"],
  "二人入居可":         ["2704"],
  "女性限定":           ["2706"],
  "女性専用":           ["2706"],
  "初期費用カード":     ["2734"],
  "クレジットカード":   ["2734"],
  "家賃カード":         ["2733"],
};

// ══════════════════════════════════════════════════════════
//  Path B: 建物属性から推定 (behavior-preserving copy)
//  Returns Map<code, evidence{reason,matched?}> instead of Set, so the caller
//  can attach per-code evidence. The set of codes is identical to the
//  inferTokuchoFromBuilding() in skills/forrent/fill-tokucho.js.
// ══════════════════════════════════════════════════════════

function inferTokuchoFromBuilding(reinsData) {
  const codes = new Map(); // code -> { reason, matched? }
  const add = (code, reason, matched) => {
    if (!codes.has(code)) {
      const entry = { reason };
      if (matched !== undefined) entry.matched = matched;
      codes.set(code, entry);
    }
  };
  const n = (s) => norm(s);

  // 階数からエレベーター推定 (4階以上 → ほぼ確実)
  const floorsRaw = n(reinsData.地上階層 || "");
  const floors = parseInt(floorsRaw, 10);
  if (floors >= 4) add("0501", `地上階層=${floors} ≥ 4F`, floorsRaw);

  // 交通情報から駅数・沿線数
  const transport = reinsData.交通 || [];
  if (transport.length >= 2) add("0102", `交通=${transport.length} 件 ≥ 2`);
  if (transport.length >= 3) add("0104", `交通=${transport.length} 件 ≥ 3`);
  const lines = new Set(transport.map((t) => t.沿線).filter(Boolean));
  if (lines.size >= 2) add("0103", `沿線=${lines.size} 件 ≥ 2`);
  if (lines.size >= 3) add("0105", `沿線=${lines.size} 件 ≥ 3`);

  // 徒歩分数
  const walk = transport.map((t) => parseInt(n(t.徒歩 || ""), 10)).filter((x) => !isNaN(x));
  if (walk.some((w) => w <= 5)) add("0129", "駅徒歩 ≤ 5 分");
  if (walk.some((w) => w <= 10)) add("0130", "駅徒歩 ≤ 10 分");

  // バルコニー方向
  const dir = n(reinsData.バルコニー方向 || "");
  if (dir.includes("南東") || dir.includes("東南")) {
    add("1002", "バルコニー方向=南東/東南", dir);
    add("2005", "バルコニー方向=南東/東南", dir);
  } else if (dir.includes("南西") || dir.includes("西南")) {
    add("1003", "バルコニー方向=南西/西南", dir);
    add("2005", "バルコニー方向=南西/西南", dir);
  } else if (dir === "南") {
    add("1001", "バルコニー方向=南", dir);
    add("2005", "バルコニー方向=南", dir);
  }
  if (dir.includes("角")) add("1007", "バルコニー方向に '角'", dir);

  // 敷金・礼金からの推定
  const shikikin = n(reinsData.敷金 || "");
  const reikin = n(reinsData.礼金 || "");
  if (/なし|0|ー|^$/.test(shikikin)) add("2712", "敷金=なし/0", shikikin);
  else if (/1ヶ?月/.test(shikikin)) add("2713", "敷金=1ヶ月", shikikin);
  else if (/2ヶ?月/.test(shikikin)) add("2714", "敷金=2ヶ月", shikikin);
  if (/なし|0|ー|^$/.test(reikin)) add("2719", "礼金=なし/0", reikin);
  else if (/1ヶ?月/.test(reikin)) add("2720", "礼金=1ヶ月", reikin);
  else if (/2ヶ?月/.test(reikin)) add("2721", "礼金=2ヶ月", reikin);
  if (/なし|0|ー/.test(shikikin) && /なし|0|ー/.test(reikin)) {
    add("2718", "敷金 & 礼金 ともに不要");
  }

  // 入居時期
  const nyukyo = n(reinsData.入居時期 || "");
  if (/即/.test(nyukyo)) add("2701", "入居時期=即", nyukyo);

  // 築年月からの推定
  const chiku = n(reinsData.築年月 || "");
  const builtYear = parseInt(chiku.match(/(\d{4})年/)?.[1] || "0", 10);
  const currentYear = new Date().getFullYear();
  if (builtYear && currentYear - builtYear <= 2) add("0701", `築${currentYear - builtYear}年 ≤ 2`, chiku);
  if (builtYear && currentYear - builtYear <= 3) add("0702", `築${currentYear - builtYear}年 ≤ 3`, chiku);
  if (builtYear && currentYear - builtYear <= 5) add("0703", `築${currentYear - builtYear}年 ≤ 5`, chiku);

  // 条件フリー / 備考3
  const cond = n(reinsData.条件フリー || "");
  const biko = n(reinsData.備考3 || "");
  const combined = cond + " " + biko;
  if (combined.includes("保証人不要")) add("2724", "条件/備考3 に '保証人不要'", "保証人不要");
  if (combined.includes("保証会社")) add("2725", "条件/備考3 に '保証会社'", "保証会社");
  if (combined.includes("フリーレント")) add("2732", "条件/備考3 に 'フリーレント'", "フリーレント");
  if (combined.includes("DIY")) add("2736", "条件/備考3 に 'DIY'", "DIY");
  if (combined.includes("リノベ")) add("2609", "条件/備考3 に 'リノベ'", "リノベ");
  if (combined.includes("リフォーム")) add("2601", "条件/備考3 に 'リフォーム'", "リフォーム");

  // 駐車場
  const parking = n(reinsData.駐車場在否 || "");
  if (/有|空有/.test(parking)) add("0816", `駐車場=${parking} → 駐輪場推定`, parking);

  return codes;
}

// ══════════════════════════════════════════════════════════
//  Internal: collect setsubi (Path A) candidates
// ══════════════════════════════════════════════════════════

function collectSetsubiCandidates(reinsData) {
  const textFields = [
    reinsData.設備フリー || "",
    reinsData.設備 || "",
    reinsData.条件フリー || "",
    reinsData.備考1 || "",
    reinsData.備考2 || "",
    reinsData.備考3 || "",
    reinsData.その他一時金 || "",
  ].map(norm);

  // code -> evidence[]
  const candidates = new Map();
  for (const [keyword, codes] of Object.entries(SETSUBI_TO_TOKUCHO)) {
    const normKey = norm(keyword);
    if (textFields.some((t) => t.includes(normKey))) {
      for (const code of codes) {
        if (!candidates.has(code)) {
          candidates.set(code, {
            reason: `keyword '${keyword}' matched in REINS 設備/備考`,
            matched: keyword,
          });
        }
      }
    }
  }
  return candidates;
}

// ══════════════════════════════════════════════════════════
//  Public API
// ══════════════════════════════════════════════════════════

/**
 * Resolve feature codes from REINS data (+ optional maisoku text in Phase γ-δ).
 *
 * @param {object} opts
 * @param {object}   opts.reinsData
 * @param {object}   opts.featureCodesConfig - Parsed config/forrent-feature-codes.json
 * @param {string|null} [opts.maisokuText]   - null until Phase γ-δ; placeholder in Phase β
 * @returns {ResolveFeatureCodesResult}
 */
function resolveFeatureCodes({ reinsData, featureCodesConfig, maisokuText = null }) {
  if (!reinsData || typeof reinsData !== "object") {
    throw new TypeError("resolveFeatureCodes: reinsData must be an object");
  }
  if (!featureCodesConfig || !Array.isArray(featureCodesConfig.codes)) {
    throw new TypeError(
      "resolveFeatureCodes: featureCodesConfig must have a codes[] array (config/forrent-feature-codes.json shape)"
    );
  }

  // The 150-code SSOT. Used ONLY by the maisoku path below — NOT by the three
  // legacy paths, which must remain bitwise-parity with fill-tokucho.js.
  const allowedCodes = new Set(featureCodesConfig.codes.map((c) => c.code));

  // code -> evidence[]. No filtering here; legacy paths emit unconditionally.
  const evidence = {};
  const addEvidence = (code, entry) => {
    if (!evidence[code]) evidence[code] = [];
    evidence[code].push(entry);
  };

  // Path A: setsubi keyword match (no SSOT filter — legacy parity)
  const setsubi = collectSetsubiCandidates(reinsData);
  for (const [code, ev] of setsubi.entries()) {
    addEvidence(code, { source: "setsubi", reason: ev.reason, matched: ev.matched });
  }

  // Path B: building inference (no SSOT filter — legacy parity)
  const building = inferTokuchoFromBuilding(reinsData);
  for (const [code, ev] of building.entries()) {
    const entry = { source: "building", reason: ev.reason };
    if (ev.matched !== undefined) entry.matched = ev.matched;
    addEvidence(code, entry);
  }

  // Path C: FANGO defaults (no SSOT filter — legacy parity).
  // Always emitted regardless of REINS data, including out-of-SSOT codes
  // like 2201 (クロゼット). The maisoku path is the only consumer of the
  // 150-SSOT filter.
  for (const code of DEFAULT_TOKUCHO_CODES) {
    addEvidence(code, { source: "default", reason: "FANGO default tokucho" });
  }

  // Path D: maisoku OCR (Phase δ T003 — materialised from Phase β placeholder)
  //
  // Iterate the 150-SSOT and emit codes whose label is found in the maisoku
  // text. SSOT filter is implicit: only labels present in `featureCodesConfig`
  // are considered, so out-of-SSOT codes (e.g. 2201 from FANGO defaults) can
  // never be sourced from the maisoku path.
  //
  // Negation filter (T002) suppresses post-keyword negations such as
  // "ペット不可" / "オートロックなし" / "別途契約". The window is 15 chars
  // after the label; see skills/negation-filter.js for the patterns.
  //
  // When `maisokuText` is null / empty / non-string, this block is a no-op
  // and the output is bitwise identical to the Phase β three-path Set.
  let maisokuRouteFired = false;
  if (typeof maisokuText === "string" && maisokuText.length > 0) {
    const normText = norm(maisokuText);
    if (normText.length > 0) {
      for (const entry of featureCodesConfig.codes) {
        if (!entry || typeof entry.code !== "string") continue;
        if (!allowedCodes.has(entry.code)) continue; // SSOT filter (maisoku only)
        const label = entry.label;
        if (typeof label !== "string" || label.length === 0) continue;
        const normLabel = norm(label);
        if (normLabel.length === 0) continue;

        if (!maisokuLabelHit(normText, normLabel)) continue;

        // T002 negation filter — pass the raw (pre-norm) text so the helper's
        // own NFC + width-fold normalisation aligns with the original label.
        const neg = isNegated(maisokuText, label);
        if (neg && neg.negated) continue;

        maisokuRouteFired = true;
        addEvidence(entry.code, {
          source: "maisoku",
          reason: `label '${label}' found in maisoku-text`,
          matched: label,
          snippet: extractSnippet(normText, normLabel),
        });
      }
    }
  }

  const checkedCodes = Object.keys(evidence).sort();

  const source_files = ["config/forrent-feature-codes.json"];
  if (maisokuRouteFired) {
    // Informative: the actual file read is owned by the 03b stage (T004);
    // this path is the conventional location it writes to.
    source_files.push("02c-maisoku-text-extract/output.json");
  }

  return {
    checkedCodes,
    evidence,
    generated_at: new Date().toISOString(),
    source_files,
  };
}

module.exports = {
  resolveFeatureCodes,
  // Exported for parity testing only. New callers should use resolveFeatureCodes()
  // via the Phase β 03b stage; these will be removed when fill-tokucho.js
  // is reduced to a thin wrapper in T004.
  SETSUBI_TO_TOKUCHO,
  DEFAULT_TOKUCHO_CODES,
  inferTokuchoFromBuilding,
};
