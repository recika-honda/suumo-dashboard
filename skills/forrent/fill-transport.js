/**
 * skills/forrent/fill-transport.js — forrent.jp 交通情報入力
 *
 * 元: skills/forrent.js (Phase 7 分割前)
 *
 * Public surface:
 *   - fillTransportViaMap(page, mainFrame, transportArray)     地図修正 + らくらく経由
 *   - fillTransportCascade(mainFrame, transportArray)          cascade select フォールバック
 *   - fillTransportRakuraku(mainFrame, transportArray)         旧ポップアップ版 (cascade alias)
 *
 * フォールバック関係:
 *   ViaMap → 失敗時 Cascade。Rakuraku は Cascade の alias (旧呼び出し互換)。
 */

const { norm } = require("./fill-texts");

// ══════════════════════════════════════════════════════════
//  交通 直接入力 — evaluate() で DOM を直接操作
//  (らくらくポップアップはonclickがフォームPOSTしてフレーム離脱を起こすため使わない)
// ══════════════════════════════════════════════════════════

/**
 * 地図修正 + らくらく交通入力 による交通設定
 *
 * フロー:
 * 1. chizuShuseiボタンをクリック → ポップアップで自動ジオコーディング
 * 2. 座標を tmpIdoFull/tmpKeidoFull から idoFull/keidoFull にコピー
 * 3. rakurakuKotsuボタンをクリック → ポップアップで最寄り駅を自動選択
 *
 * 注意: rakurakuKotsuのonclickはフォームPOSTを含むため、
 *       ポップアップハンドリングが必要
 */
