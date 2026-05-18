#!/usr/bin/env node
"use strict";

/**
 * test-dom-match.js — Phase ε T004 unit + integration tests
 *
 * Tests the 5 pure functions + 2 helpers in scripts/measure/lib-dom-match.js.
 * Also runs 1 integration test against a mock run-dir structure.
 *
 * Coverage:
 *   (1) extractCheckedCodesFromDOM — 7 cases
 *   (2) classifyMatch              — 7 cases
 *   (3) extractEvidenceBySource    — 7 cases (includes multi-source T021 code)
 *   (4) detectNegationContextCandidates — 12 cases (7 negation patterns × 1 each
 *       + boundary + affirmative + empty + Fixture A/B/C boundary variants)
 *   (5) assessNegationFP           — 8 cases (Fixture A / Fixture B / Fixture C +
 *       base cases: empty emitted / empty dom fallback / empty cand / null inputs)
 *   (6) buildCodeLabelMaps helper  — 4 cases
 *   (7) Integration test           — 1 case (CLI child process on mock-run-dir)
 *
 * Spec references:
 *   code/suumo-dashboard/docs/refactor/phase-epsilon-design.md §2-4, §8-9
 *   .claude/do/findings/epsilon-T003-implementation.md §5 (Fixture A/B/C)
 *
 * Fixture A: "駐輪場無料♪" + 0816 emitted + DOM checked → FP=1 (alarm fires)
 * Fixture B: "駐輪場無料♪" + 0816 NOT emitted           → FP=0 (resolver held line)
 * Fixture C: "バイク置場無し" + 0207 emitted + DOM checked → FP=1 (clear negation)
 *
 * T003 本体 (lib-dom-match.js / measure-phase-delta-dom-match.js) は無編集。
 */

const assert = require("assert");
const path = require("path");
const { execSync } = require("child_process");
const fs = require("fs");

const PROJECT_ROOT = path.resolve(__dirname, "..", "..");
const FIXTURE_DIR = path.resolve(__dirname, "fixtures", "dom-match");
const MOCK_RUN_DIR = path.join(FIXTURE_DIR, "mock-run-dir");

const lib = require(path.resolve(PROJECT_ROOT, "scripts", "measure", "lib-dom-match.js"));

const {
  extractCheckedCodesFromDOM,
  classifyMatch,
  extractEvidenceBySource,
  detectNegationContextCandidates,
  assessNegationFP,
  buildCodeLabelMaps,
  NEGATION_PATTERNS,
} = lib;

// ── Test harness ─────────────────────────────────────────────────────────────

let pass = 0;
let fail = 0;

function check(label, fn) {
  try {
    fn();
    console.log(`ok  ${label}`);
    pass++;
  } catch (e) {
    console.error(`FAIL ${label}`);
    console.error(`     ${e.message}`);
    fail++;
  }
}

// ── Fixture helpers ───────────────────────────────────────────────────────────

function loadFixture(name) {
  return fs.readFileSync(path.join(FIXTURE_DIR, name), "utf8");
}

// Build the mini label dictionary from our fixture edit HTML.
const editHtml = loadFixture("edit-after-teisei-mini.html");
const { labelToCodes, codeToLabel } = buildCodeLabelMaps(editHtml);

// Mini SSOT: subset of real forrent-feature-codes.json for negation tests.
// Uses Map<code,label> form accepted by normaliseSsotIter.
const MINI_SSOT_MAP = new Map([
  ["0816", "駐輪場"],
  ["0207", "バイク置場"],
  ["1201", "オートロック"],
  ["0517", "宅配ボックス"],
  ["0305", "最上階"],
  ["1211", "防犯カメラ"],
]);

// Array<{code,label}> form (mirrors forrent-feature-codes.json#codes).
const MINI_SSOT_ARR = [
  { code: "0816", label: "駐輪場" },
  { code: "0207", label: "バイク置場" },
  { code: "1201", label: "オートロック" },
  { code: "0517", label: "宅配ボックス" },
  { code: "0305", label: "最上階" },
  { code: "1211", label: "防犯カメラ" },
];

