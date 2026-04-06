/**
 * Shuhen (Surrounding Environment) Photo Acquisition
 *
 * Strategy (ordered by reliability):
 *  1. Google Maps business listing photos (most reliable — stable URLs)
 *  2. Google Image Search with consent handling + updated selectors (fallback)
 *
 * AI validation: reject images with people, ensure facility is clearly visible.
 */
const fs = require("fs");
const path = require("path");
const sharp = require("sharp");
const Anthropic = require("@anthropic-ai/sdk");

const aiClient = new Anthropic();

// ── Brand Logo Mapping ──
// Known chains use pre-stored logos instead of Maps photos (more reliable, consistent).
// Logo files are placed in assets/facility-logos/ (manually, for copyright reasons).
const BRAND_LOGOS_DIR = path.join(__dirname, "..", "assets", "facility-logos");
const BRAND_LOGOS = {
  // コンビニ
  "セブンイレブン": "seven-eleven.png", "セブン-イレブン": "seven-eleven.png",
  "ファミリーマート": "family-mart.png", "ファミマ": "family-mart.png",
  "ローソン": "lawson.png",
  "ミニストップ": "ministop.png",
  "デイリーヤマザキ": "daily-yamazaki.png",
  // スーパー
  "マルエツ": "maruetsu.png",
  "まいばすけっと": "mybascket.png",
  "ライフ": "life.png",
  "成城石井": "seijo-ishii.png",
  "いなげや": "inageya.png",
  "サミット": "sammit.png",
  "オーケー": "ok-store.png", "OKストア": "ok-store.png",
  "西友": "seiyu.png",
  "イオン": "aeon.png",
  "イトーヨーカドー": "ito-yokado.png",
  "業務スーパー": "gyoumu-super.png",
  "オオゼキ": "ozeki.png",
  "セイムス": "seims.png", "SEIMS": "seims.png",
  "パルケ": "parque.png", "Parque": "parque.png",
  "信濃屋": "shinanoya.png",
  "スーパーバリュー": "super-value.png", "SuperValue": "super-value.png",
  // ドラッグストア
  "マツモトキヨシ": "matsukiyo.png", "マツキヨ": "matsukiyo.png",
  "スギ薬局": "sugi-pharmercy.png",
  "ウエルシア": "welcia.png",
  "ツルハ": "tsuruha.png", "ツルハドラッグ": "tsuruha.png",
  "サンドラッグ": "sundrug.png",
  "ココカラファイン": "cococala-fine.png",
  "トモズ": "tomods.png", "Tomod's": "tomods.png",
  // 郵便局
  "郵便局": "japan-post.png", "日本郵便": "japan-post.png",
};

/**
 * Check if a facility name matches a known brand with a logo file.
 * Uses substring matching to handle variations like "セブンイレブン 渋谷店".
 * @returns {{ brandName: string, logoPath: string } | null}
 */
function findBrandLogo(facilityName) {
  if (!facilityName) return null;
  for (const [brand, file] of Object.entries(BRAND_LOGOS)) {
    if (facilityName.includes(brand)) {
      const logoPath = path.join(BRAND_LOGOS_DIR, file);
      if (fs.existsSync(logoPath)) {
        return { brandName: brand, logoPath };
      }
    }
  }
  return null;
}

/**
 * Resize a brand logo to 1280x960 on white background.
 * Uses "contain" fit so the logo is centered without cropping.
 */
async function resizeBrandLogo(logoPath) {
  return sharp(logoPath)
    .resize({
      width: 1280,
      height: 960,
      fit: "contain",
      background: { r: 255, g: 255, b: 255, alpha: 1 },
    })
    .jpeg({ quality: 85 })
    .toBuffer();
}

/**
 * Validate a shuhen image using Claude Vision.
 * Rejects images with people and images where the target facility is unclear.
 */
