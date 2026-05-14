/**
 * skills/forrent/register.js — forrent.jp 登録 (確認画面 → 登録ボタン → score 検証)
 *
 * 元: skills/forrent.js (Phase 7 分割前)
 * 拡張: 2026-05-14 escalation 路線 (score >= threshold で 訂正 → 掲載 + checkbox → 再確認 → 登録)
 *
 * Public surface:
 *   - scrapeValidation(frame)                          確認画面エラー収集
 *   - saveFrameArtifacts(page, frame, dir, tag)        確認画面 HTML+PNG 保存
 *   - registerProperty(page, mainFrame, opts)          確認 → 登録 → score 取得
 *
 * 内部関係: registerProperty が scrapeValidation と saveFrameArtifacts を順次呼ぶ。
 * escalation 路線では訂正ボタン → shijiIsize 変更 → checkbox 2 つ ON → 再確認 → 登録 と進む。
 */

const fs = require("fs");
const path = require("path");
const { getEscalationConfig, shouldEscalate } = require("../score-escalation");

// ── timeout 定数 (forrent の reload / onchange race を吸収する余裕値) ──
const CONFIRM_READY_TIMEOUT_MS = 20000;
const EDIT_READY_TIMEOUT_MS = 20000;
const FINAL_READY_TIMEOUT_MS = 20000;
const SHIJI_APPEAR_TIMEOUT_MS = 20000;
const CHECKBOX_ENABLE_TIMEOUT_MS = 5000;

/**
 * バリデーション情報を確認画面のフレームから収集する。
 * 「エラー 一覧」見出しだけでなく、内側のリスト項目・フィールド別メッセージ・
 * 赤字警告などを網羅的に拾って `errors[]` と `errorSectionText` に集約する。
 */
async function scrapeValidation(frame) {
  return await frame.evaluate(() => {
    const body = document.body?.innerText || "";
    const clean = (t) => (t || "").replace(/\s+/g, " ").trim();
    const uniq = (arr) => [...new Set(arr)];
    const scoreMatch = body.match(/名寄せスコア[：:\s]*(\d+)/);

    const tables = [...document.querySelectorAll("table")];
    const errorRows = [];
    for (const tbl of tables) {
      let isErrorTable = tbl.id === "err_table";
      if (!isErrorTable) {
        const allText = clean(tbl.textContent || "");
        isErrorTable =
          /状況/.test(allText) && /区分/.test(allText) && /内容/.test(allText) &&
          (/エラー\s*一覧/.test(allText) || tbl.id === "err_table");
      }
      if (!isErrorTable) continue;
      const rows = [...tbl.querySelectorAll("tr")];
      for (const tr of rows) {
        if (tr.classList.contains("headLineError")) continue;
        if (tr.classList.contains("headLineErrorHead")) continue;
        const cells = [...tr.querySelectorAll("td")].map((td) => clean(td.textContent));
        if (cells.length < 3) continue;
        const category = cells[cells.length - 3] || "";
        const content = cells[cells.length - 2] || "";
        if (!content || content.length < 2) continue;
        if (/^当該箇所へ$/.test(content)) continue;
        if (content === "内容" || content === "区分") continue;
        errorRows.push({ category, content });
      }
    }

    const fieldErrors = [];
    if (errorRows.length === 0) {
      const msgEls = document.querySelectorAll(
        '.errorMessage, .error_message, .errMsg, [class*="ErrorMsg"], .formError'
      );
      for (const el of msgEls) {
        const t = clean(el.textContent);
        if (t.length > 2 && t.length < 200 && !/^エラー\s*一覧$/.test(t)) fieldErrors.push(t);
      }
    }

    const errors = uniq([...errorRows.map((r) => r.content), ...fieldErrors]);
    const hasError = errors.length > 0;

    return {
      errors,
      errorRows,
      hasError,
      score: scoreMatch ? parseInt(scoreMatch[1]) : null,
      bodySnippet: body.slice(0, 500),
    };
  });
}

/**
 * artifact ディレクトリに確認画面の HTML / PNG を保存する（失敗原因の事後調査用）。
 */
