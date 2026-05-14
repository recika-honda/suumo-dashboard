#!/usr/bin/env node
/**
 * Phase 1 Vision A/B measurement: D (gpt-4o + detail:high + revised prompt) vs baseline.
 *
 * Reads original REINS raw screenshots from ~/Desktop/suumo-nyuko/{rid}/reins_N.jpg,
 * reclassifies each with new config, and compares against the original
 * categorization saved in logs/runs/{rd}/03-images-classify/output.json.
 *
 * Output: scripts/legacy/measure-vision-d-result.json + console table.
 *
 * Run: node scripts/legacy/measure-vision-d.js
 *
 * NOT part of production pipeline. Throwaway script for Phase 1 evaluation.
 */

require("dotenv").config({ path: ".env.local" });
const OpenAI = require("openai");
const fs = require("fs");
const path = require("path");
const os = require("os");

// Cases from 2026-05-14 batch — Vision-relevant only (>= 1 REINS raw image).
const CASES = [
  { rid: "100139127159", score: 13, raw: 2,  runDir: "20260514-194245_100139127159", name: "ポートヒルク赤塚" },
  { rid: "100139126513", score: 21, raw: 10, runDir: "20260514-192912_100139126513", name: "ステージグランデ上落合" },
  { rid: "100139127191", score: 25, raw: 5,  runDir: "20260514-194653_100139127191", name: "ヴィヴェール笹塚" },
  { rid: "100139122497", score: 26, raw: 8,  runDir: "20260514-203738_100139122497", name: "アジュール大森" },
  { rid: "100139122525", score: 27, raw: 8,  runDir: "20260514-203358_100139122525", name: "ルミエール蓮根" },
  { rid: "100139119264", score: 30, raw: 10, runDir: "20260514-205612_100139119264", name: "フィリップ下落合" },
  { rid: "100139118155", score: 32, raw: 10, runDir: "20260514-205947_100139118155", name: "ルクレ自由が丘" },
  { rid: "100139124743", score: 32, raw: 10, runDir: "20260514-201921_100139124743", name: "ソレール猿江" },
  { rid: "100139127606", score: 32, raw: 10, runDir: "20260514-201052_100139127606", name: "仮称)北小岩6丁目" },
  { rid: "100139126528", score: 33, raw: 9,  runDir: "20260514-193249_100139126528", name: "エスパシオ自由が丘" },
  { rid: "100139127644", score: 33, raw: 7,  runDir: "20260514-200729_100139127644", name: "サニーハイツ金子" },
  // Control: escalated (already-good) cases to verify prompt change doesn't regress
  { rid: "100139118138", score: 41, raw: 10, runDir: "20260514-210707_100139118138", name: "尾山台テラス [CONTROL]" },
  { rid: "100139125549", score: 41, raw: 10, runDir: "20260514-201530_100139125549", name: "エスパーダ新井薬師 [CONTROL]" },
];

const SUUMO_CATEGORIES = [
  { id: "01", label: "居室・リビング", score: 5 },
  { id: "02", label: "キッチン", score: 5 },
  { id: "03", label: "バス・シャワールーム", score: 5 },
  { id: "04", label: "間取り図", score: 5 },
  { id: "05", label: "建物外観", score: 5 },
  { id: "06", label: "その他部屋・スペース", score: 1 },
  { id: "07", label: "トイレ", score: 1 },
  { id: "08", label: "洗面設備", score: 1 },
  { id: "09", label: "収納", score: 1 },
  { id: "10", label: "バルコニー", score: 1 },
  { id: "11", label: "庭", score: 1 },
  { id: "12", label: "玄関", score: 1 },
  { id: "13", label: "セキュリティ", score: 1 },
  { id: "14", label: "その他設備", score: 1 },
  { id: "15", label: "エントランス", score: 1 },
  { id: "16", label: "ロビー", score: 1 },
  { id: "17", label: "駐車場", score: 1 },
  { id: "18", label: "その他共有部分", score: 1 },
  { id: "19", label: "眺望", score: 1 },
  { id: "20", label: "省エネ性能ラベル", score: 1 },
  { id: "21", label: "その他", score: 0 },
];
const ALLOW_DUPLICATE = new Set(["06", "14", "18", "21"]);

const MODEL = process.env.MEASURE_MODEL || "gpt-4o";
const DETAIL = process.env.MEASURE_DETAIL || "high";

