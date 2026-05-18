#!/usr/bin/env node
/**
 * test-fill-tokucho-shrink.js — Phase β T004 consumer test
 *
 * Verifies that skills/forrent/fill-tokucho.js (post-shrink) is a thin
 * Playwright consumer:
 *
 *   (1) Pre-resolved checkedCodes → each code is .check()-ed on mainFrame
 *       via the documented selector (categoryTokuchoCd[value=<code>]).
 *   (2) Returns { checked, codes } whose codes echo the input checkedCodes.
 *   (3) Skips codes whose checkbox does not exist (locator.count === 0).
 *   (4) Skips codes whose checkbox is already checked (idempotency).
 *   (5) Inline-fallback path: when checkedCodes is omitted, delegates to
 *       resolveFeatureCodes() (SSOT) — does NOT re-implement the 3-path logic
 *       in fill-tokucho.js itself.
 *   (6) Empty checkedCodes → no-op without throwing.
 *   (7) Uses Playwright native API (frame.check), NOT evaluate(.checked = true).
 *
 * The test uses a hand-rolled mock Frame that records every locator() +
 * check() call so we can assert call order and selector shape.
 */

const assert = require("assert");
const path = require("path");
const fs = require("fs");

const { fillTokucho } = require("../../skills/forrent/fill-tokucho");
const { resolveFeatureCodes } = require("../../skills/feature-codes-resolve");

let pass = 0;
let fail = 0;
function check(label, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => {
      console.log(`ok ${label}`);
      pass++;
    })
    .catch((e) => {
      console.error(`FAIL ${label}: ${e.message}`);
      fail++;
    });
}

// ──────────────────────────────────────────────────────────
// Mock Frame: minimal Playwright Frame API surface.
// Records every locator() call and the resulting check()/count()/isChecked().
// existingCodes controls which checkboxes "exist" (count > 0).
// alreadyChecked controls which checkboxes return true from isChecked().
// ──────────────────────────────────────────────────────────
function makeMockFrame({ existingCodes = null, alreadyChecked = new Set() } = {}) {
  const calls = [];
  const checkedSelectors = [];

  const frame = {
    locator(selector) {
      calls.push({ method: "locator", selector });
      // Extract the code from the selector
      const m = selector.match(/value="(\d+)"/);
      const code = m ? m[1] : null;
      const exists = existingCodes === null || existingCodes.has(code);
      return {
        async count() {
          calls.push({ method: "count", selector });
          return exists ? 1 : 0;
        },
        async isChecked() {
          calls.push({ method: "isChecked", selector });
          return alreadyChecked.has(code);
        },
        async check(opts) {
          calls.push({ method: "check", selector, opts });
          checkedSelectors.push(selector);
        },
      };
    },
  };
  return { frame, calls, checkedSelectors };
}

