/**
 * 物確プラットフォーム統合モジュール — 初期費用抽出 + 画像取得
 *
 * 管理会社から物確プラットフォーム（ITANDI BB / いえらぶBB）を特定し、
 * 物件詳細ページから初期費用データと画像を同時に取得する。
 *
 * Flow:
 *   1. REINS 商号 → プラットフォーム判定（fuzzy match）
 *   2. プラットフォームにログイン
 *   3. 建物名 + 部屋番号で検索
 *   4. 物件詳細ページから初期費用を抽出（innerText regex）
 *   5. 同ページから画像URLを取得・ダウンロード
 */
const fs = require("fs");
const path = require("path");
const https = require("https");
const http = require("http");

// ════════════════════════════════════════════════════════════════
//  管理会社 → プラットフォーム マッピング（Notion DBから取得済み）
// ════════════════════════════════════════════════════════════════
const COMPANY_PLATFORM_MAP = {
  // ITANDI BB (41社)
  "東急住宅リース": "itandi",
  "三井ホームエステート": "itandi",
  "住友林業レジデンシャル": "itandi",
  "長谷工ライブネット": "itandi",
  "東京建物不動産販売": "itandi",
  "パナソニックホームズ不動産": "itandi",
  "三井不動産レジデンシャルサービス": "itandi",
  "穴吹ハウジングサービス": "itandi",
  "住友不動産建物サービス": "itandi",
  "ケン不動産リース": "itandi",
  "住商建物": "itandi",
  "プロパティエージェント": "itandi",
  "三菱地所ハウスネット": "itandi",
  "エフ・ジェー・ネクスト": "itandi",
  "伊藤忠アーバンコミュニティ": "itandi",
  "旭化成不動産レジデンス": "itandi",
  "リロケーション・ジャパン": "itandi",
  "スターツアメニティー": "itandi",
  "大成有楽不動産": "itandi",
  "ゴールドクレスト": "itandi",
  "野村不動産パートナーズ": "itandi",
  "タカラレーベン": "itandi",
  "三菱地所リアルエステートサービス": "itandi",
  "京王不動産": "itandi",
  "小田急不動産": "itandi",
  "日鉄コミュニティ": "itandi",
  "コスモスイニシア": "itandi",
  "近鉄不動産": "itandi",
  "日本管財住宅": "itandi",
  "大和リアルティ": "itandi",
  "JPMC": "itandi",
  "ジェイアール東日本都市開発": "itandi",
  "明和管理": "itandi",
  "ロイヤルハウジング": "itandi",
  "グローバル・コミュニティ": "itandi",
  "NTT都市開発": "itandi",
  "相鉄不動産": "itandi",
  "京急不動産": "itandi",
  "フージャースリビングサービス": "itandi",
  "日本エスリード": "itandi",
  "穴吹コミュニティ": "itandi",

  // いえらぶBB (6社)
  "三井不動産レジデンシャルリース": "ielovebb",
  "三菱地所コミュニティ": "ielovebb",
  "ウインズプロモーション": "ielovebb",
  "グローバルフューエニング": "ielovebb",
  "ライフサポートN": "ielovebb",
  "シグマ・ジャパン": "ielovebb",
};

/**
 * REINS商号から物確プラットフォームを判定（部分一致・fuzzy match）
 *
 * @param {string} shogo - REINSの商号フィールド
 * @returns {{ platform: string|null, companyName: string|null }}
 */
