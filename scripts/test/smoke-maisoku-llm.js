/**
 * Production-path smoke for the maisoku LLM feature-code resolution (Path E).
 *
 * Runs the REAL stage entry (runFeatureCodesResolve) against a prepared run
 * dir that contains genuine 01/02b/02c artifacts and a real maisoku.pdf, with
 * a REAL OpenAI call. No fixture shortcut: this is the same entry point and
 * artifact-read path the production pipeline uses (smoke-production-parity).
 *
 * Usage:
 *   node scripts/test/smoke-maisoku-llm.js <runDir> [expectedCode ...]
 *
 * Exit 0 only when:
 *   (1) the LLM route fired (some evidence entry has source "maisoku-llm")
 *   (2) every expectedCode arg is present in checkedCodes
 *   (3) legacy paths still contribute (>= 1 building + >= 1 default evidence)
 */

const path = require("path");
const fs = require("fs");

const envPath = path.join(__dirname, "..", "..", ".env.local");
if (fs.existsSync(envPath)) {
  require("dotenv").config({ path: envPath });
}

const { runFeatureCodesResolve } = require("../stages/03b-feature-codes-resolve");

async function main() {
  const [runDirArg, ...expectedCodes] = process.argv.slice(2);
  if (!runDirArg) {
    console.error("usage: node scripts/test/smoke-maisoku-llm.js <runDir> [expectedCode ...]");
    process.exit(2);
  }
  const runDir = path.resolve(runDirArg);
  const stage01 = JSON.parse(
    fs.readFileSync(path.join(runDir, "01-reins-extract", "output.json"), "utf8")
  );
  const reinsData = stage01.reinsData || stage01;

  const events = [];
  const logStep = (name, extra) => events.push({ name, extra });

  const result = await runFeatureCodesResolve({ reinsData, maisokuText: null, logStep, runDir });

  const llmCodes = Object.entries(result.evidence)
    .filter(([, evs]) => evs.some((e) => e.source === "maisoku-llm"))
    .map(([code]) => code)
    .sort();
  const buildingCount = Object.values(result.evidence)
    .flat()
    .filter((e) => e.source === "building").length;
  const defaultCount = Object.values(result.evidence)
    .flat()
    .filter((e) => e.source === "default").length;
  const done = events.find((e) => e.name === "feature_codes_resolve_done");

  console.log(`checkedCodes (${result.checkedCodes.length}): ${result.checkedCodes.join(",")}`);
  console.log(`maisoku-llm codes (${llmCodes.length}): ${llmCodes.join(",")}`);
  console.log(`legacy evidence: building=${buildingCount} default=${defaultCount}`);
  console.log(`done payload: ${JSON.stringify(done && done.extra)}`);

  let failed = 0;
  const check = (label, ok) => {
    console.log(`${ok ? "PASS" : "FAIL"} - ${label}`);
    if (!ok) failed += 1;
  };

  check("llm route fired (source maisoku-llm present)", llmCodes.length > 0);
  for (const code of expectedCodes) {
    check(`expected code ${code} in checkedCodes`, result.checkedCodes.includes(code));
  }
  check("legacy building path still contributes", buildingCount >= 1);
  check("legacy default path still contributes", defaultCount >= 1);
  check(
    "done payload reports maisokuLlmStatus ok",
    !!done && done.extra && done.extra.maisokuLlmStatus === "ok"
  );

  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
