// ATBB radio 選択の有無で検索結果に差が出るか検証 (skills/atbb.js を使用)
const { chromium } = require("playwright");
const path = require("path");
require("dotenv").config({ path: path.join("/Volumes/AgentSSD/04_FANGO/FNG26_AI入稿システム/code/suumo-dashboard/.env.local") });
const atbb = require("/Volumes/AgentSSD/04_FANGO/FNG26_AI入稿システム/code/suumo-dashboard/skills/atbb");

const USER_DATA_DIR = "/Volumes/AgentSSD/04_FANGO/FNG26_AI入稿システム/code/suumo-dashboard/.playwright-data/atbb";

const CASES = [
  { kw: "ヴァンテジオ世田谷", radio: true },
  { kw: "ヴァンテジオ世田谷", radio: false },
  { kw: "ＬＩＶ　ＳＨＡＬＯＮ", radio: true },
  { kw: "ＬＩＶ　ＳＨＡＬＯＮ", radio: false },
];

(async () => {
  const ctx = await chromium.launchPersistentContext(USER_DATA_DIR, {
    headless: false,
    viewport: { width: 1280, height: 900 },
  });
  ctx.on("page", (p) => p.on("dialog", (d) => d.accept().catch(() => {})));
  const portalPage = ctx.pages()[0] ?? await ctx.newPage();
  portalPage.on("dialog", (d) => d.accept().catch(() => {}));

  try {
    console.log("ensureLoggedIn...");
    const ok = await atbb.ensureLoggedIn(portalPage, { id: process.env.ATBB_LOGIN_ID, pass: process.env.ATBB_LOGIN_PASS });
    if (!ok) throw new Error("login failed");

    console.log("navigateToSearchForm...");
    const searchPage = await atbb.navigateToSearchForm(ctx, portalPage);

    for (const c of CASES) {
      console.log(`\n--- keyword="${c.kw}", radio=${c.radio ? "賃貸居住用" : "なし"} ---`);
      await atbb.returnToSearchForm(searchPage);

      if (c.radio) {
        await searchPage.evaluate(() => {
          const radios = Array.from(document.querySelectorAll('input[name="atbbShumokuDaibunrui"]'));
          const target = radios.find((r) => r.value === "06");
          if (target && !target.checked) target.click();
        });
      }
      // radio 状態確認
      const radioVal = await searchPage.evaluate(() =>
        Array.from(document.querySelectorAll('input[name="atbbShumokuDaibunrui"]')).find((r) => r.checked)?.value
      );
      console.log(`  radio checked: ${radioVal ?? "none"}`);

      await searchPage.evaluate((kw) => {
        const el = document.getElementById("freeWordSearchSubject");
        el.value = kw;
        el.dispatchEvent(new Event("input", { bubbles: true }));
      }, c.kw);

      await searchPage.evaluate(() => {
        const btn = Array.from(document.querySelectorAll('input[type=button]')).find((b) => b.value === "検索" && b.onclick && String(b.onclick).includes("searchFreeWord"));
        btn?.click();
      });
      await searchPage.waitForTimeout(5000);

      const result = await searchPage.evaluate(() => {
        const cards = Array.from(document.querySelectorAll('[id^="bukkenCard_"]')).slice(0, 5).map((c) => ({
          name: c.querySelector(".title-bar p.name")?.textContent?.trim(),
          type: c.querySelector(".title-bar .type")?.textContent?.trim(),
        }));
        const cardCount = document.querySelectorAll('[id^="bukkenCard_"]').length;
        return { cardCount, topCards: cards, url: window.location.href };
      });
      console.log(`  url: ${result.url}`);
      console.log(`  hits (page1): ${result.cardCount}`);
      console.log(`  top cards:`, JSON.stringify(result.topCards, null, 2));
    }

    console.log("\n10 秒後 close...");
    await searchPage.waitForTimeout(10000);
  } catch (e) {
    console.error("ERROR:", e.message);
    console.error(e.stack);
  } finally {
    await ctx.close().catch(() => {});
  }
})();