function detectPlatform(shogo) {
  if (!shogo) return { platform: null, companyName: null };

  // 前処理: 法人格・部署名を除去
  const cleaned = shogo
    .replace(/（株）|（有）|\(株\)|\(有\)|株式会社|有限会社/g, "")
    .replace(/\s+/g, "")
    .trim();

  // 完全一致 → 部分一致
  for (const [company, platform] of Object.entries(COMPANY_PLATFORM_MAP)) {
    const companyClean = company.replace(/\s+/g, "");
    if (cleaned.includes(companyClean) || companyClean.includes(cleaned)) {
      return { platform, companyName: company };
    }
  }

  // 短縮名でのマッチ（「三井不動産レジデンシャルリース」の商号が
  // 「三井不動産レジデンシャルリース（株）受託運営本部 運営三部運営課」のようなケース）
  for (const [company, platform] of Object.entries(COMPANY_PLATFORM_MAP)) {
    const keywords = company.split(/[・\s]/);
    if (keywords.length > 1 && keywords.every(kw => cleaned.includes(kw))) {
      return { platform, companyName: company };
    }
  }

  return { platform: null, companyName: null };
}

// ════════════════════════════════════════════════════════════════
//  ITANDI BB
// ════════════════════════════════════════════════════════════════
const ITANDI = {
  loginUrl: "https://itandi-accounts.com/login",
  homeUrl: "https://itandibb.com/top",
  searchUrl: "https://itandibb.com/rent_rooms/list",
  email: process.env.ITANDI_EMAIL,
  password: process.env.ITANDI_PASSWORD,
};

async function itandiLogin(page) {
  console.log("[bukaku/itandi] ログイン中...");
  await page.goto(ITANDI.loginUrl, { waitUntil: "networkidle", timeout: 30000 });
  await page.waitForTimeout(2000);

  // 既にログイン済み（リダイレクトされた場合）
  if (page.url().includes("itandibb.com") && !page.url().includes("sign_in")) {
    console.log("[bukaku/itandi] 既にログイン済み");
    return true;
  }

  // ログインフォームの存在を確認
  const emailField = await page.$("#email");
  if (!emailField) {
    // ログインページではない → 既にログイン済みの可能性
    await page.goto(ITANDI.homeUrl, { waitUntil: "networkidle", timeout: 15000 });
    await page.waitForTimeout(2000);
    const isLoggedIn = page.url().includes("itandibb.com");
    console.log(`[bukaku/itandi] ログインフォームなし → ${isLoggedIn ? "ログイン済み" : "失敗"}`);
    return isLoggedIn;
  }

  await page.fill("#email", ITANDI.email);
  await page.fill("#password", ITANDI.password);
  await Promise.all([
    page.waitForNavigation({ waitUntil: "networkidle", timeout: 30000 }).catch(() => {}),
    page.click('input[type="submit"].filled-button'),
  ]);
  await page.waitForTimeout(3000);

  // BBポータルに遷移
  await page.goto(ITANDI.homeUrl, { waitUntil: "networkidle", timeout: 15000 });
  await page.waitForTimeout(2000);

  const isLoggedIn = page.url().includes("itandibb.com");
  console.log(`[bukaku/itandi] ログイン${isLoggedIn ? "成功" : "失敗"}: ${page.url()}`);
  return isLoggedIn;
}

async function itandiSearchProperty(page, buildingName, roomNumber) {
  console.log(`[bukaku/itandi] 物件検索: "${buildingName}" ${roomNumber || ""}`);
  await page.goto(ITANDI.searchUrl, { waitUntil: "networkidle", timeout: 15000 });
  await page.waitForTimeout(3000);

  // 建物名入力
  const nameInput = await page.$('input[name="building_name:match"]');
  if (nameInput) {
    await nameInput.fill(buildingName);
  }

  // 部屋番号入力
  if (roomNumber) {
    const roomInput = await page.$('input[name="room_number:match"]');
    if (roomInput) {
      await roomInput.fill(roomNumber);
    }
  }

  await page.waitForTimeout(1000);

  // 検索ボタン（ページ下部の「この条件で検索」等）
  const searchBtn = await page.$('button:has-text("検索"), button:has-text("この条件で検索")');
  if (searchBtn) {
    await searchBtn.click();
  } else {
    await page.keyboard.press("Enter");
  }
  await page.waitForTimeout(5000);

  // 結果リンクを取得
  const detailLinks = await page.evaluate(() => {
    return [...document.querySelectorAll("a")]
      .filter(a => a.href.includes("/rent_rooms/") && /\/\d+$/.test(a.href))
      .map(a => a.href);
  });

  // 重複除去
  const uniqueLinks = [...new Set(detailLinks)];
  console.log(`[bukaku/itandi] ${uniqueLinks.length}件の部屋が見つかりました`);
  return uniqueLinks;
}

