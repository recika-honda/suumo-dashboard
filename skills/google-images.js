/**
 * Google Image Search — Playwright-based image acquisition
 *
 * 1. Missing 5pt category images: search "[property name] キッチン" etc.
 * 2. Surrounding environment photos: Google Maps nearby search → Google Image search
 *    - AI validation: reject images with people, ensure facility is clearly visible
 */
const fs = require("fs");
const path = require("path");
const sharp = require("sharp");
const Anthropic = require("@anthropic-ai/sdk");

const aiClient = new Anthropic();

/**
 * Validate a shuhen (surrounding environment) image using Claude Vision.
 * Rejects images with people and images where the target facility is unclear.
 *
 * @param {Buffer} imageBuffer - JPEG image buffer
 * @param {string} facilityType - Expected facility type (e.g., "コンビニ", "スーパー")
 * @returns {{ valid: boolean, reason: string }}
 */
async function validateShuhenImage(imageBuffer, facilityType) {
  try {
    const response = await aiClient.messages.create({
      model: "claude-haiku-4-5-20251001",
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
3. ロゴ・看板・建物外観で施設が特定できる場合はOK

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
    console.log(`[google-img] Validation error: ${err.message.slice(0, 60)}`);
    return { valid: true, reason: "validation-error" };
  }
}

/**
 * Google Image search via Playwright — download first usable result.
 * When facilityType is specified, validates each candidate with AI
 * (rejects images with people / unclear facility).
 *
 * @param {import('playwright').BrowserContext} context
 * @param {string} query - search query
 * @param {string} outputPath - file save path
 * @param {string|null} facilityType - facility type for AI validation (null to skip)
 * @returns {string|null} saved file path or null
 */
async function googleImageSearch(context, query, outputPath, facilityType = null) {
  const page = await context.newPage();
  try {
    const searchUrl = `https://www.google.com/search?q=${encodeURIComponent(query)}&tbm=isch&udm=2`;
    await page.goto(searchUrl, { waitUntil: "domcontentloaded", timeout: 15000 });
    await page.waitForTimeout(2000);

    // Extract image URLs from search results
    const imageUrls = await page.evaluate(() => {
      const urls = [];
      const imgs = document.querySelectorAll("img");
      for (const img of imgs) {
        const src = img.src || "";
        if (src.startsWith("data:") || src.includes("google.com/images") ||
            src.includes("gstatic.com") || src.includes("googleusercontent.com/favicon") ||
            !src.startsWith("http")) continue;
        if (img.naturalWidth > 100 && img.naturalHeight > 100) {
          urls.push(src);
        }
      }
      const encImgs = document.querySelectorAll('img[src*="encrypted-tbn"]');
      for (const img of encImgs) {
        if (img.naturalWidth > 50) urls.push(img.src);
      }
      return [...new Set(urls)].slice(0, 10);
    });

    if (imageUrls.length === 0) {
      console.log(`[google-img] No images found for: ${query}`);
      return null;
    }

    // Try to click first result to get full-size image
    let fullUrl = null;
    try {
      const firstImg = await page.$('div[data-ri="0"] img, div[jscontroller] img');
      if (firstImg) {
        await firstImg.click();
        await page.waitForTimeout(2000);
        fullUrl = await page.evaluate(() => {
          const previewImgs = document.querySelectorAll('img[jsname="kn3ccd"], img[jsname="HiaYvf"]');
          for (const img of previewImgs) {
            const src = img.src || "";
            if (src.startsWith("http") && !src.includes("encrypted-tbn") && img.naturalWidth > 200) {
              return src;
            }
          }
          return null;
        });
      }
    } catch { /* preview click failed, use thumbnails */ }

    // Build candidate list: full-size first, then thumbnails
    const candidates = fullUrl ? [fullUrl, ...imageUrls] : imageUrls;
    const uniqueCandidates = [...new Set(candidates)];

    let fallbackSaved = false;
    for (const url of uniqueCandidates) {
      try {
        const response = await page.context().request.get(url, { timeout: 10000 });
        if (!response.ok()) continue;

        const buffer = await response.body();
        const resized = await sharp(buffer)
          .resize({ width: 1280, height: 960, fit: "cover", position: "centre" })
          .jpeg({ quality: 85 })
          .toBuffer();

        // Save first successfully downloaded image as fallback
        if (!fallbackSaved) {
          fs.writeFileSync(outputPath, resized);
          fallbackSaved = true;
        }

        // Validate with AI if facilityType specified
        if (facilityType) {
          const validation = await validateShuhenImage(resized, facilityType);
          if (!validation.valid) {
            console.log(`[google-img] Rejected: ${validation.reason}`);
            continue;
          }
          console.log(`[google-img] Validated OK for ${facilityType}`);
        }

        // Valid image — save and return
        fs.writeFileSync(outputPath, resized);
        console.log(`[google-img] Saved: ${path.basename(outputPath)}`);
        return outputPath;
      } catch {
        continue;
      }
    }

    // Return fallback if saved
    if (fallbackSaved) {
      console.log(`[google-img] Saved (fallback, no validated): ${path.basename(outputPath)}`);
      return outputPath;
    }

    return null;
  } catch (e) {
    console.log(`[google-img] Error for "${query}": ${e.message.slice(0, 80)}`);
    return null;
  } finally {
    await page.close().catch(() => {});
  }
}

/**
 * Fetch surrounding environment photos using Google Maps + Image search
 * with AI validation for quality control.
 *
 * @param {import('playwright').BrowserContext} context
 * @param {object} reinsData - REINS property data
 * @param {string} downloadDir - output directory
 * @returns {Array<{localPath: string, categoryLabel: string, facilityName: string, facilityType: string}>}
 */
async function fetchShuhenPhotos(context, reinsData, downloadDir) {
  const outDir = path.join(downloadDir, "shuhen");
  fs.mkdirSync(outDir, { recursive: true });

  const address = `${reinsData.都道府県名 || ""}${reinsData.所在地名１ || ""}${reinsData.所在地名２ || ""}${reinsData.所在地名３ || ""}`;
  if (!address) {
    console.log("[google-img] No address for shuhen search");
    return [];
  }

  const facilityTypes = [
    { type: "コンビニ", query: "コンビニ" },
    { type: "スーパー", query: "スーパーマーケット" },
    { type: "ドラッグストア", query: "ドラッグストア 薬局" },
    { type: "病院", query: "病院 クリニック" },
    { type: "飲食店", query: "レストラン 飲食店" },
    { type: "コンビニ", query: "コンビニエンスストア" },
  ];

  // Step 1: Search Google Maps for nearby facilities
  const page = await context.newPage();
  const facilities = [];

  try {
    for (const ft of facilityTypes) {
      if (facilities.length >= 6) break;

      const mapQuery = `${address} ${ft.query}`;
      const mapUrl = `https://www.google.com/maps/search/${encodeURIComponent(mapQuery)}`;

      try {
        await page.goto(mapUrl, { waitUntil: "domcontentloaded", timeout: 15000 });
        await page.waitForTimeout(4000);

        const facilityName = await page.evaluate(() => {
          const candidates = [
            ...document.querySelectorAll('[role="feed"] a[aria-label]'),
            ...document.querySelectorAll('.fontHeadlineSmall'),
            ...document.querySelectorAll('h3.fontHeadlineSmall'),
            ...document.querySelectorAll('[jstcache] .fontBodyMedium a'),
            ...document.querySelectorAll('.Nv2PK a[aria-label]'),
            ...document.querySelectorAll('[role="article"] a[aria-label]'),
          ];
          for (const el of candidates) {
            const name = (el.ariaLabel || el.textContent || "").trim();
            if (name && name.length > 1 && name.length < 50) return name;
          }
          return null;
        });

        if (facilityName) {
          facilities.push({ name: facilityName, type: ft.type });
          console.log(`[google-img] Maps: ${ft.type} → ${facilityName}`);
        } else {
          facilities.push({ name: `${address}付近の${ft.type}`, type: ft.type });
          console.log(`[google-img] Maps: ${ft.type} → generic fallback`);
        }
      } catch (e) {
        facilities.push({ name: `${address}付近の${ft.type}`, type: ft.type });
        console.log(`[google-img] Maps error for ${ft.type}: ${e.message.slice(0, 50)}`);
      }
    }
  } finally {
    await page.close().catch(() => {});
  }

  // Step 2: Google Image search for each facility (with AI validation)
  const results = [];
  for (let i = 0; i < facilities.length && i < 6; i++) {
    const facility = facilities[i];
    const outputPath = path.join(outDir, `shuhen_${i + 1}_${facility.type}.jpg`);
    const query = `${facility.name} 外観`;

    const saved = await googleImageSearch(context, query, outputPath, facility.type);
    if (saved) {
      results.push({
        localPath: saved,
        categoryLabel: "周辺環境",
        facilityName: facility.name,
        facilityType: facility.type,
      });
    }
  }

  console.log(`[google-img] Shuhen photos: ${results.length}/${facilities.length} acquired`);
  return results;
}

module.exports = { fetchShuhenPhotos, googleImageSearch };
