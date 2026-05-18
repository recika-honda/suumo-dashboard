#!/usr/bin/env node
/**
 * test-feature-codes-resolve.js — Phase β T002 unit test (v2, bitwise parity)
 *
 * SSOT FILTER POLICY (kento decision 2026-05-16):
 *   The three legacy paths (setsubi / building / default) MUST be bitwise
 *   parity with skills/forrent/fill-tokucho.js — i.e. NO 150-SSOT filter.
 *   The 150-SSOT filter is reserved for the Phase γ-δ maisoku path only.
 *
 * This test verifies that skills/feature-codes-resolve.js:
 *   (1) For each of 5 fixtures, checkedCodes (3-path output, maisokuText=null)
 *       equals the legacy 3-path Set bit-for-bit. missing=[], extra=[].
 *       This means out-of-SSOT defaults like 2201 ARE present.
 *   (2) Emits evidence with source / reason / matched fields per design.
 *   (3) Conforms to the schema (checkedCodes: string[], evidence: object,
 *       generated_at: ISO string, source_files: string[]).
 *   (4) Does NOT apply the 150-SSOT filter to the 3 legacy paths
 *       (e.g. 2201 must appear in checkedCodes).
 *   (5) Accepts maisokuText=null without throwing (Phase γ-δ placeholder).
 *   (6) Reserves the 150-SSOT filter for the maisoku path: passing a
 *       non-empty maisokuText in Phase β remains a no-op (Phase γ-δ
 *       responsibility) — documented placeholder check.
 */

const assert = require("assert");
const path = require("path");
const fs = require("fs");

const { resolveFeatureCodes } = require("../../skills/feature-codes-resolve");
// After Phase β T004, the 3-path constants live in feature-codes-resolve.js
// (the SSOT). fill-tokucho.js no longer exports them — it became a thin
// Playwright consumer. Parity testing now compares the SSOT's pure-function
// output against a hand-coded replication of the legacy 3-path Set, so the
// parity contract is "feature-codes-resolve emits the legacy 3-path Set
// bit-for-bit, regardless of where the constants physically live."
const legacy = require("../../skills/feature-codes-resolve");
const { norm } = require("../../skills/forrent/fill-texts");

const PROJECT_ROOT = path.resolve(__dirname, "../..");
const CONFIG_PATH = path.join(PROJECT_ROOT, "config", "forrent-feature-codes.json");
const featureCodesConfig = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
const allowedCodes = new Set(featureCodesConfig.codes.map((c) => c.code));

let pass = 0;
let fail = 0;
function check(label, fn) {
  try {
    fn();
    console.log(`ok ${label}`);
    pass++;
  } catch (e) {
    console.error(`FAIL ${label}: ${e.message}`);
    fail++;
  }
}

// ──────────────────────────────────────────────────────────
// Helper: legacy 3-path Set replicating fillTokucho() steps 1-3.
// NO SSOT filter — that is the bitwise-parity target.
// This logic mirrors the inline behaviour of `fillTokucho()` in
// skills/forrent/fill-tokucho.js (steps 1-3, before the DOM write).
// ──────────────────────────────────────────────────────────
function legacyAllPaths(reinsData) {
  const textFields = [
    reinsData.設備フリー || "",
    reinsData.設備 || "",
    reinsData.条件フリー || "",
    reinsData.備考1 || "",
    reinsData.備考2 || "",
    reinsData.備考3 || "",
    reinsData.その他一時金 || "",
  ].map(norm);
  const codes = new Set();
  // Path A: setsubi keyword match
  for (const [keyword, mapped] of Object.entries(legacy.SETSUBI_TO_TOKUCHO)) {
    const normKey = norm(keyword);
    if (textFields.some((t) => t.includes(normKey))) {
      for (const c of mapped) codes.add(c);
    }
  }
  // Path B: building inference. In feature-codes-resolve.js the function
  // returns a Map<code, evidence>, so we iterate keys() to get the code Set.
  const inferred = legacy.inferTokuchoFromBuilding(reinsData);
  const inferredCodes = inferred instanceof Map ? [...inferred.keys()] : [...inferred];
  for (const c of inferredCodes) codes.add(c);
  // Path C: FANGO defaults (always-on, includes out-of-SSOT codes)
  for (const c of legacy.DEFAULT_TOKUCHO_CODES) codes.add(c);
  return codes;
}