async function itandiGetImages(page, detailUrl) {
  console.log(`[bukaku/itandi] 詳細ページ: ${detailUrl}`);
  await page.goto(detailUrl, { waitUntil: "networkidle", timeout: 15000 });
  await page.waitForTimeout(3000);

  const imageUrls = await page.evaluate(() => {
    return [...document.querySelectorAll("img")]
      .filter(img =>
        img.src.includes("property-images.itandi.co.jp") &&
        img.naturalWidth > 50
      )
      .map(img => img.src);
  });

  console.log(`[bukaku/itandi] ${imageUrls.length}枚の画像URL取得`);
  return imageUrls;
}

// ════════════════════════════════════════════════════════════════
//  いえらぶBB
// ════════════════════════════════════════════════════════════════
const IELOVEBB = {
  loginUrl: "https://bb.ielove.jp/ielovebb/login/index",
  topUrl: "https://bb.ielove.jp/ielovebb/top/index/type/01/",
  email: process.env.IELOVEBB_EMAIL,
  password: process.env.IELOVEBB_PASSWORD,
};

async function ieloveBBLogin(page) {
  console.log("[bukaku/ielovebb] ログイン中...");
  await page.goto(IELOVEBB.loginUrl, { waitUntil: "networkidle", timeout: 30000 });
  await page.waitForTimeout(2000);

  // 既にログイン済み（リダイレクトされた場合）
  if (page.url().includes("/top/") || page.url().includes("/ielovebb/")) {
    console.log("[bukaku/ielovebb] 既にログイン済み");
    return true;
  }

  // ログインフォームの存在を確認
  const loginBtn = await page.$("#loginButton");
  if (!loginBtn) {
    console.log("[bukaku/ielovebb] ログインフォームなし → 失敗");
    return false;
  }

  await page.fill('input[placeholder="ログインIDを入力"]', IELOVEBB.email);
  await page.fill('input[placeholder="パスワードを入力"]', IELOVEBB.password);
  await Promise.all([
    page.waitForNavigation({ waitUntil: "networkidle", timeout: 30000 }).catch(() => {}),
    page.click("#loginButton"),
  ]);
  await page.waitForTimeout(3000);

  const isLoggedIn = page.url().includes("/top/") || page.url().includes("/ielovebb/");
  console.log(`[bukaku/ielovebb] ログイン${isLoggedIn ? "成功" : "失敗"}: ${page.url()}`);
  return isLoggedIn;
}

async function ieloveBBSearchProperty(page, buildingName, roomNumber) {
  console.log(`[bukaku/ielovebb] 物件検索: "${buildingName}" ${roomNumber || ""}`);

  // トップページに戻る
  await page.goto(IELOVEBB.topUrl, { waitUntil: "networkidle", timeout: 15000 });
  await page.waitForTimeout(2000);

  // 物件名入力 → フォーム送信
  await page.fill("#renm", buildingName);
  await page.waitForTimeout(500);

  // フォーム送信
  await page.click("#freeBknSearch");
  await page.waitForTimeout(5000);

  // 検索結果から a.bkn_detail のhrefを直接取得（target="_blank"なのでクリックではなくhref抽出）
  const detailHrefs = await page.evaluate(() => {
    return [...document.querySelectorAll("a.bkn_detail")]
      .map(a => a.getAttribute("href") || "")
      .filter(Boolean);
  });

  console.log(`[bukaku/ielovebb] 詳細リンク ${detailHrefs.length}件検出`);

  if (detailHrefs.length === 0) {
    console.log("[bukaku/ielovebb] 物件が見つかりませんでした");
    return null;
  }

  // 部屋番号でマッチ: 各詳細ページを開いてタイトルから部屋番号を確認
  // ただし全ページ開くのは遅いので、同一建物なら画像はほぼ同じ → 最初の結果を使用
  // 部屋番号が重要な場合のみ（将来拡張用にフックを残す）
  const targetHref = detailHrefs[0];
  const detailUrl = targetHref.startsWith("http")
    ? targetHref
    : `https://bb.ielove.jp${targetHref}`;

  console.log(`[bukaku/ielovebb] ターゲット詳細URL: ${detailUrl}`);
  return detailUrl;
}