// ── (1) extractCheckedCodesFromDOM ────────────────────────────────────────────

console.log("\n## (1) extractCheckedCodesFromDOM");

check("happy path: 3 known labels → 3 codes extracted", () => {
  const html = loadFixture("confirm-mini.html");
  const { codes, labels, unknownLabels } = extractCheckedCodesFromDOM(html, labelToCodes);
  assert.strictEqual(codes.size, 3, `expected 3 codes, got ${codes.size}: [${[...codes].join(",")}]`);
  assert.ok(codes.has("1201"), "1201 (オートロック) expected");
  assert.ok(codes.has("0517"), "0517 (宅配ボックス) expected");
  assert.ok(codes.has("0305"), "0305 (最上階) expected");
  assert.deepStrictEqual(unknownLabels, []);
});

check("empty string → empty Set, no throw", () => {
  const { codes, labels, unknownLabels } = extractCheckedCodesFromDOM("", labelToCodes);
  assert.strictEqual(codes.size, 0);
  assert.deepStrictEqual(labels, []);
  assert.deepStrictEqual(unknownLabels, []);
});

check("null → empty Set, no throw", () => {
  const { codes } = extractCheckedCodesFromDOM(null, labelToCodes);
  assert.strictEqual(codes.size, 0);
});

check("id=tokucho absent → empty Set", () => {
  const html = "<html><body><p>no tokucho here</p></body></html>";
  const { codes } = extractCheckedCodesFromDOM(html, labelToCodes);
  assert.strictEqual(codes.size, 0);
});

check("empty 特徴項目 cell → empty Set", () => {
  const html = `<div id="tokucho">
    <td class="itemName">特徴項目</td>
    <td class="inputItem"></td>
  </div>`;
  const { codes } = extractCheckedCodesFromDOM(html, labelToCodes);
  assert.strictEqual(codes.size, 0);
});

check("unknown label → recorded in unknownLabels, other labels still parsed", () => {
  const html = `<div id="tokucho">
    <table>
      <tr>
        <td class="itemName">特徴項目</td>
        <td class="inputItem">オートロック/存在しないラベル</td>
      </tr>
    </table>
  </div>`;
  const { codes, unknownLabels } = extractCheckedCodesFromDOM(html, labelToCodes);
  assert.ok(codes.has("1201"), "known label (オートロック) must still be resolved");
  assert.ok(unknownLabels.includes("存在しないラベル"), "unknown label must be recorded");
});

check("duplicate label (labelToCodes has 2 codes for same label) → both codes added", () => {
  // edit-after-teisei-mini.html has L9991 and L9992 both labeled "テスト重複ラベル"
  const html = `<div id="tokucho">
    <table>
      <tr>
        <td class="itemName">特徴項目</td>
        <td class="inputItem">テスト重複ラベル</td>
      </tr>
    </table>
  </div>`;
  const { codes } = extractCheckedCodesFromDOM(html, labelToCodes);
  assert.ok(codes.has("9991"), "9991 expected");
  assert.ok(codes.has("9992"), "9992 expected");
  assert.strictEqual(codes.size, 2);
});

// ── (2) classifyMatch ─────────────────────────────────────────────────────────

console.log("\n## (2) classifyMatch");

check("exact: intent === dom → exact=[a,b], missed=[], phantom=[]", () => {
  const r = classifyMatch(new Set(["1201", "0517"]), new Set(["1201", "0517"]));
  assert.deepStrictEqual(r.exact.sort(), ["0517", "1201"]);
  assert.deepStrictEqual(r.missed, []);
  assert.deepStrictEqual(r.phantom, []);
  assert.strictEqual(r.exact_rate, 1.0);
  assert.strictEqual(r.miss_rate, 0.0);
  assert.strictEqual(r.phantom_rate, 0.0);
});