// ──────────────────────────────────────────────────────────
// Fixtures: 5 cases covering each of the three paths and combinations.
// ──────────────────────────────────────────────────────────
const fixtures = [
  {
    name: "setsubi-keywords (オートロック / 宅配ボックス / バルコニー)",
    reinsData: {
      設備フリー: "オートロック、宅配ボックス、TVモニター付きインターホン、エアコン、フローリング、バルコニー",
      設備: "システムキッチン、追い焚き、温水洗浄便座",
      条件フリー: "",
      備考1: "",
      備考2: "",
      備考3: "",
      その他一時金: "",
      交通: [],
      地上階層: "",
      バルコニー方向: "",
      敷金: "",
      礼金: "",
      入居時期: "",
      築年月: "",
      駐車場在否: "",
    },
  },
  {
    name: "building-inference (5F / 2 lines / built 1 year ago / shikikin nashi)",
    reinsData: {
      設備フリー: "",
      設備: "",
      条件フリー: "",
      備考1: "",
      備考2: "",
      備考3: "",
      その他一時金: "",
      地上階層: "5",
      交通: [
        { 沿線: "山手線", 徒歩: "3" },
        { 沿線: "中央線", 徒歩: "8" },
      ],
      バルコニー方向: "南東",
      敷金: "なし",
      礼金: "なし",
      入居時期: "即",
      築年月: `${new Date().getFullYear() - 1}年6月`,
      駐車場在否: "有",
    },
  },
  {
    name: "empty (defaults-only — verifies out-of-SSOT 2201 is emitted)",
    reinsData: {
      設備フリー: "",
      設備: "",
      条件フリー: "",
      備考1: "",
      備考2: "",
      備考3: "",
      その他一時金: "",
      地上階層: "",
      交通: [],
      バルコニー方向: "",
      敷金: "",
      礼金: "",
      入居時期: "",
      築年月: "",
      駐車場在否: "",
    },
  },
  {
    name: "mixed-tower (designer + ocean view + 3 lines + parking)",
    reinsData: {
      設備フリー: "タワー、デザイナーズ、オーシャンビュー、ルーフバルコニー",
      設備: "システムキッチン、IH、食洗機、床暖房、浴室乾燥",
      条件フリー: "ペット相談、保証会社利用、リノベーション済",
      備考1: "",
      備考2: "",
      備考3: "",
      その他一時金: "",
      地上階層: "30",
      交通: [
        { 沿線: "山手線", 徒歩: "4" },
        { 沿線: "中央線", 徒歩: "6" },
        { 沿線: "東西線", 徒歩: "9" },
      ],
      バルコニー方向: "南",
      敷金: "1ヶ月",
      礼金: "なし",
      入居時期: "即",
      築年月: `${new Date().getFullYear() - 2}年4月`,
      駐車場在否: "空有",
    },
  },
  {
    name: "biko-only (keywords appear in 備考3 only)",
    reinsData: {
      設備フリー: "",
      設備: "",
      条件フリー: "",
      備考1: "",
      備考2: "",
      備考3: "フリーレント1ヶ月、保証人不要、DIY可、ペット可、リフォーム済",
      その他一時金: "",
      地上階層: "3",
      交通: [{ 沿線: "京王線", 徒歩: "12" }],
      バルコニー方向: "東",
      敷金: "2ヶ月",
      礼金: "1ヶ月",
      入居時期: "応相談",
      築年月: `${new Date().getFullYear() - 10}年1月`,
      駐車場在否: "無",
    },
  },
];

// ──────────────────────────────────────────────────────────
// (1) Bitwise parity: 5 fixtures × { missing:[], extra:[] }
//
// CONTRACT: For each fixture, the new module's checkedCodes (Set) MUST
// equal the legacy 3-path Set bit-for-bit. No SSOT filter is applied to
// either side. This guarantees fillTokucho() behaviour is preserved when
// Phase β migrates code-selection to the new module.
// ──────────────────────────────────────────────────────────
for (const fx of fixtures) {
  check(`bitwise-parity: ${fx.name}`, () => {
    const expected = legacyAllPaths(fx.reinsData);
    const actual = resolveFeatureCodes({
      reinsData: fx.reinsData,
      featureCodesConfig,
    });
    const actualSet = new Set(actual.checkedCodes);
    const missing = [...expected].filter((c) => !actualSet.has(c)).sort();
    const extra = [...actualSet].filter((c) => !expected.has(c)).sort();
    assert.deepStrictEqual(
      { missing, extra },
      { missing: [], extra: [] },
      `expected size=${expected.size}, got size=${actualSet.size}; missing=[${missing}], extra=[${extra}]`
    );
  });
}

