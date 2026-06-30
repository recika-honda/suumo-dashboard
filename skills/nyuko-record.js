/**
 * skills/nyuko-record.js — REINS 抽出テキストの「入稿記録」Notion DB への追記
 *
 * Stage 01 (scripts/stages/01-reins-extract.js) が REINS 詳細画面から
 * extractPropertyData() でテキストを得たタイミングで、抽出内容を別 Notion DB
 * 「入稿記録」(angojp ワークスペース) に 1 物件 1 行で追記する監査ログ。
 *
 * 特に欲しいのは 現況 と 入居可能時期 (年 / 月 / 時期(上旬・中旬・下旬))。
 * REINS の入居年月 / 入居時期 文字列からこれらを構造化して保存する。
 *
 * 設計方針:
 *   - 純粋関数 (parseMoveInTiming / buildRecordProps) は副作用なし → unit test 可能。
 *   - recordExtraction() は **絶対にパイプラインを壊さない**: env 未設定なら no-op、
 *     Notion 失敗は呼び出し側に握り潰させる前提 (本体 try/catch も持つ)。
 *   - Notion は頻繁に rate_limited になる (gotchas) ので指数バックオフ再試行。
 *   - 認証は既存 NOTION_TOKEN を再利用 (提供された Integration と同一)。
 *     書き込み先 DB は NOTION_NYUKO_RECORD_DB_ID で指定。
 */

const STATUS_OPTIONS = new Set(["OK", "REG_FAIL", "NOT_FOUND"]);
const GENKYO_OPTIONS = new Set([
  "空室", "空き", "居住中", "賃貸中", "使用中", "明渡予定", "建築中",
]);
const TIMING_OPTIONS = new Set(["上旬", "中旬", "下旬"]);

let _clientCache = null;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function toHalfWidthDigits(str) {
  return String(str).replace(/[０-９]/g, (c) =>
    String.fromCharCode(c.charCodeAt(0) - 0xfee0)
  );
}

/**
 * 入居(可能)時期の文字列から 年 / 月 / 時期 を抽出する純粋関数。
 *   "2026年7月上旬"   → { 年: 2026, 月: 7, 時期: "上旬" }
 *   "2026年7月"       → { 年: 2026, 月: 7 }
 *   "即時" / "相談"   → {}
 * @param {string} raw
 * @returns {{年?: number, 月?: number, 時期?: string}}
 */
function parseMoveInTiming(raw) {
  if (!raw || typeof raw !== "string") return {};
  const s = toHalfWidthDigits(raw);
  const out = {};
  const ym = s.match(/(\d{4})\s*年(?:\s*(\d{1,2})\s*月)?/);
  if (ym) {
    out.年 = parseInt(ym[1], 10);
    if (ym[2]) out.月 = parseInt(ym[2], 10);
  }
  const jun = s.match(/上旬|中旬|下旬/);
  if (jun && TIMING_OPTIONS.has(jun[0])) out.時期 = jun[0];
  return out;
}

function parseFloatFrom(str) {
  if (str == null) return null;
  const m = String(str).match(/([\d.]+)/);
  return m ? parseFloat(m[1]) : null;
}

function normalizeHalfWidth(str) {
  if (!str) return str;
  return str.replace(/[Ａ-Ｚａ-ｚ０-９]/g, (c) =>
    String.fromCharCode(c.charCodeAt(0) - 0xfee0)
  );
}

/** 2000 char 上限の Notion rich_text を複数 chunk に分割 (安全側で 1900) */
function chunkRichText(str, size = 1900, maxChunks = 12) {
  const text = String(str ?? "");
  const chunks = [];
  for (let i = 0; i < text.length && chunks.length < maxChunks; i += size) {
    chunks.push({ text: { content: text.slice(i, i + size) } });
  }
  return chunks.length ? chunks : [{ text: { content: "" } }];
}

/**
 * reinsData + status から Notion 「入稿記録」DB の properties payload を組む純粋関数。
 * @param {object} reinsData  extractPropertyData() の戻り (NOT_FOUND 時は {})
 * @param {string} status     "OK" | "REG_FAIL" | "NOT_FOUND"
 * @param {string} reinsId    物件番号 (title)
 */
