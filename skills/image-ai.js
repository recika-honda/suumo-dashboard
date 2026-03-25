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
    model: "claude-sonnet-4-6",
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
- 建物の外観写真（外から撮影、建物全体や一部が空・道路・植栽と共に写っている） → 05
- リビング・ダイニング・居間（広い部屋、ソファ、テーブル） → 01
- 洋室（ベッド、クローゼットのある個室） → 06
- キッチン（コンロ、シンク、調理台が写っている） → 02
- バスルーム・浴室（浴槽、シャワーが写っている） → 03
- トイレ（便器が写っている） → 08
- 洗面台・洗面所（洗面ボウル、鏡） → 09
- QRコードの画像 → 「QR」とだけ回答

重要ルール:
- 画像に実際に写っているものだけで判断。外部情報に頼らない。
- 05(外観)は「建物を外から撮影した写真」のみ。室内の壁・床・天井・窓が見える場合は外観ではなく室内カテゴリ(01,02,03,06,08,09等)。
- 窓から外の景色が見えても、撮影位置が室内なら外観(05)ではない。

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

  // 切り抜き可能な5ptカテゴリのみ対象（間取り04・外観05は他写真から切り出せない）
  const CROPPABLE = [
    { id: "01", label: "居室・リビング", hint: "リビング、ダイニング、居間（広い部屋、ソファ、テーブル）" },
    { id: "02", label: "キッチン", hint: "キッチン、コンロ、シンク、調理台、IHクッキングヒーター" },
    { id: "03", label: "バス・シャワー", hint: "浴室、浴槽、シャワー、バスルーム" },
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
        const response = await client.messages.create({
          model: "claude-sonnet-4-6",
          max_tokens: 200,
          messages: [{
            role: "user",
            content: [
              {
                type: "image",
                source: { type: "base64", media_type: "image/jpeg", data: buffer.toString("base64") },
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

        const text = response.content[0].text.trim();
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

module.exports = { analyzeAndCropImages, cropMissingCategories, SUUMO_CATEGORIES };
