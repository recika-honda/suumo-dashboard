/**
 * skills/forrent/fill-texts.js — forrent.jp テキスト系フィールド入力
 *
 * 元: skills/forrent.js (Phase 7 分割前)
 *
 * Public surface:
 *   - fillTexts(mainFrame, catchCopy, freeComment, reinsData, initialCostData?)
 *   - sanitizeForLength(text, maxLen)
 *   - toFullWidth(str)
 *   - norm(str)
 *
 * 注意:
 *   - sanitizeForLength は CRLF +1 char anti-pattern を予防する hot path
 *     (test-sanitize-for-length.js で 14 cases 検証済)
 *   - biko だけは toFullWidth 前段が必須 (forrent 備考欄が半角カナ・半角英数字禁止)
 *     ので fillTexts 内で inline 処理を維持
 */

function norm(str) {
  if (!str) return "";
  return str
    .replace(/[Ａ-Ｚａ-ｚ０-９]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(/　/g, " ")
    .trim();
}

/**
 * forrent.jp の備考・特記事項欄向け全角変換
 * 半角カナ・半角英数字・半角記号が禁止のため、全て全角に変換する
 */
function toFullWidth(str) {
  if (!str) return "";
  // Half-width katakana → full-width katakana
  const kanaMap = {
    "ｶﾞ":"ガ","ｷﾞ":"ギ","ｸﾞ":"グ","ｹﾞ":"ゲ","ｺﾞ":"ゴ",
    "ｻﾞ":"ザ","ｼﾞ":"ジ","ｽﾞ":"ズ","ｾﾞ":"ゼ","ｿﾞ":"ゾ",
    "ﾀﾞ":"ダ","ﾁﾞ":"ヂ","ﾂﾞ":"ヅ","ﾃﾞ":"デ","ﾄﾞ":"ド",
    "ﾊﾞ":"バ","ﾋﾞ":"ビ","ﾌﾞ":"ブ","ﾍﾞ":"ベ","ﾎﾞ":"ボ",
    "ﾊﾟ":"パ","ﾋﾟ":"ピ","ﾌﾟ":"プ","ﾍﾟ":"ペ","ﾎﾟ":"ポ",
    "ｳﾞ":"ヴ",
    "ｱ":"ア","ｲ":"イ","ｳ":"ウ","ｴ":"エ","ｵ":"オ",
    "ｶ":"カ","ｷ":"キ","ｸ":"ク","ｹ":"ケ","ｺ":"コ",
    "ｻ":"サ","ｼ":"シ","ｽ":"ス","ｾ":"セ","ｿ":"ソ",
    "ﾀ":"タ","ﾁ":"チ","ﾂ":"ツ","ﾃ":"テ","ﾄ":"ト",
    "ﾅ":"ナ","ﾆ":"ニ","ﾇ":"ヌ","ﾈ":"ネ","ﾉ":"ノ",
    "ﾊ":"ハ","ﾋ":"ヒ","ﾌ":"フ","ﾍ":"ヘ","ﾎ":"ホ",
    "ﾏ":"マ","ﾐ":"ミ","ﾑ":"ム","ﾒ":"メ","ﾓ":"モ",
    "ﾔ":"ヤ","ﾕ":"ユ","ﾖ":"ヨ",
    "ﾗ":"ラ","ﾘ":"リ","ﾙ":"ル","ﾚ":"レ","ﾛ":"ロ",
    "ﾜ":"ワ","ｦ":"ヲ","ﾝ":"ン",
    "ｧ":"ァ","ｨ":"ィ","ｩ":"ゥ","ｪ":"ェ","ｫ":"ォ",
    "ｯ":"ッ","ｬ":"ャ","ｭ":"ュ","ｮ":"ョ",
    "ｰ":"ー","｡":"。","｢":"「","｣":"」","､":"、","･":"・",
  };
  // Replace dakuten/handakuten combos first (2-char → 1-char), then singles
  let result = str;
  for (const [hw, fw] of Object.entries(kanaMap)) {
    result = result.split(hw).join(fw);
  }
  // Half-width ASCII (0x21-0x7E) → full-width (0xFF01-0xFF5E)
  // Space (0x20) → full-width space (0x3000)
  result = result.replace(/[\x20-\x7E]/g, c => {
    if (c === " ") return "　";
    return String.fromCharCode(c.charCodeAt(0) + 0xFEE0);
  });
  return result;
}

/**
 * 文字数制限のある forrent フィールド向け sanitizer。
 * 改行 (LF/CRLF) を全角スペースに置換してから slice する。
 * HTML form 送信時に textarea の \n は \r\n に展開されるため、
 * ローカルで slice(0, N) しても改行を含むとサーバ側で N+1 char 扱いになり
 * 「N 文字以内」バリデーションで弾かれる anti-pattern を予防する。
 * 長さ制限のある全フィールド (catchCopy / freeComment / netCatch / netFreeMemo / etcHiyoShosai 等) で必ず通すこと。
 */
function sanitizeForLength(text, maxLen) {
  if (!maxLen || maxLen <= 0) return "";
  if (typeof text !== "string") return "";
  return text.replace(/[\r\n]+/g, "　").slice(0, maxLen);
}

/**
 * forrent.jp の「半角カナ・半角英数字・半角記号禁止」かつ「N 文字以内」の text フィールド向け
 * (catchCopy / freeComment / netCatch / netFreeMemo / etcHiyoShosai 等)。
 *
 * 処理:
 *   1. NFKD normalize → "Grandé" (1 char é) を "Grande" + combining acute に分解、
 *      "ヴ" (1 char) も "ウ" + U+3099 (濁点 combining mark) に分解される
 *   2. **Latin diacritics のみ** strip (U+0300-U+036F) → "é" → "e"。日本語の濁点・
 *      半濁点 (U+3099, U+309A) は残す。
 *   3. NFC で recompose → 「ウ」+ U+3099 を「ヴ」に戻す (日本語破壊を避ける)。
 *      Latin combining marks は既に strip 済みなので "Grande" のまま。
 *   4. toFullWidth → ASCII 半角文字を全部全角に
 *   5. 改行 (LF/CRLF) を全角スペースに置換
 *   6. slice(0, maxLen)
 *
 * Why NFKD+strip diacritics+NFC: text-ai が "Grandé Nakaochai" のような diacritic 付き
 * Latin 文字を生成すると、ブラウザ送信時に "é" が HTML entity "&#233;" (8 chars) に
 * 展開されてサーバ側でカウントが膨らみ、ローカル slice しても "N文字以内"
 * バリデーションで弾かれる anti-pattern が発生する。同様に NFKD 後 NFC せずに送信すると
 * 「ヴ」が「ウ」+「&#12441;」に展開され (1 char → 9 chars) overflow + 禁止文字エラー。
 * (再現: 100139121297 Grandé / 100139127191 Phase 3a smoke "ヴィヴェール")
 */
function sanitizeForForrentText(text, maxLen) {
  if (!maxLen || maxLen <= 0) return "";
  if (typeof text !== "string") return "";
  const normalized = text
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .normalize("NFC");
  return toFullWidth(normalized).replace(/[\r\n]+/g, "　").slice(0, maxLen);
}

async function fillTexts(mainFrame, catchCopy, freeComment, reinsData, initialCostData = null) {
  const errors = [];

  // テキストを制限内にtruncate（フリーコメント=100文字、キャッチ=30文字）
  // sanitizeForForrentText は CRLF anti-pattern に加えて、NFKD + strip diacritics +
  // toFullWidth を適用して forrent 「禁止文字 (半角カナ・半角英数字・半角記号)」と
  // 「é → &#233; HTML entity 展開で N+5 char overflow」の両方を予防する。
  // (再現: 100139121297 "フリーコメントには、100文字以内で入力してください" + 禁止文字 — 「Grandé」原因)
  const truncCatch = sanitizeForForrentText(catchCopy, 30);
  const truncComment = sanitizeForForrentText(freeComment, 100);

  // REINS備考情報から特記事項テキストを構築（全備考+フリースペース+一時金を結合して漏れ防止）
  // forrent.jpの備考欄は半角カナ・半角英数字・記号が禁止 → 全角変換
  const bikoRaw = reinsData
    ? [reinsData.備考1, reinsData.備考2, reinsData.備考3,
       reinsData.条件フリー, reinsData.設備フリー, reinsData.その他一時金].filter(Boolean).join(" ")
    : "";
  // 改行 (\n / \r\n) は forrent 送信時に CRLF に展開され、サーバ側「200文字以内」
  // バリデータが 1 改行 = 2 文字としてカウントするため、slice 前に全角スペースへ置換する。
  // (再現済み: 100138979162 / 100139003800 の REG_FAIL — 200 → 201 として弾かれた)
  // 注: ここは sanitizeForLength を使わず inline で書いている。biko は forrent 備考欄
  //     (半角カナ・半角英数字禁止) なので toFullWidth が前段に必須。汎用 sanitizeForLength
  //     には全角化を入れていない (catchCopy 等 AI 出力の半角英数を保持したい経路があるため)。
  const biko = toFullWidth(bikoRaw).replace(/[\r\n]+/g, "　").slice(0, 200);

  // Build cost item descriptions for etcHiyoShosai
  const costItems = [];
  if (initialCostData) {
    const costMap = { "鍵交換代": "鍵交換代", "消毒代": "消毒代", "クリーニング代": "クリーニング代",
      "サポート代": "サポート代", "事務手数料": "事務手数料" };
    for (const [key, label] of Object.entries(costMap)) {
      if (initialCostData[key] && initialCostData[key] > 0) {
        costItems.push(`${label}${initialCostData[key].toLocaleString()}円`);
      }
    }
  }

  // Fixed text for net-facing fields (staff request)
  // sanitize 経由で構築 → 将来この文言が AI 化 / 設定値化されても CRLF anti-pattern を踏まない
  const NET_CATCH = sanitizeForLength("お電話番号記載のお客様限定【仲介手数料割引キャンペーン中】", 30);
  const NET_FREE_MEMO = sanitizeForLength("お急ぎやご質問の方はファンテイズ03-6403-9323大木まで！現地お待ち合わせでご紹介できます！(他社掲載物件まとめて内見可能)家賃交渉、初期費用の相談などお気軽にご相談下さい！", 200);

  // etcHiyoShosai 用テキストを Node.js 側で構築 (evaluate 内重複ロジックの排除と sanitize 経由の徹底)
  let etcTextRaw = "鍵交換代・その他初期費用";
  if (costItems.length > 0) {
    etcTextRaw = costItems.join("、");
  } else if (biko) {
    const costKeywords = ["鍵交換", "消毒", "クリーニング", "保険", "損保", "火災", "初期費用",
      "鍵代", "消臭", "室内清掃", "安心サポート", "入居サポート", "24時間サポート",
      "抗菌", "害虫駆除", "仲介手数料", "事務手数料", "書類作成", "契約事務",
      "サポート代", "サポート費", "保証料", "更新料", "更新事務"];
    const sentences = biko.split(/[、。\n]+/).map(s => s.trim()).filter(Boolean);
    const costParts = sentences.filter(s => costKeywords.some(k => s.includes(k)));
    if (costParts.length > 0) etcTextRaw = costParts.join("、");
  }
  // 「ほか初期費用詳細」は forrent 側で半角カナ・半角数字・半角記号を禁止文字として
  // バリデーション弾きする。costItems から構築するルートは toLocaleString() が
  // "70,840" のように半角数字+半角カンマを返すので toFullWidth で必ず正規化する。
  // (再現: 100139127191 / 100139119717 で REG_FAIL "ほか初期費用詳細に禁止文字..." )
  const etcHiyoText = sanitizeForLength(toFullWidth(etcTextRaw), 200);

  // evaluate() で直接 DOM 操作（フレーム状態に左右されにくい）
  try {
    const result = await mainFrame.evaluate(({ catchCopy, freeComment, biko, netCatch, netFreeMemo, etcHiyoText }) => {
      const out = [];
      const fields = [
        { id: "bukkenCatch", val: catchCopy },
        { id: "netCatch", val: netCatch },
        { id: "netFreeMemo", val: netFreeMemo },
        { id: "freeMemo", val: freeComment },
      ];
      // 特記事項 — REINS備考があれば設定
      if (biko) {
        fields.push({ id: "tokkiJiko", val: biko });
        fields.push({ id: "tokkiEtcMemo", val: biko });
      }

      for (const f of fields) {
        const el = document.getElementById(f.id);
        if (el) {
          el.value = f.val;
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
          out.push(f.id);
        } else {
          out.push(`!${f.id}`);
        }
      }
      // name属性でしかアクセスできないtextarea（IDなし）
      // etcHiyoShosai: etcHiyoFlg=ON時に必須 (構築は Node.js 側で sanitize 経由で実施済み)
      // hoshoninDaikoShosai: 保証人代行会社の詳細
      const nameFields = [];
      nameFields.push({ name: '${bukkenInputForm.etcHiyoShosai}', val: etcHiyoText, label: 'etcHiyoShosai' });
      // hoshoninDaikoShosai is now set in fillFormFields (section 19)
      for (const nf of nameFields) {
        const el = document.querySelector('[name="' + nf.name + '"]');
        if (el) {
          el.value = nf.val;
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
          out.push(nf.label);
        } else {
          out.push('!' + nf.label);
        }
      }
      return out;
    }, { catchCopy: truncCatch, freeComment: truncComment, biko, netCatch: NET_CATCH, netFreeMemo: NET_FREE_MEMO, etcHiyoText });

    const ok = result.filter(r => !r.startsWith("!"));
    const ng = result.filter(r => r.startsWith("!")).map(r => r.slice(1));
    for (const id of ng) errors.push(`${id}: element not found`);
    console.log(`[forrent] texts: ${ok.length} filled (${ok.join(", ")}), ${ng.length} missing`);
  } catch (e) {
    errors.push(`texts: ${e.message.slice(0, 80)}`);
  }

  return errors;
}

module.exports = {
  norm,
  toFullWidth,
  sanitizeForForrentText,
  sanitizeForLength,
  fillTexts,
};
