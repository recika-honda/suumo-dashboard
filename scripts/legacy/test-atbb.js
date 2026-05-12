/**
 * ATBB Initial Cost Extraction — Standalone Test
 *
 * Tests ATBB login → search → initial cost extraction independently.
 * Browser opens in headful mode so you can observe the detail page DOM
 * and adjust extractInitialCosts selectors as needed.
 *
 * Usage: bun run scripts/test-atbb.js [buildingName] [roomNumber]
 *
 * Examples:
 *   bun run scripts/test-atbb.js
 *   bun run scripts/test-atbb.js "グランドコンシェルジュ三田" "301"
 */
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", "..", ".env.local") });
const { chromium } = require("playwright");
const atbb = require("../../skills/atbb");

// Default test case — replace with a known ATBB-listed property
const DEFAULT_BUILDING = "グランドコンシェルジュ三田";
const DEFAULT_ROOM = "301";

async function test() {
  const buildingName = process.argv[2] || DEFAULT_BUILDING;
  const roomNumber = process.argv[3] || DEFAULT_ROOM;

  const loginId = process.env.ATBB_LOGIN_ID;
  const loginPass = process.env.ATBB_LOGIN_PASS;

  if (!loginId || !loginPass) {
    console.error("ATBB_LOGIN_ID / ATBB_LOGIN_PASS が .env.local に設定されていません");
    process.exit(1);
  }

  console.log("=== ATBB Initial Cost Test ===");
  console.log(`建物名: ${buildingName}`);
  console.log(`部屋番号: ${roomNumber}`);
  console.log();

  // Headful for DOM observation
  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();

  try {
    // Step 1: Login
    console.log("── Step 1: Login ──");
    const loggedIn = await atbb.login(page, { id: loginId, password: loginPass });
    if (!loggedIn) {
      console.error("ログイン失敗");
      return;
    }

    // Step 2: Navigate to search
    console.log("\n── Step 2: Navigate to Search ──");
    const navigated = await atbb.navigateToSearch(page);
    if (!navigated) {
      console.error("検索ページ遷移失敗");
      return;
    }

    // Step 3: Search property
    console.log("\n── Step 3: Search Property ──");
    const found = await atbb.searchProperty(page, buildingName, roomNumber);
    if (!found) {
      console.error("物件が見つかりませんでした");
      return;
    }

    // Step 4: Extract initial costs
    console.log("\n── Step 4: Extract Initial Costs ──");
    const costs = await atbb.extractInitialCosts(page);

    console.log("\n=== Result ===");
    if (costs) {
      console.log(JSON.stringify(costs, null, 2));
    } else {
      console.log("初期費用データなし");
    }

    // Close the page before orchestrator test to avoid concurrent login conflict
    await page.close();

    // Also test the full orchestrator with a fresh page
    console.log("\n── Orchestrator Test (fetchInitialCosts) ──");
    const result = await atbb.fetchInitialCosts(context, {
      建物名: buildingName,
      部屋番号: roomNumber,
    });
    console.log("Orchestrator result:", result ? JSON.stringify(result, null, 2) : "null");
  } catch (e) {
    console.error(`Error: ${e.message}`);
    console.error(e.stack);
  }

  // Keep browser open for DOM inspection
  console.log("\nブラウザは開いたままです。Ctrl+C で終了してください。");
  await new Promise(() => {}); // hang forever
}

test().catch(console.error);
