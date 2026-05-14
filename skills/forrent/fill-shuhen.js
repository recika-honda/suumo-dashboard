/**
 * skills/forrent/fill-shuhen.js — forrent.jp 周辺環境入力
 *
 * 元: skills/forrent.js (Phase 7 分割前)
 *
 * Public surface:
 *   - fillShuhenKankyo(page, mainFrame)               らくらく周辺環境入力 (緯度経度→施設自動取得)
 *   - syncShuhenDestinationFields(forrentPage, mainFrame)  入力結果を destination フィールドに同期
 */

const { SHUHEN_CATEGORY_CODES } = require("./constants");

/**
 * らくらく周辺環境入力 — 物件の緯度経度から周辺施設を自動取得
 * ポップアップが開き、施設一覧からチェックボックスで選択→登録
 * @param {Page} page - Playwright page (ポップアップ検出用)
 * @param {Frame} mainFrame - forrent.jp main frame
 */
async function fillShuhenKankyo(page, mainFrame) {
  console.log("[forrent] === SHUHEN KANKYO (周辺環境) START ===");
  const filled = [];
  const errors = [];

  try {
    // 「らくらく周辺環境入力」ボタンをクリック
    const popupPromise = page.context().waitForEvent("page", { timeout: 15000 }).catch(() => null);
    const btnClicked = await mainFrame.evaluate(() => {
      const buttons = document.querySelectorAll("input[type='button']");
      for (const btn of buttons) {
        if (btn.value.includes("らくらく周辺環境")) {
          btn.click();
          return true;
        }
      }
      return false;
    });

    if (!btnClicked) {
      console.log("[forrent] 周辺環境: らくらく周辺環境入力ボタンなし");
      return { filled, errors: ["らくらく周辺環境入力ボタンが見つかりません"] };
    }

    const popup = await popupPromise;
    if (!popup) {
      console.log("[forrent] 周辺環境: ポップアップが開きませんでした");
      return { filled, errors: ["周辺環境ポップアップが開きません"] };
    }

    console.log(`[forrent] 周辺環境ポップアップ検出: ${popup.url()}`);
    await popup.waitForLoadState("networkidle").catch(() => {});
    await popup.waitForTimeout(3000);

    // ポップアップ内の施設一覧を確認
    const facilityInfo = await popup.evaluate(() => {
      const result = {
        checkboxes: 0,
        checkedCount: 0,
        facilities: [],
        buttons: [],
      };

      // チェックボックスを検出
      const cbs = document.querySelectorAll("input[type='checkbox']");
      result.checkboxes = cbs.length;
      for (const cb of cbs) {
        if (cb.checked) result.checkedCount++;
        const tr = cb.closest("tr");
        const text = tr ? tr.textContent.trim().replace(/\s+/g, " ").slice(0, 100) : "";
        result.facilities.push({ checked: cb.checked, text, name: cb.name || "", value: cb.value || "" });
      }

      // ボタンを検出
      const buttons = document.querySelectorAll("input[type='button'], input[type='submit'], button, img[onclick]");
      for (const btn of buttons) {
        const text = (btn.value || btn.textContent || btn.alt || "").trim();
        if (text) result.buttons.push(text);
      }

      return result;
    }).catch(() => ({ checkboxes: 0, checkedCount: 0, facilities: [], buttons: [] }));

    console.log(`[forrent] 周辺環境ポップアップ: ${facilityInfo.checkboxes}件チェックボックス, ${facilityInfo.checkedCount}件チェック済み`);
    console.log(`[forrent] ボタン: ${facilityInfo.buttons.join(", ")}`);
    for (const f of facilityInfo.facilities.slice(0, 10)) {
      console.log(`[forrent]   [${f.checked ? "☑" : "☐"}] ${f.text.slice(0, 80)}`);
    }

    // Select up to 6 facilities, prioritizing required categories
    if (facilityInfo.checkboxes > 0 && facilityInfo.checkedCount === 0) {
      const selectedCount = await popup.evaluate(() => {
        const cbs = [...document.querySelectorAll("input[type='checkbox']")];
        const selected = [];
        // Priority categories to find (by text match in row)
        const priorities = ["コンビニ", "スーパー", "ドラッグストア", "薬局", "郵便局", "病院", "学校"];
        // First pass: select priority categories
        for (const keyword of priorities) {
          if (selected.length >= 6) break;
          for (const cb of cbs) {
            if (selected.includes(cb)) continue;
            const tr = cb.closest("tr");
            const text = tr ? tr.textContent : "";
            if (text.includes(keyword)) {
              cb.checked = true;
              cb.dispatchEvent(new Event("change", { bubbles: true }));
              selected.push(cb);
              break; // one per category
            }
          }
        }
        // Second pass: fill remaining slots
        for (const cb of cbs) {
          if (selected.length >= 6) break;
          if (!selected.includes(cb)) {
            cb.checked = true;
            cb.dispatchEvent(new Event("change", { bubbles: true }));
            selected.push(cb);
          }
        }
        return selected.length;
      });
      console.log(`[forrent] 周辺環境: ${selectedCount}件を優先順で自動選択`);
    }

    // 「登録」/「確定」/「反映」ボタンをクリック
    await popup.waitForTimeout(1000);
    const registClicked = await popup.evaluate(() => {
      // 登録ボタンを探す（ID、value、alt属性で検索）
      const btn = document.getElementById("registButton")
        || document.getElementById("regist")
        || document.getElementById("okButton");
      if (btn) { btn.click(); return btn.value || btn.alt || "registButton"; }

      // value で検索
      const buttons = [...document.querySelectorAll("input[type='button'], input[type='submit'], button")];
      for (const b of buttons) {
        const val = (b.value || b.textContent || "").trim();
        if (val.includes("登録") || val.includes("確定") || val.includes("反映") || val.includes("OK")) {
          b.click();
          return val;
        }
      }

      // img ボタンで検索
      const imgs = [...document.querySelectorAll("img")];
      for (const img of imgs) {
        const src = img.src || "";
        const alt = img.alt || "";
        if (src.includes("toroku") || alt.includes("登録") || src.includes("ok") || src.includes("regist")) {
          img.click();
          return alt || src;
        }
      }

      return null;
    }).catch((e) => {
      if (e.message.includes("closed") || e.message.includes("detach")) return "popup closed";
      return null;
    });

    console.log(`[forrent] 周辺環境ポップアップ: 登録=${registClicked}`);
    await mainFrame.waitForTimeout(3000);
    if (!popup.isClosed()) await popup.close().catch(() => {});

    // mainFrameの周辺環境フィールドが設定されたか確認
    await mainFrame.waitForTimeout(1000);

    // らくらく周辺環境ポップアップが書き込んだ施設名を 30 文字以内にクリップ。
    // Google系の長い施設名 (例: "ゆうちょ銀行 本店 ファミリーマート中野江原町一丁目店内出張所" 31文字)
    // をそのまま POST すると forrent 側「30文字以内」バリデータで弾かれる。
    // (再現済み: 100138990085 周辺環境名6 / 100139003800 周辺環境名6 / 100139017573 周辺環境名4)
    await mainFrame.evaluate(() => {
      for (let i = 0; i < 6; i++) {
        const nameEl = document.querySelector(`input[name="bukkenInputForm.shuhenKankyoInputForm[${i}].shuhenKankyoNm"]`);
        if (nameEl && nameEl.value && nameEl.value.length > 30) {
          nameEl.value = nameEl.value.slice(0, 30);
          nameEl.dispatchEvent(new Event("input", { bubbles: true }));
          nameEl.dispatchEvent(new Event("change", { bubbles: true }));
        }
      }
    }).catch(() => {});

    const shuhenResult = await mainFrame.evaluate(() => {
      const out = [];
      for (let i = 0; i < 6; i++) {
        const nameEl = document.querySelector(`input[name="bukkenInputForm.shuhenKankyoInputForm[${i}].shuhenKankyoNm"]`);
        const kyoriEl = document.querySelector(`input[name="bukkenInputForm.shuhenKankyoInputForm[${i}].kyori"]`);
        const catEl = document.querySelector(`select[name="bukkenInputForm.shuhenKankyoInputForm[${i}].categoryCd"]`);
        const name = nameEl?.value || "";
        const kyori = kyoriEl?.value || "";
        const cat = catEl?.options[catEl.selectedIndex]?.text?.trim() || "";
        const catCd = catEl?.value || "";
        if (name || kyori) out.push({ name, kyori, cat, catCd });
      }
      return out;
    });

    for (const s of shuhenResult) {
      filled.push(`${s.name} / ${s.kyori}m / ${s.cat}`);
      console.log(`[forrent] + 周辺: ${s.name} / ${s.kyori}m / ${s.cat} (${s.catCd})`);
    }

    // ポップアップ後にcategoryCdが空のスロットを補完
    // 郵便局・学校等はポップアップが自動設定しないため手動で設定
    try {
      await mainFrame.evaluate(() => {
        // Browser context: cannot reference SHUHEN_CATEGORY_CODES directly.
        // Canonical mapping is SHUHEN_CATEGORY_CODES at module top.
        const NAME_TO_CODE = {
          "コンビニ": "060203", "セブン": "060203", "ファミリーマート": "060203", "ローソン": "060203", "ミニストップ": "060203",
          "スーパー": "060202", "マルエツ": "060202", "まいばすけっと": "060202", "成城石井": "060202", "ライフ": "060202",
          "ドラッグ": "060204", "薬局": "060204", "スギ薬局": "060204", "マツモトキヨシ": "060204",
          "病院": "060210", "クリニック": "060210", "医院": "060210",
          "学校": "060207", "小学校": "060207", "中学校": "060207",
          "郵便局": "060211",
          "飲食": "060218", "レストラン": "060218",
        };
        for (let i = 0; i < 6; i++) {
          const catEl = document.querySelector(`select[name="bukkenInputForm.shuhenKankyoInputForm[${i}].categoryCd"]`);
          if (!catEl || (catEl.value && catEl.value !== "")) continue;
          const nameEl = document.querySelector(`input[name="bukkenInputForm.shuhenKankyoInputForm[${i}].shuhenKankyoNm"]`);
          const name = nameEl?.value || "";
          if (!name) continue;
          // 施設名からカテゴリコードを推測
          let code = "";
          for (const [keyword, c] of Object.entries(NAME_TO_CODE)) {
            if (name.includes(keyword)) { code = c; break; }
          }
          if (!code) code = "060201"; // フォールバック: ショッピングセンター
          const hasOption = [...catEl.options].some(o => o.value === code);
          if (hasOption) {
            catEl.value = code;
            catEl.dispatchEvent(new Event("change", { bubbles: true }));
          }
        }
      });
    } catch (e) {
      console.log(`[forrent] 周辺カテゴリ補完: ${e.message.slice(0, 60)}`);
    }

    if (filled.length === 0) {
      console.log("[forrent] 周辺環境: フィールドが更新されませんでした");
      errors.push("周辺環境フィールドが更新されませんでした");
    }

  } catch (e) {
    console.log(`[forrent] 周辺環境エラー: ${e.message.slice(0, 100)}`);
    errors.push(`周辺環境エラー: ${e.message.slice(0, 60)}`);
  }

  console.log(`[forrent] === SHUHEN KANKYO END === filled: ${filled.length}`);
  return { filled, errors };
}

