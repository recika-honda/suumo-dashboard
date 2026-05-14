/**
 * Image Pipeline — GPT-4o-mini Vision 個別分類 + Sharp リサイズ
 *
 * 各画像を1枚ずつGPT-4o-mini Visionで分類し、正確なカテゴリを割り当てる。
 * 使用済みカテゴリは候補から除外し、重複を防ぐ。
 */

const OpenAI = require("openai");
const sharp = require("sharp");
const fs = require("fs");
const path = require("path");

// Lazy init: pure helpers (pickFallbackCategory 等) は API key 無しで import 可能にする。
// クライアント取得は Vision を実際に呼ぶ analyzeAndCropImages / cropMissingCategories 経由のみ。
let _openai = null;
function getOpenAI() {
  if (!_openai) _openai = new OpenAI();
  return _openai;
}

const VISION_MODEL = "gpt-4o-mini";

// forrent.jp プルダウン選択肢と1:1対応（21カテゴリ）
const SUUMO_CATEGORIES = [
  // 5pt — 名寄せスコア主要配点
  { id: "01", label: "居室・リビング", score: 5 },
  { id: "02", label: "キッチン", score: 5 },
  { id: "03", label: "バス・シャワールーム", score: 5 },
  { id: "04", label: "間取り図", score: 5 },
  { id: "05", label: "建物外観", score: 5 },
  // 1pt — 室内系 (shitsunaiShashinCategory 12択)
  { id: "06", label: "その他部屋・スペース", score: 1 },
  { id: "07", label: "トイレ", score: 1 },
  { id: "08", label: "洗面設備", score: 1 },
  { id: "09", label: "収納", score: 1 },
  { id: "10", label: "バルコニー", score: 1 },
  { id: "11", label: "庭", score: 1 },
  { id: "12", label: "玄関", score: 1 },
  { id: "13", label: "セキュリティ", score: 1 },
  { id: "14", label: "その他設備", score: 1 },
  // 1pt — 共有部分系
  { id: "15", label: "エントランス", score: 1 },
  { id: "16", label: "ロビー", score: 1 },
  { id: "17", label: "駐車場", score: 1 },
  { id: "18", label: "その他共有部分", score: 1 },
  // 1pt — その他系
  { id: "19", label: "眺望", score: 1 },
  { id: "20", label: "省エネ性能ラベル", score: 1 },
  // 0pt — catch-all
  { id: "21", label: "その他", score: 0 },
];

// 複数画像に同じカテゴリを許可するもの
const ALLOW_DUPLICATE = new Set(["06", "14", "18", "21"]);

// 不可逆カテゴリ: 他写真から合成できず、誤判定すると名寄せスコアを壊す
// → fallback で強制充填しない。Vision が確信を持って判定した時だけ採用する
const IRREVERSIBLE_CATS = new Set(["04", "05"]);

/**
 * Fallback カテゴリ選択 (Vision が null を返した時用、pure function)
 *
 * 04 (間取り図) と 05 (建物外観) は IRREVERSIBLE_CATS に該当するため除外。
 * 確信のない画像を強引に 04/05 に当てると名寄せスコアと bukaku supplement
 * 発火条件の両方を壊すため。
 *
 * 優先順: (1) 5pt の安全カテゴリ → (2) 21 (その他) → (3) 04/05 以外の先頭
 *
 * @param {Array<{id: string, label: string, score: number}>} available
 * @returns {string | null} カテゴリ ID、何も選べない時は null
 */
function pickFallbackCategory(available) {
  const fallback5pt = available.find((c) => c.score === 5 && !IRREVERSIBLE_CATS.has(c.id));
  const fallbackOther = available.find((c) => c.id === "21");
  const safeFirst = available.find((c) => !IRREVERSIBLE_CATS.has(c.id));
  return (fallback5pt || fallbackOther || safeFirst)?.id || null;
}