// ──────────────────────────────────────────────────────────
// (2) Out-of-SSOT default code emission: 2201 (クロゼット) MUST appear.
//
// 2201 is a FANGO default but is not in the 150-SSOT. Phase β must still
// emit it (legacy parity); only the maisoku path is allowed to filter
// against the SSOT. This test is the inverse of attempt-1's
// "2201 is excluded" assertion — kento (B) judgement 2026-05-16.
// ──────────────────────────────────────────────────────────
check("default-emit: 2201 (out-of-SSOT FANGO default) is emitted via default path", () => {
  // Invariant: 2201 must NOT be in the SSOT, otherwise the test is meaningless.
  assert.strictEqual(allowedCodes.has("2201"), false, "fixture invariant: 2201 must be outside SSOT");
  const r = resolveFeatureCodes({ reinsData: { 交通: [] }, featureCodesConfig });
  assert.ok(
    r.checkedCodes.includes("2201"),
    `2201 missing from checkedCodes (legacy parity broken): ${r.checkedCodes}`
  );
  const defaultEv = r.evidence["2201"].find((e) => e.source === "default");
  assert.ok(defaultEv, `2201 must have source:'default' evidence: ${JSON.stringify(r.evidence["2201"])}`);
});

check("default-emit: all 6 legacy DEFAULT_TOKUCHO_CODES appear (including out-of-SSOT 2201)", () => {
  const r = resolveFeatureCodes({ reinsData: { 交通: [] }, featureCodesConfig });
  for (const code of legacy.DEFAULT_TOKUCHO_CODES) {
    assert.ok(r.checkedCodes.includes(code), `default code ${code} missing from checkedCodes`);
    const defaultEv = r.evidence[code].find((e) => e.source === "default");
    assert.ok(defaultEv, `${code} must have source:'default' evidence`);
  }
});

// ──────────────────────────────────────────────────────────
// (3) Evidence integrity per path
// ──────────────────────────────────────────────────────────
check("evidence: setsubi keyword → source:'setsubi' with matched keyword", () => {
  const result = resolveFeatureCodes({
    reinsData: { 設備フリー: "オートロック付", 交通: [] },
    featureCodesConfig,
  });
  assert.ok(result.checkedCodes.includes("1201"), `1201 missing from ${result.checkedCodes}`);
  const ev = result.evidence["1201"];
  assert.ok(Array.isArray(ev) && ev.length > 0, "evidence['1201'] should be a non-empty array");
  const setsubiEvidence = ev.find((e) => e.source === "setsubi");
  assert.ok(setsubiEvidence, `expected setsubi evidence for 1201, got ${JSON.stringify(ev)}`);
  assert.strictEqual(setsubiEvidence.matched, "オートロック");
});

check("evidence: building inference → source:'building' with reason", () => {
  const result = resolveFeatureCodes({
    reinsData: { 地上階層: "5", 交通: [] },
    featureCodesConfig,
  });
  assert.ok(result.checkedCodes.includes("0501"), `0501 missing from ${result.checkedCodes}`);
  const buildingEv = result.evidence["0501"].find((e) => e.source === "building");
  assert.ok(buildingEv, "expected building evidence for 0501");
  assert.ok(/地上階層/.test(buildingEv.reason));
});