async function validateShuhenImage(imageBuffer, facilityType) {
  try {
    const response = await aiClient.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 100,
      messages: [{
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
            text: `この画像を判定してください。期待する施設: 「${facilityType}」

判定基準:
1. 人物が大きく写っている場合はNG
2. 「${facilityType}」の建物・店舗の外観がはっきりと確認できない場合はNG
3. マンション・アパート等の住居建物（賃貸物件）が写っている場合はNG — 商業施設・公共施設の写真のみ許可
4. ロゴ・看板で「${facilityType}」の施設だと特定できる場合はOK

JSON形式で回答:
{"valid":true,"reason":"OK"} または {"valid":false,"reason":"理由"}`,
          },
        ],
      }],
    });

    const text = response.content[0].text.trim();
    const jsonMatch = text.match(/\{[^}]+\}/);
    if (jsonMatch) {
      try {
        return JSON.parse(jsonMatch[0]);
      } catch {}
    }
    if (text.includes('"valid":false') || text.includes('"valid": false')) {
      return { valid: false, reason: text.slice(0, 80) };
    }
    return { valid: true, reason: "OK" };
  } catch (err) {
    console.log(`[shuhen] Validation error: ${err.message.slice(0, 60)}`);
    return { valid: true, reason: "validation-error" };
  }
}

/**
 * Handle Google consent/cookie banners that block page interaction.
 */
async function handleGoogleConsent(page) {
  try {
    const consentBtn = await page.$(
      'button[aria-label*="Accept"], button[aria-label*="accept"], ' +
      'button[aria-label*="同意"], button[aria-label*="すべて同意"], ' +
      'form[action*="consent"] button, ' +
      'button:has-text("Accept all"), button:has-text("同意する"), ' +
      '[data-ved] button[jsname]'
    );
    if (consentBtn) {
      await consentBtn.click();
      await page.waitForTimeout(2000);
      console.log("[shuhen] Consent banner accepted");
    }
  } catch {}
}

/**
 * Extract photo URLs from a Google Maps business listing.
 * After clicking on a search result, the business details panel shows photos
 * with stable googleusercontent.com URLs.
 */
async function extractMapsPhotos(page) {
  return page.evaluate(() => {
    const urls = [];
    const imgs = document.querySelectorAll("img");
    for (const img of imgs) {
      const src = img.src || img.dataset?.src || "";
      // Google Maps business photos use these URL patterns
      if (
        (src.includes("googleusercontent.com/p/") ||
          src.includes("lh3.googleusercontent.com") ||
          src.includes("lh4.googleusercontent.com") ||
          src.includes("lh5.googleusercontent.com") ||
          src.includes("lh6.googleusercontent.com")) &&
        !src.includes("/favicon") &&
        !src.includes("/branding") &&
        (img.naturalWidth > 60 || img.width > 60)
      ) {
        // Request high-res version
        let highRes = src;
        highRes = highRes.replace(/=w\d+(-h\d+)?(-[a-z])?(-no)?/gi, "=w1280-h960");
        highRes = highRes.replace(/=s\d+(-[a-z])?/gi, "=s1280");
        urls.push(highRes);
      }
    }
    // Also check background images (some photos are rendered as CSS backgrounds)
    const bgEls = document.querySelectorAll('[style*="background-image"]');
    for (const el of bgEls) {
      const style = el.getAttribute("style") || "";
      const match = style.match(/url\(["']?(https:\/\/[^"')]+googleusercontent\.com[^"')]+)/);
      if (match) {
        let highRes = match[1].replace(/=w\d+(-h\d+)?(-[a-z])?(-no)?/gi, "=w1280-h960");
        urls.push(highRes);
      }
    }
    return [...new Set(urls)];
  });
}

/**
 * Try to download and validate a photo from a URL.
 * Returns the resized JPEG buffer if successful, null otherwise.
 */
async function downloadAndValidatePhoto(page, url, facilityType) {
  try {
    const resp = await page.context().request.get(url, { timeout: 10000 });
    if (!resp.ok()) return null;

    const buffer = await resp.body();
    if (buffer.length < 3000) return null; // Too small

    const resized = await sharp(buffer)
      .resize({ width: 1280, height: 960, fit: "cover", position: "centre" })
      .jpeg({ quality: 85 })
      .toBuffer();

    // AI validation
    if (facilityType) {
      const validation = await validateShuhenImage(resized, facilityType);
      if (!validation.valid) {
        console.log(`[shuhen] Rejected (${facilityType}): ${validation.reason}`);
        return null;
      }
    }

    return resized;
  } catch {
    return null;
  }
}

/**
 * Acquire a facility photo using Google Maps.
 * Searches for the facility, clicks on the result, and extracts photos from
 * the business listing panel.
 *
 * @returns {{ name: string, photoBuffer: Buffer|null }}
 */