// Revised prompt (Phase 1 D): less 21-bias, hard-case few-shot.
function buildPrompt(availableCategories) {
  const catList = availableCategories.map((c) => `${c.id}=${c.label}`).join(", ");
  return `この不動産物件写真を画像の内容のみで1つのカテゴリに分類してください。

カテゴリ: ${catList}

【最重要原則】
1. **04 / 05 の誤判定は致命的** (名寄せスコアを破壊する) — 明確に確信できる時だけ採用。
2. **ただし 21(その他) は最後の手段** — 0点なので、まず 01-20 から最も近いカテゴリを選ぶ努力をする。21 は「20カテゴリのどれにも一つも該当しない」時だけ。

【04・05 の厳格定義】
- 04 (間取り図): 線画・平面図・フロアプラン図。**線で部屋の輪郭が描かれた図解**。写真は絶対に 04 にしない (シンク・浴槽・タイル壁・床の俯瞰など四角い形状の写真も 04 ではない)。
- 05 (建物外観): **建物を屋外から撮影した写真**。空・道路・植栽と一緒に建物が写る。室内が一部でも映る画像は 05 にしない。

【判定基準】
- 線画・平面図・フロアプラン → 04
- 建物 + 空/道路/植栽 (屋外から建物撮影) → 05
- リビング・ダイニング・居間 (広い部屋、ソファ、テーブル) → 01
- 洋室・和室・寝室・個室 → 06
- キッチン (コンロ、シンク、調理台、流し台) → 02
- 浴室 (浴槽、シャワー) → 03
- トイレ (便器) → 07
- 洗面台・洗面所 (洗面ボウル、鏡) → 08
- 収納・クローゼット・押入れ → 09
- バルコニー・ベランダ → 10
- 庭・テラス・専用庭 → 11
- 玄関・靴箱 → 12
- オートロック・防犯カメラ・モニター付きインターホン → 13
- エアコン・給湯リモコン・コンセント等の設備クローズアップ → 14
- 建物エントランス (自動ドア、集合ポスト、入口ホール) → 15
- ロビー・共用ラウンジ・待合スペース → 16
- 駐車場・駐輪場 → 17
- 共用廊下・階段・ゴミ置場・宅配ボックス → 18
- 窓からの眺望 (室内から外、景色が主題) → 19
- 省エネ性能ラベル (緑黄の帯、星マーク) → 20
- QRコード → 「QR」とだけ回答

【誤分類しがちなケース (実データから抽出)】
- タイル壁・床のクローズアップ → 14 (その他設備)。21 に倒さない。
- ベランダ手すり越しの外の景色 → 19 (眺望) or 10 (バルコニー)。21 に倒さない。
- 建物の壁面アップ (空が写らず壁だけ) → 18 (その他共有部分)。05 ではない、21 でもない。
- 暗い室内・撮影角度が悪い → 写っている主題で判定 (床なら 14、ベッドが映れば 06、等)。21 に逃げない。
- 給湯器・ガスメーター等の設備 → 14 (その他設備)
- インターホン・モニター → 13 (セキュリティ)

【補足ルール】
- 画像に実際に写っているものだけで判断。
- 窓から外の景色が見えても、撮影位置が室内なら 05 ではない。景色が主題なら 19。
- 部屋が主題で窓も見えるだけなら 01 または 06。
- 四角い枠 + 線で構成されていても、写真であれば 04 ではない。被写体のカテゴリを選ぶ。
- 21 (その他) を選ぶ前に「本当に01-20 のどれにも一つも当てはまらないか?」と自問する。

IDのみ回答 (例: 01)。`;
}

let _openai = null;
function getOpenAI() {
  if (!_openai) _openai = new OpenAI();
  return _openai;
}

async function classifySingleImage(imageBuffer, availableCategories) {
  const b64 = imageBuffer.toString("base64");
  const response = await getOpenAI().chat.completions.create({
    model: MODEL,
    max_tokens: 50,
    messages: [
      {
        role: "user",
        content: [
          { type: "image_url", image_url: { url: `data:image/jpeg;base64,${b64}`, detail: DETAIL } },
          { type: "text", text: buildPrompt(availableCategories) },
        ],
      },
    ],
  });
  const text = (response.choices[0]?.message?.content || "").trim();
  if (/QR/i.test(text)) return "QR";
  const m = text.match(/\b(\d{2})\b/);
  if (m && availableCategories.find((c) => c.id === m[1])) return m[1];
  return null;
}

function loadBaselineCategorization(runDir) {
  const p = path.join("logs/runs", runDir, "03-images-classify/output.json");
  if (!fs.existsSync(p)) return {};
  const data = JSON.parse(fs.readFileSync(p, "utf8"));
  const map = {};
  for (const img of data.processedImages || []) {
    if (img.sourceIndex >= 1 && img.sourceIndex <= 50) map[img.sourceIndex] = img.categoryId;
  }
  return map;
}

