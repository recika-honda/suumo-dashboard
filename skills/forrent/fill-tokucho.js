/**
 * skills/forrent/fill-tokucho.js — forrent.jp 特徴項目チェックボックス
 *
 * 元: skills/forrent.js (Phase 7 分割前)
 *
 * Public surface:
 *   - fillTokucho(mainFrame, reinsData)
 *   - inferTokuchoFromBuilding(reinsData)  (内部利用想定だが分離テスト用に export)
 *
 * categoryTokuchoCd チェックボックスを REINS データから 2 系統で導出して打つ:
 *   1. SETSUBI_TO_TOKUCHO: 設備フリーテキスト/備考のキーワード → コード
 *   2. inferTokuchoFromBuilding: 階数/交通/敷礼金/築年月等の構造データから推定
 */

const { norm } = require("./fill-texts");

// ══════════════════════════════════════════════════════════
//  特徴項目チェックボックス
// ══════════════════════════════════════════════════════════

// 物件種別を問わず常にチェックする FANGO デフォルト特徴項目。
// REINS データ・キーワード推定とは独立に投入される。
const DEFAULT_TOKUCHO_CODES = [
  "0527", // 敷地内ごみ置き場
  "1436", // 都市ガス
  "2201", // クロゼット
  "2207", // シューズボックス
  "2724", // 保証人不要
  "2737", // IT重説 対応物件
];

// REINS設備フリーテキスト → forrent.jp categoryTokuchoCd value マッピング
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

// 建物属性から推定できる特徴項目（修正点13: 全マッピング）
function inferTokuchoFromBuilding(reinsData) {
  const codes = new Set();
  const n = (s) => norm(s);

  // 階数からエレベーター推定（4階以上 → ほぼ確実）
  const floors = parseInt(n(reinsData.地上階層 || ""), 10);
  if (floors >= 4) codes.add("0501"); // エレベーター

  // 交通情報から駅数・沿線数
  const transport = reinsData.交通 || [];
  if (transport.length >= 2) codes.add("0102"); // 2駅利用可
  if (transport.length >= 3) codes.add("0104"); // 3駅以上利用可
  const lines = new Set(transport.map(t => t.沿線).filter(Boolean));
  if (lines.size >= 2) codes.add("0103"); // 2沿線利用可
  if (lines.size >= 3) codes.add("0105"); // 3沿線以上利用可

  // 徒歩分数
  const walk = transport.map(t => parseInt(n(t.徒歩 || ""), 10)).filter(x => !isNaN(x));
  if (walk.some(w => w <= 5)) codes.add("0129"); // 駅徒歩5分以内
  if (walk.some(w => w <= 10)) codes.add("0130"); // 駅徒歩10分以内

  // バルコニー方向
  const dir = n(reinsData.バルコニー方向 || "");
  if (dir.includes("南東") || dir.includes("東南")) { codes.add("1002"); codes.add("2005"); }
  else if (dir.includes("南西") || dir.includes("西南")) { codes.add("1003"); codes.add("2005"); }
  else if (dir === "南") { codes.add("1001"); codes.add("2005"); }
  if (dir.includes("角")) codes.add("1007");

  // 敷金・礼金からの推定
  const shikikin = n(reinsData.敷金 || "");
  const reikin = n(reinsData.礼金 || "");
  if (/なし|0|ー|^$/.test(shikikin)) codes.add("2712"); // 敷金不要
  else if (/1ヶ?月/.test(shikikin)) codes.add("2713");   // 敷金1ヶ月
  else if (/2ヶ?月/.test(shikikin)) codes.add("2714");   // 敷金2ヶ月
  if (/なし|0|ー|^$/.test(reikin)) codes.add("2719");     // 礼金不要
  else if (/1ヶ?月/.test(reikin)) codes.add("2720");      // 礼金1ヶ月
  else if (/2ヶ?月/.test(reikin)) codes.add("2721");      // 礼金2ヶ月
  if (/なし|0|ー/.test(shikikin) && /なし|0|ー/.test(reikin)) codes.add("2718"); // 敷金・礼金不要

  // 入居時期
  const nyukyo = n(reinsData.入居時期 || "");
  if (/即/.test(nyukyo)) codes.add("2701"); // 即入居可

  // 築年月からの推定
  const chiku = n(reinsData.築年月 || "");
  const builtYear = parseInt(chiku.match(/(\d{4})年/)?.[1] || "0", 10);
  const currentYear = new Date().getFullYear();
  if (builtYear && currentYear - builtYear <= 2) codes.add("0701"); // 築2年以内
  if (builtYear && currentYear - builtYear <= 3) codes.add("0702"); // 築3年以内
  if (builtYear && currentYear - builtYear <= 5) codes.add("0703"); // 築5年以内

  // 条件フリー / 備考3
  const cond = n(reinsData.条件フリー || "");
  const biko = n(reinsData.備考3 || "");
  const combined = cond + " " + biko;
  if (combined.includes("保証人不要")) codes.add("2724");
  if (combined.includes("保証会社")) codes.add("2725");
  if (combined.includes("フリーレント")) codes.add("2732");
  if (combined.includes("DIY")) codes.add("2736");
  if (combined.includes("リノベ")) codes.add("2609");
  if (combined.includes("リフォーム")) codes.add("2601");

  // 駐車場
  const parking = n(reinsData.駐車場在否 || "");
  if (/有|空有/.test(parking)) {
    // 駐車場ありの場合は駐輪場もある可能性が高い
    codes.add("0816"); // 駐輪場
  }

  return codes;
}

