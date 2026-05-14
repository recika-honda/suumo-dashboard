/**
 * REINS Skill - Login, Search, Data Extraction, Image Download
 *
 * Selectors & structure based on investigation (2026-02-12):
 * - Bootstrap-Vue SPA (Nuxt.js)
 * - Dynamic IDs (__BVID__*) → use class-based selectors
 * - Image popup: modal-xl centered, dynamic boundingBox with fixed fallback
 */

const REINS_URLS = {
  login: "https://system.reins.jp/login/main/KG/GKG001200",
  dashboard: "https://system.reins.jp/main/KG/GKG003100",
  numberSearch: "https://system.reins.jp/main/BK/GBK004100",
  searchResult: "https://system.reins.jp/main/BK/GBK004200",
  detail: "https://system.reins.jp/main/BK/GBK003200",
};

const REINS_SELECTORS = {
  login: {
    idInput: 'input.p-textbox-input[type="text"]',
    passInput: 'input.p-textbox-input[type="password"]',
    checkbox: 'input.custom-control-input[type="checkbox"]',
    submitBtn: "button.p-button",
  },
  dashboard: {
    numberSearchBtn: 'button:has-text("物件番号検索")',
  },
  numberSearch: {
    inputs: 'input.p-textbox-input[type="text"]',
    searchBtn: 'button:has-text("検索")',
  },
  result: {
    row: ".p-table-body-row",
    detailBtn: 'button:has-text("詳細")',
    zumenBtn: 'button:has-text("図面")',
  },
  detail: {
    imageSectionBtn: 'button:has-text("画像・図面")',
    zumenRefBtn: 'button:has-text("図面参照")',
    imageCard: ".col-image",
    labelTitle: ".p-label-title",
  },
  imagePopup: {
    modal: ".modal.show .modal-content",
    imageView: ".flex-fill.image-view",
    closeBtn: 'button:has-text("閉じる")',
    // Tighter fallback clip (10px inset from original)
    clip: { x: 237, y: 141, width: 806, height: 634 },
  },
};

// ── Login ──────────────────────────────────────────────────
async function login(page, credentials) {
  await page.goto(REINS_URLS.login, {
    waitUntil: "networkidle",
    timeout: 20000,
  });
  await page.waitForTimeout(2000);

  await page.fill(REINS_SELECTORS.login.idInput, credentials.id);
  await page.waitForTimeout(300);
  await page.fill(REINS_SELECTORS.login.passInput, credentials.pass);
  await page.waitForTimeout(300);

  // Accept both checkboxes
  const cbs = await page.$$(REINS_SELECTORS.login.checkbox);
  for (const cb of cbs) {
    if (!(await cb.isChecked())) {
      await cb.click({ force: true });
      await page.waitForTimeout(200);
    }
  }
  await page.waitForTimeout(500);
  await page.click(REINS_SELECTORS.login.submitBtn);
  await page.waitForTimeout(5000);

  // ログイン後に告知/メンテ/セッション競合のモーダルが表示されると、
  // ダッシュボードの「物件番号検索」ボタンが visible/enabled/stable に
  // 到達せず click TIMEOUT になる。ベストエフォートで dismiss する。
  await dismissDashboardOverlays(page);

  return page.url().includes("GKG003100");
}

// ログイン後に出現しうるダイアログ/告知バナーを最大 5s ベストエフォートで閉じる。
// 既知パターン (お知らせモーダルの×ボタン / OK / 閉じる / モーダル上の同意ボタン) を順に当てる。
async function dismissDashboardOverlays(page) {
  const candidates = [
    'button:has-text("閉じる")',
    'button:has-text("OK")',
    'button:has-text("確認")',
    'button:has-text("同意")',
    'a:has-text("閉じる")',
    'div.modal button[class*="close"]',
    'div[class*="modal"] button[class*="close"]',
    'button[aria-label="Close"]',
    'button[aria-label="閉じる"]',
  ];
  const deadline = Date.now() + 5000;
  for (const sel of candidates) {
    if (Date.now() > deadline) break;
    try {
      const btn = await page.$(sel);
      if (btn && (await btn.isVisible().catch(() => false))) {
        await btn.click({ timeout: 1500 }).catch(() => {});
        await page.waitForTimeout(300);
      }
    } catch {}
  }
  // 物件番号検索ボタンが visible になるまで最大 8s 待機（モーダル消えれば即返る）
  try {
    await page.waitForSelector(REINS_SELECTORS.dashboard.numberSearchBtn, {
      state: "visible",
      timeout: 8000,
    });
  } catch {}
}

