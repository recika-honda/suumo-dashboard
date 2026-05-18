/**
 * Stage 02c: maisoku text extract (dual-mode) — Phase γ T003
 *
 * 02b で取得した maisoku.pdf を入力に、flat text を抽出する pure I/O stage。
 * Browser には触らない (gamma-design §4 rationale: 02b の browser I/O と
 * 02c の compute/file I/O を分離して unit test を簡潔に、rollback を独立に)。
 *
 * Dual-mode:
 *   primary  — pdftotext (Phase α finding-02 で text-layer 20% hit、$0)
 *   fallback — gpt-4o Vision OCR (scan PDF 80%、$0.01-0.02/物件 想定)
 *
 * 設計 SSOT: code/suumo-dashboard/docs/refactor/phase-gamma-design.md §3, §4, §7-§9
 * 実装基底:
 *   - skills/image-ai.js L94-103 (OpenAI Vision data:image/jpeg;base64,... pattern)
 *   - finding-02 (`MIN_MEANINGFUL_CHARS=50` threshold rationale)
 *
 * 失敗時の振る舞い: throw しない (gamma-design §9 non-blocking)。
 *   - maisokuPdfPath が null         → source="skipped"
 *   - pdftotext で text layer hit    → source="pdftotext"
 *   - PHASE_GAMMA_OCR=0 で fallback 抑制 → source="pdftotext" (charsExtracted<threshold)
 *   - Vision OCR success             → source="vision-ocr"
 *   - 任意の例外                      → source="error" (maisokuText="", visionUsed=false)
 *
 * Env switches (gamma-design §7、全て runtime read = lazy):
 *   PHASE_GAMMA_OCR              "0" で OCR fallback を抑制 (pdftotext-only mode)
 *   MAISOKU_MIN_MEANINGFUL_CHARS text layer 検出 threshold (default 50)
 *   OPENAI_VISION_MODEL          Vision モデル (default "gpt-4o")
 *   OPENAI_VISION_DETAIL         Vision detail (default "high")
 *   MAISOKU_OCR_DPI              pdftoppm raster DPI (default 150)
 */

const fs = require("fs");
const path = require("path");
const os = require("os");
const { execFile } = require("child_process");
const { writeStageInput, writeStageOutput } = require("../lib/artifact");

const STAGE = "02c-maisoku-text-extract";

// gamma-design §8 cost policy. WARN $0.05, ABORT $0.10. 1 call ~$0.005-$0.02。
// 1 物件 1 回呼ぶ前提なので per-call が ABORT を超えるのは異常。tests も同じ
// 閾値で動作確認する。
const VISION_COST_WARN_USD = 0.05;
const VISION_COST_ABORT_USD = 0.10;

// ------------------------------------------------------------------
// OpenAI client factory (lazy init + test seam)
// Production では openai SDK を遅延 require する (Vision API call の直前で
// import が走ることで、test 環境では実 SDK の load を skip 可能)。
// test は __setOpenAIFactoryForTests() で factory を差し替える。
// ------------------------------------------------------------------
let _openaiFactory = null;
let _cachedClient = null;

function setOpenAIFactoryForTests(factory) {
  _openaiFactory = factory;
  _cachedClient = null;
}

function getOpenAIClient() {
  if (_cachedClient) return _cachedClient;
  if (_openaiFactory) {
    _cachedClient = _openaiFactory();
    return _cachedClient;
  }
  // production path: lazy require keeps tests from loading openai SDK.
  const OpenAI = require("openai");
  _cachedClient = new OpenAI();
  return _cachedClient;
}