check("missed: dom has code not in intent → missed=[code]", () => {
  const r = classifyMatch(new Set(["1201"]), new Set(["1201", "0517"]));
  assert.deepStrictEqual(r.missed, ["0517"]);
  assert.deepStrictEqual(r.phantom, []);
  assert.strictEqual(r.exact_rate, 0.5);
  assert.strictEqual(r.miss_rate, 0.5);
});

check("phantom: intent has code not in dom → phantom=[code]", () => {
  const r = classifyMatch(new Set(["1201", "9999"]), new Set(["1201"]));
  assert.deepStrictEqual(r.phantom, ["9999"]);
  assert.deepStrictEqual(r.missed, []);
  assert.strictEqual(r.phantom_rate, 0.5);
});

check("both empty → rates null (no signal)", () => {
  const r = classifyMatch(new Set(), new Set());
  assert.strictEqual(r.exact_rate, null);
  assert.strictEqual(r.miss_rate, null);
  assert.strictEqual(r.phantom_rate, null);
});

check("empty intent, non-empty dom → exact_rate=0, miss_rate=1, phantom_rate=null", () => {
  const r = classifyMatch(new Set(), new Set(["0305"]));
  assert.strictEqual(r.exact_rate, 0);
  assert.strictEqual(r.miss_rate, 1.0);
  assert.strictEqual(r.phantom_rate, null);
});

check("non-empty intent, empty dom → exact_rate=null, miss_rate=null, phantom_rate=1", () => {
  const r = classifyMatch(new Set(["0305"]), new Set());
  assert.strictEqual(r.exact_rate, null);
  assert.strictEqual(r.miss_rate, null);
  assert.strictEqual(r.phantom_rate, 1.0);
});

check("arrays accepted as input (tolerant API)", () => {
  const r = classifyMatch(["1201", "0517"], ["1201"]);
  assert.deepStrictEqual(r.phantom, ["0517"]);
  assert.deepStrictEqual(r.missed, []);
});

// ── (3) extractEvidenceBySource ───────────────────────────────────────────────

console.log("\n## (3) extractEvidenceBySource");

check("empty evidenceMap → all arrays empty, net_gain=0", () => {
  const r = extractEvidenceBySource({});
  assert.deepStrictEqual(r.setsubi, []);
  assert.deepStrictEqual(r.building, []);
  assert.deepStrictEqual(r.maisoku, []);
  assert.strictEqual(r.maisoku_net_gain, 0);
});

check("null evidenceMap → no throw, empty result", () => {
  const r = extractEvidenceBySource(null);
  assert.strictEqual(r.maisoku_net_gain, 0);
});

check("single maisoku-only code → maisoku_pure, not legacy_only", () => {
  const ev = {
    "0305": [{ source: "maisoku", reason: "label match", matched: "最上階" }],
  };
  const r = extractEvidenceBySource(ev);
  assert.deepStrictEqual(r.maisoku_pure, ["0305"]);
  assert.deepStrictEqual(r.legacy_only, []);
  assert.deepStrictEqual(r.maisoku_overlap, []);
  assert.strictEqual(r.maisoku_net_gain, 1);
});

check("single setsubi-only code → legacy_only", () => {
  const ev = {
    "1201": [{ source: "setsubi", reason: "keyword match", matched: "オートロック" }],
  };
  const r = extractEvidenceBySource(ev);
  assert.deepStrictEqual(r.legacy_only, ["1201"]);
  assert.deepStrictEqual(r.maisoku_pure, []);
  assert.strictEqual(r.maisoku_net_gain, 0);
});