async function fillTransportViaMap(page, mainFrame, transportArray) {
  const filled = [];
  const errors = [];

  console.log("[forrent] === TRANSPORT VIA MAP ===");

  // ═══ Step 1: 地図修正ボタンクリック → registryXY()で登録 ═══
  try {
    console.log("[forrent] Step 1: 地図修正（chizuShusei）");

    const popupPromise = page.context().waitForEvent("page", { timeout: 10000 }).catch(() => null);
    await mainFrame.evaluate(() => {
      const btn = document.getElementById("chizuShusei");
      if (btn) btn.click();
    });

    const mapPopup = await popupPromise;
    if (mapPopup) {
      console.log(`[forrent] 地図ポップアップ検出: ${mapPopup.url()}`);
      await mapPopup.waitForLoadState("networkidle").catch(() => {});
      await mapPopup.waitForTimeout(3000);

      // 「登録」ボタン = <IMG onclick="registryXY();"> をクリック
      // registryXY()はポップアップを自動で閉じるので、evaluate後にpage closedエラーが出る可能性あり
      const registered = await mapPopup.evaluate(() => {
        const imgs = [...document.querySelectorAll("img[onclick*='registryXY']")];
        if (imgs.length > 0) { imgs[0].click(); return "onclick"; }
        if (typeof window.registryXY === "function") { window.registryXY(); return "direct"; }
        return null;
      }).catch((e) => {
        // ポップアップが閉じた場合のエラーは無視（registryXY成功の証拠）
        if (e.message.includes("closed") || e.message.includes("detach")) return "closed-ok";
        return null;
      });

      console.log(`[forrent] 地図ポップアップ: 登録結果=${registered}`);
      // ポップアップが閉じるのを少し待つ
      await mainFrame.waitForTimeout(2000);
      if (!mapPopup.isClosed()) await mapPopup.close().catch(() => {});
    }

    // 座標の確認（registryXY()がparentに反映したはず）
    const coordResult = await mainFrame.evaluate(() => {
      const ido = document.getElementById("idoFull")?.value || "";
      const keido = document.getElementById("keidoFull")?.value || "";
      const tmpIdo = document.getElementById("tmpIdoFull")?.value || "";
      const tmpKeido = document.getElementById("tmpKeidoFull")?.value || "";
      // registryXY()がidoFull/keidoFullを設定しなかった場合、手動コピー
      if (!ido && tmpIdo) {
        document.getElementById("idoFull").value = tmpIdo;
        document.getElementById("keidoFull").value = tmpKeido;
        const flg = document.getElementById("idokeidoNoDisp");
        if (flg) flg.value = "0";
        return { ido: tmpIdo, keido: tmpKeido, source: "manual-copy" };
      }
      return ido ? { ido, keido, source: "registryXY" } : null;
    });

    if (coordResult) {
      console.log(`[forrent] 座標セット: ido=${coordResult.ido}, keido=${coordResult.keido} (${coordResult.source})`);
    } else {
      console.log("[forrent] 座標取得失敗 → フォールバック");
      return fillTransportCascade(mainFrame, transportArray);
    }

  } catch (e) {
    console.log(`[forrent] 地図修正エラー: ${e.message.slice(0, 100)}`);
    return fillTransportCascade(mainFrame, transportArray);
  }

  // ═══ Step 2: らくらく交通入力 ═══
  try {
    console.log("[forrent] Step 2: らくらく交通入力（rakurakuKotsu）");

    // ボタン存在確認 + onclick内容をログ
    const btnInfo = await mainFrame.evaluate(() => {
      const btn = document.getElementById("rakurakuKotsu");
      if (!btn) return { exists: false };
      return {
        exists: true,
        disabled: btn.disabled,
        display: getComputedStyle(btn).display,
        onclick: btn.getAttribute("onclick") || btn.onclick?.toString()?.slice(0, 200) || "",
        tagName: btn.tagName,
      };
    });
    console.log(`[forrent] rakurakuKotsu: ${JSON.stringify(btnInfo)}`);

    if (!btnInfo.exists) {
      console.log("[forrent] rakurakuKotsuボタンが存在しない → フォールバック");
      return fillTransportCascade(mainFrame, transportArray);
    }

    // ボタンがdisabledの場合: 強制有効化 + openRakurakuKotsu() を直接呼び出し
    if (btnInfo.disabled) {
      console.log("[forrent] rakurakuKotsu disabled → 強制有効化して直接呼び出し");
      await mainFrame.evaluate(() => {
        const btn = document.getElementById("rakurakuKotsu");
        if (btn) btn.disabled = false;
      });
      await mainFrame.waitForTimeout(500);
    }

    // popup検出: context-level + page-level 両方で捕捉
    const transportPopupPromise = Promise.race([
      page.waitForEvent("popup", { timeout: 15000 }).catch(() => null),
      page.context().waitForEvent("page", { timeout: 15000 }).catch(() => null),
    ]);

    // onclick関数を直接呼び出し（disabled状態でもclickイベント不発火のため）
    await mainFrame.evaluate(() => {
      if (typeof openRakurakuKotsu === "function") {
        const flg = document.getElementById("rakurakuKotsuCacheFlg")?.value || "";
        openRakurakuKotsu(flg, "COM1R02161.action", "COM1R02167.action");
      } else {
        const btn = document.getElementById("rakurakuKotsu");
        if (btn) btn.click();
      }
    });

    const transportPopup = await transportPopupPromise;
    if (transportPopup) {
      console.log(`[forrent] 交通ポップアップ検出: ${transportPopup.url()}`);
      await transportPopup.waitForLoadState("networkidle").catch(() => {});
      await transportPopup.waitForTimeout(3000);

      // Dynamically assign radio buttons: detect available candidates and fill 3 slots
      // Radio ID format: koutu_{slot}-{candidate} (slot: 1-3, candidate: 1-4)
      const radioResult = await transportPopup.evaluate(() => {
        const results = [];
        // First detect how many candidates exist
        let maxCandidate = 0;
        for (let c = 1; c <= 4; c++) {
          const r = document.getElementById(`koutu_1-${c}`);
          if (r) maxCandidate = c;
        }
        // Assign slots: prefer diagonal (1-1, 2-2, 3-3) but fallback if fewer candidates
        const assignments = [];
        if (maxCandidate >= 3) {
          assignments.push([1, 1], [2, 2], [3, 3]);
        } else if (maxCandidate === 2) {
          // Only 2 candidates: slot1=cand1, slot2=cand2, slot3=cand1 (repeat)
          assignments.push([1, 1], [2, 2], [3, 1]);
        } else if (maxCandidate === 1) {
          assignments.push([1, 1], [2, 1], [3, 1]);
        }
        for (const [slot, cand] of assignments) {
          const radio = document.getElementById(`koutu_${slot}-${cand}`);
          if (radio) {
            radio.checked = true;
            radio.dispatchEvent(new Event("change", { bubbles: true }));
            radio.dispatchEvent(new Event("click", { bubbles: true }));
            results.push(`交通${slot}=候補${cand}`);
          }
        }
        return results;
      });
      console.log(`[forrent] ラジオ選択: ${radioResult.join(", ")}`);

      // hidden fieldsから候補データを読み取り
      const candidates = await transportPopup.evaluate(() => {
        const out = [];
        for (let i = 1; i <= 4; i++) {
          const ensenNm = document.getElementById(`ensenNm${i}`)?.value || "";
          const ensenCd = document.getElementById(`ensenCd${i}`)?.value || "";
          const ekiNm = document.getElementById(`ekiNm${i}`)?.value || "";
          const ekiCd = document.getElementById(`ekiCd${i}`)?.value || "";
          const fun = document.getElementById(`tohofun${i}`)?.value || "";
          if (ensenNm) out.push({ idx: i, ensenNm, ensenCd, ekiNm, ekiCd, fun });
        }
        return out;
      });
      for (const c of candidates) {
        console.log(`[forrent] 候補${c.idx}: ${c.ensenNm}/${c.ekiNm} 徒歩${c.fun}分 (cd:${c.ensenCd}/${c.ekiCd})`);
      }

      // 「登録」ボタンクリック: <IMG id="registButton">
      // クリック後にポップアップが閉じる可能性あり
      await transportPopup.waitForTimeout(1000);
      const registClicked = await transportPopup.evaluate(() => {
        const btn = document.getElementById("registButton");
        if (btn) { btn.click(); return true; }
        const imgs = [...document.querySelectorAll("img")];
        const regImg = imgs.find(i => i.src?.includes("toroku"));
        if (regImg) { regImg.click(); return true; }
        return false;
      }).catch((e) => {
        if (e.message.includes("closed") || e.message.includes("detach")) return true;
        return false;
      });

      console.log(`[forrent] 交通ポップアップ: 登録=${registClicked}`);
      // parent frameの更新を待つ
      await mainFrame.waitForTimeout(3000);
      if (!transportPopup.isClosed()) await transportPopup.close().catch(() => {});

      // mainFrameの交通フィールドが設定されたか確認
      await mainFrame.waitForTimeout(1000);
      const transportResult = await mainFrame.evaluate(() => {
        const out = [];
        const ids = [
          { disp: "pkgEnsenNmDisp", cd: "pkgEnsenCd", ekiDisp: "pkgEkiNmDisp", ekiCd: "pkgEkiCd", fun: "tohofun" },
          { disp: "pkgEnsenNmDisp2", cd: "pkgEnsenCd2", ekiDisp: "pkgEkiNmDisp2", ekiCd: "pkgEkiCd2", fun: "tohofun2" },
          { disp: "pkgEnsenNmDisp3", cd: "pkgEnsenCd3", ekiDisp: "pkgEkiNmDisp3", ekiCd: "pkgEkiCd3", fun: "tohofun3" },
        ];
        for (const slot of ids) {
          const ensen = document.getElementById(slot.disp)?.value || "";
          const ensenCd = document.getElementById(slot.cd)?.value || "";
          const eki = document.getElementById(slot.ekiDisp)?.value || "";
          const ekiCd = document.getElementById(slot.ekiCd)?.value || "";
          const fun = document.getElementById(slot.fun)?.value || "";
          out.push({ ensen, ensenCd, eki, ekiCd, fun });
        }
        return out;
      });

      for (const t of transportResult) {
        if (t.ensen || t.eki || t.ensenCd) {
          filled.push(`${t.ensen} ${t.eki} 徒歩${t.fun}分 (cd:${t.ensenCd}/${t.ekiCd})`);
          console.log(`[forrent] transport: ${t.ensen} ${t.eki} 徒歩${t.fun}分 code=${t.ensenCd}/${t.ekiCd}`);
        }
      }

      if (filled.length === 0) {
        console.log("[forrent] らくらく交通入力 結果なし → フォールバック");
        return fillTransportCascade(mainFrame, transportArray);
      }

    } else {
      console.log("[forrent] 交通ポップアップなし → フォールバック");
      return fillTransportCascade(mainFrame, transportArray);
    }

  } catch (e) {
    console.log(`[forrent] らくらく交通入力エラー: ${e.message.slice(0, 100)}`);
    return fillTransportCascade(mainFrame, transportArray);
  }

  console.log(`[forrent] transport via map: ${filled.length} filled, ${errors.length} errors`);
  return { filled, errors };
}