// ── Search by Property Number ──────────────────────────────
async function searchByNumber(page, reinsId) {
  // 物件番号検索ボタンがオーバーレイ等で stable にならないケースがあるため
  // 1) overlay dismiss を試行 → 2) click の前に visible 待機 → 3) 失敗時は force click にフォールバック
  await dismissDashboardOverlays(page).catch(() => {});
  try {
    await page.waitForSelector(REINS_SELECTORS.dashboard.numberSearchBtn, {
      state: "visible",
      timeout: 10000,
    });
    await page.click(REINS_SELECTORS.dashboard.numberSearchBtn, { timeout: 10000 });
  } catch {
    // 通常 click が timeout なら force click を試みる（element exists but not stable のケース対策）
    await page.click(REINS_SELECTORS.dashboard.numberSearchBtn, {
      force: true,
      timeout: 5000,
    });
  }
  await page.waitForTimeout(3000);

  const inputs = await page.$$(REINS_SELECTORS.numberSearch.inputs);
  if (inputs.length === 0) throw new Error("Property number input not found");

  await inputs[0].fill(reinsId);
  await page.waitForTimeout(500);
  await page.click(REINS_SELECTORS.numberSearch.searchBtn);
  await page.waitForTimeout(5000);

  // Check if results found
  const hasResults = await page.evaluate(() => {
    return !document.body.innerText.includes("検索結果が0件");
  });

  return hasResults;
}