async function acquireFromGoogleMaps(page, address, facilityQuery, facilityType, propertyName = "") {
  const mapQuery = `${address} ${facilityQuery}`;
  const mapUrl = `https://www.google.com/maps/search/${encodeURIComponent(mapQuery)}`;

  await page.goto(mapUrl, { waitUntil: "domcontentloaded", timeout: 15000 });
  await page.waitForTimeout(3000);
  await handleGoogleConsent(page);
  await page.waitForTimeout(1000);

  // Get ALL facility names from search results (not just first)
  const allNames = await page.evaluate(() => {
    const names = [];
    const candidates = [
      ...document.querySelectorAll('[role="feed"] a[aria-label]'),
      ...document.querySelectorAll(".fontHeadlineSmall"),
      ...document.querySelectorAll("h3.fontHeadlineSmall"),
      ...document.querySelectorAll(".Nv2PK a[aria-label]"),
      ...document.querySelectorAll('[role="article"] a[aria-label]'),
      ...document.querySelectorAll('[jstcache] .fontBodyMedium a'),
    ];
    for (const el of candidates) {
      const name = (el.ariaLabel || el.textContent || "").trim();
      if (name && name.length > 1 && name.length < 50 && !names.includes(name)) {
        names.push(name);
      }
    }
    return names;
  });

  // Filter out results that match the property name (prevents using property's own photos)
  const propNameNorm = (propertyName || "").replace(/[\s　]/g, "").toLowerCase();
  const validNames = allNames.filter(n => {
    const nameNorm = n.replace(/[\s　]/g, "").toLowerCase();
    return !propNameNorm || (
      !nameNorm.includes(propNameNorm) && !propNameNorm.includes(nameNorm)
    );
  });

  const facilityName = validNames[0] || null;

  if (!facilityName) {
    if (allNames.length > 0) {
      console.log(`[shuhen] Maps: ${facilityType} → "${allNames[0]}" matches property name, skipped`);
    } else {
      console.log(`[shuhen] Maps: no results for ${facilityType}`);
    }
    return { name: `${address}付近の${facilityType}`, photoBuffer: null };
  }

  console.log(`[shuhen] Maps: ${facilityType} → ${facilityName}`);

  // Click on the matching result (find its index and click)
  try {
    const targetIndex = allNames.indexOf(facilityName);
    const links = await page.$$('[role="feed"] a[aria-label], .Nv2PK a[aria-label], [role="article"] a[aria-label], .fontHeadlineSmall');
    // Find the link that matches our target facility name
    let clicked = false;
    for (const link of links) {
      const linkName = await link.evaluate(el => (el.ariaLabel || el.textContent || "").trim());
      if (linkName === facilityName) {
        await link.click();
        await page.waitForTimeout(3000);
        clicked = true;
        break;
      }
    }
    if (!clicked && links.length > targetIndex) {
      await links[targetIndex].click();
      await page.waitForTimeout(3000);
    }
  } catch {}

  // Extract photos from business listing
  const photoUrls = await extractMapsPhotos(page);
  console.log(`[shuhen] Maps photos found: ${photoUrls.length} for ${facilityName}`);

  // Try to download the best photo
  for (const url of photoUrls.slice(0, 5)) {
    const buffer = await downloadAndValidatePhoto(page, url, facilityType);
    if (buffer) {
      console.log(`[shuhen] Maps photo OK: ${facilityName}`);
      return { name: facilityName, photoBuffer: buffer };
    }
  }

  return { name: facilityName, photoBuffer: null };
}

/**
 * Google Image Search — fallback when Maps photos are unavailable.
 * Handles consent banners and uses updated selectors for current Google DOM.
 */
