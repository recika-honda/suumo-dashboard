// ヴァンテジオ世田谷を ATBB で直接フリーワード検索する debug スクリプト
// - 手動: ヒットする
// - 私の自動 (前回): 0 hits
// 切り分け対象: anti-bot 措置 (webdriver flag 隠蔽 + chrome args) で結果が変わるか
const { chromium } = require("playwright");
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", ".env.local") });
const atbb = require("../skills/atbb");

const STORAGE_STATE_PATH = path.join(__dirname, "..", ".playwright-data", "atbb-storage.json");
const fs = require("fs");

const KEYWORD = "ヴァンテジオ世田谷";

(async () => {
  const hasStorage = fs.existsSync(STORAGE_STATE_PATH);
  console.log(`storageState exists: ${hasStorage}`);

  const browser = await chromium.launch({
    headless: false,
    args: [
      "--disable-blink-features=AutomationControlled",
      "--disable-features=IsolateOrigins,site-per-process",
    ],
  });
  const context = await browser.newContext({
    viewport: { width: 1280, height: 900 },
    userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    ...(hasStorage ? { storageState: STORAGE_STATE_PATH } : {}),
  });

  // navigator.webdriver を隠す (bot 検出回避)
  await context.addInitScript(() => {
    Object.defineProperty(navigator, "webdriver", { get: () => undefined });
    // chrome.runtime をエミュレート
    if (!window.chrome) window.chrome = { runtime: {} };
    // languages
    Object.defineProperty(navigator, "languages", { get: () => ["ja-JP", "ja", "en-US", "en"] });
    // plugins (空配列だと bot 判定されやすい)
    Object.defineProperty(navigator, "plugins", {
      get: () => [1, 2, 3, 4, 5].map(() => ({ description: "", filename: "", name: "" })),
    });
  });

  context.on("page", (p) => p.on("dialog", (d) => d.accept().catch(() => {})));
  const portalPage = await context.newPage();
  portalPage.on("dialog", (d) => d.accept().catch(() => {}));

  try {
    console.log("ensureLoggedIn...");
    const ok = await atbb.ensureLoggedIn(portalPage, {
      id: process.env.ATBB_LOGIN_ID,
      pass: process.env.ATBB_LOGIN_PASS,
    });
    if (!ok) throw new Error("login failed");

    console.log("navigateToSearchForm...");
    const searchPage = await atbb.navigateToSearchForm(context, portalPage);

    // navigator.webdriver チェック
    const botStatus = await searchPage.evaluate(() => ({
      webdriver: navigator.webdriver,
      userAgent: navigator.userAgent,
      languages: navigator.languages,
      pluginCount: navigator.plugins?.length,
    }));
    console.log("bot status:", JSON.stringify(botStatus, null, 2));

    // 賃貸居住用 radio click
    console.log(`\n[step] radio click (賃貸居住用)`);
    await searchPage.evaluate(() => {
      const el = document.evaluate(
        "/html/body/table/tbody/tr[3]/td/table/tbody/tr[1]/td[3]/form/table[2]/tbody/tr[2]/td/div[1]/label/input",
        document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null
      ).singleNodeValue;
      if (el && !el.checked) el.click();
    });
    await searchPage.waitForTimeout(1000);

    // fill API でフリーワード入力
    console.log(`[step] fill keyword="${KEYWORD}"`);
    await searchPage.fill("#freeWordSearchSubject", KEYWORD);
    await searchPage.waitForTimeout(1500);

    // 「該当物件数」表示を確認 (動的カウンタ)
    const beforeSearch = await searchPage.evaluate(() => {
      const bodyText = document.body.innerText;
      const m = bodyText.match(/該当物件数\s*([\d,\-]+)\s*件/);
      return { hintText: m ? m[0] : null };
    });
    console.log("該当物件数 hint:", beforeSearch.hintText);

    // 検索ボタン click
    console.log(`[step] click 検索 ボタン`);
    await searchPage.evaluate(() => {
      const btns = Array.from(document.querySelectorAll('input[type="button"]'));
      const btn = btns.find((b) => b.value === "検索" && b.onclick && String(b.onclick).includes("searchFreeWord"));
      btn?.click();
    });
    await searchPage.waitForTimeout(6000);

    console.log("結果 URL:", searchPage.url());

    // reCAPTCHA score 確認 (console log から)
    const cardCount = await searchPage.evaluate(() => document.querySelectorAll('[id^="bukkenCard_"]').length);
    console.log(`結果カード数 (page 1): ${cardCount}`);

    if (cardCount > 0) {
      const cards = await searchPage.evaluate(() => {
        return Array.from(document.querySelectorAll('[id^="bukkenCard_"]')).slice(0, 10).map((c) => ({
          name: c.querySelector(".title-bar p.name")?.textContent?.trim(),
          type: c.querySelector(".title-bar .type")?.textContent?.trim(),
          shozai: c.querySelector(".info table:first-child")?.textContent?.replace(/\s+/g, "").slice(0, 50),
        }));
      });
      console.log("結果 cards:");
      cards.forEach((c, i) => console.log(`  [${i}] ${c.name} (${c.type}) ${c.shozai}`));
    }

    // screenshot
    await searchPage.screenshot({ path: "/Volumes/AgentSSD/04_FANGO/FNG26_AI入稿システム/code/suumo-dashboard/logs/atbb-matching/vantage-test-result.png", fullPage: true });
    console.log("screenshot saved");

    console.log("\n10秒後 close...");
    await searchPage.waitForTimeout(10000);
  } catch (e) {
    console.error("ERROR:", e.message);
    console.error(e.stack);
  } finally {
    // storageState 保存
    try { await context.storageState({ path: STORAGE_STATE_PATH }); console.log("storageState saved"); } catch {}
    await context.close().catch(() => {});
    await browser.close().catch(() => {});
  }
})();
