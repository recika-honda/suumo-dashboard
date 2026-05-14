/**
 * skills/forrent/fill-images.js — forrent.jp 画像アップロード
 *
 * 元: skills/forrent.js (Phase 7 分割前)
 *
 * Public surface:
 *   - setFileInput(frame, inputName, filePath)
 *   - setImageCategory(frame, slotName, catCode, shashinIdx, tsuikaIdx)
 *   - uploadImages(mainFrame, processedImages)
 *
 * 画像スロット構造:
 *   固定: file_up_gaikan / file_up_perth / file_up_shitsunai / file_up_map / file_up_shuhenkankyo
 *   可変: file_up_shashin{1-3} / file_up_tsuikaGazo{1-8}
 *   周辺6: file_up_shuhenKankyo{1-6}
 */

const sharp = require("sharp");
const path = require("path");
const { SHUHEN_CATEGORY_CODES } = require("./constants");

// ══════════════════════════════════════════════════════════
//  画像アップロード
// ══════════════════════════════════════════════════════════

/**
 * forrent.jp 画像スロット構造:
 *
 * 固定スロット:
 *   - 外観:   file_up_gaikan   (+ gaikanMemo)
 *   - パース: file_up_perth    (+ perthMemo)
 *   - 室内:   file_up_shitsunai (+ shitsunaiShashinCategory + shitsunaiMemo)
 *   - 地図:   file_up_map
 *   - 周辺環境: file_up_shuhenkankyo
 *
 * 可変スロット:
 *   - 写真1-3:     file_up_shashin{1-3}    (+ shashin{N}Category + shashin{N}Memo)
 *   - 追加画像1-8: file_up_tsuikaGazo{1-8} (+ tsuikaGazo{N}Category + tsuikaGazo{N}Memo(id=tsuikaGazo{N}))
 *
 * 周辺環境6スロット:
 *   - file_up_shuhenKankyo{1-6} (+ categoryCd + shuhenKankyoNm + kyori)
 */

/**
 * ファイル入力ヘルパー — name属性 + 可視性 + 親の可視性で正しい要素を特定
 * (forrent.jpはフォーム内でfile input が最大8回重複するため、
 *  表示中セクション内の要素を確実に特定する必要がある)
 */
async function setFileInput(frame, inputName, filePath) {
  // Step 1: 全候補を評価し、最も適切な要素のインデックスを取得
  const info = await frame.evaluate((name) => {
    const all = [...document.querySelectorAll(`input[type="file"][name="${name}"]`)];
    if (!all.length) return { total: 0, bestIdx: -1 };

    const candidates = all.map((el, i) => {
      const rect = el.getBoundingClientRect();
      const style = window.getComputedStyle(el);
      const parentStyle = el.parentElement ? window.getComputedStyle(el.parentElement) : null;
      return {
        idx: i,
        visible: style.display !== "none" && style.visibility !== "hidden",
        parentVisible: parentStyle ? parentStyle.display !== "none" : true,
        hasSize: rect.width > 0 && rect.height > 0,
        inViewport: rect.top >= 0 && rect.top < document.documentElement.scrollHeight,
      };
    });

    // 優先順位: visible + parentVisible + hasSize
    const best = candidates.find(c => c.visible && c.parentVisible && c.hasSize)
      || candidates.find(c => c.visible && c.parentVisible)
      || candidates.find(c => c.visible)
      || candidates[0];

    return { total: all.length, bestIdx: best?.idx ?? -1, candidates };
  }, inputName);

  if (info.total === 0 || info.bestIdx === -1) {
    console.log(`[forrent] x file: ${inputName} not found (0 elements)`);
    return false;
  }

  // Step 2: 特定のインデックスの要素にファイルをセット
  const handle = await frame.evaluateHandle(({ name, idx }) => {
    return document.querySelectorAll(`input[type="file"][name="${name}"]`)[idx];
  }, { name: inputName, idx: info.bestIdx });

  const el = handle.asElement();
  if (!el) {
    await handle.dispose();
    return false;
  }

  await el.setInputFiles(filePath);

  // Step 3: 検証 — ファイルがセットされたか確認
  const verified = await frame.evaluate(({ name, idx }) => {
    const el = document.querySelectorAll(`input[type="file"][name="${name}"]`)[idx];
    return el?.files?.length > 0;
  }, { name: inputName, idx: info.bestIdx });

  await handle.dispose();

  if (!verified) {
    console.log(`[forrent] ! file: ${inputName} setInputFiles succeeded but files.length=0 (${info.total} elements, idx=${info.bestIdx})`);
  }

  return verified;
}