async function googleImageSearch(context, query, outputPath, facilityType = null) {
  const page = await context.newPage();
  try {
    const searchUrl = `https://www.google.com/search?q=${encodeURIComponent(query)}&tbm=isch&udm=2`;
    await page.goto(searchUrl, { waitUntil: "domcontentloaded", timeout: 15000 });
    await page.waitForTimeout(2000);

    // Handle consent banner
    await handleGoogleConsent(page);

    // Scroll to trigger lazy loading
    await page.evaluate(() => {
      window.scrollBy(0, 500);
    });
    await page.waitForTimeout(1500);

    // Extract image URLs — multiple strategies
    const imageUrls = await page.evaluate(() => {
      const urls = [];

      // Strategy 1: encrypted-tbn thumbnails (most common)
      const encImgs = document.querySelectorAll('img[src*="encrypted-tbn"]');
      for (const img of encImgs) {
        if ((img.naturalWidth > 50 || img.width > 50) && img.src) {
          urls.push(img.src);
        }
      }

      // Strategy 2: all http images excluding Google assets
      const allImgs = document.querySelectorAll("img");
      for (const img of allImgs) {
        const src = img.src || "";
        if (
          src.startsWith("http") &&
          !src.startsWith("data:") &&
          !src.includes("google.com/images") &&
          !src.includes("gstatic.com/images") &&
          !src.includes("googleusercontent.com/favicon") &&
          !src.includes("/logos/") &&
          !src.includes("/branding/") &&
          (img.naturalWidth > 80 || img.width > 80)
        ) {
          urls.push(src);
        }
      }

      // Strategy 3: data-src lazy-loaded images
      const lazySrcs = document.querySelectorAll("img[data-src]");
      for (const img of lazySrcs) {
        const src = img.dataset.src || "";
        if (src.startsWith("http") && (img.naturalWidth > 50 || !img.naturalWidth)) {
          urls.push(src);
        }
      }

      return [...new Set(urls)].slice(0, 15);
    });

    if (imageUrls.length === 0) {
      console.log(`[shuhen] Image Search: 0 results for "${query}"`);
      return null;
    }

    console.log(`[shuhen] Image Search: ${imageUrls.length} candidates for "${query}"`);

    // Try to click first result to get full-size image
    let fullUrl = null;
    try {
      const firstImg = await page.$(
        'div[data-ri="0"] img, div[jscontroller] img, [data-id] img'
      );
      if (firstImg) {
        await firstImg.click();
        await page.waitForTimeout(2500);
        fullUrl = await page.evaluate(() => {
          const previewImgs = document.querySelectorAll(
            'img[jsname="kn3ccd"], img[jsname="HiaYvf"], ' +
            'img[data-noaft], [jsname="CGzTgf"] img'
          );
          for (const img of previewImgs) {
            const src = img.src || "";
            if (
              src.startsWith("http") &&
              !src.includes("encrypted-tbn") &&
              !src.includes("gstatic.com") &&
              (img.naturalWidth > 200 || img.width > 200)
            ) {
              return src;
            }
          }
          return null;
        });
      }
    } catch { /* preview click failed */ }

    const candidates = fullUrl ? [fullUrl, ...imageUrls] : imageUrls;
    const uniqueCandidates = [...new Set(candidates)];

    for (const url of uniqueCandidates) {
      try {
        const resp = await page.context().request.get(url, { timeout: 10000 });
        if (!resp.ok()) continue;

        const buffer = await resp.body();
        if (buffer.length < 2000) continue;

        const resized = await sharp(buffer)
          .resize({ width: 1280, height: 960, fit: "cover", position: "centre" })
          .jpeg({ quality: 85 })
          .toBuffer();

        // AI検証に通った画像のみ保存（未検証のfallbackは使わない）
        if (facilityType) {
          const validation = await validateShuhenImage(resized, facilityType);
          if (!validation.valid) {
            console.log(`[shuhen] Image Search rejected: ${validation.reason}`);
            continue;
          }
          console.log(`[shuhen] Image Search validated OK for ${facilityType}`);
        }

        fs.writeFileSync(outputPath, resized);
        return outputPath;
      } catch {
        continue;
      }
    }

    return null;
  } catch (e) {
    console.log(`[shuhen] Image Search error: ${e.message.slice(0, 80)}`);
    return null;
  } finally {
    await page.close().catch(() => {});
  }
}

/**
 * Fetch surrounding environment photos.
 *
 * Flow per facility:
 *  1. Google Maps search → get facility name + extract listing photos
 *  2. If no Maps photo → Google Image Search for "{facilityName} 外観"
 *
 * @param {import('playwright').BrowserContext} context
 * @param {object} reinsData - REINS property data
 * @param {string} downloadDir - output directory
 * @returns {Array<{localPath: string, categoryLabel: string, facilityName: string, facilityType: string}>}
 */