// ── Extract All Property Data ──────────────────────────────
async function extractPropertyData(page) {
  // Click detail button
  await page.click(REINS_SELECTORS.result.detailBtn);
  await page.waitForTimeout(5000);

  const data = await page.evaluate(() => {
    const result = {};
    const body = document.body.innerText;

    // Parse using the innerText structure
    // NOTE: REINS innerText places labels and values on separate lines.
    // When a value is empty, the NEXT label appears immediately → regex captures it.
    // Use strict patterns to avoid capturing field labels as values.

    // Known REINS field labels (used to reject garbage captures)
    const LABELS = new Set([
      "物件番号","物件種目","広告転載区分","商号","代表電話番号",
      "賃料","敷金","礼金","契約期間","使用部分面積","保証金","権利金",
      "都道府県名","所在地名","建物名","部屋番号","間取タイプ",
      "間取部屋数","築年月","建物構造","地上階層","地下階層",
      "所在階","バルコニー方向","管理費","共益費","更新料",
      "駐車場在否","現況","入居時期","取引態様","配分割合",
      "設備","条件","備考","備考１","備考２","備考３","償却コード","償却月数","償却率","報酬・負担割合",
      "更新区分","鍵交換区分","室１","室２","室３","室４","室５",
      "増改築年月","その他一時金","入居年月","設備・条件・住宅性能等",
      "設備(フリースペース)","条件(フリースペース)","配分割合客付",
    ]);

    const patterns = {
      物件番号: /物件番号\s*\n\s*(\S+)/,
      物件種目: /物件種目\s*\n\s*(マンション|アパート|一戸建|テラスハウス|タウンハウス|\S+)/,
      広告転載区分: /広告転載区分\s*\n\s*(広告可|広告不可|不可)/,
      商号: /商号\s*\n\s*([^\n]+)/,
      代表電話番号: /代表電話番号\s*\n\s*([\d-]+)/,
      賃料: /賃料\s*\n\s*([\d.]+万円)/,
      // 敷金/礼金/保証金: flexible format — amount+unit, months, or none
      敷金: /敷金\s*\n\s*([\d,.]+\s*(?:万円|円|ヶ?月|か月|カ月)|なし|ー|0)/,
      礼金: /礼金\s*\n\s*([\d,.]+\s*(?:万円|円|ヶ?月|か月|カ月)|なし|ー|0)/,
      保証金: /保証金\s*\n\s*([\d,.]+\s*(?:万円|円|ヶ?月|か月|カ月)|なし|ー|0)/,
      // 償却: コード/月数/率の3つ。償却月数 (数値+月) → forrent shokyakukin に流す。
      // 償却率は当面非対応 (forrent input が ヶ月/万円 ベース)。
      償却月数: /償却月数\s*\n\s*(\d+)(?:\s*ヶ?月)?/,
      償却率: /償却率\s*\n\s*([\d.]+)\s*[%％]?/,
      契約期間: /契約期間\s*\n\s*(\d+[^\n]*)/,
      使用部分面積: /使用部分面積\s*\n\s*([\d.]+㎡)/,
      都道府県名: /都道府県名\s*\n\s*(\S+)/,
      所在地名１: /所在地名１\s*\n\s*(\S+)/,
      所在地名２: /所在地名２\s*\n\s*(\S+)/,
      所在地名３: /所在地名３\s*\n\s*(\S+)/,
      建物名: /建物名\s*\n\s*([^\n]+)/,
      部屋番号: /部屋番号\s*\n\s*(\S+)/,
      間取タイプ: /間取タイプ\s*\n\s*(\S+)/,
      間取部屋数: /間取部屋数\s*\n\s*(\S+)/,
      間取その他: /その他\s*\n\s*([\S]+[\s\S]*?)(?=\n建物)/,
      // 築年月: 年号を含む値のみキャプチャ
      築年月: /築年月\s*\n\s*(\d{4}年[^\n]*)/,
      建物構造: /建物構造\s*\n\s*(ＲＣ|ＳＲＣ|Ｓ|鉄骨|木造|軽量鉄骨|ＡＬＣ|ブロック|ＰＣ|ＨＰＣ|鉄筋[^\n]*|その他|\S+)/,
      // 階層: 数字+階 のみキャプチャ
      地上階層: /地上階層\s*\n\s*(\d+)階/,
      地下階層: /地下階層\s*\n\s*(\d+)階/,
      // 所在階: 数字のみキャプチャ（"室１:室タイプ"等を除外）
      所在階: /所在階\s*\n\s*(\d+)(?:階|Ｆ|F)?(?:\s|\n)/,
      // バルコニー方向: 方角のみ
      バルコニー方向: /バルコニー方向\s*\n\s*(北東|東南|南東|南西|西南|北西|西北|北|東|南|西)/,
      // 管理費/共益費: 金額 or なし/ー
      管理費: /管理費\s*\n\s*([\d,]+円|なし|ー)/,
      共益費: /共益費\s*\n\s*([\d,]+円|なし|ー)/,
      更新料: /更新料\s*\n\s*([\d,.]+\s*(?:万円|円|ヶ?月)|なし|ー)/,
      駐車場在否: /駐車場在否\s*\n\s*(有|無|空有|空無)/,
      // 現況: 有効な値のみ
      現況: /現況\s*\n\s*(空室|空き|居住中|賃貸中|使用中|明渡予定|建築中)/,
      // 入居時期: 即/相談/予定/日付パターンのみ
      入居時期: /入居時期\s*\n\s*(即時?|即日?|相談|期日指定|予定|\d{4}年[^\n]*)/,
      // 取引態様: 既知の値のみ
      取引態様: /取引態様\s*\n\s*(貸主|代理|仲介元付|仲介先物|一般|専任|媒介|仲介)/,
      配分割合客付: /配分割合客付\s*\n\s*([\d.]+)/,
      設備: /設備・条件・住宅性能等\s*\n\s*([^\n]+)/,
      // フリースペース・備考は複数行にまたがるため、次のフィールドラベルまで全文取得
      設備フリー: /設備\(フリースペース\)\s*\n([\s\S]*?)(?=\n(?:条件\(フリースペース\)|備考[１２３]|償却|報酬|更新区分|鍵交換区分|$))/,
      条件フリー: /条件\(フリースペース\)\s*\n([\s\S]*?)(?=\n(?:備考[１２３]|償却|報酬|更新区分|鍵交換区分|設備\(フリースペース\)|$))/,
      備考1: /備考１\s*\n([\s\S]*?)(?=\n(?:備考[２３]|償却|報酬|更新区分|鍵交換区分|$))/,
      備考2: /備考２\s*\n([\s\S]*?)(?=\n(?:備考３|償却|報酬|更新区分|鍵交換区分|$))/,
      備考3: /備考３\s*\n([\s\S]*?)(?=\n(?:償却コード|報酬|更新区分|鍵交換区分|配分割合|$))/,
      その他一時金: /その他一時金\s*\n\s*([^\n]+)/,
      鍵交換区分: /鍵交換区分\s*\n\s*([^\n]+)/,
    };

    for (const [key, regex] of Object.entries(patterns)) {
      const match = body.match(regex);
      if (match) {
        const val = match[1].trim();
        // Reject values that are known field labels (regex miss)
        if (!LABELS.has(val)) {
          result[key] = val;
        }
      }
    }

    // 部屋番号のサニタイズ — forrent.jp は「半角10桁以内」が上限。
    // 1) 全角英数記号 → 半角に正規化（"８０１" → "801"）
    // 2) 正規化後も半角英数記号に収まらない場合のみ破棄
    //    （"その他所在地表示", "未定", "非公開" などのセンチネル文言は残り落とす）
    if (result.部屋番号) {
      const raw = result.部屋番号.trim();
      // 全角 ASCII (！-～, 0xFF01-0xFF5E) → 半角, 全角スペース → 削除
      const normalized = raw
        .replace(/[\uFF01-\uFF5E]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xFEE0))
        .replace(/[\u3000\s]+/g, "")
        .trim();
      const isValid = /^[\x21-\x7E]{1,10}$/.test(normalized);
      if (isValid) {
        if (normalized !== raw) {
          console.log(`[reins] 部屋番号を正規化: "${raw}" → "${normalized}"`);
        }
        result.部屋番号 = normalized;
      } else {
        console.log(`[reins] 部屋番号の不正値を除外: "${raw}" (センチネル or フォーマット外)`);
        delete result.部屋番号;
      }
    }

    // 建物名から号室情報を除去（forrent.jpでは物件名と号室は別フィールド）
    if (result.建物名) {
      // 部屋番号が別途取得できている場合、その番号パターンを末尾から除去
      if (result.部屋番号) {
        const roomNum = result.部屋番号.replace(/\D/g, "");
        if (roomNum) {
          result.建物名 = result.建物名
            .replace(new RegExp(`[\\s　]+${roomNum}号室?$`), "")
            .replace(new RegExp(`[\\s　]+${roomNum}$`), "");
        }
      }
      // 一般的な号室パターンを末尾から除去（半角・全角両対応）
      result.建物名 = result.建物名
        .replace(/[\s　]+[0-9０-９]+号室$/g, "")
        .replace(/[\s　]+[0-9０-９]+号$/g, "")
        .trim();
    }

    // Extract transportation (up to 3 lines)
    const transportPatterns = [
      {
        prefix: "交通１",
        lineRegex: /交通１\s*\n沿線名\s*\n\s*(\S+)\s*\n駅名\s*\n\s*(\S+)\s*\n駅より徒歩\s*\n\s*(\S+)/,
      },
      {
        prefix: "交通２",
        lineRegex: /交通２\s*\n沿線名\s*\n\s*(\S+)\s*\n駅名\s*\n\s*(\S+)\s*\n駅より徒歩\s*\n\s*(\S+)/,
      },
      {
        prefix: "交通３",
        lineRegex: /交通３\s*\n沿線名\s*\n\s*(\S+)\s*\n駅名\s*\n\s*(\S+)\s*\n駅より徒歩\s*\n\s*(\S+)/,
      },
    ];
    result.交通 = [];
    for (const tp of transportPatterns) {
      const m = body.match(tp.lineRegex);
      if (m) {
        result.交通.push({
          沿線: m[1],
          駅: m[2],
          徒歩: m[3],
        });
      }
    }

    return result;
  });

  return data;
}