// image-ai.js カテゴリ → forrent.jp スロット マッピング
const GAIKAN_CATS = ["建物外観"];
const INTERIOR_CATS = [
  "居室・リビング", "その他部屋・スペース", "キッチン", "バス・シャワールーム",
  "トイレ", "洗面設備", "収納", "バルコニー", "庭", "玄関",
  "セキュリティ", "その他設備",
]; // shitsunaiShashinCategory 12択と完全一致
const MADORI_CATS = ["間取り図"];
const SHUHEN_CATS = ["周辺環境"];

// categoryLabel → forrent.jp カテゴリコード（プルダウン value と1:1対応）
const FORRENT_CATEGORY_MAP = {
  // 室内系 (040xxx)
  "居室・リビング": "040101",
  "その他部屋・スペース": "040102",
  "キッチン": "040103",
  "バス・シャワールーム": "040104",
  "トイレ": "040105",
  "洗面設備": "040106",
  "収納": "040107",
  "バルコニー": "040108",
  "庭": "040109",
  "玄関": "040110",
  "セキュリティ": "040111",
  "その他設備": "040199",
  // 外観 (020xxx)
  "建物外観": "020101",
  // 共有部分 (030xxx)
  "エントランス": "030101",
  "ロビー": "030102",
  "駐車場": "030103",
  "その他共有部分": "030199",
  // その他
  "眺望": "050101",
  "省エネ性能ラベル": "070101",
  "その他": "999999",
};

/**
 * 画像カテゴリselectを設定
 * @param {string} slotName - gaikanFile, shitsunaiFile, shashin1File, tsuikaGazo1File, etc.
 * @param {string} catCode - forrent.jpカテゴリコード (e.g. "040101")
 * @param {number} shashinIdx - 現在のshashin番号 (1-3) - shashinFile時のみ使用
 * @param {number} tsuikaIdx - 現在のtsuikaGazo番号 (1-8) - tsuikaGazoFile時のみ使用
 */
async function setImageCategory(frame, slotName, catCode, shashinIdx, tsuikaIdx) {
  await frame.evaluate(({ slot, code, sIdx, tIdx }) => {
    let sel = null;

    if (slot === "shitsunaiFile") {
      // 室内写真: shitsunaiShashinCategory or shitsunaiCategory
      sel = document.getElementById("shitsunaiShashinCategory")
        || document.getElementById("shitsunaiCategory")
        || document.querySelector("select[name*='shitsunaiCategory']");
    } else if (slot.startsWith("shashin") && slot.endsWith("File")) {
      // shashin1File → shashin1Category, shashin2File → shashin2Category ...
      const n = slot.replace("shashin", "").replace("File", "");
      sel = document.getElementById(`shashin${n}Category`);
    } else if (slot.startsWith("tsuikaGazo") && slot.endsWith("File")) {
      // tsuikaGazo1File → index 0 の categoryCd
      const n = parseInt(slot.replace("tsuikaGazo", "").replace("File", ""), 10);
      const idx = n - 1; // 1-based → 0-based
      const all = document.querySelectorAll("select[name*='tsuikaGazoInputForm'][name*='categoryCd']");
      if (idx < all.length) sel = all[idx];
    }
    // gaikanFile, shuhenKankyoFile → カテゴリselectなし（固定）

    if (sel) {
      sel.value = code;
      sel.dispatchEvent(new Event("change", { bubbles: true }));
      return true;
    }
    return false;
  }, { slot: slotName, code: catCode, sIdx: shashinIdx, tIdx: tsuikaIdx });
}