check("multi-source code (building + maisoku) → appears in BOTH raw sets + maisoku_overlap", () => {
  // T021 production data: code 1001 (南向き) had building + maisoku evidence.
  // This is the multi-source code the spec explicitly calls out in §3.2.
  const ev = {
    "1001": [
      { source: "building", reason: "building inference", matched: "南向き" },
      { source: "maisoku", reason: "label match", matched: "南向き" },
    ],
  };
  const r = extractEvidenceBySource(ev);
  // Code 1001 must appear in BOTH raw-source sets simultaneously (§3.2).
  assert.ok(r.building.includes("1001"), "1001 must be in building raw set");
  assert.ok(r.maisoku.includes("1001"), "1001 must be in maisoku raw set");
  // Higher-level bucket: maisoku_overlap (has maisoku AND another source).
  assert.ok(r.maisoku_overlap.includes("1001"), "1001 must be in maisoku_overlap");
  assert.ok(!r.maisoku_pure.includes("1001"), "1001 must NOT be in maisoku_pure");
  assert.ok(!r.legacy_only.includes("1001"), "1001 must NOT be in legacy_only");
  assert.strictEqual(r.maisoku_net_gain, 1);
});

check("fixture feature-codes-output.json: 0305=maisoku_pure, 1201=legacy, 0517+1001=maisoku_overlap", () => {
  const raw = JSON.parse(
    fs.readFileSync(path.join(FIXTURE_DIR, "feature-codes-output.json"), "utf8")
  );
  const r = extractEvidenceBySource(raw.evidence);
  assert.ok(r.maisoku_pure.includes("0305"), "0305 is maisoku-only → pure");
  assert.ok(r.legacy_only.includes("1201"), "1201 is setsubi-only → legacy");
  // 0517 and 1001 both have building + maisoku → overlap
  assert.ok(r.maisoku_overlap.includes("0517"), "0517 is building+maisoku → overlap");
  assert.ok(r.maisoku_overlap.includes("1001"), "1001 is building+maisoku → overlap");
  assert.strictEqual(r.maisoku_net_gain, 3); // 0305(pure) + 0517(overlap) + 1001(overlap)
});

check("unknown source string → code still processed without crash", () => {
  const ev = {
    "0233": [{ source: "alien", reason: "x", matched: "y" }],
  };
  // Should not throw, and the code is not in any of the 4 known-source raw lists.
  const r = extractEvidenceBySource(ev);
  assert.ok(!r.setsubi.includes("0233"));
  assert.ok(!r.building.includes("0233"));
  assert.ok(!r.maisoku.includes("0233"));
  assert.ok(!r.default.includes("0233"));
  // No maisoku source → legacy_only
  assert.ok(r.legacy_only.includes("0233"));
});

// ── (4) detectNegationContextCandidates ──────────────────────────────────────

console.log("\n## (4) detectNegationContextCandidates");

// 7 negation patterns, each ≥1 case.

check("pattern[なし]: 'バイク置場なし' → 0207 negated", () => {
  const { negatedCodes, details } = detectNegationContextCandidates(
    "バイク置場なし（スペースなし）",
    MINI_SSOT_MAP
  );
  assert.ok(negatedCodes.has("0207"), "0207 (バイク置場) should be negated");
  assert.ok(details.some((d) => d.pattern === "なし"));
});

check("pattern[不可]: 'バイク置場不可' → 0207 negated", () => {
  const { negatedCodes } = detectNegationContextCandidates(
    "バイク置場不可（管理規約により）",
    MINI_SSOT_MAP
  );
  assert.ok(negatedCodes.has("0207"));
});

check("pattern[未]: '駐輪場未整備' → 0816 negated", () => {
  const { negatedCodes } = detectNegationContextCandidates(
    "駐輪場未整備のため駐輪不可",
    MINI_SSOT_MAP
  );
  assert.ok(negatedCodes.has("0816"));
});

check("pattern[無]: 'バイク置場無' → 0207 negated", () => {
  const { negatedCodes } = detectNegationContextCandidates(
    "バイク置場無",
    MINI_SSOT_MAP
  );
  assert.ok(negatedCodes.has("0207"));
});

check("pattern[別途]: '駐輪場別途契約' → 0816 negated", () => {
  const { negatedCodes } = detectNegationContextCandidates(
    "駐輪場別途契約（月額2,000円）",
    MINI_SSOT_MAP
  );
  assert.ok(negatedCodes.has("0816"));
});