async function ieloveBBGetImages(page, detailUrl) {
  if (detailUrl && detailUrl !== page.url()) {
    await page.goto(detailUrl, { waitUntil: "networkidle", timeout: 15000 });
    await page.waitForTimeout(3000);
  }

  console.log(`[bukaku/ielovebb] 詳細ページから画像取得: ${page.url()}`);

  // いえらぶBBはbxSliderで遅延読み込み。ほとんどの画像が data:image placeholder。
  // 戦略: 読み込み済みのCDN画像URLからパターンを抽出し、全インデックスのURLを構築する。
  // パターン: cdn-img.cloud.ielove.jp/image/rent/{hash}/{buildingId}_{roomId}_{index}_{width}_{height}.jpg
  // サムネイル(80x60) → 大画像(550x413)に変換

  const imageData = await page.evaluate(() => {
    // 1. 読み込み済みの実画像URLを取得（CDN画像）
    const loadedUrls = [...document.querySelectorAll("img")]
      .map(img => img.src)
      .filter(src => src && src.includes("cdn-img.cloud.ielove.jp") && !src.includes("data:"));

    // 2. スライダー内の大画像li要素数をカウント（クローンを除外）
    const largeItems = [...document.querySelectorAll("li.largeImage:not(.bx-clone)")];
    const slideCount = largeItems.length;

    // 3. bb.ielove.jp ドメインの画像URL（類似物件以外）
    const bbUrls = [...document.querySelectorAll("img")]
      .map(img => img.src)
      .filter(src =>
        src &&
        !src.includes("data:") &&
        (src.includes("cdn-img.cloud.ielove.jp") || src.includes("bb.ielove.jp/image/rent/")) &&
        !src.includes("logo") && !src.includes("loading")
      );

    return { loadedUrls, slideCount, bbUrls };
  });

  console.log(`[bukaku/ielovebb] スライド数: ${imageData.slideCount}, 読込済URL: ${imageData.loadedUrls.length}`);

  let imageUrls = [];

  if (imageData.loadedUrls.length > 0 && imageData.slideCount > 0) {
    // URLパターンから全画像URLを構築
    // 例: https://cdn-img.cloud.ielove.jp/image/rent/3dc03bb3/47612_770851_1_550_413.jpg
    const sampleUrl = imageData.loadedUrls[0];
    // _数字_数字_数字.jpg のパターンを見つける
    const match = sampleUrl.match(/^(.*\/)(\d+_\d+)_(\d+)_(\d+)_(\d+)\.jpg$/);
    if (match) {
      const [, basePath, ids, , , ] = match;
      // 大画像サイズで全インデックスのURLを生成
      for (let i = 1; i <= imageData.slideCount; i++) {
        imageUrls.push(`${basePath}${ids}_${i}_550_413.jpg`);
      }
      console.log(`[bukaku/ielovebb] URLパターンから ${imageUrls.length}枚のURLを構築`);
    }
  }

  // パターン構築に失敗した場合、読み込み済みURLをフォールバック
  if (imageUrls.length === 0) {
    imageUrls = [...new Set(imageData.bbUrls)].filter(url =>
      !url.includes("similarlist") && !url.includes("_80_60")
    );
    console.log(`[bukaku/ielovebb] フォールバック: ${imageUrls.length}枚の読込済URL`);
  }

  console.log(`[bukaku/ielovebb] ${imageUrls.length}枚の画像URL取得`);
  return imageUrls;
}