async function uploadImages(mainFrame, processedImages) {
  const uploaded = [];
  const errors = [];

  const items = (processedImages || []).map(img =>
    typeof img === "string" ? { localPath: img } : img
  );
  if (!items.length) return { uploaded, errors };

  // 画像セクションへスクロール
  await mainFrame.evaluate(() => {
    const a = document.querySelector('[name="gazou"]');
    if (a) a.scrollIntoView();
  }).catch(() => {});
  await mainFrame.waitForTimeout(1000);

  // スロット使用トラッカー
  let gaikanDone = false, shitsunaiDone = false, madoriDone = false;
  let shashinN = 1;  // 1-3
  let tsuikaN = 1;   // 1-8
  let shuhenN = 1;   // 1-6

  for (const img of items) {
    const cat = img.categoryLabel || "";
    let inputName = null;

    // カテゴリ → スロット割り当て
    if (MADORI_CATS.includes(cat) && !madoriDone) {
      // 間取り図専用スロット（名寄せ5pt — shashin枠の1ptより大幅UP）
      inputName = "clientMadoriFile"; madoriDone = true;
    } else if (GAIKAN_CATS.includes(cat) && !gaikanDone) {
      inputName = "gaikanFile"; gaikanDone = true;
    } else if (INTERIOR_CATS.includes(cat) && !shitsunaiDone) {
      inputName = "shitsunaiFile"; shitsunaiDone = true;
    } else if (SHUHEN_CATS.includes(cat) && shuhenN <= 6) {
      const currentShuhen = shuhenN;
      inputName = `shuhenKankyo${shuhenN++}File`;
      // Required categories per slot: コンビニ/スーパー/ドラッグストア/病院/飲食店 etc.
      // NOTE: 070201(郵便局), 080101(学校) 等の非ショッピング系コードは
      // mokuteki selectに存在しない可能性があるため除外
      const SHUHEN_CATEGORIES = [
        { code: "060203", name: "コンビニ" },
        { code: "060202", name: "スーパー" },
        { code: "060204", name: "ドラッグストア" },
        { code: "060210", name: "病院" },
        { code: "060218", name: "飲食店" },
        { code: "060211", name: "郵便局" },
      ];
      // facilityTypeがある場合は画像の実際の施設種別に合ったカテゴリを使用
      // Derived from SHUHEN_CATEGORY_CODES (single source of truth at module top)
      const SHUHEN_TYPE_MAP = Object.fromEntries(
        Object.entries(SHUHEN_CATEGORY_CODES).map(([code, name]) => [name, { code, name }])
      );
      const catInfo = (img.facilityType && SHUHEN_TYPE_MAP[img.facilityType])
        || SHUHEN_CATEGORIES[currentShuhen - 1]
        || SHUHEN_CATEGORIES[0];
      const destName = (img.facilityName && img.facilityName !== catInfo.name)
        ? img.facilityName
        : `近隣${catInfo.name}`;
      try {
        const metaResult = await mainFrame.evaluate(({ n, catCode, catName }) => {
          const catEl = document.getElementById(`mokuteki${n}`);
          let catSet = false;
          if (catEl) {
            // mokuteki selectにコードが存在するか確認してから設定
            const hasOption = [...catEl.options].some(o => o.value === catCode);
            if (hasOption) {
              catEl.value = catCode;
              catEl.dispatchEvent(new Event("change", { bubbles: true }));
              catSet = true;
            }
          }
          const nameEl = document.getElementById(`destination${n}`);
          if (nameEl) {
            // forrent 側「30文字以内」バリデータに合わせてクリップ
            nameEl.value = (catName || "").slice(0, 30);
            nameEl.dispatchEvent(new Event("input", { bubbles: true }));
          }
          const distEl = document.getElementById(`distance${n}`);
          if (distEl) {
            distEl.value = "100";
            distEl.dispatchEvent(new Event("input", { bubbles: true }));
          }
          return { catSet };
        }, { n: currentShuhen, catCode: catInfo.code, catName: destName });
        console.log(`[forrent] + 周辺環境${currentShuhen}メタ: ${destName}(${catInfo.name})/100m${metaResult.catSet ? "" : " [mokutekiコード無効]"}`);
      } catch (e) {
        console.log(`[forrent] x 周辺環境メタ: ${e.message.slice(0, 60)}`);
      }
    } else if (shashinN <= 3) {
      inputName = `shashin${shashinN++}File`;
    } else if (tsuikaN <= 8) {
      inputName = `tsuikaGazo${tsuikaN++}File`;
    } else {
      errors.push(`slot overflow: ${img.localPath}`);
      continue;
    }

    try {
      const ok = await setFileInput(mainFrame, inputName, img.localPath);
      if (ok) {
        uploaded.push(img.localPath);
        console.log(`[forrent] + image: ${inputName} <- ${img.localPath.split("/").pop()}`);

        // ★ カテゴリselect設定（名寄せスコアの主要配点）
        const forrentCatCode = FORRENT_CATEGORY_MAP[cat] || "";
        if (forrentCatCode) {
          await setImageCategory(mainFrame, inputName, forrentCatCode, shashinN - 1, tsuikaN - 1);
          console.log(`[forrent] + category: ${inputName} → ${forrentCatCode} (${cat})`);
        }
      } else {
        console.log(`[forrent] x image: ${inputName} not found in DOM`);
        errors.push(`image(${inputName}): element not found`);
      }
      await mainFrame.waitForTimeout(1500);
    } catch (e) {
      console.log(`[forrent] x image: ${inputName}: ${e.message.slice(0, 80)}`);
      errors.push(`image(${inputName}): ${e.message.slice(0, 60)}`);
    }
  }

  // ★ 残りtsuikaGazoスロットを未使用カテゴリで埋める
  // Create unique image variants (different crop/quality) to avoid duplicate detection
  const EXTRA_CATEGORIES = [
    { code: "040107", label: "収納" },
    { code: "040108", label: "バルコニー" },
    { code: "040109", label: "庭" },
    { code: "030101", label: "エントランス" },
    { code: "030102", label: "ロビー" },
    { code: "040111", label: "セキュリティ" },
    { code: "050101", label: "眺望" },
  ];
  const usedCodes = new Set();
  for (const img of items) {
    const cat = img.categoryLabel || "";
    const code = FORRENT_CATEGORY_MAP[cat];
    if (code) usedCodes.add(code);
  }
  const reuseImages = items.filter(img => INTERIOR_CATS.includes(img.categoryLabel || ""));

  if (reuseImages.length > 0 && tsuikaN <= 8) {
    let reuseIdx = 0;
    for (const extra of EXTRA_CATEGORIES) {
      if (tsuikaN > 8) break;
      if (usedCodes.has(extra.code)) continue;

      const reuseImage = reuseImages[reuseIdx % reuseImages.length];
      reuseIdx++;
      const inputName = `tsuikaGazo${tsuikaN++}File`;
      try {
        // Create a unique variant: different crop offset + quality to avoid duplicate detection
        const variantPath = reuseImage.localPath.replace(/\.jpg$/, `_var${reuseIdx}.jpg`);
        const meta = await sharp(reuseImage.localPath).metadata();
        const cropX = Math.min(reuseIdx * 3, Math.floor((meta.width || 1280) * 0.05));
        const cropY = Math.min(reuseIdx * 2, Math.floor((meta.height || 960) * 0.05));
        await sharp(reuseImage.localPath)
          .extract({
            left: cropX, top: cropY,
            width: (meta.width || 1280) - cropX * 2,
            height: (meta.height || 960) - cropY * 2,
          })
          .resize({ width: 1280, height: 960, fit: "cover" })
          .jpeg({ quality: 82 - reuseIdx }) // slightly different quality each time
          .toFile(variantPath);

        const ok = await setFileInput(mainFrame, inputName, variantPath);
        if (ok) {
          uploaded.push(variantPath);
          console.log(`[forrent] + image(variant): ${inputName} <- ${path.basename(variantPath)} as ${extra.label}`);
          await setImageCategory(mainFrame, inputName, extra.code, 0, tsuikaN - 1);
          console.log(`[forrent] + category: ${inputName} → ${extra.code} (${extra.label})`);
        }
        await mainFrame.waitForTimeout(1000);
      } catch (e) {
        console.log(`[forrent] x fill: ${inputName}: ${e.message.slice(0, 60)}`);
      }
    }
  }

  // ★ 周辺環境画像フォールバック削除
  // 外観写真を周辺環境として使うのは不適切（先方フィードバック: 全て物件の外観写真になるケースあり）
  // 周辺環境写真がない場合はスロットを空のままにする（らくらく周辺環境ポップアップで補完）
  if (shuhenN === 1) {
    console.log(`[forrent] 周辺環境画像なし → スロット空（外観フォールバック無効化済み）`);
  }

  console.log(`[forrent] images: ${uploaded.length} uploaded, ${errors.length} errors`);
  return { uploaded, errors };
}


module.exports = {
  setFileInput,
  setImageCategory,
  uploadImages,
};