// cascade select フォールバック: 沿線select→駅select→徒歩分数を正しくコード設定
async function fillTransportCascade(mainFrame, transportArray) {
  const filled = [];
  const errors = [];
  if (!transportArray?.length) return { filled, errors };

  // forrent.jpの交通フィールド構造を自動検出
  const formInfo = await mainFrame.evaluate(() => {
    const info = {};
    // cascade select 方式 (select要素)
    const ensenSel1 = document.querySelector('select[name*="ensenCd1"], select[name*="ensenCd"][name$="1"]');
    info.hasCascadeSelects = !!ensenSel1;
    if (ensenSel1) {
      info.ensenSelName = ensenSel1.name;
      info.ensenOptCount = ensenSel1.options.length;
    }
    // hidden field 方式 (pkgEnsenCd)
    const pkgEnsen = document.getElementById("pkgEnsenCd");
    info.hasHiddenFields = !!pkgEnsen;
    // display field 方式
    const pkgDisp = document.getElementById("pkgEnsenNmDisp");
    info.hasDisplayFields = !!pkgDisp;
    return info;
  });
  console.log(`[forrent] transport form info: ${JSON.stringify(formInfo)}`);

  for (let i = 0; i < Math.min(transportArray.length, 3); i++) {
    const t = transportArray[i];
    const ensen = norm(t.沿線 || "");
    const eki = norm(t.駅 || "");
    const walk = String(parseInt(t.徒歩) || 0);
    if (!ensen || !eki) continue;

    const suffix = i === 0 ? "" : String(i + 1);
    const idx1 = i + 1; // 1-based for name attributes

    try {
      // === Method 1: cascade select (最も確実) ===
      const ensenOk = await mainFrame.evaluate(({ ensen, idx }) => {
        // Try multiple naming patterns for ensen select
        const patterns = [
          `select[name*="ensenCd${idx}"]`,
          `select[name*="ensenCd"][name$="${idx}"]`,
          `select[name$="kotsuInputForm[${idx - 1}].ensenCd"]`,
          `select[name*="kotsuInputForm"][name*="[${idx - 1}]"][name*="ensenCd"]`,
        ];
        let sel = null;
        for (const p of patterns) {
          sel = document.querySelector(p);
          if (sel && sel.options.length > 1) break;
        }
        if (!sel) return { ok: false, reason: "select not found" };

        // Partial match on option text
        const options = [...sel.options];
        const match = options.find(o => o.text === ensen)
          || options.find(o => o.text.includes(ensen))
          || options.find(o => ensen.includes(o.text.replace(/（.*）/, "").trim()));
        if (!match) return { ok: false, reason: `no match for "${ensen}" in ${options.length} options` };

        sel.value = match.value;
        sel.dispatchEvent(new Event("change", { bubbles: true }));
        return { ok: true, code: match.value, text: match.text };
      }, { ensen, idx: idx1 });

      if (ensenOk.ok) {
        console.log(`[forrent] transport(cascade) ${idx1}: 沿線=${ensenOk.text} code=${ensenOk.code}`);

        // Wait for station cascade to load
        await mainFrame.waitForTimeout(2500);

        // Select station
        const ekiOk = await mainFrame.evaluate(({ eki, idx }) => {
          const patterns = [
            `select[name*="ekiCd${idx}"]`,
            `select[name*="ekiCd"][name$="${idx}"]`,
            `select[name$="kotsuInputForm[${idx - 1}].ekiCd"]`,
            `select[name*="kotsuInputForm"][name*="[${idx - 1}]"][name*="ekiCd"]`,
          ];
          let sel = null;
          for (const p of patterns) {
            sel = document.querySelector(p);
            if (sel && sel.options.length > 1) break;
          }
          if (!sel) return { ok: false, reason: "select not found" };

          const options = [...sel.options];
          const match = options.find(o => o.text === eki)
            || options.find(o => o.text.includes(eki))
            || options.find(o => eki.includes(o.text.replace(/（.*）/, "").trim()));
          if (!match) return { ok: false, reason: `no match for "${eki}" in ${options.length} options`, available: options.slice(0, 10).map(o => o.text) };

          sel.value = match.value;
          sel.dispatchEvent(new Event("change", { bubbles: true }));
          return { ok: true, code: match.value, text: match.text };
        }, { eki, idx: idx1 });

        if (ekiOk.ok) {
          console.log(`[forrent] transport(cascade) ${idx1}: 駅=${ekiOk.text} code=${ekiOk.code}`);
        } else {
          console.log(`[forrent] transport(cascade) ${idx1}: 駅失敗: ${ekiOk.reason}`);
          errors.push(`交通${idx1} 駅: ${ekiOk.reason}`);
        }

        // 徒歩分数
        await mainFrame.evaluate(({ idx, walk }) => {
          const patterns = [
            `input[name*="tohoFun${idx}"]`,
            `input[name*="kotsuInputForm"][name*="[${idx - 1}]"][name*="tohoFun"]`,
          ];
          for (const p of patterns) {
            const el = document.querySelector(p);
            if (el) {
              el.value = walk;
              el.dispatchEvent(new Event("input", { bubbles: true }));
              el.dispatchEvent(new Event("change", { bubbles: true }));
              return;
            }
          }
          // fallback: tohofun by ID
          const funEl = document.getElementById(idx === 1 ? "tohofun" : `tohofun${idx}`);
          if (funEl) {
            funEl.value = walk;
            funEl.dispatchEvent(new Event("input", { bubbles: true }));
          }
        }, { idx: idx1, walk });

        // 徒歩ラジオボタン
        await mainFrame.evaluate(({ idx }) => {
          const radioId = idx === 1 ? "toho" : `toho${idx}`;
          const radioEl = document.getElementById(radioId);
          if (radioEl) {
            radioEl.checked = true;
            radioEl.dispatchEvent(new Event("change", { bubbles: true }));
          }
        }, { idx: idx1 });

        filled.push(`交通${idx1}: ${eki}駅 徒歩${walk}分 (cascade)`);
        await mainFrame.waitForTimeout(500);
        continue; // cascade success, skip to next
      }

      // === Method 2: hidden field + display field (ポップアップ互換) ===
      console.log(`[forrent] transport(cascade) ${idx1}: 沿線select失敗(${ensenOk.reason}) → hidden field方式`);
      const hiddenResult = await mainFrame.evaluate(({ suffix, ensen, eki, walk }) => {
        const out = [];
        const fire = (el) => {
          el.dispatchEvent(new Event("input", { bubbles: true }));
          el.dispatchEvent(new Event("change", { bubbles: true }));
        };
        // Display fields
        const dispEnsen = document.getElementById(`pkgEnsenNmDisp${suffix}`);
        if (dispEnsen) { dispEnsen.value = ensen; fire(dispEnsen); }
        const nmEnsen = document.getElementById(`pkgEnsenNm${suffix}`);
        if (nmEnsen) { nmEnsen.value = ensen; }
        const dispEki = document.getElementById(`pkgEkiNmDisp${suffix}`);
        if (dispEki) { dispEki.value = eki; fire(dispEki); }
        const nmEki = document.getElementById(`pkgEkiNm${suffix}`);
        if (nmEki) { nmEki.value = eki; }
        // Radio
        const radioId = suffix === "" ? "toho" : `toho${suffix}`;
        const radio = document.getElementById(radioId);
        if (radio) { radio.checked = true; fire(radio); }
        // Minutes
        const funId = suffix === "" ? "tohofun" : `tohofun${suffix}`;
        const funEl = document.getElementById(funId);
        if (funEl && walk !== "0") { funEl.value = walk; fire(funEl); }
        out.push(`display=${!!dispEnsen}, hidden=${!!nmEnsen}`);
        return out;
      }, { suffix, ensen, eki, walk });

      filled.push(`交通${idx1}: ${eki}駅 徒歩${walk}分 (hidden)`);
      console.log(`[forrent] transport(hidden) ${idx1}: ${hiddenResult.join(", ")}`);

    } catch (e) {
      errors.push(`交通${idx1}: ${e.message.slice(0, 80)}`);
      console.log(`[forrent] transport(cascade) ${idx1}: error: ${e.message.slice(0, 100)}`);
    }
  }

  console.log(`[forrent] transport(cascade): ${filled.length} filled, ${errors.length} errors`);
  return { filled, errors };
}

// 旧ポップアップ版（互換性のため残す）
async function fillTransportRakuraku(mainFrame, transportArray) {
  return fillTransportCascade(mainFrame, transportArray);
}

module.exports = {
  fillTransportViaMap,
  fillTransportCascade,
  fillTransportRakuraku,
};