// ════════════════════════════════════════════════════════════════
//  画像ダウンロード
// ════════════════════════════════════════════════════════════════
function downloadImage(url, outputPath) {
  return new Promise((resolve, reject) => {
    const protocol = url.startsWith("https") ? https : http;
    const req = protocol.get(url, { timeout: 15000 }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        // Redirect
        return downloadImage(res.headers.location, outputPath).then(resolve).catch(reject);
      }
      if (res.statusCode !== 200) {
        return reject(new Error(`HTTP ${res.statusCode}`));
      }
      const stream = fs.createWriteStream(outputPath);
      res.pipe(stream);
      stream.on("finish", () => {
        stream.close();
        resolve(outputPath);
      });
      stream.on("error", reject);
    });
    req.on("error", reject);
    req.on("timeout", () => { req.destroy(); reject(new Error("timeout")); });
  });
}

// ════════════════════════════════════════════════════════════════
//  初期費用抽出（innerText regex — プラットフォーム非依存）
// ════════════════════════════════════════════════════════════════

/**
 * 物確プラットフォーム詳細ページから初期費用データを抽出
 *
 * innerText + regex パターンで抽出するため、DOM構造に依存しない。
 * forrent.js の initialCostData インターフェースと互換。
 *
 * @param {import('playwright').Page} page - 詳細ページが表示された状態のページ
 * @returns {Promise<Object|null>} 初期費用データ or null
 */
async function extractInitialCostsFromPage(page) {
  console.log("[bukaku] 初期費用データを抽出中...");

  const text = await page.evaluate(() => document.body.innerText);
  if (!text || text.length < 100) {
    console.log("[bukaku] ページテキストが取得できません");
    return null;
  }

  const result = {};

  // Helper: extract yen amount from text near a keyword
  const extractYen = (keyword) => {
    const patterns = [
      new RegExp(`${keyword}[代費用]?[\\s：:]*([\\d,]+)\\s*円`, "i"),
      new RegExp(`${keyword}[代費用]?[\\s：:]*([\\d.]+)\\s*万\\s*円`, "i"),
    ];
    for (const re of patterns) {
      const m = text.match(re);
      if (m) {
        if (re.source.includes("万")) {
          return Math.round(parseFloat(m[1]) * 10000);
        }
        return parseInt(m[1].replace(/,/g, ""), 10);
      }
    }
    return null;
  };

  // ── Initial cost items ──

  const kagikoukanYen = extractYen("鍵交換");
  if (kagikoukanYen) result["鍵交換代"] = kagikoukanYen;

  const shoudokuYen = extractYen("消毒") || extractYen("消臭") || extractYen("抗菌");
  if (shoudokuYen) result["消毒代"] = shoudokuYen;

  const cleaningYen = extractYen("クリーニング") || extractYen("室内清掃") || extractYen("清掃");
  if (cleaningYen) result["クリーニング代"] = cleaningYen;

  const supportYen = extractYen("安心サポート") || extractYen("入居サポート") || extractYen("24時間サポート");
  if (supportYen) result["サポート代"] = supportYen;

  const jimuYen = extractYen("事務手数料") || extractYen("書類作成") || extractYen("契約事務");
  if (jimuYen) result["事務手数料"] = jimuYen;

  // ── Guarantee company ──

  const hoshoCompanies = [
    "全保連", "日本セーフティー", "日本セーフティ", "Casa", "CASA", "カーサ",
    "ジェイリース", "オリコ", "エポス", "ジャックス", "アプラス",
    "日本賃貸保証", "フォーシーズ", "エルズサポート", "日商トレーディング",
    "ナップ賃貸保証", "大和リビング保証", "レジデンシャルパートナーズ",
  ];
  for (const co of hoshoCompanies) {
    if (text.includes(co)) {
      result["保証会社"] = co;
      break;
    }
  }

  // Guarantee fee (percentage or fixed)
  const rateMatch = text.match(/(?:初回)?保証(?:委託)?料?\s*[:：]?\s*(?:(?:賃料等?)?(?:合計)?の?)?\s*(\d+(?:\.\d+)?)\s*[%％]/);
  if (rateMatch) result["保証料率"] = parseFloat(rateMatch[1]);

  const fixedMatch = text.match(/(?:初回)?保証(?:委託)?料?\s*[:：]?\s*([\d,]+)\s*円/);
  if (fixedMatch && !rateMatch) {
    result["保証料円額"] = parseInt(fixedMatch[1].replace(/,/g, ""), 10);
  }

  // ── Fire insurance ──

  const kasaiYen = extractYen("火災保険") || extractYen("損害保険") || extractYen("損保");
  if (kasaiYen) result["火災保険"] = kasaiYen;

  if (!kasaiYen) {
    const kasaiMatch = text.match(/火災保険[料]?\s*([\d,.]+)\s*万?\s*円/);
    if (kasaiMatch) {
      const val = kasaiMatch[0].includes("万")
        ? Math.round(parseFloat(kasaiMatch[1]) * 10000)
        : parseInt(kasaiMatch[1].replace(/,/g, ""), 10);
      if (val > 0) result["火災保険"] = val;
    }
  }

  // ── AD (advertising fee) ──

  const adMatch = text.match(/(?:AD|広告[料費転載])[^\d]*([\d.]+)\s*(?:[%％]|ヶ?月)/);
  if (adMatch) result["AD"] = adMatch[1];

  if (text.includes("広告転載不可") || text.includes("転載不可")) {
    result["広告転載"] = "不可";
  } else if (text.includes("広告転載可") || text.includes("転載可")) {
    result["広告転載"] = "可";
  }

  // ── Broker fee ──

  const chuukaiYen = extractYen("仲介手数料");
  if (chuukaiYen) result["仲介手数料"] = chuukaiYen;

  // ── Summary ──

  const keys = Object.keys(result);
  if (keys.length === 0) {
    console.log("[bukaku] 初期費用データが抽出できませんでした");
    return null;
  }

  console.log(`[bukaku] 初期費用抽出結果: ${JSON.stringify(result, null, 2)}`);
  return result;
}

