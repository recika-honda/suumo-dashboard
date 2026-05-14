/**
 * ATBB Matcher - REINS データから ATBB 物件を特定するためのロジック層
 *
 * Design: docs/refactor/atbb-search-result-schema.md §マッチング判定ロジック
 *
 * Public API:
 *   - normalizeBuildingName(s)
 *   - normalizeRoomNumber(s)
 *   - generateSearchKeywords(reinsData) → [{ strategy, keyword }]
 *   - scoreCandidate(reinsData, card) → { score, breakdown }
 *   - matchProperty(searchPage, reinsData, opts) → { matched, confidence, ... }
 */

const atbb = require("./atbb");

// ── Normalization helpers ──────────────────────────────────────

function toHalfWidthAlphaNum(s) {
  if (!s) return s;
  // 英数字
  let r = s.replace(/[Ａ-Ｚａ-ｚ０-９]/g, (c) =>
    String.fromCharCode(c.charCodeAt(0) - 0xfee0)
  );
  // 全角括弧・記号類も半角化 (company 名の (株) マッチ用)
  // 注: 「ー」(U+30FC, 片仮名長音符) は ASCII ハイフンと意味が違うため変換しない
  //     建物名「コーポマリーナ」が「コ-ポマリ-ナ」になって ATBB で 0 件になる
  r = r.replace(/[（]/g, "(").replace(/[）]/g, ")")
       .replace(/[［]/g, "[").replace(/[］]/g, "]")
       .replace(/[「]/g, '"').replace(/[」]/g, '"')
       .replace(/[‐－―−]/g, "-")  // ー(U+30FC) は意図的に除外
       .replace(/[／]/g, "/");
  return r;
}

function toFullWidthAlphaNum(s) {
  if (!s) return s;
  return s.replace(/[A-Za-z0-9]/g, (c) =>
    String.fromCharCode(c.charCodeAt(0) + 0xfee0)
  );
}

function collapseSpaces(s) {
  if (!s) return s;
  return s.replace(/[\s　]+/g, " ").trim();
}

function stripSpaces(s) {
  if (!s) return s;
  return s.replace(/[\s　]+/g, "");
}

function extractParenContent(s) {
  if (!s) return null;
  const m = s.match(/[（(]([^）)]+)[）)]/);
  return m ? m[1] : null;
}

function stripParens(s) {
  if (!s) return s;
  return s.replace(/[（(][^）)]*[）)]/g, "").trim();
}

function stripBracketCodes(s) {
  // "Ｎａｎｏ北新宿２　２１０（業１００）" → "Ｎａｎｏ北新宿２　２１０"
  // "細谷方(ホソヤカタ)" → "細谷方"
  if (!s) return s;
  return s.replace(/[（(][^）)]*[）)]/g, "").trim();
}

// 建物名から汎用接頭辞を除去 (例: 「コーポマリーナ尾山台」→「マリーナ尾山台」)
const GENERIC_PREFIXES = [
  "コーポ", "ハウス", "メゾン", "ヴィラ", "ビラ", "グランド", "グラン",
  "ロイヤル", "ハイツ", "プチ", "ドミール", "ラ・", "ル・", "ザ・",
  "ヴェル", "ベル", "プラザ", "アビタシオン", "アビター", "アビタ",
  "シャトー", "シャルマン", "サンライズ", "サン", "リバー", "リバーサイド",
];
function stripGenericPrefix(s) {
  if (!s) return s;
  for (const p of GENERIC_PREFIXES) {
    if (s.startsWith(p) && s.length > p.length + 1) {
      return s.slice(p.length).trim();
    }
  }
  return s;
}

// 建物名から汎用接尾辞を除去 (例: 「Ｎコート久我山」→ コートは中間なので対象外; 「ガーデニエール砧レジデンス」→「ガーデニエール砧」)
const GENERIC_SUFFIXES = [
  "レジデンス", "マンション", "アパート", "コーポ", "ハウス", "ハイツ",
  "コート", "パレス", "タワー", "ヒルズ", "ガーデン", "テラス", "プレイス",
  "メゾン", "アパートメント", "ヴィレッジ", "ステージ",
];
function stripGenericSuffix(s) {
  if (!s) return s;
  for (const sfx of GENERIC_SUFFIXES) {
    if (s.endsWith(sfx) && s.length > sfx.length + 1) {
      return s.slice(0, -sfx.length).trim();
    }
  }
  return s;
}