// ──────────────────────────────────────────────────────────
// (4) Schema invariants
// ──────────────────────────────────────────────────────────
check("schema: checkedCodes is string[]", () => {
  const r = resolveFeatureCodes({ reinsData: { 交通: [] }, featureCodesConfig });
  assert.ok(Array.isArray(r.checkedCodes));
  for (const c of r.checkedCodes) assert.strictEqual(typeof c, "string");
});
check("schema: evidence is a plain object of arrays with valid source/reason", () => {
  const r = resolveFeatureCodes({ reinsData: { 交通: [] }, featureCodesConfig });
  assert.strictEqual(typeof r.evidence, "object");
  for (const [code, entries] of Object.entries(r.evidence)) {
    assert.ok(Array.isArray(entries), `evidence['${code}'] is not array`);
    for (const ent of entries) {
      assert.ok(
        ["setsubi", "building", "default", "maisoku"].includes(ent.source),
        `bad source: ${ent.source}`
      );
      assert.strictEqual(typeof ent.reason, "string");
    }
  }
});
check("schema: generated_at is ISO 8601", () => {
  const r = resolveFeatureCodes({ reinsData: { 交通: [] }, featureCodesConfig });
  assert.match(r.generated_at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
});
check("schema: source_files is string[]", () => {
  const r = resolveFeatureCodes({ reinsData: { 交通: [] }, featureCodesConfig });
  assert.ok(Array.isArray(r.source_files));
  for (const f of r.source_files) assert.strictEqual(typeof f, "string");
});

// ──────────────────────────────────────────────────────────
// (5) Maisoku-only SSOT filter (placeholder behaviour in Phase β)
//
// The 150-SSOT filter is reserved for the Phase γ-δ maisoku path. Phase β
// must NOT apply it to the 3 legacy paths. These tests pin that invariant.
// ──────────────────────────────────────────────────────────
check("maisoku-only-filter: legacy 3 paths emit codes outside the 150-SSOT (no filter applied)", () => {
  const r = resolveFeatureCodes({ reinsData: { 交通: [] }, featureCodesConfig });
  // Find any code that is in checkedCodes but NOT in the SSOT. There MUST be
  // at least one (2201 is the canonical example); otherwise the test fixture
  // would not exercise the no-filter invariant.
  const outOfSsot = r.checkedCodes.filter((c) => !allowedCodes.has(c));
  assert.ok(
    outOfSsot.length > 0,
    `expected at least one out-of-SSOT code in checkedCodes (legacy parity); got ${r.checkedCodes}`
  );
  assert.ok(
    outOfSsot.includes("2201"),
    `expected 2201 in out-of-SSOT set, got ${outOfSsot}`
  );
});

check("maisoku-only-filter: Phase β with maisokuText=null emits no source:'maisoku' evidence", () => {
  const r = resolveFeatureCodes({
    reinsData: { 交通: [] },
    featureCodesConfig,
    maisokuText: null,
  });
  for (const entries of Object.values(r.evidence)) {
    for (const ent of entries) {
      assert.notStrictEqual(ent.source, "maisoku", "Phase β must not emit maisoku evidence");
    }
  }
});

check("maisoku-only-filter: Phase δ T003 — non-empty maisokuText emits maisoku evidence under SSOT filter", () => {
  // Phase δ T003 contract (supersedes the Phase β placeholder pin at this
  // position): when maisokuText is non-empty, labels present in the 150-SSOT
  // and found in the text emit `source:"maisoku"` evidence. Codes outside the
  // SSOT (e.g. 2201 クロゼット) must never be sourced from the maisoku path,
  // even when their label string appears in the text — the SSOT filter is
  // the entire purpose of this path.
  const r = resolveFeatureCodes({
    reinsData: { 交通: [] },
    featureCodesConfig,
    maisokuText: "オートロック ペット相談 駐輪場 クロゼット",
  });
  // 1201 (オートロック) and 0816 (駐輪場) are in the SSOT → must have maisoku evidence
  const ev1201 = (r.evidence["1201"] || []).filter((e) => e.source === "maisoku");
  assert.ok(ev1201.length > 0, `1201 should have maisoku evidence, got ${JSON.stringify(r.evidence["1201"])}`);
  const ev0816 = (r.evidence["0816"] || []).filter((e) => e.source === "maisoku");
  assert.ok(ev0816.length > 0, `0816 should have maisoku evidence`);
  // 2201 (クロゼット) is OUT of SSOT — must NOT have maisoku evidence (default path only)
  const ev2201Maisoku = (r.evidence["2201"] || []).filter((e) => e.source === "maisoku");
  assert.strictEqual(ev2201Maisoku.length, 0, "2201 (out-of-SSOT) must not be sourced from maisoku path");
});

// ──────────────────────────────────────────────────────────
// (6) maisoku-null acceptance
// ──────────────────────────────────────────────────────────
check("maisoku-null: maisokuText=null does not throw", () => {
  const r = resolveFeatureCodes({ reinsData: { 交通: [] }, featureCodesConfig, maisokuText: null });
  assert.ok(Array.isArray(r.checkedCodes));
});
check("maisoku-null: omitted maisokuText argument also works", () => {
  const r = resolveFeatureCodes({ reinsData: { 交通: [] }, featureCodesConfig });
  assert.ok(Array.isArray(r.checkedCodes));
});

// ──────────────────────────────────────────────────────────
// (7) Input validation
// ──────────────────────────────────────────────────────────
check("input: missing reinsData throws", () => {
  assert.throws(() => resolveFeatureCodes({ featureCodesConfig }), /reinsData/);
});
check("input: missing featureCodesConfig throws", () => {
  assert.throws(() => resolveFeatureCodes({ reinsData: {} }), /featureCodesConfig/);
});

// ──────────────────────────────────────────────────────────
// (8) Purity: same input → same checkedCodes (generated_at varies)
// ──────────────────────────────────────────────────────────
check("purity: same reinsData yields same checkedCodes across calls", () => {
  const a = resolveFeatureCodes({ reinsData: fixtures[3].reinsData, featureCodesConfig });
  const b = resolveFeatureCodes({ reinsData: fixtures[3].reinsData, featureCodesConfig });
  assert.deepStrictEqual(a.checkedCodes, b.checkedCodes);
});

// ══════════════════════════════════════════════════════════
// Phase δ T003 — Maisoku route (positive emission + negation + parity)
//
// New cases added 2026-05-16. Existing fixtures and parity assertions
// are unchanged. These cases verify:
//   - positive label match → checkedCode + maisoku evidence with snippet
//   - negation filter (T002) suppresses post-keyword "不可" / "なし" / "別途"
//   - parity preserved when maisokuText is null / empty / whitespace
//   - SSOT filter prevents out-of-SSOT codes from the maisoku path
//   - short labels (BS / CS / LAN) require word boundary (no false positive
//     inside Latin words)
//   - multi-token labels matched as single substring after norm()
//   - multiple label matches accumulate; duplicate codes get multi-source evidence
//   - full-width / half-width mixing is normalised by norm()
//   - snippet field is present on maisoku evidence and contains the matched label
// ══════════════════════════════════════════════════════════

check("delta T003: positive match — 'オートロック' in maisoku → 1201 with maisoku evidence + snippet", () => {
  const r = resolveFeatureCodes({
    reinsData: { 交通: [] },
    featureCodesConfig,
    maisokuText: "セキュリティ充実 オートロック完備 防犯カメラ24時間稼働",
  });
  assert.ok(r.checkedCodes.includes("1201"), "1201 (オートロック) must be in checkedCodes");
  const maisokuEv = (r.evidence["1201"] || []).find((e) => e.source === "maisoku");
  assert.ok(maisokuEv, "1201 must have source:'maisoku' evidence");
  assert.strictEqual(maisokuEv.matched, "オートロック", `matched should be the label; got ${maisokuEv.matched}`);
  assert.ok(maisokuEv.snippet && maisokuEv.snippet.includes("オートロック"), `snippet must include matched label; got ${maisokuEv.snippet}`);
});

check("delta T003: negation 'ペット不可' suppresses 2705 (ペット相談)", () => {
  const r = resolveFeatureCodes({
    reinsData: { 交通: [] },
    featureCodesConfig,
    maisokuText: "本物件はペット不可です。楽器演奏も不可。",
  });
  // 2705 must NOT have maisoku evidence (negated); other paths may still emit it
  const ev2705 = (r.evidence["2705"] || []).filter((e) => e.source === "maisoku");
  assert.strictEqual(ev2705.length, 0, `2705 should be suppressed by '不可', got ${JSON.stringify(r.evidence["2705"])}`);
});

check("delta T003: negation '別途契約' suppresses LAN (2413)", () => {
  // Per finding-02-pdf-text-layer.md: "フレッツ光ネクスト利用可能（別途契約、費用）"
  const r = resolveFeatureCodes({
    reinsData: { 交通: [] },
    featureCodesConfig,
    maisokuText: "通信回線について。LANは別途契約、費用が掛かります。",
  });
  const ev2413 = (r.evidence["2413"] || []).filter((e) => e.source === "maisoku");
  assert.strictEqual(ev2413.length, 0, `2413 (LAN) should be suppressed by '別途', got ${JSON.stringify(r.evidence["2413"])}`);
});

check("delta T003: parity — maisokuText=null produces identical checkedCodes to omitted arg", () => {
  const reins = fixtures[3].reinsData; // mixed-tower, exercises all 3 legacy paths
  const a = resolveFeatureCodes({ reinsData: reins, featureCodesConfig, maisokuText: null });
  const b = resolveFeatureCodes({ reinsData: reins, featureCodesConfig });
  assert.deepStrictEqual(a.checkedCodes, b.checkedCodes, "null vs omitted must yield identical checkedCodes");
});

check("delta T003: parity — empty string and whitespace-only maisokuText emit no maisoku evidence", () => {
  for (const txt of ["", "   ", "\n\t  \n"]) {
    const r = resolveFeatureCodes({
      reinsData: { 交通: [] },
      featureCodesConfig,
      maisokuText: txt,
    });
    for (const entries of Object.values(r.evidence)) {
      for (const ent of entries) {
        assert.notStrictEqual(ent.source, "maisoku", `maisokuText=${JSON.stringify(txt)} must not emit maisoku evidence`);
      }
    }
  }
});

check("delta T003: SSOT filter — label outside the 150-SSOT cannot be sourced from maisoku", () => {
  // クロゼット (2201) is OUT of the 150-SSOT (verified by the SETSUBI_TO_TOKUCHO
  // dictionary mapping it as a default), so even if the literal string appears
  // verbatim in maisoku text, the maisoku path must not emit it.
  assert.strictEqual(allowedCodes.has("2201"), false, "fixture invariant: 2201 must be outside SSOT");
  const r = resolveFeatureCodes({
    reinsData: { 交通: [] },
    featureCodesConfig,
    maisokuText: "全居室クロゼット完備、収納豊富です。",
  });
  // 2201 still appears (from default path), but must have NO maisoku evidence
  assert.ok(r.checkedCodes.includes("2201"), "2201 still present via default path");
  const ev2201Maisoku = (r.evidence["2201"] || []).filter((e) => e.source === "maisoku");
  assert.strictEqual(ev2201Maisoku.length, 0, "2201 must never have maisoku evidence (SSOT filter)");
});

check("delta T003: multiple label matches accumulate (オートロック + 駐輪場 + 宅配ボックス)", () => {
  const r = resolveFeatureCodes({
    reinsData: { 交通: [] },
    featureCodesConfig,
    maisokuText: "オートロック、駐輪場あり、宅配ボックス24時間利用可能",
  });
  for (const code of ["1201", "0816", "0517"]) {
    assert.ok(r.checkedCodes.includes(code), `${code} should be in checkedCodes`);
    const maisokuEv = (r.evidence[code] || []).find((e) => e.source === "maisoku");
    assert.ok(maisokuEv, `${code} must have maisoku evidence`);
  }
});

check("delta T003: same code from setsubi + maisoku → both sources in evidence array", () => {
  const r = resolveFeatureCodes({
    reinsData: { 設備フリー: "オートロック付", 交通: [] },
    featureCodesConfig,
    maisokuText: "オートロック完備の安心物件です。",
  });
  assert.ok(r.checkedCodes.includes("1201"));
  const sources = (r.evidence["1201"] || []).map((e) => e.source);
  assert.ok(sources.includes("setsubi"), `expected setsubi source, got ${sources}`);
  assert.ok(sources.includes("maisoku"), `expected maisoku source, got ${sources}`);
});

check("delta T003: short label 'BS' (2402) has boundary anchoring — false positive avoided", () => {
  // "ABStract" / "subSTANCE" / arbitrary Latin text must NOT trigger BS (2402).
  // Note: 2402 is in the SSOT (label "BS").
  if (!allowedCodes.has("2402")) {
    // If SSOT shape changes, skip rather than fail.
    return;
  }
  const r = resolveFeatureCodes({
    reinsData: { 交通: [] },
    featureCodesConfig,
    maisokuText: "ABStract design notes — subSTANCE only — no broadcast satellite mentioned.",
  });
  const ev2402 = (r.evidence["2402"] || []).filter((e) => e.source === "maisoku");
  assert.strictEqual(ev2402.length, 0, `BS (2402) must NOT match inside Latin words; got ${JSON.stringify(r.evidence["2402"])}`);
});

check("delta T003: short label 'BS' (2402) DOES match when surrounded by Japanese context", () => {
  if (!allowedCodes.has("2402")) return;
  const r = resolveFeatureCodes({
    reinsData: { 交通: [] },
    featureCodesConfig,
    maisokuText: "テレビ視聴環境: BS視聴可能 (アンテナ設置済)。",
  });
  const ev2402 = (r.evidence["2402"] || []).filter((e) => e.source === "maisoku");
  assert.strictEqual(ev2402.length, 1, `BS (2402) should match when bounded by CJK; got ${JSON.stringify(r.evidence["2402"])}`);
});

check("delta T003: full-width / half-width width-fold via norm() — half-width digits in label area still match", () => {
  // norm() folds full-width Ａ-Ｚ／ａ-ｚ／０-９ to half-width. We exercise the
  // path where the SOURCE text uses full-width "ＬＡＮ" — both label and text
  // are normalised by norm() so the match succeeds despite the visual difference.
  if (!allowedCodes.has("2413")) return;
  const r = resolveFeatureCodes({
    reinsData: { 交通: [] },
    featureCodesConfig,
    maisokuText: "通信: ＬＡＮ配線済 (全室)",
  });
  const ev2413 = (r.evidence["2413"] || []).filter((e) => e.source === "maisoku");
  assert.strictEqual(ev2413.length, 1, `LAN (2413) should match full-width ＬＡＮ via norm(); got ${JSON.stringify(r.evidence["2413"])}`);
});

check("delta T003: multi-token label 'IT重説 対応物件' (2737) matched as single substring", () => {
  if (!allowedCodes.has("2737")) return;
  const r = resolveFeatureCodes({
    reinsData: { 交通: [] },
    featureCodesConfig,
    maisokuText: "オンライン対応: IT重説 対応物件 / 内見後すぐ契約可能",
  });
  const ev2737 = (r.evidence["2737"] || []).filter((e) => e.source === "maisoku");
  assert.strictEqual(ev2737.length, 1, `2737 should match the multi-token label; got ${JSON.stringify(r.evidence["2737"])}`);
});

check("delta T003: source_files includes 02c output path only when maisoku route fires", () => {
  // No maisoku → only the config file
  const r1 = resolveFeatureCodes({ reinsData: { 交通: [] }, featureCodesConfig });
  assert.deepStrictEqual(r1.source_files, ["config/forrent-feature-codes.json"]);
  // Empty maisoku → still only the config file
  const r2 = resolveFeatureCodes({ reinsData: { 交通: [] }, featureCodesConfig, maisokuText: "" });
  assert.deepStrictEqual(r2.source_files, ["config/forrent-feature-codes.json"]);
  // Non-empty maisoku that matches at least one label → 02c output path appended
  const r3 = resolveFeatureCodes({
    reinsData: { 交通: [] },
    featureCodesConfig,
    maisokuText: "オートロック完備",
  });
  assert.ok(r3.source_files.includes("02c-maisoku-text-extract/output.json"), `expected 02c path, got ${JSON.stringify(r3.source_files)}`);
  // Non-empty maisoku that matches nothing → no 02c path
  const r4 = resolveFeatureCodes({
    reinsData: { 交通: [] },
    featureCodesConfig,
    maisokuText: "本物件の所在地は xxxxx です。最寄駅から徒歩 5 分。", // intentionally avoids SSOT labels
  });
  // Confirm no SSOT label was hit
  const hasMaisoku = Object.values(r4.evidence).some((arr) => arr.some((e) => e.source === "maisoku"));
  assert.strictEqual(hasMaisoku, false, `fixture invariant: maisoku text must not match any SSOT label`);
  assert.deepStrictEqual(r4.source_files, ["config/forrent-feature-codes.json"]);
});

check("delta T003: snippet field absent on non-maisoku evidence (backward compatible)", () => {
  const r = resolveFeatureCodes({
    reinsData: { 設備フリー: "オートロック付", 地上階層: "5", 交通: [] },
    featureCodesConfig,
  });
  // setsubi / building / default evidence must NOT carry snippet
  for (const [, entries] of Object.entries(r.evidence)) {
    for (const ent of entries) {
      if (ent.source !== "maisoku") {
        assert.strictEqual(ent.snippet, undefined, `non-maisoku evidence must not carry snippet; got ${JSON.stringify(ent)}`);
      }
    }
  }
});

// ──────────────────────────────────────────────────────────
console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