check("pattern[要確認]: 'バイク置場要確認' → 0207 negated", () => {
  const { negatedCodes } = detectNegationContextCandidates(
    "バイク置場要確認",
    MINI_SSOT_MAP
  );
  assert.ok(negatedCodes.has("0207"));
});

check("pattern[撤去]: '駐輪場撤去済み' → 0816 negated", () => {
  const { negatedCodes } = detectNegationContextCandidates(
    "駐輪場撤去済み（廃止）",
    MINI_SSOT_MAP
  );
  assert.ok(negatedCodes.has("0816"));
});

check("affirmative text: 'オートロックあり' → no codes negated", () => {
  const { negatedCodes } = detectNegationContextCandidates(
    "オートロックあり、宅配ボックスあり",
    MINI_SSOT_MAP
  );
  assert.strictEqual(negatedCodes.size, 0);
});

check("empty maisokuText → empty result", () => {
  const { negatedCodes, details } = detectNegationContextCandidates("", MINI_SSOT_MAP);
  assert.strictEqual(negatedCodes.size, 0);
  assert.deepStrictEqual(details, []);
});

check("NEG_WINDOW_AFTER boundary: negation at char 16 is outside window → not detected", () => {
  // NEG_WINDOW_AFTER = 15. Place negation 16 chars after label end.
  // Label "バイク置場" = 5 chars. Post-label content = 16 chars of padding + "なし".
  // isNegated inspects chars [label_end .. label_end+15], so char 16 is excluded.
  const padding = "1234567890123456"; // 16 ASCII chars (each 1 char)
  const text = `バイク置場${padding}なし`;
  const { negatedCodes } = detectNegationContextCandidates(text, MINI_SSOT_MAP);
  assert.ok(!negatedCodes.has("0207"), "negation outside 15-char window must not be detected");
});

check("Array<{code,label}> SSOT form accepted (mirrors forrent-feature-codes.json)", () => {
  const { negatedCodes } = detectNegationContextCandidates(
    "バイク置場なし",
    MINI_SSOT_ARR
  );
  assert.ok(negatedCodes.has("0207"));
});

// Fixture A — boundary verification (T003 §5):
// "駐輪場無料♪" trips the "無" pattern (substring of "無料").
// isNegated DOES return negated:true for this text (confirmed in T003 live run).
check("Fixture A boundary: '駐輪場無料♪' → '無' pattern triggers, 0816 ∈ negatedCodes (framework alarm)", () => {
  const { negatedCodes, details } = detectNegationContextCandidates(
    "駐輪場無料♪（月額0円）",
    MINI_SSOT_MAP
  );
  // T003 §5: isNegated returns negated:true, pattern:"無" on this text.
  // The framework correctly identifies this as a negation candidate.
  assert.ok(negatedCodes.has("0816"),
    "0816 must be in negatedCodes — framework alarm is working (partial-label '無' in '無料')");
  assert.ok(details.some((d) => d.code === "0816" && d.pattern === "無"),
    "detail entry must show pattern='無'");
});

// ── (5) assessNegationFP ─────────────────────────────────────────────────────

console.log("\n## (5) assessNegationFP");

// Fixture A: "駐輪場無料♪" + 0816 emitted + DOM checked → FP=1
check("Fixture A: 0816 in cand + emitted + dom → FP=[0816], fp_rate=1.0", () => {
  const cand = new Set(["0816"]);       // negation candidate from text
  const emitted = new Set(["0816"]);    // maisoku route emitted
  const dom = new Set(["0816"]);        // DOM ground truth checked
  const r = assessNegationFP(cand, emitted, dom);
  assert.deepStrictEqual(r.false_positives, ["0816"], "0816 must be FP");
  assert.deepStrictEqual(r.true_negatives, []);
  assert.strictEqual(r.fp_rate, 1.0);
});

