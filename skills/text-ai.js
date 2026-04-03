/**
 * AI Text Pipeline — GPT-4o-mini
 *
 * Generates キャッチコピー and フリーコメント from REINS property data
 * to maximize SUUMO 名寄せスコア (2 points for catch copy + comment).
 */

const OpenAI = require("openai");

const openai = new OpenAI();

/**
 * Generate catch copy and free comment from REINS property data.
 *
 * @param {Object} reinsData - Extracted REINS property data
 * @returns {{catchCopy: string, freeComment: string}}
 */
async function generateTexts(reinsData) {
  const transport = reinsData.交通?.[0];
  const propSummary = [
    `物件名: ${reinsData.建物名 || "不明"}`,
    `所在地: ${reinsData.都道府県名 || ""}${reinsData.所在地名１ || ""}${reinsData.所在地名２ || ""}`,
    transport
      ? `交通: ${transport.沿線} ${transport.駅}駅 徒歩${transport.徒歩}`
      : null,
    `賃料: ${reinsData.賃料 || "不明"}`,
    `間取り: ${reinsData.間取部屋数 || ""}${reinsData.間取タイプ || ""}`,
    `面積: ${reinsData.使用部分面積 || "不明"}`,
    `築年月: ${reinsData.築年月 || "不明"}`,
    `構造: ${reinsData.建物構造 || "不明"}`,
    `階数: ${reinsData.所在階 || ""}/${reinsData.地上階層 || ""}階建`,
    reinsData.バルコニー方向
      ? `バルコニー: ${reinsData.バルコニー方向}`
      : null,
    reinsData.設備 ? `設備: ${reinsData.設備}` : null,
    reinsData.設備フリー ? `設備(詳細): ${reinsData.設備フリー}` : null,
  ]
    .filter(Boolean)
    .join("\n");

  const prompt = `あなたは賃貸物件の広告コピーライターです。
以下の物件データからSUUMO掲載用テキストを生成してください。

${propSummary}

以下の2点をJSONで出力（説明不要、JSONのみ）:
1. catchCopy: キャッチコピー（全角15文字以内。物件の最大の魅力を端的に）
2. freeComment: フリーコメント（全角200文字以内。設備・交通・環境の魅力を丁寧語で）

制約:
- 事実ベース。誇張・最上級表現禁止（最高級/No.1/一番/最安値）
- フリーコメントは「〜です。〜ございます。」体
- 駅徒歩分数、間取り、築年数など具体的数値を含める`;

  try {
    const response = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      max_tokens: 500,
      messages: [{ role: "user", content: prompt }],
    });

    const text = (response.choices[0]?.message?.content || "").trim();
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    return jsonMatch ? JSON.parse(jsonMatch[0]) : JSON.parse(text);
  } catch (err) {
    console.error("Text generation failed, using template:", err.message);
    return generateFallback(reinsData);
  }
}

/**
 * Template-based fallback when Claude API is unavailable.
 */
function generateFallback(reinsData) {
  const transport = reinsData.交通?.[0];
  const stationInfo = transport
    ? `${transport.駅}駅徒歩${transport.徒歩}`
    : "";

  return {
    catchCopy: stationInfo
      ? `${stationInfo}の好立地`
      : `${reinsData.間取部屋数 || ""}${reinsData.間取タイプ || ""}の快適空間`,
    freeComment: [
      `${reinsData.建物名 || "当物件"}は`,
      stationInfo ? `${stationInfo}の好立地に位置しております。` : "",
      reinsData.間取部屋数 && reinsData.間取タイプ
        ? `${reinsData.間取部屋数}${reinsData.間取タイプ}、`
        : "",
      reinsData.使用部分面積 ? `${reinsData.使用部分面積}の広さで` : "",
      `快適にお過ごしいただけます。`,
      reinsData.設備 ? `${reinsData.設備}等の設備が充実しております。` : "",
      `ぜひお気軽にお問い合わせください。`,
    ]
      .filter(Boolean)
      .join("")
      .slice(0, 200),
  };
}

module.exports = { generateTexts };