/**
 * 1枚の画像をGPT-4o-mini Visionで分類
 * @param {Buffer} imageBuffer - JPEG画像バッファ
 * @param {Array<{id: string, label: string}>} availableCategories - 使用可能なカテゴリ
 * @returns {string|null} カテゴリID
 */
async function classifySingleImage(imageBuffer, availableCategories) {
  const catList = availableCategories.map((c) => `${c.id}=${c.label}`).join(", ");
  const b64 = imageBuffer.toString("base64");

  const response = await getOpenAI().chat.completions.create({
    model: VISION_MODEL,
    max_tokens: 50,
    messages: [
      {
        role: "user",
        content: [
          {
            type: "image_url",
            image_url: { url: `data:image/jpeg;base64,${b64}`, detail: "low" },
          },
          {
            type: "text",
            text: `この不動産物件写真を画像の内容のみで1つのカテゴリに分類してください。

カテゴリ: ${catList}

【絶対ルール — 04と05は誤判定すると物件の検索順位を壊す】
- 04 (間取り図) は「線画・平面図・フロアプラン図のみ」。線で部屋の輪郭が描かれた図解であることが必須。写真は絶対に04にしない (シンク、浴槽、タイル壁、床の俯瞰など四角い形状の写真も04ではない)。
- 05 (建物外観) は「建物を屋外から撮影した写真のみ」。空・道路・植栽と一緒に建物が写っていること。室内が一部でも映る画像は絶対に05にしない。

【確信度ルール】
- 04 / 05 は明確に確信が持てる場合のみ選ぶこと。少しでも怪しければ別カテゴリ、または 21 (その他) に倒す。
- 04 / 05 を選ぶ前に「これは図面か?」「これは屋外から撮った建物か?」と自問してYESなら採用。

【判定基準（画像に実際に写っているもので判断）】
- 間取り図・平面図・フロアプラン (線画) → 04
- 建物を屋外から撮影した写真 (建物 + 空 / 道路 / 植栽) → 05
- リビング・ダイニング・居間（広い部屋、ソファ、テーブル） → 01
- 洋室・和室・寝室・個室 → 06
- キッチン（コンロ、シンク、調理台、流し台の俯瞰） → 02
- バスルーム・浴室（浴槽、シャワー、浴槽の俯瞰） → 03
- トイレ（便器） → 07
- 洗面台・洗面所（洗面ボウル、鏡） → 08
- 収納・クローゼット・押入れ → 09
- バルコニー・ベランダ → 10
- 庭・テラス・専用庭 → 11
- 玄関・靴箱・玄関ドア内側 → 12
- オートロック・防犯カメラ・モニター付きインターホン → 13
- エアコン・給湯リモコン・コンセント等の設備クローズアップ → 14
- タイル壁・床のクローズアップ等 → 14 (その他設備) または 21 (その他)
- 建物エントランス（自動ドア、集合ポスト、建物入口ホール） → 15
- ロビー・共用ラウンジ・待合スペース → 16
- 駐車場・駐輪場 → 17
- 共用廊下・階段・ゴミ置場・宅配ボックス等 → 18
- 窓からの眺望（室内から外を撮影、景色が主題） → 19
- 省エネ性能ラベル（緑黄の帯、星マーク、住宅の省エネ表示） → 20
- 上記いずれにも明確に該当しない → 21
- QRコードの画像 → 「QR」とだけ回答

【補足ルール】
- 画像に実際に写っているものだけで判断。外部情報に頼らない。
- 窓から外の景色が見えても、撮影位置が室内なら05ではない。景色が主題なら19(眺望)。
- 部屋が主題で窓も見えるだけなら01または06。
- 四角い枠 + 線で構成されていても、写真であれば04ではない。被写体 (シンク・浴槽・タイル等) のカテゴリを選ぶ。

IDのみ回答（例: 01）。`,
          },
        ],
      },
    ],
  });

  const text = (response.choices[0]?.message?.content || "").trim();
  if (/QR/i.test(text)) {
    return "QR";
  }
  const match = text.match(/\b(\d{2})\b/);
  if (match && availableCategories.find((c) => c.id === match[1])) {
    return match[1];
  }
  return null;
}

