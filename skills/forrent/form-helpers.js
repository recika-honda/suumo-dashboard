/**
 * skills/forrent/form-helpers.js — forrent.jp フォーム入力の低レベルヘルパー
 *
 * 元: skills/forrent.js (Phase 7 分割前)
 *
 * Playwright Frame を第一引数に取り、selector + value を入力する小さな関数群。
 * fill-form / fill-transport / fill-images 等の高レベル fill 系から呼ばれる。
 *
 * 規約:
 *   - 第一引数 f は Playwright Frame (mainFrame)
 *   - 戻り値は boolean (成功/失敗) または void
 *   - 各操作は console.log で痕跡を残す (`[forrent] + label` / `[forrent] x label`)
 */

/** fill input/textarea by ID */
async function fillById(f, id, value, label) {
  if (!value && value !== 0) return false;
  try {
    await f.fill(`#${id}`, String(value));
    console.log(`[forrent] + ${label}: "${value}"`);
    await f.waitForTimeout(200);
    return true;
  } catch (e) {
    console.log(`[forrent] x ${label}: ${e.message.slice(0, 60)}`);
    return false;
  }
}

/** fill input by Struts name attribute (handles ${} escaping via evaluate) */
async function fillByName(f, name, value, label) {
  if (!value && value !== 0) return false;
  try {
    const ok = await f.evaluate(({ n, v }) => {
      const el = document.querySelector(`[name="${n}"]`);
      if (!el) return false;
      el.focus();
      el.value = v;
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
      el.blur();
      return true;
    }, { n: name, v: String(value) });
    console.log(`[forrent] ${ok ? "+" : "x"} ${label}: "${value}"`);
    return ok;
  } catch (e) {
    console.log(`[forrent] x ${label}: ${e.message.slice(0, 60)}`);
    return false;
  }
}

/** select option by value code, using Struts name attribute */
async function selectByName(f, name, code, label) {
  if (!code) return false;
  try {
    const ok = await f.evaluate(({ n, c }) => {
      const el = document.querySelector(`select[name="${n}"]`);
      if (!el) return false;
      const opt = Array.from(el.options).find(o => o.value === c);
      if (!opt) return false;
      el.value = c;
      el.dispatchEvent(new Event("change", { bubbles: true }));
      return true;
    }, { n: name, c: code });
    console.log(`[forrent] ${ok ? "+" : "x"} ${label}: code=${code}`);
    return ok;
  } catch (e) {
    console.log(`[forrent] x ${label}: ${e.message.slice(0, 60)}`);
    return false;
  }
}

/** select option by ID — tries value first, then label partial match */
async function selectById(f, id, text, label) {
  if (!text) return false;
  try {
    // 1. 完全一致（label）
    await f.selectOption(`#${id}`, { label: text });
    console.log(`[forrent] + ${label}: "${text}"`);
    await f.waitForTimeout(500);
    return true;
  } catch {
    // 2. 部分一致
    try {
      const val = await f.evaluate(({ elId, txt }) => {
        const el = document.getElementById(elId);
        if (!el) return null;
        const opts = Array.from(el.options);
        const m = opts.find(o => o.text.trim() === txt) ||
                  opts.find(o => o.text.includes(txt)) ||
                  opts.find(o => txt.includes(o.text.replace(/（.*）/, "").trim()));
        return m?.value ?? null;
      }, { elId: id, txt: text });
      if (val) {
        await f.selectOption(`#${id}`, val);
        console.log(`[forrent] + ${label}: "${text}" (partial match)`);
        await f.waitForTimeout(500);
        return true;
      }
    } catch {}
    console.log(`[forrent] x ${label}: "${text}" not found`);
    return false;
  }
}

/** set checkbox by ID */
async function setCheckbox(f, id, checked, label) {
  try {
    const current = await f.$eval(`#${id}`, el => el.checked);
    if (current !== checked) {
      await f.click(`#${id}`);
      console.log(`[forrent] + ${label}: ${checked ? "ON" : "OFF"}`);
      await f.waitForTimeout(200);
    }
    return true;
  } catch (e) {
    console.log(`[forrent] x ${label}: ${e.message.slice(0, 60)}`);
    return false;
  }
}

/**
 * Radio button をインデックス（0始まり）で選択する。
 * forrent.jp のradio value値は推測不可能なため、index指定が最も確実。
 */
async function selectRadioByIndex(f, fieldName, index) {
  return f.evaluate(({ fieldName, index }) => {
    const selector = `input[type="radio"][name="\${bukkenInputForm.${fieldName}}"]`;
    const radios = document.querySelectorAll(selector);
    if (radios.length > index) {
      radios[index].checked = true;
      radios[index].dispatchEvent(new Event("change", { bubbles: true }));
      return true;
    }
    return false;
  }, { fieldName, index });
}

/** wait for cascade select to populate (options > 1) */
async function waitForCascade(f, selectId, timeoutMs = 5000) {
  try {
    await f.waitForFunction(
      (id) => {
        const el = document.getElementById(id);
        return el && el.options.length > 1;
      },
      selectId,
      { timeout: timeoutMs }
    );
    return true;
  } catch {
    console.log(`[forrent] x cascade ${selectId}: timeout`);
    return false;
  }
}

module.exports = {
  fillById,
  fillByName,
  selectByName,
  selectById,
  setCheckbox,
  selectRadioByIndex,
  waitForCascade,
};