// 末尾の番号類を除去 (アラビア数字、ローマ数字、全角・半角)
function stripTrailingNumbers(s) {
  if (!s) return s;
  // ローマ数字 Ⅰ-Ⅹ
  let r = s.replace(/[ⅠⅡⅢⅣⅤⅥⅦⅧⅨⅩ]+$/, "").trim();
  // 全角・半角アラビア数字 (1-4 桁) + 任意のスペース
  r = r.replace(/[\s　]*[0-9０-９]+$/, "").trim();
  // 「２号棟」「A棟」のような棟番号
  r = r.replace(/[\s　]*[A-ZＡ-Ｚ0-9０-９]+号棟$/, "").trim();
  r = r.replace(/[\s　]*[A-ZＡ-Ｚ]棟$/, "").trim();
  return r;
}

// 建物名を空白で分割した各部分 (数字のみは除外、文字長 >= 2)
function splitByWhitespace(s) {
  if (!s) return [];
  return s.split(/[\s　]+/)
    .filter((p) => p.length >= 2)
    .filter((p) => !/^[0-9０-９ⅠⅡⅢⅣⅤⅥⅦⅧⅨⅩ]+$/.test(p));  // 数字だけの部分は除外
}

function normalizeBuildingName(s) {
  if (!s) return s;
  return stripSpaces(toHalfWidthAlphaNum(stripBracketCodes(s)));
}

function normalizeRoomNumber(s) {
  if (!s) return null;
  const half = toHalfWidthAlphaNum(String(s));
  // "2F-1" 等の表記を保持しつつ、空白除去・大文字化
  return half.replace(/\s/g, "").toUpperCase();
}

// ── Search keyword generation strategies ────────────────────────

function generateSearchKeywords(reinsData) {
  // kento 教示 (2026-05-14):
  //   「物件名を入れるだけでいい。住所入れたり変なことしなくていい」
  //   → REINS 建物名そのまま (S1_raw) のみ。ヒットしなければ ATBB_NOT_FOUND 確定。
  //   anti-bot 措置 (webdriver 隠蔽 + UA + chrome args) が効いている前提で、
  //   フリーワード検索は「物件名そのまま」で大木さん経験則通り十分機能する。
  const name = reinsData?.建物名 ?? "";
  if (!name.trim()) return [];
  return [{ strategy: "S1_raw", keyword: name.trim() }];
}

// ── Score a candidate card against REINS data ───────────────────

function parseMensekiToNumber(s) {
  if (!s) return null;
  const m = String(s).match(/([0-9.]+)\s*㎡/);
  return m ? parseFloat(m[1]) : null;
}

function parseChikuNenToYearMonth(s) {
  if (!s) return null;
  // ATBB: "1970/03"
  let m = String(s).match(/(\d{4})\/(\d{1,2})/);
  if (m) return { year: parseInt(m[1], 10), month: parseInt(m[2], 10) };
  // REINS: "1970年03月" / "1970年3月"
  m = String(s).match(/(\d{4})年\s*(\d{1,2})月/);
  if (m) return { year: parseInt(m[1], 10), month: parseInt(m[2], 10) };
  return null;
}

function parseKaisuToFloorParts(s) {
  if (!s) return null;
  // "2階建/2階" or "2階建/2階部分"
  const m = String(s).match(/(\d+)階建\/(\d+)階/);
  return m ? { total: parseInt(m[1], 10), floor: parseInt(m[2], 10) } : null;
}

// REINS の物件種目語彙 → ATBB の物件種目語彙
const SHUMOKU_DICT = {
  マンション: ["貸マンション"],
  アパート: ["貸アパート"],
  一戸建: ["貸戸建", "貸一戸建"],
  テラスハウス: ["貸テラスハウス"],
};

function shumokuMatches(reinsType, atbbType) {
  if (!reinsType || !atbbType) return false;
  const accepted = SHUMOKU_DICT[reinsType] || [];
  return accepted.some((a) => atbbType.includes(a));
}