/**
 * 周辺環境ポップアップが書き込んだ施設名 (`shuhenKankyoNm[i]`) を
 * 旧フォーム側の `destination${i+1}` フィールドにコピー同期する。
 *
 * forrent 自身が用意している周辺環境入力ポップアップは、施設名を
 * `bukkenInputForm.shuhenKankyoInputForm[i].shuhenKankyoNm` に書き込むが、
 * 一部経路で表示用の `destination${i+1}` 側が空のままになる事例があるため、
 * mainFrame 側で手動同期する。
 *
 * non-critical: 失敗しても入稿は継続する (catch 内は何もしない)。
 */
async function syncShuhenDestinationFields(forrentPage, mainFrame) {
  try {
    await mainFrame.evaluate(() => {
      for (let i = 0; i < 6; i++) {
        const nameEl = document.querySelector(
          `input[name="bukkenInputForm.shuhenKankyoInputForm[${i}].shuhenKankyoNm"]`
        );
        const destEl = document.getElementById(`destination${i + 1}`);
        if (nameEl && nameEl.value && destEl) {
          destEl.value = nameEl.value;
          destEl.dispatchEvent(new Event("input", { bubbles: true }));
        }
      }
    });
  } catch (e) {
    // Non-critical
  }
}

module.exports = {
  fillShuhenKankyo,
  syncShuhenDestinationFields,
};