// ── Extract Image Metadata ─────────────────────────────────
async function extractImageData(page) {
  await page.click(REINS_SELECTORS.detail.imageSectionBtn);
  await page.waitForTimeout(2000);

  const images = await page.evaluate(() => {
    const cards = document.querySelectorAll(".col-image");
    return Array.from(cards).map((card, idx) => {
      const bgDiv = card.querySelector("[style*='background']");
      const style = bgDiv?.getAttribute("style") || "";
      const urlMatch = style.match(/url\("([^"]+)"\)/);
      // カード内の全テキストとHTML構造をデバッグ出力
      const debugHtml = card.innerHTML?.substring(0, 500) || "";
      // カード内のテキスト取得（ファイル名以外を探す）
      const allText = card.textContent?.trim() || "";
      // 親要素（グループヘッダー等）のテキストも確認
      const parentText = card.parentElement?.closest("[class]")?.querySelector(":scope > *:first-child")?.textContent?.trim() || "";
      return {
        index: idx + 1,
        thumbnailUrl: urlMatch?.[1] || "",
        allText,
        parentText,
        debugHtml,
      };
    });
  });

  // デバッグ: 最初の2枚のカード構造を出力
  for (const img of images.slice(0, 2)) {
    console.log(`[reins] card ${img.index} allText: "${img.allText}"`);
    console.log(`[reins] card ${img.index} parentText: "${img.parentText}"`);
    console.log(`[reins] card ${img.index} html: ${img.debugHtml.substring(0, 300)}`);
  }

  // Derive full-size image URLs from thumbnail URLs
  // Thumbnail: findBkknGzuThm → Full: findBkknGzu
  return images.map((img) => ({
    ...img,
    fullUrl: img.thumbnailUrl.replace("findBkknGzuThm", "findBkknGzu"),
  }));
}