function normalizeForCompare(s) {
  if (!s) return "";
  return stripSpaces(toHalfWidthAlphaNum(s));
}

function scoreCandidate(reinsData, card) {
  const breakdown = {};

  // 部屋番号一致 (0.30) — 最強の識別子
  const reinsRoom = normalizeRoomNumber(reinsData?.部屋番号);
  const atbbRoom = normalizeRoomNumber(card?.roomNumber);
  if (reinsRoom && atbbRoom && reinsRoom === atbbRoom) {
    breakdown.room = 0.30;
  } else {
    breakdown.room = 0;
  }

  // 専有面積一致 (±0.5㎡) (0.15)
  const reinsMenseki = parseMensekiToNumber(reinsData?.使用部分面積);
  const atbbMenseki = parseMensekiToNumber(card?.menseki);
  if (reinsMenseki && atbbMenseki && Math.abs(reinsMenseki - atbbMenseki) <= 0.5) {
    breakdown.menseki = 0.15;
  } else {
    breakdown.menseki = 0;
  }

  // 築年月一致 (0.15)
  const reinsChiku = parseChikuNenToYearMonth(reinsData?.築年月);
  const atbbChiku = parseChikuNenToYearMonth(card?.chikuNen);
  if (reinsChiku && atbbChiku && reinsChiku.year === atbbChiku.year && reinsChiku.month === atbbChiku.month) {
    breakdown.chiku = 0.15;
  } else {
    breakdown.chiku = 0;
  }

  // 階建/階一致 (0.10)
  const reinsKaisu = parseKaisuToFloorParts(reinsData?.階建);
  const atbbKaisu = parseKaisuToFloorParts(card?.kaisu);
  if (reinsKaisu && atbbKaisu && reinsKaisu.total === atbbKaisu.total && reinsKaisu.floor === atbbKaisu.floor) {
    breakdown.kaisu = 0.10;
  } else if (reinsKaisu && atbbKaisu && reinsKaisu.floor === atbbKaisu.floor) {
    // 階数だけ一致 (建物総階数情報が REINS に無い場合の救済)
    breakdown.kaisu = 0.05;
  } else {
    breakdown.kaisu = 0;
  }

  // 物件種目一致 (0.10)
  if (shumokuMatches(reinsData?.物件種目, card?.type)) {
    breakdown.shumoku = 0.10;
  } else {
    breakdown.shumoku = 0;
  }

  // 所在地一致 (0.10) — 市区町村+丁目まで一致なら 0.10、番地以下違いは許容
  // REINS: 所在地名１=世田谷区, 所在地名２=赤堤５丁目, 所在地名３=37-6
  // ATBB:  shozai=世田谷区赤堤５丁目22-10
  const reinsShozaiCityChome = normalizeForCompare(
    [reinsData?.所在地名１, reinsData?.所在地名２].filter(Boolean).join("")
  );
  const reinsShozaiFull = normalizeForCompare(
    [reinsData?.所在地名１, reinsData?.所在地名２, reinsData?.所在地名３].filter(Boolean).join("")
  );
  const atbbShozai = normalizeForCompare(card?.shozai);
  if (reinsShozaiCityChome && atbbShozai) {
    // 完全一致 or 番地以下まで一致 → 0.10
    if (atbbShozai.includes(reinsShozaiFull) || reinsShozaiFull.includes(atbbShozai)) {
      breakdown.shozai = 0.10;
    } else if (atbbShozai.includes(reinsShozaiCityChome) || reinsShozaiCityChome.includes(atbbShozai.slice(0, reinsShozaiCityChome.length))) {
      // 市区町村+丁目まで一致 (番地違いは許容) → 0.10
      breakdown.shozai = 0.10;
    } else {
      // 市区町村レベル (頭 4-6 文字) のみ一致 → 弱マッチ 0.05
      const prefix = reinsShozaiCityChome.slice(0, Math.min(6, reinsShozaiCityChome.length));
      if (prefix && atbbShozai.includes(prefix)) breakdown.shozai = 0.05;
      else breakdown.shozai = 0;
    }
  } else {
    breakdown.shozai = 0;
  }

  // 元付業者名一致 (0.10) — 同一物件複数登録の決定打
  const reinsCompany = normalizeForCompare(reinsData?.商号);
  const atbbCompany = normalizeForCompare(card?.company);
  if (reinsCompany && atbbCompany) {
    // 株式会社等の法人格表記揺れを吸収するため、両方から (株)/株式会社/(有)/有限会社 を除去
    const stripCorp = (s) => s.replace(/\(株\)|株式会社|\(有\)|有限会社|\(合同\)|合同会社/g, "");
    const r = stripCorp(reinsCompany);
    const a = stripCorp(atbbCompany);
    if (r && a && (r.includes(a) || a.includes(r))) {
      breakdown.company = 0.10;
    } else {
      breakdown.company = 0;
    }
  } else {
    breakdown.company = 0;
  }

  const score = Object.values(breakdown).reduce((a, b) => a + b, 0);
  return { score: Math.round(score * 100) / 100, breakdown };
}

