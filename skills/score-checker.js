/**
 * Score Checker — 名寄せスコア取得
 *
 * Reads the 名寄せスコア from forrent.jp after property registration.
 * The score appears on the property detail/edit page.
 */

/**
 * Read the 名寄せスコア from the current forrent.jp page.
 * Should be called after successful property registration.
 *
 * @param {import('playwright').Page} page - The Playwright page
 * @returns {{total: number, breakdown: Object}}
 */
async function readNayoseScore(page) {
  const mainFrame = page.frame({ name: "main" });
  if (!mainFrame) return { total: 0, breakdown: {}, raw: "" };

  // Wait for page to fully load
  await mainFrame.waitForTimeout(3000);

  const scoreData = await mainFrame.evaluate(() => {
    const body = document.body.innerText;
    const breakdown = {};

    // Score patterns (forrent.jp uses various formats)
    const patterns = [
      { key: "居室/リビング", regex: /居室.*?(\d+)\s*点/s },
      { key: "キッチン", regex: /キッチン.*?(\d+)\s*点/s },
      { key: "バス/シャワー", regex: /(?:バス|シャワー|浴室).*?(\d+)\s*点/s },
      { key: "間取り図", regex: /間取り.*?(\d+)\s*点/s },
      { key: "外観", regex: /外観.*?(\d+)\s*点/s },
      {
        key: "キャッチコピー",
        regex: /(?:キャッチ|コピー|コメント).*?(\d+)\s*点/s,
      },
      { key: "周辺環境", regex: /周辺.*?(\d+)\s*点/s },
      { key: "パノラマ", regex: /パノラマ.*?(\d+)\s*点/s },
      { key: "動画CM", regex: /(?:動画|CM).*?(\d+)\s*点/s },
    ];

    // Try to find the total score directly (confirmation page only shows total)
    const totalPatterns = [
      /名寄せスコア[：:\s]*(\d+)/,
      /SUUMO採点[：:\s]*(\d+)/,
      /合計[：:\s]*(\d+)\s*点/,
      /スコア[：:\s]*(\d+)/,
    ];
    let total = 0;
    for (const re of totalPatterns) {
      const m = body.match(re);
      if (m) {
        total = parseInt(m[1]);
        break;
      }
    }

    // Per-category breakdown: only trust matches where the score differs from total
    // (confirmation page has no per-category scores; patterns false-match the total)
    let sum = 0;
    for (const p of patterns) {
      const m = body.match(p.regex);
      if (m) {
        const pts = parseInt(m[1]);
        if (pts !== total && pts <= 5) {
          breakdown[p.key] = pts;
          sum += pts;
        }
      }
    }

    return { total, breakdown };
  });

  return scoreData;
}

/**
 * Navigate to the property's score/detail page.
 * After registration, navigate to management list and find the property.
 *
 * @param {import('playwright').Page} page
 */
async function navigateToScorePage(page) {
  const naviFrame = page.frame({ name: "navi" });
  if (!naviFrame) return;

  // Click 掲載管理 menu
  try {
    await naviFrame.click("#menu_3");
    await page.waitForTimeout(5000);
  } catch {
    // Try alternative navigation
    try {
      await naviFrame.click('a:has-text("掲載管理")');
      await page.waitForTimeout(5000);
    } catch {
      // Navigation failed
    }
  }
}

module.exports = { readNayoseScore, navigateToScorePage };