// ── Screenshot All Images (white frame clip) ───────────────
async function screenshotAllImages(page, imagesMeta, downloadDir) {
  const fs = require("fs");
  const path = require("path");

  if (!fs.existsSync(downloadDir)) {
    fs.mkdirSync(downloadDir, { recursive: true });
  }

  const downloaded = [];
  const cards = await page.$$(REINS_SELECTORS.detail.imageCard);
  const count = Math.min(Array.isArray(imagesMeta) ? imagesMeta.length : imagesMeta, cards.length);

  for (let i = 0; i < count; i++) {
    try {
      // Click image card to open modal popup
      const link = await cards[i].$("a");
      if (!link) continue;
      await link.click();
      await page.waitForTimeout(2000);

      // Dynamic clip from modal <img> boundingBox (avoids green background bleeding)
      const filePath = path.join(downloadDir, `reins_${i + 1}.jpg`);
      let clip = REINS_SELECTORS.imagePopup.clip;
      try {
        const modalImg = await page.$('.modal.show .modal-content img');
        if (modalImg) {
          const box = await modalImg.boundingBox();
          if (box && box.width > 50 && box.height > 50) {
            clip = { x: box.x + 2, y: box.y + 2, width: box.width - 4, height: box.height - 4 };
            console.log(`[reins] Dynamic clip: ${JSON.stringify(clip)}`);
          }
        }
      } catch {}
      await page.screenshot({
        type: "jpeg",
        quality: 90,
        clip,
        path: filePath,
      });

      // REINSカードのタイトルを引き継ぐ
      const meta = Array.isArray(imagesMeta) ? imagesMeta[i] : null;
      downloaded.push({ index: i + 1, localPath: filePath, title: meta?.title || "" });

      // Close modal
      const closeBtn = await page.$('.modal.show button:has-text("閉じる")');
      if (closeBtn) {
        await closeBtn.click();
        await page.waitForTimeout(800);
      }
    } catch (err) {
      console.error(`Failed to screenshot image ${i + 1}:`, err.message);
      // Try to close modal if still open
      try {
        const closeBtn = await page.$('.modal.show button:has-text("閉じる")');
        if (closeBtn) await closeBtn.click();
        await page.waitForTimeout(500);
      } catch {}
    }
  }

  return downloaded;
}

// ── Batch Search by Property Numbers (up to 20 at once) ────
// Assumes `page` is on the dashboard. Clicks 物件番号検索, fills up to 20
// inputs with the given IDs, clicks 検索 once, and leaves the page on the
// search result. Returns { rowCount }.
async function searchByNumbers(page, reinsIds) {
  if (!Array.isArray(reinsIds) || reinsIds.length === 0) return { rowCount: 0 };
  if (reinsIds.length > 20) {
    throw new Error(`searchByNumbers: REINS batch limit is 20 (got ${reinsIds.length})`);
  }

  await page.click(REINS_SELECTORS.dashboard.numberSearchBtn);
  await page.waitForTimeout(3000);

  const inputs = await page.$$(REINS_SELECTORS.numberSearch.inputs);
  if (inputs.length < reinsIds.length) {
    throw new Error(`searchByNumbers: expected ≥${reinsIds.length} input fields, found ${inputs.length}`);
  }
  for (let i = 0; i < reinsIds.length; i++) {
    await inputs[i].fill(String(reinsIds[i]));
    await page.waitForTimeout(80);
  }

  await page.click(REINS_SELECTORS.numberSearch.searchBtn);
  await page.waitForTimeout(5000);

  const rowCount = (await page.$$(REINS_SELECTORS.result.row)).length;
  return { rowCount };
}