// ── Main matcher orchestrator ──────────────────────────────────

async function matchProperty(searchPage, reinsData, opts = {}) {
  const {
    minConfidence = 0.70,
    ambiguousThreshold = 0.50,
    logger = () => {},
  } = opts;

  const keywords = generateSearchKeywords(reinsData);
  const trials = [];
  let bestCandidate = null;
  let bestStrategy = null;

  for (const { strategy, keyword } of keywords) {
    // 注: 早期短絡 (S1-S5 全 0 件 → S6 skip) は撤回 (2026-05-13)
    //   理由: 大木さん経験則「REINS にあれば ATBB にもだいたいある」。
    //   S1-S5 が表記揺れで全 0 件でも、S6 (所在地) で正しい候補に到達するケースが
    //   実測で複数あった (例: ベル・ソレイユ, クレストコート)。
    //   速度より精度を優先。
    logger(`[matcher] try strategy=${strategy} keyword="${keyword}"`);
    try {
      await atbb.returnToSearchForm(searchPage);
      await atbb.submitFreeWordSearch(searchPage, { keyword });
    } catch (e) {
      trials.push({ strategy, keyword, status: "search_failed", reason: e.message });
      continue;
    }

    const cardCount = await atbb.countCards(searchPage);
    if (cardCount === 0) {
      trials.push({ strategy, keyword, status: "no_hits", hits: 0 });
      continue;
    }

    const cards = await atbb.extractCards(searchPage);
    const scored = cards.map((c) => ({ card: c, ...scoreCandidate(reinsData, c) }));
    scored.sort((a, b) => b.score - a.score);
    const top = scored[0];

    trials.push({
      strategy,
      keyword,
      status: "scored",
      hits: cards.length,
      topScore: top.score,
      topBreakdown: top.breakdown,
      topName: top.card.buildingName,
      topRoom: top.card.roomNumber,
    });

    if (!bestCandidate || top.score > bestCandidate.score) {
      bestCandidate = top;
      bestStrategy = strategy;
    }

    if (top.score >= minConfidence) {
      // Early exit on high-confidence match
      break;
    }
  }

  if (!bestCandidate) {
    return {
      matched: false,
      confidence: 0,
      strategy: null,
      candidate: null,
      reason: "ATBB_NOT_FOUND",
      trials,
    };
  }

  const verdict =
    bestCandidate.score >= minConfidence
      ? "matched"
      : bestCandidate.score >= ambiguousThreshold
        ? "ambiguous"
        : "not_matched";

  return {
    matched: verdict === "matched",
    verdict,
    confidence: bestCandidate.score,
    breakdown: bestCandidate.breakdown,
    strategy: bestStrategy,
    candidate: bestCandidate.card,
    reason: verdict === "matched" ? null : verdict === "ambiguous" ? "ATBB_AMBIGUOUS" : "ATBB_LOW_CONFIDENCE",
    trials,
  };
}

module.exports = {
  normalizeBuildingName,
  normalizeRoomNumber,
  generateSearchKeywords,
  scoreCandidate,
  matchProperty,
  // exported for tests
  _internal: {
    toHalfWidthAlphaNum,
    toFullWidthAlphaNum,
    stripParens,
    extractParenContent,
    parseMensekiToNumber,
    parseChikuNenToYearMonth,
    parseKaisuToFloorParts,
    shumokuMatches,
  },
};
