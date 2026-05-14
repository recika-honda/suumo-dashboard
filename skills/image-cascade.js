/**
 * Image Cascade — REINS 画像不足時に物確サイトを順番に試して画像取得
 *
 * Phase 3a (2026-05-15): itandi のみ実装。商号判定なしで「物件名 + 部屋番号」で
 * 直接検索する。前回バッチで bukaku が 16 件中 1 件しか発火しなかったのは
 * detectPlatform(商号) が殆どの元付業者で null を返したため (`BEACON / カナッツ /
 * バディ / 明和管財 / 東急住宅リース / 田中土建工業 / SPILYTUS / Good / リアルワン
 * / 中央都市管理` 等)。商号判定をやめてしまえば、これらの物件も itandi BB に
 * 登録されていれば画像を引いてこられる。
 *
 * 設計:
 *   - 発火条件: stage 02 で REINS raw <= 2 (Phase 2 の IMAGE_INSUFFICIENT 検出時)
 *   - 検索キー: 物件名 (必須) + 部屋番号 (PF が対応していれば)
 *   - 順番: opts.platforms (default ["itandi"]) を試して、最初にヒットした PF
 *           の画像を返す。全 miss なら { images: [] }
 *   - 環境変数 PHASE3_CASCADE=0 で全体無効化可能 (実装側で env を読む)
 *
 * 将来 (Phase 3b/c) で atbb / essquare を追加する時は HANDLERS にエントリを足す。
 * ATBB は ~/.claude/rules/atbb-session-management.md に厳格遵守。
 *
 * Public API:
 *   cascadeImageFetch(context, reinsData, downloadDir, opts?) → { platform, images, attempts }
 *     - platform: ヒットした PF 名 (string) or null
 *     - images: Array<{ index, localPath, source, originalUrl }>
 *     - attempts: Array<{ platform, status, count? }> (各 PF の試行結果ログ)
 */

const fs = require("fs");
const path = require("path");
const bukaku = require("./bukaku");

/**
 * itandi BB ハンドラ — bukaku.js の primitives を商号判定なしで直接使う。
 * 既存 fetchBukakuData が detectPlatform(商号) で gated されているのを bypass。
 */
async function fetchFromItandi(context, buildingName, roomNumber, downloadDir) {
  if (!buildingName) return { status: "no-building-name", images: [] };
  const page = await context.newPage();
  try {
    const loggedIn = await bukaku.itandiLogin(page);
    if (!loggedIn) return { status: "login-fail", images: [] };

    let detailLinks = await bukaku.itandiSearchProperty(page, buildingName, roomNumber || "");
    if (detailLinks.length === 0 && roomNumber) {
      // 部屋番号でヒットしなければ物件名のみで再検索
      detailLinks = await bukaku.itandiSearchProperty(page, buildingName, "");
    }
    if (detailLinks.length === 0) return { status: "no-hit", images: [] };

    const imageUrls = await bukaku.itandiGetImages(page, detailLinks[0]);
    if (imageUrls.length === 0) return { status: "no-images", images: [] };

    const cascadeDir = path.join(downloadDir, "cascade-itandi");
    fs.mkdirSync(cascadeDir, { recursive: true });

    const downloaded = [];
    for (let i = 0; i < imageUrls.length; i++) {
      const ext = imageUrls[i].match(/\.(jpg|jpeg|png|gif|webp)/i)?.[1] || "jpg";
      const outputPath = path.join(cascadeDir, `cascade_${i + 1}.${ext}`);
      try {
        await bukaku.downloadImage(imageUrls[i], outputPath);
        downloaded.push({
          // stage 03 (analyzeAndCropImages) が読む index は 1 始まり
          index: i + 1,
          localPath: outputPath,
          source: "itandi",
          originalUrl: imageUrls[i],
        });
      } catch (e) {
        console.error(`[cascade/itandi] download fail [${i + 1}]: ${e.message}`);
      }
    }
    return { status: "hit", images: downloaded };
  } catch (e) {
    return { status: "error", images: [], error: e.message };
  } finally {
    await page.close().catch(() => {});
  }
}

const DEFAULT_HANDLERS = {
  itandi: fetchFromItandi,
  // Phase 3b: atbb (要 atbb-session-management.md 遵守)
  // Phase 3c: essquare
};

/**
 * Cascade orchestrator. Try platforms in order, return on first hit.
 *
 * @param {object} context        Playwright BrowserContext
 * @param {object} reinsData      Stage 01 の reins extract 結果 (建物名 / 部屋番号 必須)
 * @param {string} downloadDir    画像保存ディレクトリ
 * @param {object} [opts]
 * @param {Array<string>} [opts.platforms]   試行順 (default ["itandi"])
 * @param {object} [opts.handlers]           DI 用 (test で mock 注入)
 * @returns {Promise<{ platform: string|null, images: Array, attempts: Array }>}
 */
async function cascadeImageFetch(context, reinsData, downloadDir, opts = {}) {
  const platforms = opts.platforms || ["itandi"];
  const handlers = opts.handlers || DEFAULT_HANDLERS;
  const buildingName = (reinsData && reinsData["建物名"]) || "";
  const roomNumber = (reinsData && reinsData["部屋番号"]) || "";
  const attempts = [];

  for (const pf of platforms) {
    const handler = handlers[pf];
    if (!handler) {
      attempts.push({ platform: pf, status: "no-handler" });
      continue;
    }
    let result;
    try {
      result = await handler(context, buildingName, roomNumber, downloadDir);
    } catch (err) {
      attempts.push({ platform: pf, status: "throw", error: err.message });
      continue;
    }
    attempts.push({ platform: pf, status: result.status, count: result.images.length });
    if (result.images.length > 0) {
      return { platform: pf, images: result.images, attempts };
    }
  }
  return { platform: null, images: [], attempts };
}

module.exports = { cascadeImageFetch, fetchFromItandi };