// ════════════════════════════════════════════════════════════════
//  メインAPI: 物確プラットフォームから初期費用 + 画像を取得
// ════════════════════════════════════════════════════════════════

/**
 * 画像が不足しているかチェック
 * - 5ptカテゴリ（01-05）が1つでも欠けている場合
 * - 全体のカテゴリカバー率が低い場合（実画像10枚未満）
 *
 * @param {Array} processedImages - AI分類済み画像
 * @returns {{ insufficient: boolean, missingCategories: string[], missing1ptCategories: string[] }}
 */
function checkImageSufficiency(processedImages) {
  const HIGH_VALUE_CATS = ["01", "02", "03", "04", "05"];
  const ALL_CATS = ["01", "02", "03", "04", "05", "06", "07", "08", "09", "10", "11", "12", "13", "14"];
  const presentCats = new Set(processedImages.map(img => img.categoryId).filter(Boolean));

  const missing5pt = HIGH_VALUE_CATS.filter(cat => !presentCats.has(cat));
  const missing1pt = ALL_CATS.filter(cat => !presentCats.has(cat) && !HIGH_VALUE_CATS.includes(cat));

  // 不足判定: 5ptカテゴリが欠けている OR 全体の画像数が少ない（1ptカテゴリ大量不足）
  const insufficient = missing5pt.length > 0 || (processedImages.length < 10 && missing1pt.length >= 3);

  return {
    insufficient,
    missingCategories: [...missing5pt, ...missing1pt],
    missing5pt,
    missing1pt,
    presentCount: processedImages.length,
  };
}