/**
 * 画像を個別にGPT-4o-mini Visionで分類し、Sharp でリサイズ
 *
 * @param {Array<{index: number, localPath: string}>} downloaded
 * @param {string} downloadDir
 * @returns {Array<{localPath: string, categoryId: string, categoryLabel: string}>}
 */
async function analyzeAndCropImages(downloaded, downloadDir, existingCategories = []) {
  const outputDir = path.join(downloadDir, "processed");
  fs.mkdirSync(outputDir, { recursive: true });

  const validImages = downloaded.filter((img) => fs.existsSync(img.localPath));
  if (validImages.length === 0) return [];

  const processedImages = [];
  const usedCategories = new Set(existingCategories);

  // 5ptカテゴリを優先的に埋めるため、まず全画像を分類してからソート
  const classifications = [];

  // Title → category ID mapping (for conflict detection logging only)
  const TITLE_TO_CAT = {
    "間取": "04", "平面図": "04", "フロア": "04",
    "外観": "05", "建物": "05",
    "リビング": "01", "居室": "01", "LD": "01",
    "キッチン": "02", "台所": "02",
    "バス": "03", "浴室": "03", "風呂": "03",
    "洋室": "06", "ベッドルーム": "06", "和室": "06", "寝室": "06",
    "トイレ": "07",
    "洗面": "08",
    "収納": "09", "クローゼット": "09", "押入": "09",
    "バルコニー": "10", "ベランダ": "10",
    "庭": "11", "テラス": "11",
    "玄関": "12",
    "セキュリティ": "13", "防犯": "13", "オートロック": "13",
    "エントランス": "15",
    "ロビー": "16",
    "駐車": "17", "駐輪": "17",
    "共用": "18", "ゴミ置": "18",
    "眺望": "19", "景色": "19",
    "省エネ": "20",
  };

  for (const img of validImages) {
    const buffer = fs.readFileSync(img.localPath);
    const available = SUUMO_CATEGORIES.filter((c) => !usedCategories.has(c.id) || ALLOW_DUPLICATE.has(c.id));

    let catId = null;
    try {
      catId = await classifySingleImage(buffer, available);
    } catch (err) {
      console.error(`[image] Vision failed #${img.index}:`, err.message);
    }

    // Retry once if Vision failed
    if (!catId) {
      try {
        catId = await classifySingleImage(buffer, available);
        if (catId) console.log(`[image] #${img.index} → classified on retry`);
      } catch (err) {
        console.error(`[image] Vision retry failed #${img.index}:`, err.message);
      }
    }

    // Cross-check: detect REINS title vs Vision mismatch (Vision always wins)
    if (catId && img.title) {
      const titleLower = img.title.toLowerCase();
      let titleSuggestedId = null;
      for (const [key, id] of Object.entries(TITLE_TO_CAT)) {
        if (titleLower.includes(key.toLowerCase())) {
          titleSuggestedId = id;
          break;
        }
      }
      if (titleSuggestedId && titleSuggestedId !== catId) {
        const visionCat = SUUMO_CATEGORIES.find(c => c.id === catId);
        const titleCat = SUUMO_CATEGORIES.find(c => c.id === titleSuggestedId);
        console.warn(`[image] WARNING #${img.index}: REINS title="${img.title}"(${titleCat?.label}) vs Vision="${visionCat?.label}" → Vision優先`);
      }
    }

    // Final fallback: 04/05 (間取り図/建物外観) は不可逆カテゴリのため除外
    // → 5pt 安全枠 → 21 (その他) → 04/05 以外の先頭、の順で fallback
    // null になった場合はその画像を upload からスキップ
    if (!catId) {
      catId = pickFallbackCategory(available);
      if (catId) {
        console.log(`[image] #${img.index} → generic fallback: ${SUUMO_CATEGORIES.find(c => c.id === catId)?.label}`);
      } else {
        console.log(`[image] #${img.index} → fallback skipped (no safe category available)`);
      }
    }

    // QRコード画像はスキップ
    if (catId === "QR") {
      console.log(`[image] #${img.index} → QRコード検出 → スキップ`);
      continue;
    }

    if (catId) {
      usedCategories.add(catId);
      classifications.push({ img, catId });
      const cat = SUUMO_CATEGORIES.find((c) => c.id === catId);
      console.log(`[image] #${img.index} → ${cat?.label} (vision)`);
    }
  }

  // リサイズして出力
  for (const { img, catId } of classifications) {
    const cat = SUUMO_CATEGORIES.find((c) => c.id === catId);
    const outPath = path.join(outputDir, `cat_${catId}_${img.index}.jpg`);

    try {
      await sharp(img.localPath)
        .resize({ width: 1280, height: 960, fit: "cover", position: "centre" })
        .jpeg({ quality: 85 })
        .toFile(outPath);

      processedImages.push({
        localPath: outPath,
        categoryId: catId,
        categoryLabel: cat?.label || catId,
        sourceIndex: img.index,
      });
    } catch (err) {
      console.error(`[image] resize failed #${img.index}:`, err.message);
    }
  }

  // Sort by slot priority:
  // 間取り→建物外観→居室→その他部屋→キッチン→バス→トイレ→洗面→収納→バルコニー→庭→玄関→セキュリティ→その他設備→エントランス→ロビー→駐車場→その他共有→眺望→省エネ→その他
  const UPLOAD_ORDER = ["04", "05", "01", "06", "02", "03", "07", "08", "09", "10", "11", "12", "13", "14", "15", "16", "17", "18", "19", "20", "21"];
  return processedImages.sort((a, b) => {
    const idxA = UPLOAD_ORDER.indexOf(a.categoryId);
    const idxB = UPLOAD_ORDER.indexOf(b.categoryId);
    return (idxA === -1 ? 99 : idxA) - (idxB === -1 ? 99 : idxB);
  });
}