function buildRecordProps(reinsData, status, reinsId) {
  const data = reinsData || {};
  const props = {};

  const setText = (key, value) => {
    if (value != null && String(value).trim() !== "") {
      props[key] = { rich_text: [{ text: { content: String(value).trim() } }] };
    }
  };
  const setNum = (key, value) => {
    if (value != null && !isNaN(value)) props[key] = { number: value };
  };
  const setSelect = (key, value, allowed) => {
    if (value && (!allowed || allowed.has(value))) {
      props[key] = { select: { name: value } };
    }
  };

  // title: REINS ID (物件番号)。reinsData.物件番号 を優先、無ければ引数 reinsId。
  props["REINS ID"] = {
    title: [{ text: { content: String(data.物件番号 || reinsId || "").trim() } }],
  };

  // 抽出ステータス
  setSelect("抽出ステータス", status, STATUS_OPTIONS);

  // 現況: XPath 由来の値は許可値セット外があり得るため制限せず raw を書く。
  // Notion は未知の select option を自動作成するので取りこぼさない。
  setSelect("現況", data.現況);

  // 入居可能時期: XPath 由来の 年月(日付) と 旬(上旬/中旬/下旬) を一次ソースに、
  // 区分(入居時期: 即時/相談/期日指定/予定) も含めて原文を保存する。
  const movingRaw = [data.入居可能年月, data.入居可能時期, data.入居時期]
    .filter(Boolean)
    .join(" / ");
  setText("入居時期(原文)", movingRaw);
  const ym = parseMoveInTiming(data.入居可能年月 || movingRaw);
  setNum("入居可能_年", ym.年);
  setNum("入居可能_月", ym.月);
  const jun = TIMING_OPTIONS.has(data.入居可能時期)
    ? data.入居可能時期
    : parseMoveInTiming(movingRaw).時期;
  setSelect("入居可能_時期", jun, TIMING_OPTIONS);

  // 主要テキスト
  setText("物件種目", data.物件種目);
  setText("建物名", data.建物名);
  setNum("賃料(万)", parseFloatFrom(data.賃料));
  setNum("専有面積(㎡)", parseFloatFrom(data.使用部分面積));

  if (data.間取タイプ) {
    const rooms = data.間取部屋数 ? String(data.間取部屋数).match(/(\d+)/)?.[1] || "" : "";
    setText("間取り", `${rooms}${normalizeHalfWidth(data.間取タイプ)}`);
  }

  const fullAddress = [data.都道府県名, data.所在地名１, data.所在地名２, data.所在地名３]
    .filter(Boolean)
    .join("");
  setText("所在地", fullAddress);

  // どんなテキストデータを得たか: reinsData 全文を JSON で保存 (chunk 分割)
  props["抽出テキスト全文"] = {
    rich_text: chunkRichText(JSON.stringify(data, null, 2)),
  };

  return props;
}

function getClient() {
  if (_clientCache) return _clientCache;
  const token = process.env.NOTION_TOKEN;
  if (!token) return null;
  const { Client } = require("@notionhq/client");
  _clientCache = new Client({ auth: token });
  return _clientCache;
}

/**
 * 抽出結果を「入稿記録」DB に 1 行追記する。失敗してもパイプラインは止めない。
 * env 未設定 (NOTION_TOKEN / NOTION_NYUKO_RECORD_DB_ID) なら静かに no-op。
 * @returns {Promise<{ok: boolean, skipped?: boolean, reason?: string, pageId?: string, error?: string}>}
 */
async function recordExtraction({ reinsId, reinsData, status }) {
  const dbId = process.env.NOTION_NYUKO_RECORD_DB_ID;
  if (!dbId) return { ok: false, skipped: true, reason: "NOTION_NYUKO_RECORD_DB_ID未設定" };

  const notion = getClient();
  if (!notion) return { ok: false, skipped: true, reason: "NOTION_TOKEN未設定" };

  const properties = buildRecordProps(reinsData, status, reinsId);

  let lastErr;
  const MAX_ATTEMPTS = 4;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const page = await notion.pages.create({
        parent: { database_id: dbId },
        properties,
      });
      return { ok: true, pageId: page.id };
    } catch (err) {
      lastErr = err;
      const code = err?.status ?? err?.code;
      const retriable =
        code === 429 ||
        code === 409 ||
        code === "rate_limited" ||
        code === "conflict_error" ||
        (typeof code === "number" && code >= 500);
      if (!retriable || attempt === MAX_ATTEMPTS) break;
      await sleep(500 * Math.pow(2, attempt - 1)); // 0.5s, 1s, 2s
    }
  }
  return { ok: false, error: lastErr?.message || String(lastErr) };
}

module.exports = {
  parseMoveInTiming,
  buildRecordProps,
  recordExtraction,
  // test 用 export
  _internal: { chunkRichText, parseFloatFrom },
};