/**
 * 物確プラットフォームから初期費用 + 画像を同時取得
 *
 * 常に詳細ページに遷移して初期費用を抽出し、同時に画像もダウンロードする。
 * 画像の使用判断（不足時のみマージ）は呼び出し元（server.js）で行う。
 *
 * @param {Object} context - Playwright BrowserContext
 * @param {Object} reinsData - REINS抽出データ
 * @param {string} downloadDir - 画像保存先ディレクトリ
 * @returns {{ initialCosts: Object|null, images: Array }} 初期費用 + 画像パス
 */
async function fetchBukakuData(context, reinsData, downloadDir) {
  const shogo = reinsData.商号 || "";
  const { platform, companyName } = detectPlatform(shogo);

  if (!platform) {
    console.log(`[bukaku] 商号「${shogo}」→ 物確プラットフォーム対応なし`);
    return { initialCosts: null, images: [] };
  }

  console.log(`[bukaku] 商号「${shogo}」→ ${companyName} → ${platform}`);

  const buildingName = reinsData.建物名 || "";
  const roomNumber = reinsData.部屋番号 || "";

  if (!buildingName) {
    console.log("[bukaku] 建物名が空のためスキップ");
    return { initialCosts: null, images: [] };
  }

  const page = await context.newPage();
  const downloaded = [];
  let initialCosts = null;

  try {
    let imageUrls = [];

    if (platform === "itandi") {
      const loggedIn = await itandiLogin(page);
      if (!loggedIn) return { initialCosts: null, images: [] };

      const detailLinks = await itandiSearchProperty(page, buildingName, roomNumber);
      if (detailLinks.length === 0) {
        const linksNoRoom = await itandiSearchProperty(page, buildingName, "");
        if (linksNoRoom.length === 0) return { initialCosts: null, images: [] };
        imageUrls = await itandiGetImages(page, linksNoRoom[0]);
      } else {
        imageUrls = await itandiGetImages(page, detailLinks[0]);
      }

      // Detail page is loaded — extract initial costs
      initialCosts = await extractInitialCostsFromPage(page);

    } else if (platform === "ielovebb") {
      const loggedIn = await ieloveBBLogin(page);
      if (!loggedIn) return { initialCosts: null, images: [] };

      const detailUrl = await ieloveBBSearchProperty(page, buildingName, roomNumber);
      if (!detailUrl) return { initialCosts: null, images: [] };

      imageUrls = await ieloveBBGetImages(page, detailUrl);

      // Detail page is loaded — extract initial costs
      initialCosts = await extractInitialCostsFromPage(page);
    }

    // Download images
    console.log(`[bukaku] ${imageUrls.length}枚の画像をダウンロード中...`);
    const bukakuDir = path.join(downloadDir, "bukaku");
    fs.mkdirSync(bukakuDir, { recursive: true });

    for (let i = 0; i < imageUrls.length; i++) {
      const ext = imageUrls[i].match(/\.(jpg|jpeg|png|gif|webp)/i)?.[1] || "jpg";
      const outputPath = path.join(bukakuDir, `bukaku_${i + 1}.${ext}`);
      try {
        await downloadImage(imageUrls[i], outputPath);
        downloaded.push({
          localPath: outputPath,
          source: platform,
          index: i + 1,
          originalUrl: imageUrls[i],
        });
        console.log(`[bukaku] + ${path.basename(outputPath)}`);
      } catch (e) {
        console.log(`[bukaku] x ダウンロード失敗 [${i + 1}]: ${e.message}`);
      }
    }
  } catch (e) {
    console.error(`[bukaku] エラー: ${e.message}`);
  } finally {
    await page.close().catch(() => {});
  }

  console.log(`[bukaku] 初期費用: ${initialCosts ? Object.keys(initialCosts).length + "項目" : "なし"}, 画像: ${downloaded.length}枚`);
  return { initialCosts, images: downloaded };
}

module.exports = {
  detectPlatform,
  checkImageSufficiency,
  fetchBukakuData,
  COMPANY_PLATFORM_MAP,
};