// ── Parse All Result Rows ─────────────────────────────────
// Reads the current 物件番号検索結果 table and returns one object per row
// with column keys. Anchors on the 12-digit 物件番号 cell so it tolerates
// wrapping structure changes. The row has 26 direct children including 3
// empty spacer cells between visual column groups — offsets below skip them.
//
// DOM cell layout (observed 2026-04-21 via debug-batch-rows.js):
//   [idIdx+0]  物件番号        [idIdx+11] 賃料
//   [idIdx+1]  物件種別        [idIdx+12] ㎡単価
//   [idIdx+2]  土地面積        [idIdx+13] 沿線駅
//   [idIdx+3]  所在地          [idIdx+14] 交通
//   [idIdx+4]  取引状況        [idIdx+15] (spacer)
//   [idIdx+5]  物件種目        [idIdx+16] 坪単価
//   [idIdx+6]  建物面積        [idIdx+17] 商号
//   [idIdx+7]  建物名          [idIdx+18] (spacer)
//   [idIdx+8]  部屋番号        [idIdx+19] 築年月
//   [idIdx+9]  所在階          [idIdx+20] 電話番号
//   [idIdx+10] (spacer)
async function parseAllResultRows(page) {
  return await page.evaluate(() => {
    const OFFSETS_FROM_ID = {
      '物件番号': 0,
      '物件種別': 1,
      '土地面積': 2,
      '所在地': 3,
      '取引状況': 4,
      '物件種目': 5,
      '建物面積': 6,
      '建物名': 7,
      '部屋番号': 8,
      '所在階': 9,
      '賃料': 11,
      '㎡単価': 12,
      '沿線駅': 13,
      '交通': 14,
      '坪単価': 16,
      '商号': 17,
      '築年月': 19,
      '電話番号': 20,
    };

    const rowEls = Array.from(document.querySelectorAll('.p-table-body-row'));
    return rowEls.map((row) => {
      const cellText = (el) => (el.innerText || el.textContent || '').trim();
      const cells = Array.from(row.children).map(cellText);

      const idIdx = cells.findIndex((t) => /^\d{12}$/.test(t));
      if (idIdx === -1) {
        // Fallback: innerText split — collapses spacer cells, so shift offsets
        // back to their visible-only positions.
        const visibleCols = [
          '物件番号', '物件種別', '土地面積', '所在地', '取引状況',
          '物件種目', '建物面積', '建物名', '部屋番号', '所在階',
          '賃料', '㎡単価', '沿線駅', '交通', '坪単価',
          '商号', '築年月', '電話番号',
        ];
        const lines = ((row.innerText || '').split('\n').map((s) => s.trim()));
        const idLineIdx = lines.findIndex((t) => /^\d{12}$/.test(t));
        if (idLineIdx === -1) return null;
        const obj = {};
        for (let i = 0; i < visibleCols.length; i++) {
          obj[visibleCols[i]] = lines[idLineIdx + i] || '';
        }
        obj.__source = 'innerText-split';
        return obj;
      }

      const obj = {};
      for (const [col, off] of Object.entries(OFFSETS_FROM_ID)) {
        obj[col] = cells[idIdx + off] || '';
      }
      obj.__source = 'children-cells';
      return obj;
    }).filter(Boolean);
  });
}

// ── Screenshot Image Popup (fixed coordinates) ─────────────
async function screenshotImagePopup(page, imageIndex) {
  const cards = await page.$$(REINS_SELECTORS.detail.imageCard);
  if (imageIndex > cards.length) return null;

  // Click the image card link
  const link = await cards[imageIndex - 1].$("a");
  if (link) await link.click();
  await page.waitForTimeout(2000);

  // Dynamic clip from modal <img> boundingBox
  let clip = REINS_SELECTORS.imagePopup.clip;
  try {
    const modalImg = await page.$('.modal.show .modal-content img');
    if (modalImg) {
      const box = await modalImg.boundingBox();
      if (box && box.width > 50 && box.height > 50) {
        clip = { x: box.x + 2, y: box.y + 2, width: box.width - 4, height: box.height - 4 };
        console.log(`[reins] Dynamic clip: ${JSON.stringify(clip)}`);
      }
    }
  } catch {}
  const buffer = await page.screenshot({
    type: "jpeg",
    quality: 85,
    clip,
  });

  // Close modal
  const closeBtn = await page.$('.modal.show button:has-text("閉じる")');
  if (closeBtn) await closeBtn.click();
  await page.waitForTimeout(500);

  return buffer;
}

module.exports = {
  REINS_URLS,
  REINS_SELECTORS,
  login,
  searchByNumber,
  searchByNumbers,
  parseAllResultRows,
  extractPropertyData,
  extractImageData,
  screenshotAllImages,
  screenshotImagePopup,
};
