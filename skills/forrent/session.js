/**
 * skills/forrent/session.js — forrent.jp のログイン & 初期ナビゲーション
 *
 * 元: skills/forrent.js (Phase 7 分割前)
 *
 * Public surface:
 *   - login(page, credentials)            → boolean (main_r.action に到達したか)
 *   - navigateToNewProperty(page, opts)   → { mainFrame, title }
 *
 * login の朝のコールドスタート対策 (waitForURL 25s) は元コードの semantic をそのまま保持。
 */

const { FORRENT_URLS, FORRENT_SELECTORS } = require("./constants");

async function login(page, credentials) {
  await page.goto(FORRENT_URLS.login, {
    waitUntil: "domcontentloaded",
    timeout: 20000,
  });
  await page.waitForTimeout(3000);
  await page.fill(FORRENT_SELECTORS.login.idInput, credentials.id);
  await page.waitForTimeout(300);
  await page.fill(FORRENT_SELECTORS.login.passInput, credentials.pass);
  await page.waitForTimeout(300);
  await page.click(FORRENT_SELECTORS.login.submitBtn);
  // 朝のコールドスタートでログイン後遷移が遅延するケースがある。
  // fixed sleep で諦める代わりに main_r.action への遷移を最大 25s 待つ。
  try {
    await page.waitForURL(/main_r\.action/, { timeout: 25000 });
  } catch {
    // 遷移しなかった場合は失敗扱い（呼び出し側で再試行されるか FORRENT_LOGIN_FAIL が返る）
  }
  return page.url().includes("main_r.action");
}

async function navigateToNewProperty(page, { deleteDraft = true } = {}) {
  const naviFrame = page.frame({ name: "navi" });
  if (!naviFrame) throw new Error("Navi frame not found");
  await naviFrame.click(FORRENT_SELECTORS.navi.menuNewProperty);
  await page.waitForTimeout(5000);
  const mainFrame = page.frame({ name: "main" });
  if (!mainFrame) throw new Error("Main frame not found");

  // ドラフト復元ダイアログが出ている場合
  const hasDraft = await mainFrame.evaluate(() => {
    const btn = document.getElementById("deleteDraftButton");
    if (btn && btn.offsetParent !== null) return true;
    return false;
  });
  if (hasDraft) {
    if (deleteDraft) {
      console.log("[forrent] ドラフト検出 → 削除して新規物件登録");
      await mainFrame.click("#deleteDraftButton");
      await page.waitForTimeout(2000);
      const yesBtn = await mainFrame.$("#yesDeleteDraftButton");
      if (yesBtn) {
        await yesBtn.click();
        await page.waitForTimeout(3000);
      }
    } else {
      console.log("[forrent] ドラフト検出 → 保持（deleteDraft=false）");
    }
  }

  return { mainFrame, title: await mainFrame.title() };
}

module.exports = {
  login,
  navigateToNewProperty,
};
