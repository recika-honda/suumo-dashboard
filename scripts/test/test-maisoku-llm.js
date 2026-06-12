/**
 * Tests for skills/maisoku-llm.js (pure helpers + mocked client path) and
 * the Path E merge in skills/feature-codes-resolve.js.
 *
 * No Playwright, no real OpenAI: the client is replaced via
 * __setOpenAIFactoryForTests, and the resolver merge is exercised directly.
 */

const assert = require("assert");
const {
  buildMaisokuLlmPrompt,
  parseLlmCodes,
  resolveMaisokuCodesLlm,
  __setOpenAIFactoryForTests,
} = require("../../skills/maisoku-llm");
const { resolveFeatureCodes } = require("../../skills/feature-codes-resolve");

const CONFIG = {
  codes: [
    { code: "1507", label: "浴室乾燥機" },
    { code: "1603", label: "温水洗浄便座" },
    { code: "1414", label: "2口コンロ" },
    { code: "0517", label: "宅配ボックス" },
  ],
};

const tests = [];
function test(name, fn) {
  tests.push({ name, fn });
}

// ------------------------------------------------------------------
// buildMaisokuLlmPrompt
// ------------------------------------------------------------------
test("prompt contains every SSOT code+label line and the JSON instruction", () => {
  const p = buildMaisokuLlmPrompt(CONFIG);
  for (const c of CONFIG.codes) {
    assert.ok(p.includes(`${c.code} ${c.label}`), `missing line for ${c.code}`);
  }
  assert.ok(p.includes('"codes":'), "missing JSON output instruction");
});

test("prompt embeds maisoku text block when provided", () => {
  const p = buildMaisokuLlmPrompt(CONFIG, "設備: 浴室乾燥 オートロック");
  assert.ok(p.includes("機械抽出したテキスト"));
  assert.ok(p.includes("設備: 浴室乾燥 オートロック"));
  const without = buildMaisokuLlmPrompt(CONFIG, null);
  assert.ok(!without.includes("機械抽出したテキスト"));
});

test("prompt tolerates malformed config entries", () => {
  const p = buildMaisokuLlmPrompt({ codes: [{ code: "1507", label: "浴室乾燥機" }, null, { code: 42 }] });
  assert.ok(p.includes("1507 浴室乾燥機"));
});

// ------------------------------------------------------------------
// parseLlmCodes
// ------------------------------------------------------------------
test("parses valid object payload and keeps evidence", () => {
  const raw = '{"codes":[{"code":"1507","evidence":"設備欄に浴室乾燥"}]}';
  assert.deepStrictEqual(parseLlmCodes(raw, CONFIG), [
    { code: "1507", evidence: "設備欄に浴室乾燥" },
  ]);
});

test("parses payload wrapped in a markdown code fence", () => {
  const raw = '```json\n{"codes":[{"code":"1603","evidence":"洗浄便座"}]}\n```';
  assert.deepStrictEqual(parseLlmCodes(raw, CONFIG), [{ code: "1603", evidence: "洗浄便座" }]);
});

test("filters codes outside the SSOT allowlist", () => {
  const raw = '{"codes":[{"code":"9999","evidence":"x"},{"code":"1414","evidence":"2口"}]}';
  assert.deepStrictEqual(parseLlmCodes(raw, CONFIG), [{ code: "1414", evidence: "2口" }]);
});

test("dedupes repeated codes and accepts bare-string entries", () => {
  const raw = '{"codes":["1507","1507",{"code":"0517"}]}';
  assert.deepStrictEqual(parseLlmCodes(raw, CONFIG), [
    { code: "1507", evidence: "" },
    { code: "0517", evidence: "" },
  ]);
});

test("clamps over-long evidence to 120 chars", () => {
  const raw = JSON.stringify({ codes: [{ code: "1507", evidence: "あ".repeat(300) }] });
  const out = parseLlmCodes(raw, CONFIG);
  assert.strictEqual(out[0].evidence.length, 120);
});

test("returns null for malformed payloads", () => {
  assert.strictEqual(parseLlmCodes("not json at all", CONFIG), null);
  assert.strictEqual(parseLlmCodes('{"foo": 1}', CONFIG), null);
  assert.strictEqual(parseLlmCodes("", CONFIG), null);
  assert.strictEqual(parseLlmCodes(null, CONFIG), null);
});

test("returns null when the SSOT config is empty (cannot validate)", () => {
  assert.strictEqual(parseLlmCodes('{"codes":[{"code":"1507"}]}', { codes: [] }), null);
});

