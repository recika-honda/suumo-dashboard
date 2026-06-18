/**
 * skills/retouch.js — image-retouch の純粋ヘルパー群 (stage 04b 用)
 *
 * 元ロジック: kento 承認済の手元スクリプト ~/Desktop/suumo-nyuko/retouch-listing-images.sh
 * 設計 SSOT:   docs/refactor/retouch-stage-design.md (T001)
 *
 * これらは全て pure function。I/O / 副作用なし (fs / child_process を require しない)。
 * magick / realesrgan の引数配列・WB ゲイン・gamma 値を「組み立てて返す」だけで、
 * 実 spawn は呼び出し側 (T003 stage) の責務。
 *
 * 寸法非依存: buildMagickOps は targetW / targetH を引数で受ける
 * (kento 合意 2026-06-18: 全画像 1280x960、写真=cover、間取り図=contain white-pad)。
 *
 * Signature 補足 (T001 doc との差分):
 *  - kind の値は "floorplan" / "photo" (T001 doc の floor_plan 表記でなく、
 *    stage 03 と一貫させた検証契約に合わせる)。
 *  - buildMagickOps は寸法を 4 引数目 opts で受ける (T001 doc はハードコード版)。
 *    寸法を後段 stage から渡せるよう引数化する kento 合意 (2026-06-18) を優先。
 *  - buildUpscaleArgs は modelsDir を渡し、-m <modelsDir> を引数に含める
 *    (元 shell の realesrgan 呼び出しに合わせる)。
 */

/**
 * 画像をどう加工するか (floorplan / photo) を判定する。
 *
 * 主判定: stage 03 の分類結果。categoryId === "04" もしくは
 *         categoryLabel === "間取り図" なら floorplan。
 * 副判定: 分類結果が間取り図でないとき、pixelStats (whitePct / satPct) が
 *         渡されていれば white 率 > 60% かつ 彩度 < 6 で floorplan に倒す。
 *
 * @param {{ categoryId?: string, categoryLabel?: string }} img
 * @param {{ whitePct?: number, satPct?: number }} [pixelStats=null]
 * @returns {"floorplan" | "photo"}
 */
function classifyImageKind(img, pixelStats = null) {
  const i = img || {};
  // primary gate — stage 03 classification
  if (i.categoryId === "04" || i.categoryLabel === "間取り図") {
    return "floorplan";
  }
  // pixel heuristic — fallback only (when not classified as floor plan)
  if (pixelStats && typeof pixelStats.whitePct === "number" && typeof pixelStats.satPct === "number") {
    if (pixelStats.whitePct > 60 && pixelStats.satPct < 6) {
      return "floorplan";
    }
  }
  return "photo";
}

/**
 * adaptive gamma の補正指数を返す。
 * brightnessPct は 0-100% スケール (明るさの割合)。
 *
 *   < 40 → "1.22"
 *   < 50 → "1.16"
 *   < 60 → "1.11"
 *   else → "1.06"
 *
 * @param {number} brightnessPct  明るさ [0, 100]
 * @returns {string}              gamma 指数 (magick -gamma にそのまま渡せる文字列)
 */
function pickGamma(brightnessPct) {
  if (brightnessPct < 40) return "1.22";
  if (brightnessPct < 50) return "1.16";
  if (brightnessPct < 60) return "1.11";
  return "1.06";
}

/**
 * gray-world 仮定で per-channel ゲインを計算する。
 *
 *   gain_c = 1 + 0.5 * (overall_mean / channel_mean - 1)
 *
 * (元 shell と等価。overall_mean = (R+G+B)/3。)
 *
 * @param {number} rMean  R チャンネル平均 [0, 255]
 * @param {number} gMean  G チャンネル平均 [0, 255]
 * @param {number} bMean  B チャンネル平均 [0, 255]
 * @returns {{ gr: number, gg: number, gb: number }}  ゲイン係数
 */
function buildGrayWorldGains(rMean, gMean, bMean) {
  const overall = (rMean + gMean + bMean) / 3;
  const gain = (channel) => 1 + 0.5 * (overall / channel - 1);
  return {
    gr: gain(rMean),
    gg: gain(gMean),
    gb: gain(bMean),
  };
}

/**
 * 1 画像分の ImageMagick 引数配列を組み立てる。
 *
 * 返り値は spawn("magick", [inputPath, ...ops, outputPath]) の "...ops" 部分。
 * inputPath / outputPath は含めない (呼び出し側が前後に付ける)。
 *
 * photo (in order):
 *   gray-world WB (-channel R/G/B -evaluate multiply <gain>)
 *   -gamma <gamma>
 *   -modulate 100,<100+satBoost>,100  (彩度ブースト)
 *   -resize <W>x<H>^ -gravity center -extent <W>x<H>  (cover)
 *   -quality 92
 *
 * floorplan:
 *   -resize <W>x<H> -background white -gravity center -extent <W>x<H>  (contain pad)
 *   -quality 92
 *
 * @param {"floorplan" | "photo"} kind
 * @param {{ gr: number, gg: number, gb: number }} gains  gray-world ゲイン (floorplan では無視)
 * @param {string} gamma  adaptive gamma 指数 (floorplan では無視)
 * @param {{ targetW: number, targetH: number, satBoost?: number }} opts
 * @returns {string[]}  magick 引数配列 (input/output を除く)
 */
function buildMagickOps(kind, gains, gamma, opts) {
  const o = opts || {};
  const W = o.targetW;
  const H = o.targetH;
  const dim = `${W}x${H}`;

  if (kind === "floorplan") {
    // contain (white pad) — アスペクト比を保ったまま白背景で枠合わせ
    return [
      "-resize", dim,
      "-background", "white",
      "-gravity", "center",
      "-extent", dim,
      "-quality", "92",
    ];
  }

  // photo: WB → gamma → 彩度 → cover crop
  const satBoost = typeof o.satBoost === "number" ? o.satBoost : 5;
  const g = gains || {};
  return [
    // gray-world white balance, per channel
    "-channel", "R", "-evaluate", "multiply", String(g.gr),
    "-channel", "G", "-evaluate", "multiply", String(g.gg),
    "-channel", "B", "-evaluate", "multiply", String(g.gb),
    "+channel",
    // adaptive gamma
    "-gamma", String(gamma),
    // saturation boost (modulate brightness,saturation,hue)
    "-modulate", `100,${100 + satBoost},100`,
    // cover crop to target dimensions
    "-resize", `${dim}^`,
    "-gravity", "center",
    "-extent", dim,
    "-quality", "92",
  ];
}

/**
 * realesrgan-ncnn-vulkan の引数配列を組み立てる。
 *
 * Emits: ["-i", inputPath, "-o", outputPath, "-n", modelName, "-m", modelsDir]
 *
 * @param {string} inputPath   入力 JPEG の絶対パス
 * @param {string} outputPath  出力の絶対パス
 * @param {string} modelName   モデル名 (例: "realesrgan-x4plus")
 * @param {string} modelsDir   モデルディレクトリの絶対パス
 * @returns {string[]}         spawn(binaryPath, args) の args
 */
function buildUpscaleArgs(inputPath, outputPath, modelName, modelsDir) {
  return [
    "-i", inputPath,
    "-o", outputPath,
    "-n", modelName,
    "-m", modelsDir,
  ];
}

module.exports = {
  classifyImageKind,
  pickGamma,
  buildGrayWorldGains,
  buildMagickOps,
  buildUpscaleArgs,
};
