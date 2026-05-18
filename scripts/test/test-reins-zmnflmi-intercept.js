#!/usr/bin/env node
/**
 * test-reins-zmnflmi-intercept.js — Phase ε T020
 *
 * Verifies that skills/reins.js#extractPropertyData() injects zmnFlmi from
 * the /BK/GBK003200/getInitData XHR response into the returned reinsData.
 *
 * Root cause being fixed (see .claude/do/findings/epsilon-T010-rootcause.md):
 *   The legacy extractor only parsed document.body.innerText via regex. The
 *   zmnFlmi (マイソク PDF filename) lives only inside the getInitData API
 *   JSON, never in DOM text — so reinsData.zmnFlmi was always undefined, and
 *   02b's isZmnFlmiPresent() check always skipped. This broke 622/622 runs.
 *
 * Coverage:
 *   - extractZmnFlmiFromInitData (pure JSON walker): 6 cases
 *       top-level / nested data / nested result / deep walk / null tree /
 *       empty-string-field-returns-empty
 *   - extractPropertyData (mock page integration): 6 cases
 *       happy path / response-null-timeout / response-without-zmnFlmi /
 *       JSON-parse-throws / waitForResponse-listener-installed-before-click /
 *       existing-30+-fields-intact
 *
 * Total: 12 cases. Mock Playwright page never spins up a real browser.
 */

const assert = require("assert");

const reins = require("../../skills/reins");
const { extractZmnFlmiFromInitData, extractPropertyData } = reins;

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

/**
 * Build a mock Playwright Page. We capture how waitForResponse is invoked so
 * tests can assert the filter regex and timeout are correct, and we let each
 * test control what waitForResponse resolves to (a fake response object,
 * null = timeout/error, or throwing).
 *
 * NOTE: ordering matters — production code calls page.waitForResponse(...)
 * BEFORE page.click(detail). If the test sees the click recorded before the
 * waitForResponse call, the regression we are fixing has come back.
 */
function mkMockPage(opts) {
  const calls = {
    waitForResponseArgs: [],
    clicked: [],
    evaluateCount: 0,
    // ordering: each operation appends a unique tag to this array
    order: [],
  };

  const page = {
    waitForResponse(predicate, predicateOpts) {
      calls.waitForResponseArgs.push({ predicate, predicateOpts });
      calls.order.push("waitForResponse");
      // Each call returns the SAME promise — we simulate Playwright's
      // single-use Promise returned by waitForResponse.
      if (opts.responseBehavior === "throw") {
        return Promise.reject(new Error("simulated waitForResponse rejection"));
      }
      if (opts.responseBehavior === "null") {
        // The production code chains .catch(() => null), so a Promise that
        // resolves to null simulates the post-catch state.
        return Promise.resolve(null);
      }
      // "fire" — resolve to a mock response object
      return Promise.resolve({
        url: () => opts.responseUrl || "https://system.reins.jp/main/BK/GBK003200/getInitData",
        status: () => 200,
        async json() {
          if (opts.jsonBehavior === "throw") {
            throw new Error("simulated JSON parse error");
          }
          return opts.jsonPayload;
        },
      });
    },
    async click(selector) {
      calls.clicked.push(selector);
      calls.order.push("click:" + selector);
      return;
    },
    async waitForTimeout(_ms) {
      calls.order.push("waitForTimeout");
      return;
    },
    async evaluate(_fn) {
      // The production extractor runs a single page.evaluate that returns the
      // result object (with regex-extracted fields). We return a fixed stub
      // representing "30+ fields successfully parsed" — the existing regex
      // behavior is exercised by other tests, here we only verify zmnFlmi
      // injection does not corrupt the merged object.
      calls.evaluateCount += 1;
      calls.order.push("evaluate");
      return opts.evaluateResult || {
        物件番号: "100139158281",
        建物名: "サンプルマンション",
        賃料: "10.5万円",
        交通: [],
      };
    },
  };
  return { page, calls };
}

