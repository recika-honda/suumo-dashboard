/**
 * skills/forrent/register.js — forrent.jp 登録 (確認画面 → 登録ボタン → score 検証)
 *
 * 元: skills/forrent.js (Phase 7 分割前)
 *
 * Public surface:
 *   - scrapeValidation(frame)                          確認画面エラー収集
 *   - saveFrameArtifacts(page, frame, dir, tag)        確認画面 HTML+PNG 保存
 *   - registerProperty(page, mainFrame, opts)          確認 → 登録 → score 取得
 *
 * 内部関係: registerProperty が scrapeValidation と saveFrameArtifacts を順次呼ぶ。
 */

const fs = require("fs");
const path = require("path");

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

    // forrent のエラー一覧テーブル構造:
    //   <table>
    //     <tr>...|状況|区分|内容|当該箇所へ| ...</tr>  ← ヘッダ
    //     <tr><td>...</td><td>区分名(ex:桁数チェック)</td><td>実エラー文</td><td>リンク</td></tr>
    //     ...
    //   </table>
    // この構造の tbody 行からのみエラーを拾い、他の画面要素（"よろしければ登録ボタンをクリックしてください" 等）は拾わない。
    // forrent の実 DOM では err_table の構造が:
    //   <tbody>
    //     <tr class="headLineError"><td colspan="4">エラー 一覧</td></tr>          ← タイトル行
    //     <tr class="headLineErrorHead"><td>状況</td><td>区分</td><td>内容</td></tr> ← ヘッダ行 (2 行目)
    //     <tr class="headLineErrorLine" id="error"><td>...</td><td>区分名</td><td>エラー文</td><td>当該箇所へ</td></tr>
    //   </tbody>
    // よって "thead/tr:first-child" 検査では検出できない。id="err_table" 直マッチ + 全行スキャンで補強。
    const tables = [...document.querySelectorAll("table")];
    const errorRows = [];
    for (const tbl of tables) {
      let isErrorTable = tbl.id === "err_table";
      if (!isErrorTable) {
        const allText = clean(tbl.textContent || "");
        // 任意の行に 状況/区分/内容 が揃っていればエラーテーブルとみなす
        isErrorTable =
          /状況/.test(allText) && /区分/.test(allText) && /内容/.test(allText) &&
          (/エラー\s*一覧/.test(allText) || tbl.id === "err_table");
      }
      if (!isErrorTable) continue;
      const rows = [...tbl.querySelectorAll("tr")];
      for (const tr of rows) {
        // タイトル行 (colspan のみ) / ヘッダ行 (状況/区分/内容) は除外
        if (tr.classList.contains("headLineError")) continue;
        if (tr.classList.contains("headLineErrorHead")) continue;
        const cells = [...tr.querySelectorAll("td")].map((td) => clean(td.textContent));
        if (cells.length < 3) continue;
        const category = cells[cells.length - 3] || "";
        const content = cells[cells.length - 2] || "";
        if (!content || content.length < 2) continue;
        if (/^当該箇所へ$/.test(content)) continue;
        // 万が一クラスでフィルタ漏れた場合の保険: ヘッダ語そのものを除外
        if (content === "内容" || content === "区分") continue;
        errorRows.push({ category, content });
      }
    }

    // フォールバック: error クラス要素（エラーテーブルが壊れていた場合の保険）
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
    // hasError は「エラーテーブルに具体的な行がある」を真のシグナルとする。
    // 確認画面(正常時)にも "エラー 一覧" テーブルは存在するが行は空なので hasError=false。
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

/**
 * 物件登録 — 2ステップフロー:
 *   Step A: regButton2（確認画面へ）をクリック → バリデーション
 *   Step B: エラーなしなら確認画面上部の「登録」ボタンをクリック → 実登録
 *
 * エラーが出た場合はダイアログを受諾してリトライ（最大2回）
 *
 * @param {object} page - Playwright Page
 * @param {object} mainFrame - main frame reference
 * @param {object} [opts] - options
 * @param {string} [opts.artifactDir] - 指定時、確認画面の HTML/PNG を保存
 */