/**
 * 不足5ptカテゴリを既存画像から部分切り抜きで補完
 *
 * 例: リビング写真の端にキッチンが写っている → そこだけ切り抜いてキッチン画像にする
 *
 * @param {Array} processedImages - 分類済み画像リスト
 * @param {Array<{index: number, localPath: string}>} downloaded - 元画像リスト
 * @param {string} downloadDir - 出力ディレクトリ
 * @returns {Array} 新たに生成された画像リスト
 */
async function cropMissingCategories(processedImages, downloaded, downloadDir) {
  const outputDir = path.join(downloadDir, "processed");
  fs.mkdirSync(outputDir, { recursive: true });

  const presentCats = new Set(processedImages.map(img => img.categoryId));

  // 切り抜き可能な5ptカテゴリのみ対象（間取り04・建物外観05は他写真から切り出せない）
  const CROPPABLE = [
    { id: "01", label: "居室・リビング", hint: "リビング、ダイニング、居間（広い部屋、ソファ、テーブル）" },
    { id: "02", label: "キッチン", hint: "キッチン、コンロ、シンク、調理台、IHクッキングヒーター" },
    { id: "03", label: "バス・シャワールーム", hint: "浴室、浴槽、シャワー、バスルーム" },
  ];

  const missingCats = CROPPABLE.filter(c => !presentCats.has(c.id));
  if (missingCats.length === 0) return [];

  // 実写真を優先、間取り図(04)・外観(05)は最後の手段として使用
  const floorPlanIndices = new Set(
    processedImages
      .filter(img => img.categoryId === "04" || img.categoryId === "05")
      .map(img => img.sourceIndex)
  );
  const photoSources = downloaded.filter(
    img => fs.existsSync(img.localPath) && !floorPlanIndices.has(img.index)
  );
  const diagramSources = downloaded.filter(
    img => fs.existsSync(img.localPath) && floorPlanIndices.has(img.index)
  );
  // 実写真 → 間取り図/外観の順で試行
  const sourceImages = [...photoSources, ...diagramSources];
  if (sourceImages.length === 0) return [];

  const newImages = [];

  for (const target of missingCats) {
    let found = false;

    for (const srcImg of sourceImages) {
      if (found) break;

      let buffer;
      try {
        buffer = fs.readFileSync(srcImg.localPath);
      } catch { continue; }

      // Vision: この画像に対象エリアが部分的に写っているか判定 + 切り抜き座標取得
      try {
        const b64 = buffer.toString("base64");
        const response = await getOpenAI().chat.completions.create({
          model: VISION_MODEL,
          max_tokens: 200,
          messages: [{
            role: "user",
            content: [
              {
                type: "image_url",
                image_url: { url: `data:image/jpeg;base64,${b64}`, detail: "low" },
              },
              {
                type: "text",
                text: `この不動産写真の一部に「${target.label}」エリアが写っていますか？
探す対象: ${target.hint}

判定ルール:
- 写真のメインの被写体でなくても、背景や端に写っていればOK
- 対象エリアが画像面積の10%以上を占めていること
- 明確に識別できること（ぼやけていたり極端に小さい場合はNG）

写っている場合、切り抜き座標をJSON形式で回答:
{"found":true,"x":左端パーセント,"y":上端パーセント,"w":幅パーセント,"h":高さパーセント}
座標は画像全体に対する割合(0-100)。対象エリアを中心に余裕を持って指定。

写っていない場合: {"found":false}
JSONのみ回答。`,
              },
            ],
          }],
        });

        const text = (response.choices[0]?.message?.content || "").trim();
        const jsonMatch = text.match(/\{[^}]+\}/);
        if (!jsonMatch) continue;

        const result = JSON.parse(jsonMatch[0]);
        if (!result.found) continue;

        // 座標バリデーション
        const { x, y, w, h } = result;
        if (typeof x !== "number" || typeof y !== "number" || typeof w !== "number" || typeof h !== "number") continue;
        if (w < 10 || h < 10 || x < 0 || y < 0 || x + w > 105 || y + h > 105) continue;

        // Sharp で切り抜き
        const metadata = await sharp(buffer).metadata();
        const imgW = metadata.width || 1280;
        const imgH = metadata.height || 960;

        const cropX = Math.max(0, Math.round(imgW * Math.min(x, 100) / 100));
        const cropY = Math.max(0, Math.round(imgH * Math.min(y, 100) / 100));
        const cropW = Math.min(Math.round(imgW * Math.min(w, 100) / 100), imgW - cropX);
        const cropH = Math.min(Math.round(imgH * Math.min(h, 100) / 100), imgH - cropY);

        if (cropW < 100 || cropH < 100) continue;

        const outPath = path.join(outputDir, `crop_${target.id}_from${srcImg.index}.jpg`);
        await sharp(buffer)
          .extract({ left: cropX, top: cropY, width: cropW, height: cropH })
          .resize({ width: 1280, height: 960, fit: "cover", position: "centre" })
          .jpeg({ quality: 85 })
          .toFile(outPath);

        newImages.push({
          localPath: outPath,
          categoryId: target.id,
          categoryLabel: target.label,
          sourceIndex: srcImg.index,
          cropped: true,
        });

        console.log(`[image] CROP: ${target.label} extracted from image #${srcImg.index} (${x},${y} ${w}x${h}%) → ${path.basename(outPath)}`);
        found = true;
      } catch (err) {
        // JSON parse error or sharp error — skip to next image
        continue;
      }
    }

    if (!found) {
      console.log(`[image] CROP: ${target.label} not found in any source image`);
    }
  }

  return newImages;
}

module.exports = { analyzeAndCropImages, cropMissingCategories, SUUMO_CATEGORIES, pickFallbackCategory, IRREVERSIBLE_CATS };