async function saveFrameArtifacts(page, frame, dir, tag) {
  if (!dir) return;
  try { fs.mkdirSync(dir, { recursive: true }); } catch {}
  try {
    const html = await frame.content();
    fs.writeFileSync(path.join(dir, `${tag}.html`), html);
  } catch (e) {
    try { fs.writeFileSync(path.join(dir, `${tag}.html.err`), String(e.message || e)); } catch {}
  }
  try {
    await page.screenshot({ path: path.join(dir, `${tag}.png`), fullPage: true });
  } catch (e) {
    try { fs.writeFileSync(path.join(dir, `${tag}.png.err`), String(e.message || e)); } catch {}
  }
}

// ──────────────────────────────────────────────────────────────
// 内部ヘルパ (DOM 操作)
// ──────────────────────────────────────────────────────────────

/**
 * 編集画面で「確認画面へ」(regButton2) をクリックする。フォールバックでテキスト一致も試す。
 * @returns {Promise<string|null>} クリックしたボタンのラベル / null = 見つからず
 */
async function clickConfirmButton(frame) {
  return await frame.evaluate(() => {
    const btn = document.getElementById("regButton2");
    if (btn) { btn.click(); return btn.value || btn.alt || "regButton2"; }
    const buttons = [...document.querySelectorAll("input[type='button'], input[type='submit'], input[type='image'], button")];
    for (const b of buttons) {
      const t = (b.value || b.textContent || b.alt || "").trim();
      if ((t.includes("確認") || t.includes("登録")) && !t.includes("削除") && !t.includes("一時")) {
        b.click(); return t;
      }
    }
    return null;
  });
}

/**
 * 確認画面で「訂正」(#teisei) をクリックして編集画面に戻る。
 * onclick=ImageButton.onceSubmit(...) が走るので click() のみで遷移する。
 */
async function clickTeiseiButton(confirmFrame) {
  return await confirmFrame.evaluate(() => {
    const btn = document.getElementById("teisei");
    if (btn) { btn.click(); return btn.alt || btn.value || "teisei"; }
    return null;
  });
}

/**
 * 編集画面で shijiIsize を「掲載」(value=1) に変更し、スマピク掲載 + 店舗案内ピックアップ掲載
 * の 2 checkbox を ON にする。change イベントを dispatch して changeShiji() を発火させ、
 * toggleSumapiku/toggleTenpiku が checkbox の disabled/visibility を解除する想定。
 * 念のため checkbox 側も disabled=false, visibility=visible を明示。
 *
 * @returns {Promise<{ok:boolean, error?:string, shijiValue?:string, sumapikuChecked?:boolean, tenpikuChecked?:boolean}>}
 */
async function modifyShijiAndCheckboxes(editFrame) {
  await editFrame.evaluate(() => window.scrollTo(0, 0));

  // ── #shijiIsize の出現を polling 待機 ──
  try {
    await editFrame.waitForFunction(
      () => !!document.getElementById("shijiIsize"),
      { timeout: SHIJI_APPEAR_TIMEOUT_MS }
    );
  } catch (e) {
    return { ok: false, error: `#shijiIsize が編集画面に現れませんでした (${SHIJI_APPEAR_TIMEOUT_MS / 1000}s)` };
  }

  // ── Playwright native API で shijiIsize=1 (掲載) を設定 ──
  // selectOption が内部で input + change イベントを正しい順序で発火し、
  // forrent の onchange handler (changeShiji → toggleSumapiku/Tenpiku) が
  // 確実に走る。手動 evaluate より event chain が forrent JS と整合的。
  try {
    await editFrame.selectOption("#shijiIsize", "1");
  } catch (e) {
    return { ok: false, error: `shijiIsize selectOption 失敗: ${e.message.slice(0, 200)}` };
  }

  // ── changeShiji() の onchange 副作用 (toggleSumapiku/toggleTenpiku) で
  //    checkbox が enabled になるまで polling 待機 ──
  try {
    await editFrame.waitForFunction(
      () => {
        const s = document.getElementById("sumapiku");
        const t = document.getElementById("tenpiku");
        if (!s || !t) return false;
        const sEnabled = !s.disabled && s.style.visibility !== "hidden";
        const tEnabled = !t.disabled && t.style.visibility !== "hidden";
        return sEnabled && tEnabled;
      },
      { timeout: CHECKBOX_ENABLE_TIMEOUT_MS }
    );
  } catch {
    // best-effort: 出ていなくても後段で明示 enable + check を試みる
  }

  // ── visibility/disabled を明示的に解除 (Playwright .check() の visibility check を通すため) ──
  await editFrame.evaluate(() => {
    for (const id of ["sumapiku", "tenpiku"]) {
      const el = document.getElementById(id);
      if (el) {
        el.disabled = false;
        el.style.visibility = "visible";
        if (el.classList) el.classList.remove("defaultHidden");
      }
    }
  });

  // ── Playwright native check() で checkbox を ON にする ──
  // check() は visibility 待機 + actual click event を発火するので
  // forrent JS の onchange listener も正しく駆動される。
  try {
    await editFrame.check("#sumapiku", { force: true });
  } catch (e) {
    return { ok: false, error: `スマピク掲載 check 失敗: ${e.message.slice(0, 200)}` };
  }
  try {
    await editFrame.check("#tenpiku", { force: true });
  } catch (e) {
    return { ok: false, error: `店舗案内ピックアップ check 失敗: ${e.message.slice(0, 200)}` };
  }

  // ── 結果確認 ──
  return await editFrame.evaluate(() => {
    const sel = document.getElementById("shijiIsize");
    const sumapiku = document.getElementById("sumapiku");
    const tenpiku = document.getElementById("tenpiku");
    return {
      ok: true,
      shijiValue: sel?.value,
      sumapikuChecked: !!sumapiku?.checked,
      tenpikuChecked: !!tenpiku?.checked,
    };
  });
}