async function registerProperty(page, mainFrame, opts = {}) {
  const { artifactDir } = opts;
  console.log("[forrent] === REGISTER PROPERTY START ===");
  try {
    const dialogs = [];
    page.on("dialog", async (dialog) => {
      dialogs.push({ type: dialog.type(), message: dialog.message() });
      await dialog.accept();
    });

    const MAX_ATTEMPTS = 2;
    let lastValidation = null;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      console.log(`[forrent] 確認画面へ 試行 ${attempt}/${MAX_ATTEMPTS}`);

      // mainFrame を最新に再取得
      mainFrame = page.frame({ name: "main" }) || mainFrame;
      await mainFrame.evaluate(() => window.scrollTo(0, 0));
      await mainFrame.waitForTimeout(500);

      // ── Step A: 「確認画面へ」(regButton2) をクリック ──
      const clicked = await mainFrame.evaluate(() => {
        const btn = document.getElementById("regButton2");
        if (btn) { btn.click(); return btn.value || btn.alt || "regButton2"; }
        // Fallback: テキスト検索
        const buttons = [...document.querySelectorAll("input[type='button'], input[type='submit'], input[type='image'], button")];
        for (const b of buttons) {
          const t = (b.value || b.textContent || b.alt || "").trim();
          if ((t.includes("確認") || t.includes("登録")) && !t.includes("削除") && !t.includes("一時")) {
            b.click(); return t;
          }
        }
        return null;
      });

      if (!clicked) {
        console.log("[forrent] 確認画面へボタンが見つかりません");
        return { saved: false, registrationType: null, error: "確認画面へボタンが見つかりません" };
      }

      console.log(`[forrent] 確認画面へクリック: ${clicked}`);
      await mainFrame.waitForTimeout(10000);

      // 確認画面のフレームを再取得
      const confirmFrame = page.frame({ name: "main" }) || mainFrame;

      // バリデーション結果を詳細スクレイプ
      const validation = await scrapeValidation(confirmFrame);
      lastValidation = validation;

      if (dialogs.length > 0) {
        console.log(`[forrent] ダイアログ: ${dialogs.map(d => d.message).join(", ")}`);
      }

      // 確認画面スナップショットを保存（成否問わず）
      await saveFrameArtifacts(page, confirmFrame, artifactDir, `confirm-attempt${attempt}`);

      // エラーあり → リトライ
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
          dialogs,
          errors: validation.errors,
          errorRows: validation.errorRows,
          error: `バリデーションエラー: ${validation.errors[0] || "詳細不明（artifactDir の validation.json を参照）"}`,
        };
      }

      // ── Step B: 確認画面上部の「登録」ボタンをクリック ──
      console.log(`[forrent] 確認画面到達 (score: ${validation.score}) → 登録ボタンを押下`);

      const regClicked = await confirmFrame.evaluate(() => {
        // Search for the registration button at the top of the confirmation screen
        // Try common patterns: id, value, alt text, button text
        const candidates = [
          ...document.querySelectorAll("input[type='button'], input[type='submit'], input[type='image'], button"),
        ];
        for (const b of candidates) {
          const t = (b.value || b.textContent || b.alt || "").trim();
          // Match "登録" but exclude "確認画面へ", "一時", "削除", "戻る"
          if (t.includes("登録") && !t.includes("確認") && !t.includes("一時") && !t.includes("削除") && !t.includes("戻")) {
            b.click();
            return t;
          }
        }
        // Fallback: try image buttons with src containing "toroku" or "regist"
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

      if (!regClicked) {
        console.log("[forrent] 確認画面の登録ボタンが見つかりません");
        return {
          saved: false,
          registrationType: null,
          score: validation.score,
          error: "確認画面の登録ボタンが見つかりません",
        };
      }

      console.log(`[forrent] 登録ボタンクリック: ${regClicked}`);
      await confirmFrame.waitForTimeout(10000);

      // ── 登録完了確認 ──
      const finalFrame = page.frame({ name: "main" }) || confirmFrame;
      const result = await finalFrame.evaluate(() => {
        const body = document.body?.innerText || "";
        const scoreMatch = body.match(/名寄せスコア[：:\s]*(\d+)/);
        const isComplete = body.includes("完了") || body.includes("登録しました");
        return { isComplete, score: scoreMatch ? parseInt(scoreMatch[1]) : null, bodySnippet: body.slice(0, 200) };
      });

      const finalScore = result.score || validation.score;
      console.log(`[forrent] === REGISTER END === 登録完了 (score: ${finalScore}, complete: ${result.isComplete})`);
      await saveFrameArtifacts(page, finalFrame, artifactDir, "final");
      return {
        saved: true,
        registrationType: "掲載保留",
        score: finalScore,
        dialogs,
        errors: [],
      };
    }
  } catch (e) {
    console.log(`[forrent] 登録エラー: ${e.message}`);
    if (artifactDir) {
      try {
        const f = page.frame({ name: "main" });
        if (f) await saveFrameArtifacts(page, f, artifactDir, "exception");
      } catch {}
    }
    return { saved: false, registrationType: null, error: e.message };
  }
}

module.exports = {
  scrapeValidation,
  saveFrameArtifacts,
  registerProperty,
};