(async function main() {
  // ──────────────────────────────────────────────────────────────────────
  // Pure helper: extractZmnFlmiFromInitData
  // ──────────────────────────────────────────────────────────────────────

  await check("(1) helper: top-level zmnFlmi is returned verbatim", () => {
    const r = extractZmnFlmiFromInitData({ zmnFlmi: "100139158281.pdf", other: "noise" });
    assert.strictEqual(r, "100139158281.pdf");
  });

  await check("(2) helper: nested data.zmnFlmi is reached via direct path", () => {
    const r = extractZmnFlmiFromInitData({ data: { zmnFlmi: "賃貸マイソク羽沢コート.pdf" } });
    assert.strictEqual(r, "賃貸マイソク羽沢コート.pdf");
  });

  await check("(3) helper: nested result.zmnFlmi is reached via direct path", () => {
    const r = extractZmnFlmiFromInitData({ result: { zmnFlmi: "20260512113532-0004.pdf" } });
    assert.strictEqual(r, "20260512113532-0004.pdf");
  });

  await check("(4) helper: deeply-buried zmnFlmi is found via tree walk", () => {
    const tree = { foo: { bar: { baz: { detail: { zmnFlmi: "deep.pdf" } } } } };
    const r = extractZmnFlmiFromInitData(tree);
    assert.strictEqual(r, "deep.pdf");
  });

  await check("(5) helper: null / non-object input returns empty string", () => {
    assert.strictEqual(extractZmnFlmiFromInitData(null), "");
    assert.strictEqual(extractZmnFlmiFromInitData(undefined), "");
    assert.strictEqual(extractZmnFlmiFromInitData("string-not-object"), "");
    assert.strictEqual(extractZmnFlmiFromInitData(42), "");
  });

  await check("(6) helper: zmnFlmi field absent returns empty string", () => {
    const r = extractZmnFlmiFromInitData({ otherField: "x", data: { unrelated: 1 } });
    assert.strictEqual(r, "");
  });

  // ──────────────────────────────────────────────────────────────────────
  // Integration: extractPropertyData with mock page
  // ──────────────────────────────────────────────────────────────────────

  await check("(7) happy path: response with zmnFlmi → data.zmnFlmi populated", async () => {
    const { page, calls } = mkMockPage({
      responseBehavior: "fire",
      jsonPayload: { zmnFlmi: "100139158281.pdf" },
    });
    const data = await extractPropertyData(page);
    assert.strictEqual(data.zmnFlmi, "100139158281.pdf",
      "zmnFlmi must be injected from API response");
    // existing 30+ fields preserved (mock returns 4 of them)
    assert.strictEqual(data.物件番号, "100139158281");
    assert.strictEqual(data.建物名, "サンプルマンション");
    assert.strictEqual(data.賃料, "10.5万円");
    assert.deepStrictEqual(data.交通, []);
    // ordering: waitForResponse MUST be called before click — this is the
    // regression we are guarding against.
    const wIdx = calls.order.indexOf("waitForResponse");
    const cIdx = calls.order.findIndex((s) => s.startsWith("click:"));
    assert.ok(wIdx >= 0 && cIdx >= 0,
      "both waitForResponse and click should have occurred");
    assert.ok(wIdx < cIdx,
      `waitForResponse (idx=${wIdx}) must be installed BEFORE click (idx=${cIdx}). ` +
      "If listener install happens after the click, the response is lost.");
  });

  await check("(8) null fallback: response Promise resolves null (timeout) → data.zmnFlmi=null", async () => {
    const { page } = mkMockPage({ responseBehavior: "null" });
    const data = await extractPropertyData(page);
    assert.strictEqual(data.zmnFlmi, null,
      "graceful fallback: null response → null zmnFlmi (02b will skip)");
    // existing fields still preserved
    assert.strictEqual(data.建物名, "サンプルマンション");
  });

  await check("(9) empty-string zmnFlmi in payload → data.zmnFlmi=null (treated as missing)", async () => {
    const { page } = mkMockPage({
      responseBehavior: "fire",
      jsonPayload: { zmnFlmi: "" },
    });
    const data = await extractPropertyData(page);
    assert.strictEqual(data.zmnFlmi, null,
      "empty-string zmnFlmi must collapse to null so 02b's isZmnFlmiPresent works");
  });

  await check("(10) payload lacking zmnFlmi → data.zmnFlmi=null", async () => {
    const { page } = mkMockPage({
      responseBehavior: "fire",
      jsonPayload: { otherField: "x" },
    });
    const data = await extractPropertyData(page);
    assert.strictEqual(data.zmnFlmi, null);
  });

  await check("(11) JSON parse throws → data.zmnFlmi=null (graceful)", async () => {
    const { page } = mkMockPage({
      responseBehavior: "fire",
      jsonBehavior: "throw",
    });
    const data = await extractPropertyData(page);
    assert.strictEqual(data.zmnFlmi, null,
      "JSON parse failure must not crash extractor; fall back to null");
    // existing fields still preserved
    assert.strictEqual(data.物件番号, "100139158281");
  });

  await check("(12) filter regex scopes to /BK/GBK003200/getInitData (not bare /getInitData)", async () => {
    const { page, calls } = mkMockPage({
      responseBehavior: "fire",
      jsonPayload: { zmnFlmi: "scoped.pdf" },
    });
    await extractPropertyData(page);
    assert.strictEqual(calls.waitForResponseArgs.length, 1,
      "exactly one waitForResponse listener should be installed");
    const { predicate, predicateOpts } = calls.waitForResponseArgs[0];
    // Verify the predicate is the scoped regex — must MATCH the full path
    // and must REJECT bare /getInitData (Phase α T001 bug regression guard).
    const goodResp = {
      url: () => "https://system.reins.jp/main/BK/GBK003200/getInitData",
      status: () => 200,
    };
    const dashboardResp = {
      url: () => "https://system.reins.jp/main/KG/GKG003100/getInitData",
      status: () => 200,
    };
    const wrongStatusResp = {
      url: () => "https://system.reins.jp/main/BK/GBK003200/getInitData",
      status: () => 500,
    };
    assert.strictEqual(predicate(goodResp), true,
      "predicate must match the scoped detail-page getInitData URL");
    assert.strictEqual(predicate(dashboardResp), false,
      "predicate must NOT match the dashboard-menu getInitData URL");
    assert.strictEqual(predicate(wrongStatusResp), false,
      "predicate must require status 200");
    // Timeout sanity: must be finite and at least a few seconds for slow REINS
    assert.ok(predicateOpts && typeof predicateOpts.timeout === "number" && predicateOpts.timeout >= 5000,
      "timeout must be >= 5000ms to tolerate slow REINS responses");
  });

  // ──────────────────────────────────────────────────────────────────────
  // Summary
  // ──────────────────────────────────────────────────────────────────────
  console.log("");
  console.log(`# tests: pass=${pass} fail=${fail}`);
  process.exit(fail === 0 ? 0 : 1);
})();
