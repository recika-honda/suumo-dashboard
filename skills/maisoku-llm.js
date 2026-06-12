/**
 * Maisoku LLM feature-code resolution
 *
 * Sends the maisoku PDF (rasterised page 1) plus the 150-code SSOT list to
 * gpt-4o and asks the model to judge which feature codes apply to the
 * property. Replaces the exact-substring label matching of the maisoku path
 * in skills/feature-codes-resolve.js, which systematically missed wording
 * variants (e.g. maisoku "浴室乾燥" vs SSOT label "浴室乾燥機") and could not
 * see checkbox states (□/■) that pdftotext flattens away.
 *
 * Behaviour contract (mirrors 02c-maisoku-text-extract):
 *   - never throws: all failures resolve to { status: "error", codes: null }
 *   - codes are validated against the SSOT allowlist before being returned
 *   - env MAISOKU_LLM_RESOLVE=0 is honoured by the 03b stage (not here)
 *
 * Env switches (all runtime-read = lazy):
 *   MAISOKU_LLM_MODEL   chat model (default "gpt-4o")
 *   MAISOKU_OCR_DPI     pdftoppm raster DPI (default 150, shared with 02c)
 */

const fs = require("fs");
const path = require("path");
const os = require("os");
const { execFile } = require("child_process");

// Cost guardrail, same policy as 02c (gamma-design section 8). One high-detail
// gpt-4o call with a ~150-line prompt is ~$0.01.
const LLM_COST_WARN_USD = 0.05;
const LLM_COST_ABORT_USD = 0.10;

function estimateLlmCostUSD() {
  return 0.01;
}

// ------------------------------------------------------------------
// OpenAI client factory (lazy init + test seam), same pattern as 02c.
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
  const OpenAI = require("openai");
  _cachedClient = new OpenAI();
  return _cachedClient;
}

// ------------------------------------------------------------------
// pdftoppm rasteriser. Self-contained copy of the 02c helper so that the
// tested 02c stage stays untouched (code-preservation rule); both follow
// the same poppler invocation.
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

async function rasterizeFirstPageToJpeg(pdfPath) {
  const dpi = (() => {
    const raw = process.env.MAISOKU_OCR_DPI;
    if (raw == null || raw === "") return 150;
    const n = Number(raw);
    return Number.isFinite(n) && n >= 50 && n <= 600 ? Math.floor(n) : 150;
  })();
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "fango-maisoku-llm-"));
  const prefix = path.join(tmpDir, "page");
  try {
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
// Prompt builder (pure). The full SSOT list rides in the prompt so the model
// can only pick from valid codes; parseLlmCodes() re-validates anyway.
// ------------------------------------------------------------------
function buildMaisokuLlmPrompt(featureCodesConfig, maisokuText = null) {
  const lines = (featureCodesConfig?.codes || [])
    .filter((c) => c && typeof c.code === "string" && typeof c.label === "string")
    .map((c) => `${c.code} ${c.label}`)
    .join("\n");

  // The 02c flat text rides along when available: the image carries layout
  // and checkbox state, the text guarantees no equipment line is overlooked
  // (smoke run 20260612: image-only missed オートロック / システムキッチン
  // that were plainly in the 設備欄).
  const textBlock =
    typeof maisokuText === "string" && maisokuText.trim().length > 0
      ? "\n\n参考: 同じ図面から機械抽出したテキスト (レイアウトは崩れている):\n---\n" +
        maisokuText.trim().slice(0, 4000) +
        "\n---\n"
      : "";

  return (
    "これは賃貸物件の募集図面 (マイソク) を画像化したものです。\n" +
    "以下は不動産ポータルの「特徴コード」一覧です (コード ラベル):\n\n" +
    lines +
    textBlock +
    "\n\n" +
    "この図面に書かれている内容から、この物件に該当する特徴コードを判定してください。\n" +
    "手順: まず図面の設備欄・条件欄に列挙されている項目を漏れなく items に書き出し、" +
    "次に items と図面全体の記載を特徴コードに対応付けて codes を作る。\n" +
    "判定ルール:\n" +
    "- 図面に明記されている事実のみ採用する。推測で補わない\n" +
    "- 表記ゆれは意味で対応付ける (例: 図面の「浴室乾燥」はラベル「浴室乾燥機」、「洗浄便座」は「温水洗浄便座」、「ガスコンロ2口」は「2口コンロ」に該当)\n" +
    "- 設備欄がチェックボックス形式で、チェック済み (■/☑ 等) と未チェック (□) の区別が見える場合、チェック済みの項目のみ採用する\n" +
    "- 全項目が同じ記号 (□ 等) で列挙され塗り分けが無い場合は、列挙されている項目を全てこの物件の設備とみなす\n" +
    "- 「不可」「なし」「無」「相談」「別途」など否定・条件付きの表現が付く項目は採用しない (例: 「バイク置き場 ー」は該当なし)\n" +
    "- 賃料・敷金礼金 0 円・駅徒歩分数など、一覧のラベルに直接対応する記載があればそれも採用する\n" +
    '出力は次の JSON のみ (前置き・説明文は不要): {"items":["浴室乾燥","オートロック"],"codes":[{"code":"1507","evidence":"設備欄に浴室乾燥"}]}\n' +
    "evidence は図面内の根拠を 30 文字以内で書く。該当が無ければ {\"items\":[],\"codes\":[]} を返す。"
  );
}

// ------------------------------------------------------------------
// Response parser (pure). Tolerates markdown code fences and a plain string
// array. Filters to the SSOT allowlist, dedupes, clamps evidence length.
// Returns Array<{code, evidence}> or null when the payload is unusable.
// ------------------------------------------------------------------
function parseLlmCodes(rawText, featureCodesConfig) {
  if (typeof rawText !== "string" || rawText.trim().length === 0) return null;
  const allowed = new Set(
    (featureCodesConfig?.codes || [])
      .filter((c) => c && typeof c.code === "string")
      .map((c) => c.code)
  );
  if (allowed.size === 0) return null;

  let text = rawText.trim();
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) text = fence[1].trim();

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  const list = Array.isArray(parsed) ? parsed : parsed?.codes;
  if (!Array.isArray(list)) return null;

  const seen = new Set();
  const out = [];
  for (const item of list) {
    const code = typeof item === "string" ? item : item?.code;
    if (typeof code !== "string" || !allowed.has(code) || seen.has(code)) continue;
    seen.add(code);
    const evidence =
      typeof item === "object" && typeof item?.evidence === "string"
        ? item.evidence.trim().slice(0, 120)
        : "";
    out.push({ code, evidence });
  }
  return out;
}