async function processCase(c) {
  const imgDir = path.join(os.homedir(), "Desktop/suumo-nyuko", c.rid);
  const baseline = loadBaselineCategorization(c.runDir);
  const usedCats = new Set();
  const newCats = {};
  const perImage = [];

  // Replicate baseline algorithm: classify one at a time, exclude used 5pt cats from available
  for (let i = 1; i <= c.raw; i++) {
    const imgPath = path.join(imgDir, `reins_${i}.jpg`);
    if (!fs.existsSync(imgPath)) {
      perImage.push({ idx: i, baseline: baseline[i] || "-", new: "MISSING" });
      continue;
    }
    const buf = fs.readFileSync(imgPath);
    const available = SUUMO_CATEGORIES.filter((cat) => !usedCats.has(cat.id) || ALLOW_DUPLICATE.has(cat.id));
    let newCat = null;
    let attempts = 0;
    let isRetry = false;
    try {
      newCat = await classifySingleImage(buf, available);
      attempts++;
    } catch (err) {
      console.error(`  [${c.rid}#${i}] ${err.message}`);
    }
    // Retry once on null (mirror prod image-ai.js behavior)
    if (!newCat) {
      isRetry = true;
      try {
        newCat = await classifySingleImage(buf, available);
        attempts++;
      } catch (err) {
        console.error(`  [${c.rid}#${i}] retry: ${err.message}`);
      }
    }
    let usedFallback = false;
    // Fallback (mirror prod pickFallbackCategory)
    if (!newCat) {
      const IRREVERSIBLE = new Set(["04", "05"]);
      const fb5pt = available.find((cc) => cc.score === 5 && !IRREVERSIBLE.has(cc.id));
      const fb21 = available.find((cc) => cc.id === "21");
      const fbFirst = available.find((cc) => !IRREVERSIBLE.has(cc.id));
      newCat = (fb5pt || fb21 || fbFirst)?.id || null;
      usedFallback = !!newCat;
    }
    if (newCat && newCat !== "QR") {
      if (!ALLOW_DUPLICATE.has(newCat)) usedCats.add(newCat);
      newCats[newCat] = (newCats[newCat] || 0) + 1;
    }
    perImage.push({ idx: i, baseline: baseline[i] || "-", new: newCat || "null", attempts, usedFallback, isRetry });
  }

  return { ...c, baseline, newCats, perImage };
}

function summarize(results) {
  // Per-case summary table
  console.log("\n=== Per-case: distinct categories & key cells (baseline → new) ===");
  console.log(
    `${"rid".padEnd(13)} ${"score".padEnd(6)} ${"raw".padEnd(4)} ${"old#cat".padEnd(8)} ${"new#cat".padEnd(8)} ${"04 b→n".padEnd(8)} ${"05 b→n".padEnd(8)} ${"21 b→n".padEnd(8)} name`,
  );
  const totals = { b_04: 0, n_04: 0, b_05: 0, n_05: 0, b_21: 0, n_21: 0, b_dc: 0, n_dc: 0 };
  for (const r of results) {
    const bCount = (cat) => Object.values(r.baseline).filter((c) => c === cat).length;
    const nCount = (cat) => r.newCats[cat] || 0;
    const bDistinct = new Set(Object.values(r.baseline).filter((c) => c && /^\d\d$/.test(c))).size;
    const nDistinct = new Set(Object.keys(r.newCats).filter((c) => /^\d\d$/.test(c))).size;
    totals.b_04 += bCount("04"); totals.n_04 += nCount("04");
    totals.b_05 += bCount("05"); totals.n_05 += nCount("05");
    totals.b_21 += bCount("21"); totals.n_21 += nCount("21");
    totals.b_dc += bDistinct;    totals.n_dc += nDistinct;
    console.log(
      `${r.rid.padEnd(13)} ${String(r.score).padEnd(6)} ${String(r.raw).padEnd(4)} ${String(bDistinct).padEnd(8)} ${String(nDistinct).padEnd(8)} ${(bCount("04") + "→" + nCount("04")).padEnd(8)} ${(bCount("05") + "→" + nCount("05")).padEnd(8)} ${(bCount("21") + "→" + nCount("21")).padEnd(8)} ${r.name}`,
    );
  }
  console.log("\n=== Totals (baseline → new) ===");
  console.log(`04 (間取り): ${totals.b_04} → ${totals.n_04}  ${totals.n_04 - totals.b_04 >= 0 ? "+" : ""}${totals.n_04 - totals.b_04}`);
  console.log(`05 (外観):   ${totals.b_05} → ${totals.n_05}  ${totals.n_05 - totals.b_05 >= 0 ? "+" : ""}${totals.n_05 - totals.b_05}`);
  console.log(`21 (誤分類): ${totals.b_21} → ${totals.n_21}  ${totals.n_21 - totals.b_21 >= 0 ? "+" : ""}${totals.n_21 - totals.b_21}  (低いほど良い)`);
  console.log(`distinct cats sum: ${totals.b_dc} → ${totals.n_dc}  ${totals.n_dc - totals.b_dc >= 0 ? "+" : ""}${totals.n_dc - totals.b_dc}  (高いほど良い、score とほぼ線形相関)`);
}

async function main() {
  console.log(`Model: ${MODEL} / detail: ${DETAIL}`);
  console.log(`Cases: ${CASES.length}`);
  const results = [];
  for (const c of CASES) {
    process.stdout.write(`[${c.rid}] ${c.name} score=${c.score} raw=${c.raw} ... `);
    const r = await processCase(c);
    console.log(`new cats: ${JSON.stringify(r.newCats)}`);
    results.push(r);
  }
  const outPath = "scripts/legacy/measure-vision-d-result.json";
  fs.writeFileSync(outPath, JSON.stringify({ model: MODEL, detail: DETAIL, generatedAt: new Date().toISOString(), results }, null, 2));
  console.log(`\nSaved: ${outPath}`);
  summarize(results);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
