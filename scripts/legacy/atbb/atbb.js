/**
 * ATBB Skill - Login, Search, Card Extraction
 *
 * Selectors & structure based on investigation (2026-05-13):
 * - Login page: https://atbb.athome.jp/ → POST → https://members.athome.jp/portal
 * - Search form: bfcm003s201 (new tab from portal)
 * - Search results: bfcm300s008 (#bukkenCard_0..19)
 * - Detail page: bfcm381s016
 *
 * See: docs/refactor/atbb-search-result-schema.md and atbb-to-forrent-mapping.md
 */

const ATBB_URLS = {
  loginEntry: "https://atbb.athome.jp/",
  portal: "https://members.athome.jp/portal",
  searchForm: "https://atbb.athome.co.jp/front-web/mainservlet/bfcm003s201",
  searchResult: "https://atbb.athome.co.jp/front-web/mainservlet/bfcm300s008",
};

const ATBB_SHUMOKU = {
  uriTochi: "01",
  uriKodate: "02",
  uriMansion: "03",
  uriJigyou: "04",
  uriResort: "05",
  chintaiKyojuyo: "06",
  chintaiJigyou: "07",
  kashiTochi: "08",
  kashiChushajo: "09",
};

// ── Ensure Logged In (use persistent context cookies if available) ─
// 既存セッションが有効なら portal に直接遷移できる → login() スキップ
// ATBB 多重ログイン禁止に対応するため、persistent context (cookies 永続化) と
// この関数を組み合わせて使うこと
async function ensureLoggedIn(page, { id, pass }) {
  await page.goto(ATBB_URLS.portal, { waitUntil: "domcontentloaded", timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(1500);

  const url = page.url();
  // 既に portal にいる = ログイン状態維持されている (cookies が有効)
  if (url.includes("members.athome.jp/portal")) {
    return true;
  }

  // ログイン画面 (atbb.athome.jp / members.athome.jp/login) にリダイレクトされた → ログインフォーム入力
  return await login(page, { id, pass });
}

// ── Login ──────────────────────────────────────────────────────
async function login(page, { id, pass }) {
  await page.goto(ATBB_URLS.loginEntry, { waitUntil: "domcontentloaded", timeout: 20000 });
  await page.waitForTimeout(1000);

  // members.athome.jp/login の React 制御フォームには native setter + input イベントが必須
  await page.evaluate(({ id, pass }) => {
    const set = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
    const idEl = document.querySelector("input[name=loginId]");
    const pwEl = document.querySelector("input[name=password]");
    if (!idEl || !pwEl) throw new Error("ログインフォーム要素なし");
    set.call(idEl, id);
    idEl.dispatchEvent(new Event("input", { bubbles: true }));
    set.call(pwEl, pass);
    pwEl.dispatchEvent(new Event("input", { bubbles: true }));
  }, { id, pass });

  await page.waitForTimeout(500);

  // 第一画面: <input type=submit> / 第二画面: <button>
  await page.evaluate(() => {
    const btn = document.querySelector("input[type=submit], button[type=submit], button");
    btn?.click();
  });

  // members.athome.jp/portal に遷移するまで最大 15s 待機
  try {
    await page.waitForURL(/members\.athome\.jp\/portal/, { timeout: 15000 });
  } catch {
    // 二段階ログイン (members.athome.jp/login) を介する場合がある → 同じ手順で再送信
    const current = page.url();
    if (current.includes("members.athome.jp/login")) {
      await page.evaluate(({ id, pass }) => {
        const set = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
        const idEl = document.querySelector("input[name=loginId]");
        const pwEl = document.querySelector("input[name=password]");
        if (idEl && pwEl) {
          set.call(idEl, id);
          idEl.dispatchEvent(new Event("input", { bubbles: true }));
          set.call(pwEl, pass);
          pwEl.dispatchEvent(new Event("input", { bubbles: true }));
        }
      }, { id, pass });
      await page.waitForTimeout(500);
      await page.evaluate(() => {
        const btn = document.querySelector("input[type=submit], button[type=submit], button");
        btn?.click();
      });
      await page.waitForURL(/members\.athome\.jp\/portal/, { timeout: 15000 });
    }
  }

  return page.url().includes("/portal");
}

// ── Navigate Portal → Search Form (new tab) ────────────────────
async function navigateToSearchForm(context, portalPage, opts = {}) {
  const { maxRetries = 5 } = opts;
  let lastUrl = "";

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    // 毎回 portal を fresh state にする
    await portalPage.goto(ATBB_URLS.portal, { waitUntil: "domcontentloaded", timeout: 15000 }).catch(() => {});
    await portalPage.waitForTimeout(1500);

    const newPagePromise = context.waitForEvent("page", { timeout: 10000 }).catch(() => null);

    const click1 = await portalPage.evaluate(() => {
      const links = Array.from(document.querySelectorAll("a"));
      const target = links.find((a) => a.textContent?.trim() === "物件・会社検索");
      if (!target) return false;
      target.click();
      return true;
    });
    if (!click1) {
      await portalPage.waitForTimeout(1000);
      continue;
    }
    await portalPage.waitForTimeout(800);

    const click2 = await portalPage.evaluate(() => {
      const all = Array.from(document.querySelectorAll("h3, a, button"));
      const target = all.find((el) => el.textContent?.trim() === "流通物件検索");
      if (!target) return false;
      target.click();
      return true;
    });
    if (!click2) {
      await portalPage.waitForTimeout(1000);
      continue;
    }

    const searchPage = await newPagePromise;
    if (!searchPage) {
      await portalPage.waitForTimeout(2000);
      continue;
    }

    // 新タブの dialog handler を即仕掛け (ConcurrentLoginException の confirm 用)
    searchPage.on("dialog", (d) => d.accept().catch(() => {}));

    try {
      await searchPage.waitForLoadState("domcontentloaded", { timeout: 15000 });
    } catch {}

    await searchPage.waitForTimeout(2000);
    const url = searchPage.url();
    lastUrl = url;

    if (url.includes("bfcm003s201")) {
      return searchPage;
    }

    // ConcurrentLoginException / セッションタイムアウト系
    if (url.includes("ConcurrentLoginException") || url.includes("timeout")) {
      // kento 教示: この画面に「強制終了してログイン」ボタンがある → 押せばセッション奪取して進める
      const kickResult = await searchPage.evaluate(() => {
        const candidates = Array.from(document.querySelectorAll("input[type=button], input[type=submit], button, a, img"));
        // テキスト or value or alt or onclick で「強制」「強制終了」を含むものを探す
        const target = candidates.find((el) => {
          const text = (el.value || el.textContent || el.alt || el.getAttribute("aria-label") || "").trim();
          const onclick = String(el.onclick || el.getAttribute("onclick") || "");
          return /強制(終了|ログイン)|奪取|kick|forceLogin/i.test(text + " " + onclick);
        });
        if (target) {
          // anchor or img の場合、parent の link を辿る
          const clickable = target.closest("a, button") || target;
          clickable.click();
          return { ok: true, label: (target.value || target.textContent || target.alt || "").trim().slice(0, 40), tag: target.tagName };
        }
        // 見つからなければ画面に出ているすべての clickable を返す (debug 用)
        const allClickable = candidates.filter(c => c.offsetParent !== null).map(c => ({
          tag: c.tagName,
          text: (c.value || c.textContent || c.alt || "").trim().slice(0, 60),
          onclick: String(c.onclick || c.getAttribute("onclick") || "").slice(0, 80),
        }));
        return { ok: false, allClickable };
      });

      if (kickResult.ok) {
        console.log(`  [atbb] ConcurrentLoginException 突破: 強制ログインボタン click (${kickResult.label})`);
        await searchPage.waitForTimeout(5000);
        const urlAfter = searchPage.url();
        if (urlAfter.includes("bfcm003s201")) return searchPage;
        if (urlAfter.includes("/portal")) {
          // portal に戻った → タブ閉じてリトライ
          await searchPage.close().catch(() => {});
          continue;
        }
        // 強制ログイン後の遷移先が想定外 → 続けてリトライ
        await searchPage.close().catch(() => {});
        continue;
      } else {
        // 強制ログインボタンが見つからない → 画面の要素を debug log
        console.log(`  [atbb] 強制ログインボタンなし。clickable elements:`);
        console.log(JSON.stringify(kickResult.allClickable, null, 2));
        await searchPage.waitForTimeout(6000);
        await searchPage.close().catch(() => {});
        continue;
      }
    }

    // 想定外 URL: 一旦閉じてリトライ
    await searchPage.close().catch(() => {});
  }

  throw new Error(`検索フォーム遷移失敗: ${maxRetries} 回試行 (last url: ${lastUrl})`);
}

// ── Submit Free Word Search ────────────────────────────────────
// 注 (2026-05-14 kento 教示): 賃貸居住用 radio をクリックしないと freeWordSearchSubject が
//     DOM 上に出現しない (= radio click 必須)。一度 radio click を撤回したが「画面の操作が
//     正しくありません」エラーが出て差し戻し。デフォルト '06' (賃貸居住用) を必須化。
async function submitFreeWordSearch(searchPage, { keyword, shumokuValue = ATBB_SHUMOKU.chintaiKyojuyo }) {
  // shumoku radio click は必須 (skip しない)
  await searchPage.evaluate(({ shumokuValue }) => {
    const radios = Array.from(document.querySelectorAll('input[name="atbbShumokuDaibunrui"]'));
    const target = radios.find((r) => r.value === shumokuValue);
    if (!target) throw new Error(`shumoku radio not found: ${shumokuValue}`);
    if (!target.checked) target.click();
  }, { shumokuValue });
  // radio click 後の searcharea display 反映を待つ (重要)
  await searchPage.waitForTimeout(800);

  // Playwright `fill()` を使う = focus + keyboard simulation + input/change イベント発火
  // 2026-05-14: eval ベースの value 代入だと ATBB の動的 state (入力欄横の「該当物件数」カウンタ等)
  //   が動かず、結果として検索が「フリーワード入力されてない」扱いになり 0 件返ってきていた仮説。
  //   fill() は人間のタイピングに近い event sequence を発火するため、ATBB の JS が正しく反応する。
  await searchPage.fill("#freeWordSearchSubject", keyword);
  await searchPage.waitForTimeout(800);

  await searchPage.evaluate(() => {
    const btns = Array.from(document.querySelectorAll('input[type="button"]'));
    const btn = btns.find((b) => b.value === "検索" && b.onclick && String(b.onclick).includes("searchFreeWord"));
    if (!btn) throw new Error("searchFreeWord button not found");
    btn.click();
  });

  // 検索結果ページに遷移するまで最大 20s 待機 (reCAPTCHA 通過込み)
  try {
    await searchPage.waitForURL(/bfcm300s008/, { timeout: 20000 });
    await searchPage.waitForTimeout(1500); // カード描画待ち
  } catch (e) {
    throw new Error(`検索送信失敗: ${e.message}`);
  }

  return true;
}

// ── Extract Cards from Search Result Page ──────────────────────
async function extractCards(searchPage) {
  return await searchPage.evaluate(() => {
    const cards = document.querySelectorAll('[id^="bukkenCard_"]');
    return Array.from(cards).map((c) => {
      const get = (sel) => c.querySelector(sel)?.textContent?.trim() ?? null;
      const normSpace = (s) => s?.replace(/\s+/g, "") ?? null;

      // payment dl の <div><dt>label</dt><dd>value</dd></div> から label の値を取得
      const getPayment = (label) => {
        const divs = c.querySelectorAll(".payment dl div");
        for (const d of divs) {
          if (d.querySelector("dt")?.textContent?.trim() === label) {
            return d.querySelector("dd")?.textContent?.trim() ?? null;
          }
        }
        return null;
      };

      // .info table 内の <tr><th>label</th><td>value</td>...</tr> から label の値を取得
      const getInfo = (label) => {
        const tables = c.querySelectorAll(".info table");
        for (const tbl of tables) {
          const rows = tbl.querySelectorAll("tr");
          for (const r of rows) {
            const ths = r.querySelectorAll("th");
            const tds = r.querySelectorAll("td");
            for (let j = 0; j < ths.length; j++) {
              if (ths[j]?.textContent?.trim() === label) {
                return tds[j]?.textContent?.trim() ?? null;
              }
            }
          }
        }
        return null;
      };

      // property_data の dl 内 dt/dd 対応
      const getPropData = (label) => {
        const dls = c.querySelectorAll(".property_data dl");
        for (const dl of dls) {
          const items = Array.from(dl.children);
          for (let j = 0; j < items.length; j++) {
            if (items[j].tagName === "DT" && items[j].textContent?.trim() === label) {
              const next = items[j + 1];
              if (next?.tagName === "DD") return next.textContent?.trim() ?? null;
            }
          }
        }
        return null;
      };

      const namePath = get(".title-bar p.name") ?? "";
      const [buildingName, roomNumber] = namePath.split("/").map((s) => s?.trim());
      const sheets = get(".sheets") ?? "";
      const imageCountMatch = sheets.match(/(\d+)\s*点/);

      return {
        idx: parseInt(c.id.replace("bukkenCard_", ""), 10),
        type: get(".title-bar .type"),
        buildingName: buildingName || null,
        roomNumber: roomNumber || null,
        publishDate: get(".title-bar p.date span"),
        imageCount: imageCountMatch ? parseInt(imageCountMatch[1], 10) : null,
        kanrihi: getPayment("管理費等"),
        reikin: getPayment("礼金"),
        shikikin: getPayment("敷金"),
        shikibiki: getPayment("敷引"),
        madori: getInfo("間取り"),
        shozai: normSpace(getInfo("所在地")),
        kotsu: normSpace(getInfo("交通")),
        menseki: getInfo("専有面積"),
        kaisu: getInfo("階建/階"),
        chikuNen: getInfo("築年月"),
        tanka: getInfo("坪単価"),
        kozo: getInfo("建物構造"),
        company: get(".property_data .company a"),
        tel: get(".property_data .tel a"),
        torihiki: getPropData("取引態様"),
        kokokuTensai: getPropData("広告転載"),
        shosaiBtnId: `shosai_${c.id.replace("bukkenCard_", "")}`,
      };
    });
  });
}

// ── Count of search results (確実な件数判定用) ─────────────────
async function countCards(searchPage) {
  return await searchPage.evaluate(() => {
    return document.querySelectorAll('[id^="bukkenCard_"]').length;
  });
}

// ── Click 詳細 button by index (Phase E で使う) ────────────────
async function clickShosaiButton(searchPage, idx) {
  await searchPage.evaluate((idx) => {
    const btn = document.getElementById(`shosai_${idx}`);
    if (!btn) throw new Error(`shosai_${idx} not found`);
    btn.click();
  }, idx);
  await searchPage.waitForURL(/bfcm381s016/, { timeout: 20000 });
  await searchPage.waitForTimeout(1000);
}

// ── Reset search form (連続検索用) ─────────────────────────────
async function returnToSearchForm(searchPage) {
  await searchPage.goto(ATBB_URLS.searchForm, { waitUntil: "domcontentloaded", timeout: 15000 });
  await searchPage.waitForTimeout(1000);
}

module.exports = {
  ATBB_URLS,
  ATBB_SHUMOKU,
  login,
  ensureLoggedIn,
  navigateToSearchForm,
  submitFreeWordSearch,
  extractCards,
  countCards,
  clickShosaiButton,
  returnToSearchForm,
};