/**
 * 確認画面で「登録」ボタンを探してクリック。確認/一時/削除/戻 を含む候補は除外。
 */
async function clickRegistrationButton(confirmFrame) {
  return await confirmFrame.evaluate(() => {
    const candidates = [
      ...document.querySelectorAll("input[type='button'], input[type='submit'], input[type='image'], button"),
    ];
    for (const b of candidates) {
      const t = (b.value || b.textContent || b.alt || "").trim();
      if (t.includes("登録") && !t.includes("確認") && !t.includes("一時") && !t.includes("削除") && !t.includes("戻")) {
        b.click();
        return t;
      }
    }
    const imgs = [...document.querySelectorAll("input[type='image'], img[onclick]")];
    for (const img of imgs) {
      const src = (img.src || img.getAttribute("src") || "").toLowerCase();
      const alt = (img.alt || "").trim();
      const onclick = (img.getAttribute("onclick") || "");
      if (src.includes("toroku") || src.includes("regist") || alt.includes("登録") || onclick.includes("regist")) {
        img.click();
        return alt || src.split("/").pop() || "img-register";
      }
    }
    return null;
  });
}

/**
 * 登録完了画面から score / 完了テキスト / エラーテキストの有無を取得。
 * waitForFinalReady が「エラー」も ready 条件に含むため、ここで「完了」「登録しました」
 * の不在 + 「エラー」存在 を hasErrorText として返し、caller 側で saved 判定に使う。
 */
async function readFinalState(frame) {
  return await frame.evaluate(() => {
    const body = document.body?.innerText || "";
    const scoreMatch = body.match(/名寄せスコア[：:\s]*(\d+)/);
    const isComplete = body.includes("完了") || body.includes("登録しました");
    const hasErrorText = !isComplete && /エラー/.test(body);
    return {
      isComplete,
      hasErrorText,
      score: scoreMatch ? parseInt(scoreMatch[1]) : null,
      bodySnippet: body.slice(0, 500),
    };
  });
}

/**
 * 確認画面の signature を polling 待機。
 *
 * 重要 (2026-05-14 bug): 編集画面にも「名寄せスコア ― 点」というプレースホルダ表示が
 * あり、`/名寄せスコア/` regex は edit/confirm を区別できない。signature は
 * 「confirm 画面に確実に存在し、edit 画面に存在しないもの」だけで構成する。
 *
 * 確定 signature:
 *   - #teisei (訂正ボタン): 確認画面の exclusive marker (edit にはない)
 *   - 数値スコア「名寄せスコア NN 点」: forrent サーバが score を埋めた状態
 *   - title が「新規物件登録」以外: edit ページの title が「新規物件登録」固定
 */