(async function main() {
  // ──────────────────────────────────────────────────────────
  // (1) Pre-resolved path: every code .check()-ed via correct selector
  // ──────────────────────────────────────────────────────────
  await check("preresolved: checkedCodes → frame.check called once per code", async () => {
    const { frame, checkedSelectors } = makeMockFrame();
    const checkedCodes = ["0501", "1201", "2201"];
    const r = await fillTokucho(frame, {}, { checkedCodes });
    assert.strictEqual(r.checked, 3, `expected 3 checks, got ${r.checked}`);
    assert.strictEqual(r.codes.length, 3, "codes echo back");
    assert.deepStrictEqual([...r.codes].sort(), ["0501", "1201", "2201"]);
    // Selector shape — must include categoryTokuchoCd name + value
    for (const code of checkedCodes) {
      const sel = checkedSelectors.find((s) => s.includes(`value="${code}"`));
      assert.ok(sel, `no check call for code ${code}`);
      assert.ok(
        sel.includes("categoryTokuchoCd"),
        `selector must reference categoryTokuchoCd, got: ${sel}`
      );
      assert.ok(
        sel.includes('type="checkbox"'),
        `selector must constrain type=checkbox, got: ${sel}`
      );
    }
  });

  // ──────────────────────────────────────────────────────────
  // (2) checkedCodes count == frame.check call count (acceptance criterion)
  // ──────────────────────────────────────────────────────────
  await check("count parity: |checkedCodes| === |frame.check calls|", async () => {
    const { frame, calls } = makeMockFrame();
    const checkedCodes = ["0102", "0103", "0501", "1436", "2201", "2724"];
    await fillTokucho(frame, {}, { checkedCodes });
    const checkCalls = calls.filter((c) => c.method === "check");
    assert.strictEqual(
      checkCalls.length,
      checkedCodes.length,
      `expected ${checkedCodes.length} frame.check calls, got ${checkCalls.length}`
    );
  });

  // ──────────────────────────────────────────────────────────
  // (3) Missing checkbox → skipped (count === 0 → no check())
  // ──────────────────────────────────────────────────────────
  await check("missing checkbox: count=0 codes are skipped", async () => {
    const existingCodes = new Set(["0501", "2201"]); // 1201 absent
    const { frame, calls } = makeMockFrame({ existingCodes });
    const r = await fillTokucho(frame, {}, { checkedCodes: ["0501", "1201", "2201"] });
    assert.strictEqual(r.checked, 2);
    const checkCalls = calls.filter((c) => c.method === "check");
    assert.strictEqual(checkCalls.length, 2);
    assert.ok(!checkCalls.some((c) => c.selector.includes('value="1201"')));
  });

  // ──────────────────────────────────────────────────────────
  // (4) Already-checked → skipped (idempotency)
  // ──────────────────────────────────────────────────────────
  await check("idempotent: already-checked codes are not re-checked", async () => {
    const alreadyChecked = new Set(["0501"]);
    const { frame, calls } = makeMockFrame({ alreadyChecked });
    const r = await fillTokucho(frame, {}, { checkedCodes: ["0501", "1201"] });
    assert.strictEqual(r.checked, 1, "only 1201 should be newly checked");
    const checkCalls = calls.filter((c) => c.method === "check");
    assert.strictEqual(checkCalls.length, 1);
    assert.ok(checkCalls[0].selector.includes('value="1201"'));
  });

  // ──────────────────────────────────────────────────────────
  // (5) Inline-fallback: omitted checkedCodes → delegates to SSOT
  // ──────────────────────────────────────────────────────────
  await check("inline fallback: omitted checkedCodes → SSOT resolve, then check", async () => {
    const { frame, checkedSelectors } = makeMockFrame();
    const reinsData = {
      設備フリー: "オートロック",
      交通: [{ 沿線: "山手線", 徒歩: "5" }],
      地上階層: "5",
    };
    const r = await fillTokucho(frame, reinsData);
    // SSOT must have resolved at least the default codes + setsubi(オートロック=1201) + building(0501)
    assert.ok(r.checked > 0, "fallback should produce at least 1 check");
    assert.ok(
      checkedSelectors.some((s) => s.includes('value="1201"')),
      "fallback must include setsubi-matched code 1201 (オートロック)"
    );
    assert.ok(
      checkedSelectors.some((s) => s.includes('value="0501"')),
      "fallback must include building-inferred code 0501 (エレベーター, 5F)"
    );
    // SSOT consistency: results match resolveFeatureCodes directly
    const configPath = path.join(__dirname, "..", "..", "config", "forrent-feature-codes.json");
    const featureCodesConfig = JSON.parse(fs.readFileSync(configPath, "utf8"));
    const direct = resolveFeatureCodes({ reinsData, featureCodesConfig, maisokuText: null });
    assert.strictEqual(
      r.codes.length,
      direct.checkedCodes.length,
      "fallback codes count must equal SSOT direct call"
    );
  });

  // ──────────────────────────────────────────────────────────
  // (6) Empty checkedCodes: no-op
  // ──────────────────────────────────────────────────────────
  await check("empty: checkedCodes=[] → no-op, returns {checked:0, codes:[]}", async () => {
    const { frame, calls } = makeMockFrame();
    const r = await fillTokucho(frame, {}, { checkedCodes: [] });
    assert.strictEqual(r.checked, 0);
    assert.deepStrictEqual(r.codes, []);
    // No locator/check calls should happen
    assert.strictEqual(
      calls.filter((c) => c.method === "check").length,
      0,
      "no check calls expected on empty checkedCodes"
    );
  });

  // ──────────────────────────────────────────────────────────
  // (7) No evaluate(): the consumer must NOT use mainFrame.evaluate()
  //     (Playwright native API only, per CLAUDE.md <rules>).
  //     We assert this by NOT providing an evaluate method on the mock —
  //     any code path that reached .evaluate() would throw TypeError.
  // ──────────────────────────────────────────────────────────
  await check("native API only: mock without evaluate() is sufficient", async () => {
    const { frame } = makeMockFrame();
    // The mock frame has no .evaluate property at all. If fill-tokucho
    // tried to call mainFrame.evaluate(...), it would throw
    // "frame.evaluate is not a function". The very fact that the previous
    // tests pass proves the consumer never reached evaluate().
    assert.strictEqual(typeof frame.evaluate, "undefined");
    // Run a real call to confirm the contract still holds.
    const r = await fillTokucho(frame, {}, { checkedCodes: ["0501"] });
    assert.strictEqual(r.checked, 1);
  });

  // ──────────────────────────────────────────────────────────
  // (8) Evidence pass-through: when opts.evidence is supplied, the
  //     consumer logs per-code source (debug log only, not asserted on
  //     content — just verify no throw).
  // ──────────────────────────────────────────────────────────
  await check("evidence: evidence object is accepted without throwing", async () => {
    const { frame } = makeMockFrame();
    const checkedCodes = ["0501", "1201"];
    const evidence = {
      "0501": [{ source: "building", reason: "地上階層=5 ≥ 4F" }],
      "1201": [{ source: "setsubi", reason: "keyword 'オートロック' matched", matched: "オートロック" }],
    };
    const r = await fillTokucho(frame, {}, { checkedCodes, evidence });
    assert.strictEqual(r.checked, 2);
  });

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
})();