test("empty codes array parses to empty list (valid no-feature answer)", () => {
  assert.deepStrictEqual(parseLlmCodes('{"codes":[]}', CONFIG), []);
});

// ------------------------------------------------------------------
// resolveMaisokuCodesLlm (mocked client / no-pdf)
// ------------------------------------------------------------------
test("skips gracefully when pdf path is null or missing", async () => {
  const r1 = await resolveMaisokuCodesLlm({ maisokuPdfPath: null, featureCodesConfig: CONFIG });
  assert.strictEqual(r1.status, "skipped:no_pdf");
  assert.strictEqual(r1.codes, null);
  const r2 = await resolveMaisokuCodesLlm({
    maisokuPdfPath: "/nonexistent/maisoku.pdf",
    featureCodesConfig: CONFIG,
  });
  assert.strictEqual(r2.status, "skipped:no_pdf");
});

test("returns error (never throws) when the client call fails", async () => {
  __setOpenAIFactoryForTests(() => ({
    chat: { completions: { create: async () => { throw new Error("quota exceeded"); } } },
  }));
  // Use a real existing file so the rasteriser is the next step; pdftoppm
  // on a non-PDF fails first, which is also a fine never-throw exercise.
  const r = await resolveMaisokuCodesLlm({
    maisokuPdfPath: __filename,
    featureCodesConfig: CONFIG,
  });
  assert.strictEqual(r.status, "error");
  assert.strictEqual(r.codes, null);
  assert.ok(typeof r.error === "string" && r.error.length > 0);
  __setOpenAIFactoryForTests(null);
});

// ------------------------------------------------------------------
// resolveFeatureCodes Path E merge
// ------------------------------------------------------------------
const REINS_EMPTY = { setsubi: "" };

test("Path E: llm codes are merged with source maisoku-llm and SSOT-filtered", () => {
  const out = resolveFeatureCodes({
    reinsData: REINS_EMPTY,
    featureCodesConfig: CONFIG,
    maisokuText: null,
    maisokuLlmCodes: [
      { code: "1507", evidence: "設備欄に浴室乾燥" },
      { code: "9999", evidence: "out of ssot" },
    ],
  });
  assert.ok(out.checkedCodes.includes("1507"));
  assert.ok(!out.checkedCodes.includes("9999"));
  const ev = out.evidence["1507"].find((e) => e.source === "maisoku-llm");
  assert.ok(ev, "expected maisoku-llm evidence entry");
  assert.strictEqual(ev.evidence, "設備欄に浴室乾燥");
  assert.ok(out.source_files.some((f) => f.includes("maisoku-llm")));
});

test("Path E replaces Path D: keyword matching does not run when llm codes present", () => {
  // maisokuText contains 宅配ボックス which Path D would emit; with llm codes
  // present (even empty), Path D must be skipped.
  const out = resolveFeatureCodes({
    reinsData: REINS_EMPTY,
    featureCodesConfig: CONFIG,
    maisokuText: "設備: 宅配ボックス",
    maisokuLlmCodes: [],
  });
  assert.ok(!out.checkedCodes.includes("0517"), "Path D must not fire when llm array given");
});

test("fallback parity: llm=null leaves Path D behaviour unchanged", () => {
  const withNull = resolveFeatureCodes({
    reinsData: REINS_EMPTY,
    featureCodesConfig: CONFIG,
    maisokuText: "設備: 宅配ボックス",
    maisokuLlmCodes: null,
  });
  const withoutParam = resolveFeatureCodes({
    reinsData: REINS_EMPTY,
    featureCodesConfig: CONFIG,
    maisokuText: "設備: 宅配ボックス",
  });
  assert.deepStrictEqual(withNull.checkedCodes, withoutParam.checkedCodes);
  assert.ok(withNull.checkedCodes.includes("0517"), "Path D keyword hit expected");
});

// ------------------------------------------------------------------
// runner
// ------------------------------------------------------------------
(async () => {
  let failed = 0;
  for (const { name, fn } of tests) {
    try {
      await fn();
      console.log(`ok - ${name}`);
    } catch (e) {
      failed += 1;
      console.error(`FAIL - ${name}`);
      console.error(e && e.stack ? e.stack : e);
    }
  }
  console.log(`\n${tests.length - failed}/${tests.length} passed`);
  if (failed > 0) process.exit(1);
})();