/**
 * 特徴項目チェックボックスを設定
 * @param {Frame} mainFrame
 * @param {object} reinsData - REINS抽出データ
 */
async function fillTokucho(mainFrame, reinsData) {
  console.log("[forrent] === TOKUCHO (特徴項目) START ===");

  // 1. 設備系テキスト全てからマッチング（修正点13: スキャン範囲拡大）
  const textFields = [
    reinsData.設備フリー || "",
    reinsData.設備 || "",
    reinsData.条件フリー || "",
    reinsData.備考1 || "",
    reinsData.備考2 || "",
    reinsData.備考3 || "",
    reinsData.その他一時金 || "",
  ].map(norm);
  const codesToCheck = new Set();

  for (const [keyword, codes] of Object.entries(SETSUBI_TO_TOKUCHO)) {
    const normKey = norm(keyword);
    if (textFields.some(t => t.includes(normKey))) {
      for (const c of codes) codesToCheck.add(c);
    }
  }

  // 2. 建物属性から推定
  const inferred = inferTokuchoFromBuilding(reinsData);
  for (const c of inferred) codesToCheck.add(c);

  // 3. FANGO デフォルト (REINS データに依らず常時投入)
  for (const c of DEFAULT_TOKUCHO_CODES) codesToCheck.add(c);

  if (codesToCheck.size === 0) {
    console.log("[forrent] tokucho: no matching features found");
    return { checked: 0, codes: [] };
  }

  // 4. チェックボックスを設定
  const codesArray = [...codesToCheck];
  const result = await mainFrame.evaluate((codes) => {
    let checked = 0;
    const checkedCodes = [];
    for (const code of codes) {
      // categoryTokuchoCd のチェックボックスで value=code のものを探す
      const cb = document.querySelector(
        `input[type="checkbox"][name="\${bukkenInputForm.categoryTokuchoCd}"][value="${code}"]`
      );
      if (cb && !cb.checked) {
        cb.checked = true;
        cb.dispatchEvent(new Event("change", { bubbles: true }));
        checked++;
        // ラベル取得
        let label = "";
        if (cb.nextSibling) label = (cb.nextSibling.textContent || "").trim().slice(0, 30);
        checkedCodes.push({ code, label });
      }
    }
    return { checked, checkedCodes };
  }, codesArray);

  for (const { code, label } of result.checkedCodes) {
    console.log(`[forrent] + 特徴: ${code} (${label})`);
  }
  console.log(`[forrent] === TOKUCHO END === checked: ${result.checked}`);

  return { checked: result.checked, codes: codesArray };
}

module.exports = {
  SETSUBI_TO_TOKUCHO,
  DEFAULT_TOKUCHO_CODES,
  inferTokuchoFromBuilding,
  fillTokucho,
};