// Fixture B: "駐輪場無料♪" + 0816 NOT emitted → FP=0 (production reality)
check("Fixture B: 0816 in cand but NOT emitted → FP=[], fp_rate=null (empty denominator)", () => {
  const cand = new Set(["0816"]);
  const emitted = new Set([]);          // production: negation filter held, 0816 not emitted
  const dom = new Set(["0816"]);
  const r = assessNegationFP(cand, emitted, dom);
  assert.deepStrictEqual(r.false_positives, [], "no emitted codes → no FP");
  assert.strictEqual(r.fp_rate, null, "fp_rate is null when emitted set is empty");
});

// Fixture C: "バイク置場無し" + 0207 emitted + DOM checked → FP=1 (clear negation)
check("Fixture C: 0207 in cand + emitted + dom → FP=[0207], fp_rate=1.0", () => {
  const cand = new Set(["0207"]);
  const emitted = new Set(["0207"]);
  const dom = new Set(["0207"]);
  const r = assessNegationFP(cand, emitted, dom);
  assert.deepStrictEqual(r.false_positives, ["0207"]);
  assert.strictEqual(r.fp_rate, 1.0);
});

check("code emitted but NOT in cand → true_negative (correct emit)", () => {
  const cand = new Set([]);
  const emitted = new Set(["1201"]);    // オートロック: no negation in text
  const dom = new Set(["1201"]);
  const r = assessNegationFP(cand, emitted, dom);
  assert.deepStrictEqual(r.true_negatives, ["1201"]);
  assert.deepStrictEqual(r.false_positives, []);
  assert.strictEqual(r.fp_rate, 0.0);
});

check("empty emitted → fp_rate=null (no denominator)", () => {
  const r = assessNegationFP(new Set(["0816"]), new Set(), new Set(["0816"]));
  assert.strictEqual(r.fp_rate, null);
  assert.deepStrictEqual(r.false_positives, []);
});

check("empty dom → intent-only fallback: code in cand + emitted → FP regardless of dom", () => {
  // When domChecked is empty, dom.size===0 so condition is (dom.size===0 ? true : dom.has(code))
  // which resolves to true → FP is counted from intent alone.
  const r = assessNegationFP(new Set(["0816"]), new Set(["0816"]), new Set());
  assert.deepStrictEqual(r.false_positives, ["0816"]);
  assert.strictEqual(r.fp_rate, 1.0);
});

check("mixed: one FP + one TN", () => {
  const cand = new Set(["0816"]);       // 0816 is negation candidate
  const emitted = new Set(["0816", "1201"]); // both emitted
  const dom = new Set(["0816", "1201"]);
  const r = assessNegationFP(cand, emitted, dom);
  assert.deepStrictEqual(r.false_positives, ["0816"]);
  assert.deepStrictEqual(r.true_negatives, ["1201"]);
  assert.strictEqual(r.fp_rate, 0.5);
});

check("null inputs → no throw, fp_rate=null", () => {
  const r = assessNegationFP(null, null, null);
  assert.strictEqual(r.fp_rate, null);
  assert.deepStrictEqual(r.false_positives, []);
});

// ── (6) buildCodeLabelMaps helper ────────────────────────────────────────────

console.log("\n## (6) buildCodeLabelMaps helper");

check("empty string → empty maps", () => {
  const { codeToLabel, labelToCodes } = buildCodeLabelMaps("");
  assert.strictEqual(codeToLabel.size, 0);
  assert.strictEqual(labelToCodes.size, 0);
});

check("mini fixture: known codes parsed correctly", () => {
  // editHtml loaded from edit-after-teisei-mini.html above
  assert.ok(codeToLabel.has("1201"), "L1201 → オートロック");
  assert.strictEqual(codeToLabel.get("1201"), "オートロック");
  assert.ok(labelToCodes.has("オートロック"));
  assert.ok(labelToCodes.get("オートロック").includes("1201"));
});

