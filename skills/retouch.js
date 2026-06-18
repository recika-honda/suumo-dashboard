/**
 * skills/retouch.js — image-retouch の純粋ヘルパー群 (stage 04b 用)
 *
 * 元ロジック: kento 承認済の手元スクリプト ~/Desktop/suumo-nyuko/retouch-listing-images.sh
 * 設計 SSOT:   docs/refactor/retouch-stage-design.md (T001)
 *
 * これらは全て pure function。I/O / 副作用なし (fs / child_process / sharp を require しない)。
 * 値・LUT・sharp resize plan・realesrgan 引数を「組み立てて返す」だけで、
 * 実 spawn / sharp 実行は呼び出し側 (stage 04b) の責務。
 *
 * 加工エンジン: ImageMagick CLI ではなく sharp (既存パイプラインと同じ。本番機に magick が無く
 *   brew が別ユーザ所有で入れられないため、2026-06-18 に magick → sharp へ切替)。
 *   sharp の .gamma() は magick -gamma と挙動が異なるため、明るさ(ガンマ)は per-channel LUT
 *   (WB ゲイン × ガンマを畳んだ 256 段変換表) で magick と数値一致させる。
 *
 * 寸法は呼び出し側から targetW / targetH を渡す
 * (kento 合意 2026-06-18: 全画像 1280x960、写真=cover、間取り図=contain white-pad、JPEG Q92)。
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
 * @returns {string}              gamma 指数 (buildChannelLut にそのまま渡せる)
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
 * 1 チャンネル分の 256 段ルックアップテーブルを作る。
 * WB ゲイン (乗算) と adaptive gamma (べき乗カーブ) を 1 本の表に畳む。
 *
 *   out = round( 255 * clamp01( (i/255) * gain ) ^ (1/gamma) )
 *
 * これは magick の `-channel C -evaluate multiply gain` → `-gamma g` と数値等価
 * (実測: reins_3 で magick -gamma1.14 と LUT で明るさ持ち上げ幅が一致)。
 * sharp はこの表を画素バッファに per-channel 適用するだけで magick と同じ結果になる。
 *
 * 不変条件: i=0 → 0、フル白 (clamp 後 1.0) → 255 (端点保存 = 白飛びさせない)。
 * gain=1 かつ gamma=1 のとき恒等 (lut[i] === i)。
 *
 * @param {number} gain          チャンネルゲイン (gray-world WB)。1.0 で無補正
 * @param {number|string} gamma  adaptive gamma 指数 (>1 で中間調を持ち上げ)
 * @returns {Buffer}             長さ 256 の Uint8 変換表
 */
function buildChannelLut(gain, gamma) {
  const g = typeof gamma === "string" ? parseFloat(gamma) : gamma;
  const inv = 1 / g;
  const lut = Buffer.alloc(256);
  for (let i = 0; i < 256; i++) {
    let v = (i / 255) * gain;
    if (v > 1) v = 1;
    else if (v < 0) v = 0;
    lut[i] = Math.max(0, Math.min(255, Math.round(255 * Math.pow(v, inv))));
  }
  return lut;
}

/**
 * 彩度ブースト量 (0-100 の delta) を sharp.modulate({saturation}) の倍率に変換。
 *   satBoost=5 → 1.05 (= magick -modulate 100,105,100 と等価)。
 *
 * @param {number} satBoost  彩度の増分 [%], 既定 5
 * @returns {number}         sharp saturation 倍率
 */
function saturationMultiplier(satBoost) {
  const b = typeof satBoost === "number" ? satBoost : 5;
  return 1 + b / 100;
}

/**
 * sharp.resize() に渡すオプションを kind 別に組み立てる。
 *   photo     → cover (中央 crop で 4:3 ぴったり)
 *   floorplan → contain + 白 pad (線を切らない)
 *
 * @param {"floorplan" | "photo"} kind
 * @param {number} targetW
 * @param {number} targetH
 * @returns {{ width:number, height:number, fit:string, position?:string, background?:object }}
 */
function buildResizePlan(kind, targetW, targetH) {
  if (kind === "floorplan") {
    return {
      width: targetW,
      height: targetH,
      fit: "contain",
      background: { r: 255, g: 255, b: 255 },
    };
  }
  return {
    width: targetW,
    height: targetH,
    fit: "cover",
    position: "centre",
  };
}

/**
 * raw RGB(A) バッファから white 率 (%) と HSL 彩度平均 (%) を計算する。
 * 間取り図 pixel-fallback 判定の入力 (classifyImageKind の pixelStats)。
 *
 *   white = 全チャンネル >= 252 (≒99% 白) の画素割合
 *   sat   = HSL S の画素平均 (magick の HSL S 平均と整合)
 *
 * @param {Buffer|Uint8Array} data  raw 画素 (channels バイト/画素)
 * @param {number} channels         1 画素あたりバイト数 (3 or 4)
 * @returns {{ whitePct:number, satPct:number }}
 */
function computePixelStats(data, channels) {
  const ch = channels || 3;
  const px = Math.floor(data.length / ch);
  if (px === 0) return { whitePct: 0, satPct: 0 };
  let whiteCount = 0;
  let satSum = 0;
  for (let p = 0; p < px; p++) {
    const o = p * ch;
    const r = data[o];
    const g = data[o + 1];
    const b = data[o + 2];
    if (r >= 252 && g >= 252 && b >= 252) whiteCount++;
    const mx = Math.max(r, g, b);
    const mn = Math.min(r, g, b);
    if (mx !== mn) {
      const L = (mx + mn) / 2 / 255;
      const d = (mx - mn) / 255;
      satSum += d / (1 - Math.abs(2 * L - 1));
    }
  }
  return {
    whitePct: (whiteCount / px) * 100,
    satPct: (satSum / px) * 100,
  };
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
  buildChannelLut,
  saturationMultiplier,
  buildResizePlan,
  computePixelStats,
  buildUpscaleArgs,
};