// ------------------------------------------------------------------
// Public entry. Never throws.
// ------------------------------------------------------------------
/**
 * @param {object} opts
 * @param {string|null} opts.maisokuPdfPath  02b output (maisoku.pdf)
 * @param {object} opts.featureCodesConfig   config/forrent-feature-codes.json shape
 * @returns {Promise<{
 *   status: "ok"|"skipped:no_pdf"|"error",
 *   codes: Array<{code: string, evidence: string}>|null,
 *   costUSD: number,
 *   model: string|null,
 *   error?: string
 * }>}
 */
async function resolveMaisokuCodesLlm({ maisokuPdfPath, featureCodesConfig, maisokuText = null }) {
  if (!maisokuPdfPath || !fs.existsSync(maisokuPdfPath)) {
    return { status: "skipped:no_pdf", codes: null, costUSD: 0, model: null };
  }

  const model = process.env.MAISOKU_LLM_MODEL || "gpt-4o";
  const cost = estimateLlmCostUSD();
  if (cost >= LLM_COST_ABORT_USD) {
    return {
      status: "error",
      codes: null,
      costUSD: cost,
      model,
      error: `llm cost ${cost.toFixed(4)} USD exceeded abort threshold ${LLM_COST_ABORT_USD}`,
    };
  }

  let tmpDir = null;
  try {
    const { buf, tmpDir: td } = await rasterizeFirstPageToJpeg(maisokuPdfPath);
    tmpDir = td;
    const client = getOpenAIClient();
    const response = await client.chat.completions.create({
      model,
      max_tokens: 1500,
      temperature: 0,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "user",
          content: [
            {
              type: "image_url",
              image_url: {
                url: `data:image/jpeg;base64,${buf.toString("base64")}`,
                detail: "high",
              },
            },
            { type: "text", text: buildMaisokuLlmPrompt(featureCodesConfig, maisokuText) },
          ],
        },
      ],
    });

    const raw = (response.choices?.[0]?.message?.content || "").trim();
    const codes = parseLlmCodes(raw, featureCodesConfig);
    if (codes === null) {
      return {
        status: "error",
        codes: null,
        costUSD: cost,
        model,
        error: `unparseable LLM response: ${raw.slice(0, 120)}`,
      };
    }
    return { status: "ok", codes, costUSD: cost, model };
  } catch (e) {
    return {
      status: "error",
      codes: null,
      costUSD: 0,
      model,
      error: `maisoku llm resolve failed: ${String(e.message || e).slice(0, 200)}`,
    };
  } finally {
    cleanupTmpDir(tmpDir);
  }
}

module.exports = {
  resolveMaisokuCodesLlm,
  buildMaisokuLlmPrompt,
  parseLlmCodes,
  // Internal helpers exported for test scaffolding (not part of public API):
  __setOpenAIFactoryForTests: setOpenAIFactoryForTests,
  __LLM_COST_WARN_USD: LLM_COST_WARN_USD,
  __LLM_COST_ABORT_USD: LLM_COST_ABORT_USD,
};
