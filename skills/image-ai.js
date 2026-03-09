/**
 * Image Pipeline — Claude Vision 個別分類 + Sharp リサイズ
 *
 * 各画像を1枚ずつClaude Visionで分類し、正確なカテゴリを割り当てる。
 * 使用済みカテゴリは候補から除外し、重複を防ぐ。
 */

const Anthropic = require("@anthropic-ai/sdk");
const sharp = require("sharp");
const fs = require("fs");
const path = require("path");

const client = new Anthropic();

const SUUMO_CATEGORIES = [
  { id: "01", label: "居室・リビング", score: 5 },
  { id: "02", label: "キッチン", score: 5 },
  { id: "03", label: "バス・シャワー", score: 5 },
  { id: "04", label: "間取り図", score: 5 },
  { id: "05", label: "外観", score: 5 },
  { id: "06", label: "洋室", score: 1 },
  { id: "07", label: "和室", score: 1 },
  { id: "08", label: "トイレ", score: 1 },
  { id: "09", label: "洗面所", score: 1 },
  { id: "10", label: "玄関", score: 1 },
  { id: "11", label: "収納", score: 1 },
  { id: "12", label: "バルコニー", score: 1 },
  { id: "13", label: "共用部", score: 1 },
  { id: "14", label: "周辺環境", score: 1 },
];

/**
 * 1枚の画像をClaude Visionで分類
 * @param {Buffer} imageBuffer - JPEG画像バッファ
 * @param {Array<{id: string, label: string}>} availableCategories - 使用可能なカテゴリ
 * @returns {string|null} カテゴリID
 */
async function classifySingleImage(imageBuffer, availableCategories) {
  const catList = availableCategories.map((c) => `${c.id}=${c.label}`).join(", ");

  const response = await client.messages.create({
    model: "claude-haiku-4-5-20251001",
    max_tokens: 50,
    messages: [
      {
        role: "user",
        content: [
          {
            type: "image",
            source: {
              type: "base64",
              media_type: "image/jpeg",
              data: imageBuffer.toString("base64"),
            },
          },
          {
            type: "text",
            text: `この不動産物件写真を画像の内容のみで1つのカテゴリに分類してください。

カテゴリ: ${catList}

判定基準（画像に実際に写っているもので判断）:
- 間取り図・平面図・フロアプラン → 必ず04
- 建物の外観写真（外から撮影） → 05
- リビング・ダイニング・居間（広い部屋、ソファ、テーブル） → 01
- 洋室（ベッド、クローゼットのある個室） → 06
- キッチン（コンロ、シンク、調理台が写っている） → 02
- バスルーム・浴室（浴槽、シャワーが写っている） → 03
- トイレ（便器が写っている） → 08
- 洗面台・洗面所（洗面ボウル、鏡） → 09
- QRコードの画像 → 「QR」とだけ回答

重要: 画像に実際に写っているものだけで判断してください。外部情報に頼らないでください。

IDのみ回答（例: 01）。`,
          },
        ],
      },
    ],
  });

  const text = response.content[0].text.trim();
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
 * 画像を個別にClaude Visionで分類し、Sharp でリサイズ
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
    "洋室": "06", "ベッドルーム": "06",
    "和室": "07",
    "トイレ": "08",
    "洗面": "09",
    "玄関": "10",
    "収納": "11", "クローゼット": "11",
    "バルコニー": "12", "ベランダ": "12",
    "エントランス": "13", "共用": "13",
    "周辺": "14",
  };

  for (const img of validImages) {
    const buffer = fs.readFileSync(img.localPath);
    const available = SUUMO_CATEGORIES.filter((c) => !usedCategories.has(c.id));

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

    // Final fallback: fill high-score categories first (NO title-based fallback)
    if (!catId) {
      const fallback = available.find((c) => c.score === 5) || available[0];
      catId = fallback?.id;
      if (catId) console.log(`[image] #${img.index} → generic fallback: ${SUUMO_CATEGORIES.find(c => c.id === catId)?.label}`);
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

  // Sort by staff-specified order:
  // 間取り→外観→リビング→その他・洋室→キッチン→バス→トイレ→洗面設備→収納→その他設備→エントランス→ロビー→その他共有部分→その他
  const UPLOAD_ORDER = ["04", "05", "01", "06", "02", "03", "08", "09", "11", "10", "12", "13", "14", "07"];
  return processedImages.sort((a, b) => {
    const idxA = UPLOAD_ORDER.indexOf(a.categoryId);
    const idxB = UPLOAD_ORDER.indexOf(b.categoryId);
    return (idxA === -1 ? 99 : idxA) - (idxB === -1 ? 99 : idxB);
  });
}

module.exports = { analyzeAndCropImages, SUUMO_CATEGORIES };
