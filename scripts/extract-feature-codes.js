#!/usr/bin/env node
/**
 * extract-feature-codes.js
 *
 * forrent.jp の入稿フォーム保存 HTML
 * (logs/runs/.../edit-after-teisei.html) から特徴コード 491 個を列挙し、
 * Phase 4 SSOT として使う 150 個 (検索可能 140 = `spicon kodawari_mark`
 * 付き + allowlist 10 = 検索タグ無しでも必チェック) に絞った config を生成する。
 *
 * Output: config/forrent-feature-codes.json
 *
 * Re-run: `node scripts/extract-feature-codes.js`
 *   - logs/runs 配下で `edit-after-teisei.html` を持つ run の最新 mtime を自動選択
 *   - 明示指定: `node scripts/extract-feature-codes.js <path-to-html>`
 *
 * Design notes:
 *  - cheerio/jsdom を追加しない。forrent 出力 HTML の `<td id="td_XXXX">...</td>`
 *    構造は安定しており、label は `<span id="LXXXX" class="tokuchoKoumoku">LABEL</span>`、
 *    kodawari は `<div class="spicon kodawari_mark"></div>` の有無で判別できる。
 *    依存追加コストの方が大きいので素の RegExp 走査で実装。
 *  - allowlist 10 個は kento の判断 (blueprint.html Key Decisions 2026-05-15) で
 *    検索タグなしでも必チェック扱い。スクリプト内に hard-code する。
 */

const fs = require("fs");
const path = require("path");

// allowlist: 検索タグなしでも必チェック (blueprint.html "Phase 4 設計")
const ALLOWLIST = [
  "0102", // 2駅利用可
  "0103", // 2沿線利用可
  "0104", // 3駅以上利用可
  "0105", // 3沿線以上利用可
  "0201", // 耐震構造
  "0202", // 制震構造
  "0203", // 免震構造
  "0701", // 築2年以内
  "0702", // 築3年以内
  "0703", // 築5年以内
];

const PROJECT_ROOT = path.resolve(__dirname, "..");
const RUNS_DIR = path.join(PROJECT_ROOT, "logs", "runs");
const OUTPUT_PATH = path.join(PROJECT_ROOT, "config", "forrent-feature-codes.json");

function pickLatestHtml() {
  if (!fs.existsSync(RUNS_DIR)) {
    throw new Error(`runs dir not found: ${RUNS_DIR}`);
  }
  const candidates = [];
  for (const entry of fs.readdirSync(RUNS_DIR)) {
    const htmlPath = path.join(RUNS_DIR, entry, "edit-after-teisei.html");
    if (fs.existsSync(htmlPath)) {
      candidates.push({ path: htmlPath, mtime: fs.statSync(htmlPath).mtimeMs });
    }
  }
  if (!candidates.length) {
    throw new Error(`no edit-after-teisei.html found under ${RUNS_DIR}`);
  }
  candidates.sort((a, b) => b.mtime - a.mtime);
  return candidates[0].path;
}

/**
 * Parse all `<td id="td_XXXX">...</td>` blocks (4-digit codes only) from the HTML.
 * Returns Map<code, { label: string|null, searchable: boolean }>.
 */
function parseFeatureCodes(html) {
  const out = new Map();
  // `id="td_XXXX"` の XXXX は forrent では 4桁数字。
  // 2桁の id="td_30" 等はセクションヘッダなので除外。
  const tdRe = /id="td_([0-9]+)"[^>]*>([\s\S]*?)<\/td>/g;
  let m;
  while ((m = tdRe.exec(html))) {
    const code = m[1];
    if (code.length !== 4) continue; // セクション header は無視
    if (out.has(code)) continue; // 念のため (本来重複しない)
    const inner = m[2];
    const searchable = inner.includes("spicon kodawari_mark");
    // label は同 td 内の <span id="LXXXX" ...>LABEL</span>
    const labelMatch = inner.match(new RegExp(`id="L${code}"[^>]*>([^<]+)<`));
    const label = labelMatch ? labelMatch[1].trim() : null;
    out.set(code, { label, searchable });
  }
  return out;
}

function main() {
  const cliPath = process.argv[2];
  const srcPath = cliPath ? path.resolve(cliPath) : pickLatestHtml();
  const html = fs.readFileSync(srcPath, "utf8");

  const parsed = parseFeatureCodes(html);
  const totalParsed = parsed.size;

  // allowlist 存在チェック (HTML に label が無い code は warn だが許容)
  const allowlistMissing = [];
  for (const code of ALLOWLIST) {
    if (!parsed.has(code)) {
      allowlistMissing.push(code);
      parsed.set(code, { label: null, searchable: false });
    } else if (!parsed.get(code).label) {
      allowlistMissing.push(code);
    }
  }
  if (allowlistMissing.length) {
    console.warn(
      `[warn] allowlist label missing in HTML: ${allowlistMissing.join(", ")} ` +
      `(Phase β で人手 fill する)`
    );
  }

  // filter: searchable (140) or allowlist (10) → 150
  const allowSet = new Set(ALLOWLIST);
  const filtered = [];
  for (const [code, info] of parsed) {
    const allowlist = allowSet.has(code);
    if (!info.searchable && !allowlist) continue;
    filtered.push({
      code,
      label: info.label,
      searchable: info.searchable,
      allowlist,
    });
  }
  // code 昇順
  filtered.sort((a, b) => a.code.localeCompare(b.code));

  // 整合性 assert
  const searchableCount = filtered.filter((x) => x.searchable).length;
  const allowlistCount = filtered.filter((x) => x.allowlist).length;
  const overlap = filtered.filter((x) => x.searchable && x.allowlist);
  if (overlap.length) {
    console.warn(
      `[warn] codes appearing both as searchable AND allowlist: ${overlap.map((x) => x.code).join(", ")}`
    );
  }

  const payload = {
    generated_at: new Date().toISOString(),
    source_html: path.relative(PROJECT_ROOT, srcPath),
    total: filtered.length,
    parsed_total: totalParsed,
    searchable_total: searchableCount,
    allowlist_total: allowlistCount,
    codes: filtered,
  };

  fs.mkdirSync(path.dirname(OUTPUT_PATH), { recursive: true });
  fs.writeFileSync(OUTPUT_PATH, JSON.stringify(payload, null, 2) + "\n", "utf8");

  console.log(`source: ${payload.source_html}`);
  console.log(`parsed 4-digit codes: ${totalParsed}`);
  console.log(`output codes: ${payload.total} (searchable=${searchableCount}, allowlist=${allowlistCount})`);
  console.log(`written: ${path.relative(PROJECT_ROOT, OUTPUT_PATH)}`);
}

if (require.main === module) {
  try {
    main();
  } catch (err) {
    console.error(`[error] ${err.message}`);
    process.exit(1);
  }
}

module.exports = { parseFeatureCodes, ALLOWLIST };