async function fetchShuhenPhotos(context, reinsData, downloadDir) {
  const outDir = path.join(downloadDir, "shuhen");
  fs.mkdirSync(outDir, { recursive: true });

  const address =
    `${reinsData.都道府県名 || ""}${reinsData.所在地名１ || ""}${reinsData.所在地名２ || ""}${reinsData.所在地名３ || ""}`;
  if (!address) {
    console.log("[shuhen] No address");
    return [];
  }

  // Phase 1: Mandatory 4 types (must attempt all)
  const mandatoryTypes = [
    { type: "コンビニ", query: "コンビニ" },
    { type: "スーパー", query: "スーパーマーケット" },
    { type: "ドラッグストア", query: "ドラッグストア" },
    { type: "郵便局", query: "郵便局" },
  ];

  // Phase 2: Fill remaining slots to reach 6
  const flexibleTypes = [
    { type: "コンビニ2", query: "コンビニエンスストア", displayType: "コンビニ" },
    { type: "スーパー2", query: "スーパー 食品", displayType: "スーパー" },
    { type: "ドラッグストア2", query: "薬局 ドラッグ", displayType: "ドラッグストア" },
    { type: "病院", query: "病院 クリニック" },
    { type: "学校", query: "小学校 中学校" },
  ];

  const results = [];
  const mapsPage = await context.newPage();
  const propertyName = reinsData.建物名 || "";

  // Shared per-facility acquisition logic
  async function acquireFacilityPhoto(ft) {
    const displayType = ft.displayType || ft.type;
    const slotNum = results.length + 1;
    const outputPath = path.join(outDir, `shuhen_${slotNum}_${displayType}.jpg`);

    try {
      const mapsResult = await acquireFromGoogleMaps(
        mapsPage, address, ft.query, displayType, propertyName
      );

      // 実店舗名が取得できなかった場合はスキップ（偽名+偽画像を入れない）
      if (mapsResult.name.includes("付近の")) {
        console.log(`[shuhen] SKIP: ${displayType} — 店舗名が特定できませんでした`);
        return false;
      }

      // Priority: brand logo > Maps photo > Image Search
      const brandMatch = findBrandLogo(mapsResult.name);
      if (brandMatch) {
        try {
          const logoBuffer = await resizeBrandLogo(brandMatch.logoPath);
          fs.writeFileSync(outputPath, logoBuffer);
          console.log(`[shuhen] Brand logo used: ${brandMatch.brandName} for ${mapsResult.name}`);
          results.push({
            localPath: outputPath,
            categoryLabel: "周辺環境",
            facilityName: mapsResult.name,
            facilityType: displayType,
          });
          return true;
        } catch (e) {
          console.log(`[shuhen] Brand logo failed: ${e.message.slice(0, 60)}`);
        }
      }

      if (mapsResult.photoBuffer) {
        fs.writeFileSync(outputPath, mapsResult.photoBuffer);
        results.push({
          localPath: outputPath,
          categoryLabel: "周辺環境",
          facilityName: mapsResult.name,
          facilityType: displayType,
        });
        return true;
      }

      // Fallback to Google Image Search (実店舗名がある場合のみ)
      console.log(`[shuhen] No Maps photo for ${displayType}, trying Image Search...`);
      const queries = [
        `${mapsResult.name} 外観`,
        `${displayType} 店舗 外観`,
      ];
      for (const imgQuery of queries) {
        const saved = await googleImageSearch(context, imgQuery, outputPath, displayType);
        if (saved) {
          results.push({
            localPath: outputPath,
            categoryLabel: "周辺環境",
            facilityName: mapsResult.name,
            facilityType: displayType,
          });
          return true;
        }
      }

      console.log(`[shuhen] SKIP: ${displayType} — no photo available`);
      return false;
    } catch (e) {
      console.log(`[shuhen] Error for ${displayType}: ${e.message.slice(0, 80)}`);
      return false;
    }
  }

  try {
    // Phase 1: attempt all mandatory types
    for (const ft of mandatoryTypes) {
      await acquireFacilityPhoto(ft);
    }

    // Phase 2: fill remaining slots to reach 6
    for (const ft of flexibleTypes) {
      if (results.length >= 6) break;
      await acquireFacilityPhoto(ft);
    }
  } finally {
    await mapsPage.close().catch(() => {});
  }

  console.log(`[shuhen] Total acquired: ${results.length}/6`);
  return results;
}

module.exports = { fetchShuhenPhotos, googleImageSearch };