// ------------------------------------------------------------------
// pdftotext via system binary
// pdf-parse 等の npm dep を追加しないことで blast radius を最小化。
// Phase α probe (`sample-maisoku-and-zmnflmi.js`) と同じ tool を使うため、
// hit/miss 判定が finding-02 とコンパチ。
// ------------------------------------------------------------------
function execFileAsync(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { ...opts }, (err, stdout, stderr) => {
      if (err) {
        err.stdout = stdout;
        err.stderr = stderr;
        reject(err);
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

async function runPdftotext(pdfPath) {
  // -layout は表構造を保持しやすいが、マイソクは縦書/混在レイアウトが多く
  // -layout だと逆に noise が増えるケースがあるため default (linearized) で抽出。
  const { stdout } = await execFileAsync("pdftotext", [pdfPath, "-"], {
    timeout: 30_000,
    maxBuffer: 8 * 1024 * 1024,
  });
  return stdout || "";
}

function meaningfulChars(text) {
  // finding-02 と同じ判定: 非空白文字のみ数える (scan PDF が trailing \n を返す罠の回避)
  return (text || "").replace(/\s+/g, "").length;
}

// ------------------------------------------------------------------
// pdftoppm → page-1.jpg → base64
// gamma-design §8: -jpeg -r 150 maisoku.pdf <prefix>。マイソクは 1 page。
// 一時 dir を作って後で消す (runDir 配下に置くと artifact noise になる)。
// ------------------------------------------------------------------
async function rasterizeFirstPageToJpeg(pdfPath) {
  const dpi = (() => {
    const raw = process.env.MAISOKU_OCR_DPI;
    if (raw == null || raw === "") return 150;
    const n = Number(raw);
    return Number.isFinite(n) && n >= 50 && n <= 600 ? Math.floor(n) : 150;
  })();
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "fango-maisoku-ocr-"));
  const prefix = path.join(tmpDir, "page");
  try {
    // -f 1 -l 1 で 1 page のみ → page-1.jpg
    await execFileAsync(
      "pdftoppm",
      ["-jpeg", "-r", String(dpi), "-f", "1", "-l", "1", pdfPath, prefix],
      { timeout: 30_000 }
    );
    const candidates = ["page-1.jpg", "page-01.jpg"];
    let imagePath = null;
    for (const name of candidates) {
      const p = path.join(tmpDir, name);
      if (fs.existsSync(p)) {
        imagePath = p;
        break;
      }
    }
    if (!imagePath) {
      throw new Error("pdftoppm produced no output (expected page-1.jpg)");
    }
    const buf = fs.readFileSync(imagePath);
    return { buf, tmpDir };
  } catch (e) {
    // cleanup before rethrow
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
    throw e;
  }
}

function cleanupTmpDir(tmpDir) {
  if (!tmpDir) return;
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
}

// ------------------------------------------------------------------
// gpt-4o Vision OCR call. Cost estimation is intentionally simple
// (~$0.005 per high-detail call) since gamma-design §8 only requires a
// warn/abort guardrail, not accurate billing.
// ------------------------------------------------------------------
function estimateVisionCostUSD() {
  // gamma-design §8 anchor: ~$0.005/property baseline. Single-call stage so
  // this is also the per-stage total. Tests pin this number; tweaking it
  // requires updating test-stage-02c.js expectations.
  return 0.005;
}

async function callVisionOCR(jpegBuffer) {
  const model = process.env.OPENAI_VISION_MODEL || "gpt-4o";
  const detail = process.env.OPENAI_VISION_DETAIL || "high";
  const client = getOpenAIClient();
  const b64 = jpegBuffer.toString("base64");

  const response = await client.chat.completions.create({
    model,
    max_tokens: 2000,
    messages: [
      {
        role: "user",
        content: [
          {
            type: "image_url",
            image_url: { url: `data:image/jpeg;base64,${b64}`, detail },
          },
          {
            type: "text",
            text:
              "この募集図面 (マイソク) PDF を 1 ページの画像にラスタライズしたものです。\n" +
              "画像内に書かれている全ての日本語テキストを上から下、左から右の順で素直に文字起こししてください。\n" +
              "出力ルール:\n" +
              "- 装飾的な箇条書き記号 (◆◇■□●○★☆) は除去し、地の文として書き出す\n" +
              "- 数値・面積・畳数・距離・賃料などは画像通りに書く (改ざんしない)\n" +
              "- 表は行ごとに「ラベル: 値」の形で書く\n" +
              "- 何も読み取れない時は空文字を返す\n" +
              "テキストのみを返してください (markdown / json / 前置きは不要)。",
          },
        ],
      },
    ],
  });

  const text = (response.choices?.[0]?.message?.content || "").trim();
  return text;
}

// ------------------------------------------------------------------
// Public stage entry
// ------------------------------------------------------------------
/**
 * @param {object} opts
 * @param {string|null} opts.maisokuPdfPath  02b output. null → "skipped"
 * @param {string}   opts.runDir
 * @param {(name: string, extra?: object) => void} opts.logStep
 * @returns {Promise<{
 *   maisokuText: string,
 *   charsExtracted: number,
 *   source: "pdftotext"|"vision-ocr"|"skipped"|"error",
 *   visionUsed: boolean,
 *   visionCostUSD: number,
 *   error?: string,
 *   generated_at: string
 * }>}
 */
async function runMaisokuTextExtract({ maisokuPdfPath, runDir, logStep }) {
  const log = typeof logStep === "function" ? logStep : () => {};
  writeStageInput(runDir, STAGE, {
    hasMaisokuPdf: !!maisokuPdfPath,
    maisokuPdfPath: maisokuPdfPath || null,
  });
  console.error("  [2c/6] マイソク text 抽出...");
  log("maisoku_text_start", { hasMaisokuPdf: !!maisokuPdfPath });

  const minMeaningful = (() => {
    const raw = process.env.MAISOKU_MIN_MEANINGFUL_CHARS;
    if (raw == null || raw === "") return 50;
    const n = Number(raw);
    return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 50;
  })();
  const ocrEnabled = process.env.PHASE_GAMMA_OCR !== "0";

  // ── 1) skipped: PDF が無い ──
  if (!maisokuPdfPath || !fs.existsSync(maisokuPdfPath)) {
    const out = {
      maisokuText: "",
      charsExtracted: 0,
      source: "skipped",
      visionUsed: false,
      visionCostUSD: 0,
      generated_at: new Date().toISOString(),
    };
    log("maisoku_text_skipped", { reason: maisokuPdfPath ? "pdf file missing" : "no maisokuPdfPath" });
    writeStageOutput(runDir, STAGE, out);
    persistMaisokuText(runDir, "");
    return out;
  }

  // ── 2) pdftotext primary ──
  let pdftotextText = "";
  let pdftotextChars = 0;
  try {
    pdftotextText = await runPdftotext(maisokuPdfPath);
    pdftotextChars = meaningfulChars(pdftotextText);
  } catch (e) {
    console.error(`  [02c] pdftotext failed: ${e.message.slice(0, 200)}`);
    log("maisoku_text_pdftotext_error", { error: e.message.slice(0, 200) });
    pdftotextText = "";
    pdftotextChars = 0;
  }

  if (pdftotextChars >= minMeaningful) {
    const out = {
      maisokuText: pdftotextText.trim(),
      charsExtracted: pdftotextChars,
      source: "pdftotext",
      visionUsed: false,
      visionCostUSD: 0,
      generated_at: new Date().toISOString(),
    };
    console.error(`  ✓ pdftotext hit (${pdftotextChars} chars)`);
    log("maisoku_text_pdftotext_hit", { chars: pdftotextChars, threshold: minMeaningful });
    writeStageOutput(runDir, STAGE, out);
    persistMaisokuText(runDir, out.maisokuText);
    return out;
  }

  // ── 3) PHASE_GAMMA_OCR=0 → fallback 抑制 (pdftotext-only mode) ──
  if (!ocrEnabled) {
    const out = {
      maisokuText: pdftotextText.trim(),
      charsExtracted: pdftotextChars,
      source: "pdftotext",
      visionUsed: false,
      visionCostUSD: 0,
      generated_at: new Date().toISOString(),
    };
    console.error(`  pdftotext ${pdftotextChars} chars < ${minMeaningful} → PHASE_GAMMA_OCR=0 で OCR skip`);
    log("maisoku_text_ocr_disabled", { chars: pdftotextChars, threshold: minMeaningful });
    writeStageOutput(runDir, STAGE, out);
    persistMaisokuText(runDir, out.maisokuText);
    return out;
  }

  // ── 4) gpt-4o Vision OCR fallback ──
  console.error(`  pdftotext ${pdftotextChars} chars < ${minMeaningful} → Vision OCR fallback`);
  log("maisoku_text_ocr_fallback", { pdftotextChars, threshold: minMeaningful });

  let tmpDir = null;
  try {
    const { buf, tmpDir: td } = await rasterizeFirstPageToJpeg(maisokuPdfPath);
    tmpDir = td;
    const text = await callVisionOCR(buf);
    const chars = meaningfulChars(text);
    const cost = estimateVisionCostUSD();

    if (cost >= VISION_COST_ABORT_USD) {
      // gamma-design §8 abort guardrail: cost spike (e.g. estimator bumped to
      // an outrageous number) → mark as error and discard the text.
      const out = {
        maisokuText: "",
        charsExtracted: 0,
        source: "error",
        visionUsed: true,
        visionCostUSD: cost,
        error: `vision cost ${cost.toFixed(4)} USD exceeded abort threshold ${VISION_COST_ABORT_USD}`,
        generated_at: new Date().toISOString(),
      };
      console.error(`  ✗ OCR cost over abort threshold: $${cost.toFixed(4)} >= $${VISION_COST_ABORT_USD}`);
      log("maisoku_text_ocr_cost_abort", { cost, threshold: VISION_COST_ABORT_USD });
      writeStageOutput(runDir, STAGE, out);
      persistMaisokuText(runDir, "");
      return out;
    }
    if (cost >= VISION_COST_WARN_USD) {
      console.error(`  ⚠ OCR cost warn: $${cost.toFixed(4)} >= $${VISION_COST_WARN_USD}`);
      log("maisoku_text_ocr_cost_warn", { cost, threshold: VISION_COST_WARN_USD });
    }

    const out = {
      maisokuText: text,
      charsExtracted: chars,
      source: "vision-ocr",
      visionUsed: true,
      visionCostUSD: cost,
      generated_at: new Date().toISOString(),
    };
    console.error(`  ✓ vision-ocr ${chars} chars, cost ~$${cost.toFixed(4)}`);
    log("maisoku_text_done", { source: "vision-ocr", chars, cost });
    writeStageOutput(runDir, STAGE, out);
    persistMaisokuText(runDir, text);
    return out;
  } catch (e) {
    const out = {
      maisokuText: "",
      charsExtracted: 0,
      source: "error",
      visionUsed: false,
      visionCostUSD: 0,
      error: `OCR fallback failed: ${e.message.slice(0, 200)}`,
      generated_at: new Date().toISOString(),
    };
    console.error(`  ✗ ${out.error}`);
    log("maisoku_text_error", { error: out.error });
    writeStageOutput(runDir, STAGE, out);
    persistMaisokuText(runDir, "");
    return out;
  } finally {
    cleanupTmpDir(tmpDir);
  }
}

// gamma-design §5: 02c artifact subdir に input/output.json + maisoku-text.txt を書く
// (Phase δ で 03b が読みやすいよう、生 text を別ファイルにも残す)。
function persistMaisokuText(runDir, text) {
  if (!runDir) return;
  try {
    const dir = path.join(runDir, STAGE);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "maisoku-text.txt"), text || "");
  } catch (e) {
    console.error(`[02c] maisoku-text.txt write failed: ${e.message}`);
  }
}

module.exports = {
  runMaisokuTextExtract,
  // Internal helpers exported for test scaffolding (not part of public API):
  __setOpenAIFactoryForTests: setOpenAIFactoryForTests,
  __VISION_COST_WARN_USD: VISION_COST_WARN_USD,
  __VISION_COST_ABORT_USD: VISION_COST_ABORT_USD,
};