check("duplicate label → both codes stored under same labelToCodes key", () => {
  const arr = labelToCodes.get("テスト重複ラベル");
  assert.ok(Array.isArray(arr));
  assert.ok(arr.includes("9991"));
  assert.ok(arr.includes("9992"));
  assert.strictEqual(arr.length, 2);
});

check("non-string input → empty maps, no throw", () => {
  const { codeToLabel } = buildCodeLabelMaps(null);
  assert.strictEqual(codeToLabel.size, 0);
});

// ── (7) Integration test ──────────────────────────────────────────────────────

console.log("\n## (7) Integration test");

check("CLI on mock-run-dir produces summary.json with expected schema", () => {
  // Build a minimal dict-html path from the fixture.
  const dictHtml = path.join(FIXTURE_DIR, "edit-after-teisei-mini.html");
  const outDir = path.join(require("os").tmpdir(), `dom-match-test-${Date.now()}`);
  const cliScript = path.join(PROJECT_ROOT, "scripts", "measure-phase-delta-dom-match.js");

  // The CLI traverses --runs-dir looking for {ts}_{reinsId} subdirectories.
  // We provide MOCK_RUN_DIR as the run-dir directly, but it's named "mock-run-dir"
  // which won't match the ts_reinsId pattern. So we create a temp wrapper dir.
  const tmpRunsDir = path.join(require("os").tmpdir(), `dom-match-runs-${Date.now()}`);
  const runSubDir = path.join(tmpRunsDir, "20260517-000000_100139999999");
  fs.mkdirSync(runSubDir, { recursive: true });
  // Copy mock run artifacts into the ts_reinsId subdir.
  for (const entry of fs.readdirSync(MOCK_RUN_DIR)) {
    const src = path.join(MOCK_RUN_DIR, entry);
    const dst = path.join(runSubDir, entry);
    if (fs.statSync(src).isDirectory()) {
      fs.mkdirSync(dst, { recursive: true });
      for (const f of fs.readdirSync(src)) {
        fs.copyFileSync(path.join(src, f), path.join(dst, f));
      }
    } else {
      fs.copyFileSync(src, dst);
    }
  }

  // Run the CLI.
  execSync(
    `node "${cliScript}" --runs-dir="${tmpRunsDir}" --out="${outDir}" --filter=all --dict="${dictHtml}"`,
    { cwd: PROJECT_ROOT, stdio: "pipe" }
  );

  // Assert summary.json exists and has expected top-level keys.
  // Schema per aggregate() in measure-phase-delta-dom-match.js:
  //   { generated_at, runs_dir, dict_html, code_label_dict_size, ssot_size,
  //     filter, since, counts{total,ok,...}, dom{runs,exact_rate_mean,...},
  //     source{...}, negation{...}, records_count }
  const summaryPath = path.join(outDir, "summary.json");
  assert.ok(fs.existsSync(summaryPath), "summary.json must be created");
  const summary = JSON.parse(fs.readFileSync(summaryPath, "utf8"));

  assert.ok("counts" in summary, "summary.json must have 'counts' key");
  assert.ok("dom" in summary, "summary.json must have 'dom' key");
  assert.ok("source" in summary, "summary.json must have 'source' key");
  assert.ok("negation" in summary, "summary.json must have 'negation' key");
  assert.ok("records_count" in summary, "summary.json must have 'records_count' key");
  assert.ok(typeof summary.counts.total === "number", "counts.total must be a number");
  assert.ok(typeof summary.dom.runs === "number", "dom.runs must be a number");

  // Clean up temp dirs.
  fs.rmSync(outDir, { recursive: true, force: true });
  fs.rmSync(tmpRunsDir, { recursive: true, force: true });
});

// ── Final report ──────────────────────────────────────────────────────────────

console.log(`\n${"─".repeat(60)}`);
console.log(`Passed: ${pass}  Failed: ${fail}  Total: ${pass + fail}`);
if (fail > 0) {
  process.exit(1);
}