async function waitForConfirmReady(page, fallbackFrame, timeoutMs = 20000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const frame = page.frame({ name: "main" }) || fallbackFrame;
    try {
      const ready = await frame.evaluate(() => {
        // 訂正ボタン (#teisei) は確認画面の exclusive marker
        if (document.getElementById("teisei")) return true;
        // title に「確認」が含まれていれば確認画面 (例: 物件新規登録確認)
        // 注意: 「名寄せスコア NN 点」も edit 画面に出現するので signature に使わない
        // (一度確認画面へ送信後に teisei で戻った edit 画面は forrent が計算済 score を表示)
        if (/確認/.test(document.title || "")) return true;
        return false;
      });
      if (ready) return frame;
    } catch {
      // frame detached during navigation — retry
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  return page.frame({ name: "main" }) || fallbackFrame;
}

/**
 * 編集画面の signature (#regButton2 or #shijiIsize) を polling 待機。
 */
async function waitForEditReady(page, fallbackFrame, timeoutMs = 20000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const frame = page.frame({ name: "main" }) || fallbackFrame;
    try {
      const ready = await frame.evaluate(() => {
        return !!(
          document.getElementById("shijiIsize") ||
          document.getElementById("regButton2")
        );
      });
      if (ready) return frame;
    } catch {
      // frame detached during navigation — retry
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  return page.frame({ name: "main" }) || fallbackFrame;
}

/**
 * 登録完了画面の signature (「完了」「登録しました」テキスト or final score) を polling 待機。
 */
async function waitForFinalReady(page, fallbackFrame, timeoutMs = 20000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const frame = page.frame({ name: "main" }) || fallbackFrame;
    try {
      const ready = await frame.evaluate(() => {
        const body = document.body?.innerText || "";
        return /完了|登録しました|エラー/.test(body);
      });
      if (ready) return frame;
    } catch {
      // frame detached during navigation — retry
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  return page.frame({ name: "main" }) || fallbackFrame;
}

// ──────────────────────────────────────────────────────────────
// メイン: registerProperty
// ──────────────────────────────────────────────────────────────

/**
 * 物件登録 — 2 路線フロー:
 *
 *   Phase 1: 編集画面 → 確認画面 (バリデーション、最大 2 回試行)
 *
 *   Phase 2 (score 分岐):
 *     score >= threshold  ⇒ escalation 路線
 *       訂正 → 編集画面で shijiIsize=掲載 + スマピク掲載 + 店舗案内ピックアップ掲載 ON
 *       → 確認画面再到達 → エラーなければ登録 → registrationType:"掲載指示"
 *       (再バリデーションエラー時は error 返却、再戻りせず終了)
 *     score <  threshold  ⇒ 通常路線
 *       確認画面で 登録 → registrationType:"掲載保留"
 *
 * @param {object} page - Playwright Page
 * @param {object} mainFrame - main frame reference
 * @param {object} [opts] - options
 * @param {string} [opts.artifactDir] - 指定時、確認画面の HTML/PNG を保存
 * @returns {Promise<{
 *   saved: boolean,
 *   registrationType: "掲載指示"|"掲載保留"|null,
 *   score: number|null,
 *   escalated: boolean,
 *   threshold?: number,
 *   dialogs?: Array,
 *   errors?: Array<string>,
 *   errorRows?: Array,
 *   error?: string
 * }>}
 */
async function registerProperty(page, mainFrame, opts = {}) {
  const { artifactDir } = opts;
  const escalationCfg = getEscalationConfig();
  console.log("[forrent] === REGISTER PROPERTY START ===");
  try {
    const dialogs = [];
    let dialogPhase = "phase1";
    page.on("dialog", async (dialog) => {
      dialogs.push({ phase: dialogPhase, type: dialog.type(), message: dialog.message() });
      await dialog.accept();
    });

    // ── Phase 1: 編集画面 → 確認画面 (validation retry) ──
    const MAX_ATTEMPTS = 2;
    let confirmFrame = null;
    let validation = null;
    let validated = false;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      console.log(`[forrent] 確認画面へ 試行 ${attempt}/${MAX_ATTEMPTS}`);

      mainFrame = page.frame({ name: "main" }) || mainFrame;
      await mainFrame.evaluate(() => window.scrollTo(0, 0));
      await mainFrame.waitForTimeout(500);

      const clicked = await clickConfirmButton(mainFrame);
      if (!clicked) {
        console.log("[forrent] 確認画面へボタンが見つかりません");
        return { saved: false, registrationType: null, score: null, escalated: false, error: "確認画面へボタンが見つかりません" };
      }
      console.log(`[forrent] 確認画面へクリック: ${clicked}`);
      // 固定 sleep ではなく確認画面 signature の出現を polling 待機
      confirmFrame = await waitForConfirmReady(page, mainFrame, CONFIRM_READY_TIMEOUT_MS);
      validation = await scrapeValidation(confirmFrame);
      if (dialogs.length > 0) {
        console.log(`[forrent] ダイアログ: ${dialogs.map(d => d.message).join(", ")}`);
      }
      await saveFrameArtifacts(page, confirmFrame, artifactDir, `confirm-attempt${attempt}`);

      if (validation.hasError && attempt < MAX_ATTEMPTS) {
        console.log(`[forrent] バリデーションエラー (${validation.errors.length}件) → リトライ`);
        for (const e of validation.errors.slice(0, 8)) console.log(`[forrent]   - ${e}`);
        dialogs.length = 0;
        continue;
      }

      if (validation.hasError) {
        console.log(`[forrent] バリデーションエラー残存 (最終試行): ${validation.errors.slice(0, 8).join(" / ")}`);
        if (artifactDir) {
          try {
            fs.writeFileSync(
              path.join(artifactDir, "validation.json"),
              JSON.stringify(validation, null, 2)
            );
          } catch {}
        }
        return {
          saved: false,
          registrationType: null,
          score: validation.score,
          escalated: false,
          dialogs,
          errors: validation.errors,
          errorRows: validation.errorRows,
          error: `バリデーションエラー: ${validation.errors[0] || "詳細不明（artifactDir の validation.json を参照）"}`,
        };
      }
      validated = true;
      break;
    }

    if (!validated || !validation || !confirmFrame) {
      return { saved: false, registrationType: null, score: null, escalated: false, error: "確認画面到達失敗" };
    }

    // ── Phase 2: スコア分岐 ──
    const initialScore = validation.score;
    const escalate = shouldEscalate(initialScore, escalationCfg);
    console.log(`[forrent] 確認画面到達 (score: ${initialScore}, threshold: ${escalationCfg.threshold}, escalate: ${escalate})`);

    if (escalate) {
      // ── escalation 路線 ──
      console.log("[forrent] === ESCALATION PATH ===");
      dialogPhase = "escalate-teisei";

      const teiseiClicked = await clickTeiseiButton(confirmFrame);
      if (!teiseiClicked) {
        return { saved: false, registrationType: null, score: initialScore, escalated: true, threshold: escalationCfg.threshold, error: "訂正ボタンが見つかりません" };
      }
      console.log(`[forrent] 訂正クリック: ${teiseiClicked}`);
      // 編集画面 signature を polling 待機
      const editFrame = await waitForEditReady(page, confirmFrame, EDIT_READY_TIMEOUT_MS);
      await saveFrameArtifacts(page, editFrame, artifactDir, "edit-after-teisei");

      dialogPhase = "escalate-modify";
      const modifyResult = await modifyShijiAndCheckboxes(editFrame);
      if (!modifyResult.ok) {
        await saveFrameArtifacts(page, editFrame, artifactDir, "edit-modify-failed");
        return { saved: false, registrationType: null, score: initialScore, escalated: true, threshold: escalationCfg.threshold, error: modifyResult.error };
      }
      console.log(`[forrent] 掲載に変更 (shiji=${modifyResult.shijiValue}, sumapiku=${modifyResult.sumapikuChecked}, tenpiku=${modifyResult.tenpikuChecked})`);
      await editFrame.waitForTimeout(500);
      await saveFrameArtifacts(page, editFrame, artifactDir, "edit-after-modify");

      // 再確認: regButton2 を再クリック
      dialogPhase = "escalate-reconfirm";
      const reconfirmClicked = await clickConfirmButton(editFrame);
      if (!reconfirmClicked) {
        return { saved: false, registrationType: null, score: initialScore, escalated: true, threshold: escalationCfg.threshold, error: "再確認: 確認画面へボタンが見つかりません" };
      }
      console.log(`[forrent] 再確認クリック: ${reconfirmClicked}`);
      confirmFrame = await waitForConfirmReady(page, editFrame, CONFIRM_READY_TIMEOUT_MS);

      const revalidation = await scrapeValidation(confirmFrame);
      await saveFrameArtifacts(page, confirmFrame, artifactDir, "confirm-after-escalate");
      if (revalidation.hasError) {
        console.log(`[forrent] 再バリデーションエラー: ${revalidation.errors.slice(0, 8).join(" / ")}`);
        if (artifactDir) {
          try {
            fs.writeFileSync(
              path.join(artifactDir, "validation-after-escalate.json"),
              JSON.stringify(revalidation, null, 2)
            );
          } catch {}
        }
        return {
          saved: false,
          registrationType: null,
          score: revalidation.score || initialScore,
          escalated: true,
          threshold: escalationCfg.threshold,
          dialogs,
          errors: revalidation.errors,
          errorRows: revalidation.errorRows,
          error: `バリデーションエラー (再確認): ${revalidation.errors[0] || "詳細不明"}`,
        };
      }

      const escalateScore = revalidation.score || initialScore;
      console.log(`[forrent] 再確認画面到達 (score: ${escalateScore}) → 登録ボタン押下`);

      dialogPhase = "escalate-register";
      const regClicked = await clickRegistrationButton(confirmFrame);
      if (!regClicked) {
        return { saved: false, registrationType: null, score: escalateScore, escalated: true, threshold: escalationCfg.threshold, error: "確認画面の登録ボタンが見つかりません (escalation)" };
      }
      console.log(`[forrent] 登録ボタンクリック (escalated): ${regClicked}`);

      const finalFrame = await waitForFinalReady(page, confirmFrame, FINAL_READY_TIMEOUT_MS);
      const result = await readFinalState(finalFrame);
      const finalScore = result.score || escalateScore;
      console.log(`[forrent] === REGISTER END === 掲載指示判定 (score: ${finalScore}, complete: ${result.isComplete}, errorText: ${result.hasErrorText})`);
      await saveFrameArtifacts(page, finalFrame, artifactDir, "final-escalated");
      if (!result.isComplete) {
        const errMsg = result.hasErrorText
          ? `登録後にエラー画面検出 (escalation): ${(result.bodySnippet || "").slice(0, 400)}`
          : "登録完了マーカーが現れませんでした (escalation)";
        return {
          saved: false,
          registrationType: null,
          score: finalScore,
          escalated: true,
          threshold: escalationCfg.threshold,
          dialogs,
          errors: [errMsg],
          error: errMsg,
        };
      }
      return {
        saved: true,
        registrationType: "掲載指示",
        score: finalScore,
        escalated: true,
        threshold: escalationCfg.threshold,
        dialogs,
        errors: [],
      };
    }

    // ── 通常路線 (掲載保留) ──
    console.log(`[forrent] 確認画面到達 (score: ${initialScore}) → 登録ボタンを押下`);
    dialogPhase = "normal-register";
    const regClicked = await clickRegistrationButton(confirmFrame);
    if (!regClicked) {
      console.log("[forrent] 確認画面の登録ボタンが見つかりません");
      return {
        saved: false,
        registrationType: null,
        score: initialScore,
        escalated: false,
        threshold: escalationCfg.threshold,
        error: "確認画面の登録ボタンが見つかりません",
      };
    }
    console.log(`[forrent] 登録ボタンクリック: ${regClicked}`);

    const finalFrame = await waitForFinalReady(page, confirmFrame, FINAL_READY_TIMEOUT_MS);
    const result = await readFinalState(finalFrame);
    const finalScore = result.score || initialScore;
    console.log(`[forrent] === REGISTER END === 登録判定 (score: ${finalScore}, complete: ${result.isComplete}, errorText: ${result.hasErrorText})`);
    await saveFrameArtifacts(page, finalFrame, artifactDir, "final");
    if (!result.isComplete) {
      const errMsg = result.hasErrorText
        ? `登録後にエラー画面検出: ${(result.bodySnippet || "").slice(0, 400)}`
        : "登録完了マーカーが現れませんでした";
      return {
        saved: false,
        registrationType: null,
        score: finalScore,
        escalated: false,
        threshold: escalationCfg.threshold,
        dialogs,
        errors: [errMsg],
        error: errMsg,
      };
    }
    return {
      saved: true,
      registrationType: "掲載保留",
      score: finalScore,
      escalated: false,
      threshold: escalationCfg.threshold,
      dialogs,
      errors: [],
    };
  } catch (e) {
    console.log(`[forrent] 登録エラー: ${e.message}`);
    if (artifactDir) {
      try {
        const f = page.frame({ name: "main" });
        if (f) await saveFrameArtifacts(page, f, artifactDir, "exception");
      } catch {}
    }
    return { saved: false, registrationType: null, score: null, escalated: false, error: e.message };
  }
}

module.exports = {
  scrapeValidation,
  saveFrameArtifacts,
  registerProperty,
};
