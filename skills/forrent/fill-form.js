/**
 * skills/forrent/fill-form.js — forrent.jp 棟情報/所在地/お金/間取り フォーム入力
 *
 * 元: skills/forrent.js (Phase 7 分割前)
 *
 * Public surface:
 *   - fillPropertyForm(mainFrame, reinsData, initialCostData?)  メインのフォーム入力 orchestrator
 *
 * 内部ヘルパー (export はしない、内部利用のみ):
 *   - fillMoneyFields    お金系フィールド (賃料・管理費・敷金・礼金)
 *   - fillDeposit        敷金・礼金の特殊処理
 *   - fillConditionRadios 入居条件ラジオボタン群
 *
 * 依存:
 *   - form-helpers: fillById/fillByName/selectByName/selectById/setCheckbox/selectRadioByIndex/waitForCascade
 *   - fill-texts: norm
 *   - validate: resolvePropertyTypeCode
 *   - constants: S (Struts prefix), STRUCTURE_CODE, MADORI_TYPE_CODE
 */

const {
  fillById,
  fillByName,
  selectByName,
  selectById,
  setCheckbox,
  selectRadioByIndex,
  waitForCascade,
} = require("./form-helpers");
const { norm, sanitizeForLength, toFullWidth } = require("./fill-texts");
const { resolvePropertyTypeCode } = require("./validate");
const { S, STRUCTURE_CODE, MADORI_TYPE_CODE } = require("./constants");

// ══════════════════════════════════════════════════════════
//  MAIN FORM FILL — 決定論的フィールドマッピング
// ══════════════════════════════════════════════════════════

async function fillPropertyForm(mainFrame, reinsData, initialCostData = null) {
  const filled = {};
  const errors = [];
  const ok = (name, result) => {
    if (result) filled[name] = true;
    else errors.push(name);
  };

  console.log("[forrent] === FORM FILL START ===");

  // ═══ 1. 棟情報 ═══

  // 物件名 — id="bukkenNm", max=35
  ok("物件名", await fillById(mainFrame, "bukkenNm", reinsData.建物名, "物件名"));

  // 地上階建 — id="kai", max=2
  const floors = norm(reinsData.地上階層)?.match(/(\d+)/)?.[1];
  if (floors) ok("地上階建", await fillById(mainFrame, "kai", floors, "地上階建"));

  // 地下階建 — id="chikaInput", max=1
  const bFloors = norm(reinsData.地下階層)?.match(/(\d+)/)?.[1];
  if (bFloors) ok("地下階建", await fillById(mainFrame, "chikaInput", bFloors, "地下階建"));

  // 階部分 — id="kaibubun", max=5
  // 優先順位: 1) 所在階が有効な数字, 2) 部屋番号から推定（901→9, 1201→12）, 3) 部屋番号1-2桁の場合
  let floor = null;
  const rawFloor = norm(reinsData.所在階 || "");
  if (/^\d+$/.test(rawFloor)) {
    floor = rawFloor;
  } else if (reinsData.部屋番号) {
    const digits = norm(reinsData.部屋番号).replace(/\D/g, "");
    if (digits.length >= 3) {
      floor = String(parseInt(digits.slice(0, -2), 10)); // 901→9, 1201→12
    } else if (digits.length === 1 || digits.length === 2) {
      // 小規模物件: 部屋番号が1-2桁 → 地上階建が2-3階なら部屋番号の先頭桁を階に
      const totalFloors = parseInt(norm(reinsData.地上階層 || "")?.match(/(\d+)/)?.[1] || "0", 10);
      if (totalFloors > 0 && totalFloors <= 5 && parseInt(digits[0], 10) <= totalFloors) {
        floor = digits[0]; // "4"→4階, "201"→already handled above
      }
    }
  }
  if (floor) ok("階部分", await fillById(mainFrame, "kaibubun", floor, "階部分"));

  // 号室 — id="heyaNoInput", max=10, 半角英数記号のみ
  // 念のため入力直前にも全角→半角正規化 + 最終チェック（REINS側と二重防御）
  if (reinsData.部屋番号) {
    const raw = String(reinsData.部屋番号).trim();
    const normalized = raw
      .replace(/[\uFF01-\uFF5E]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xFEE0))
      .replace(/[\u3000\s]+/g, "")
      .trim();
    if (/^[\x21-\x7E]{1,10}$/.test(normalized)) {
      ok("号室", await fillById(mainFrame, "heyaNoInput", normalized, "号室"));
    } else {
      console.log(`[forrent] 号室スキップ: "${raw}" は半角10桁以内を満たさない`);
    }
  }

  // 物件種別 — select name="${bukkenInputForm.bukkenShuCd}"
  //   マンション(01), アパート(02), 一戸建て(11), テラス・タウンハウス(16), その他(99)
  //   木造/軽量鉄骨の場合は物件種目がマンションでもアパート(02)に強制変更
  //   必須フィールドのため、マッピングに失敗した場合は "その他"(99) でフォールバック。
  if (reinsData.物件種目) {
    let code = resolvePropertyTypeCode(norm(reinsData.物件種目));
    const struct = norm(reinsData.建物構造 || "");
    if (code === "01" && /木造|軽量鉄骨|LS/.test(struct)) {
      code = "02"; // マンション+木造/軽量鉄骨 → アパート
    }
    if (!code) {
      console.log(`[forrent] 物件種別マッピング失敗: "${reinsData.物件種目}" → その他(99) でフォールバック`);
      code = "99";
    }
    ok("物件種別", await selectByName(mainFrame, `${S}bukkenShuCd}`, code, "物件種別"));
  }

  // 構造 — select name="${bukkenInputForm.kozoShuCd}"
  //   鉄筋コン(01)..その他(99)  ※必須フィールド — マッチしない場合はその他(99)で埋める
  {
    let structCode = "99"; // fallback: その他
    if (reinsData.建物構造) {
      const structNorm = norm(reinsData.建物構造).replace(/造$/, "");
      const matched = STRUCTURE_CODE[structNorm];
      if (matched) {
        structCode = matched;
      } else {
        console.log(`[forrent] ! 構造: "${structNorm}" → マッチなし → その他(99)にフォールバック`);
      }
    } else {
      console.log("[forrent] ! 構造: REINS未取得 → その他(99)にフォールバック");
    }
    ok("構造", await selectByName(mainFrame, `${S}kozoShuCd}`, structCode, "構造"));
  }

  // 築年 — id="Wareki2Seireki1", max=4 (西暦)
  const chikuNorm = norm(reinsData.築年月);
  const yearM = chikuNorm?.match(/(\d{4})年/);
  if (yearM) {
    ok("築年", await fillById(mainFrame, "Wareki2Seireki1", yearM[1], "築年"));
  } else {
    // 築年月が不明の場合は必須フィールドなのでフォールバック（1990年1月）
    console.log("[forrent] ! 築年月が不明 → 1990年1月をフォールバック");
    await fillById(mainFrame, "Wareki2Seireki1", "1990", "築年(FB)");
    ok("築年", true);
  }

  // 築月 — name="${bukkenInputForm.chikuGetsu}", no id, max=2
  // 月がない場合（"1974年（昭和49年）"等）は1月をデフォルト
  const monthM = chikuNorm?.match(/(\d{1,2})月/);
  const chikuMonth = monthM ? monthM[1] : "1";
  ok("築月", await fillByName(mainFrame, `${S}chikuGetsu}`, chikuMonth, "築月"));

  // 新築/中古/未入居（入居区分） — shinchikuKbnCd: 1=新築, 2=中古, 3=未入居
  // 必須フィールド（バリデーション「入居区分を選択してください」を回避）
  {
    let shinchikuIdx = 0; // default: 中古 (value=2, index=0=#shinchikuKbnCd1)
    if (yearM) {
      const builtYear = parseInt(yearM[1], 10);
      const builtMonth = monthM ? parseInt(monthM[1], 10) : 1;
      const now = new Date();
      // 築1年未満 (=12ヶ月未満) → 新築。月精度で判定しないと、年初の物件で +14ヶ月でも
      // 「currentYear - builtYear = 1」となり 新築扱いされる事故が発生する
      // (再現済み: 100138970003 — 2025年1月築 / 2026-04 入稿で「築年月が1年以上前」エラー)
      const monthsSinceBuilt = (now.getFullYear() - builtYear) * 12 + (now.getMonth() + 1 - builtMonth);
      if (monthsSinceBuilt < 12) {
        shinchikuIdx = 1; // value=1, index=1=#shinchikuKbnCd2
      }
    }
    // 現況が「空室」で入居時期が「即時」で築年月が新しい → 未入居の可能性
    // ただし安全策として中古/新築の2択に限定
    ok("入居区分", await selectRadioByIndex(mainFrame, "shinchikuKbnCd", shinchikuIdx));
    if (filled["入居区分"]) console.log(`[forrent] + 入居区分: ${shinchikuIdx === 0 ? "中古" : "新築"}`);
  }

  // ═══ 2. 所在地 ═══

  // 都道府県 — id="todofukenList" (default=東京都)
  if (reinsData.都道府県名) {
    ok("都道府県", await selectById(mainFrame, "todofukenList", reinsData.都道府県名, "都道府県"));
    await mainFrame.waitForTimeout(1500);
  }

  // 市郡区 — id="shigunkuList" (cascade from 都道府県)
  if (reinsData.所在地名１) {
    ok("市郡区", await selectById(mainFrame, "shigunkuList", reinsData.所在地名１, "市郡区"));
    // 町村リストの読み込みを待つ
    await waitForCascade(mainFrame, "chosonList", 5000);
  }

  // 町村 — id="chosonList" (cascade from 市郡区)
  // REINS 所在地名２ は "神田神保町１丁目" のように丁目付きの場合がある
  // → chosonList には "神田神保町" のみなので、丁目部分を分離して aza 選択に使う
  let azaFromTown = null; // 所在地名２から抽出した丁目番号（半角）
  if (reinsData.所在地名２) {
    const townInput = norm(reinsData.所在地名２);
    const townSplit = townInput.match(/^(.+?)(\d+)丁目$/);
    if (townSplit) {
      // "神田神保町1丁目" → town="神田神保町", aza="1"
      ok("町村", await selectById(mainFrame, "chosonList", townSplit[1], "町村"));
      azaFromTown = townSplit[2]; // "1"
    } else {
      ok("町村", await selectById(mainFrame, "chosonList", townInput, "町村"));
    }
    // 字丁リストの読み込みを待つ
    await waitForCascade(mainFrame, "azaList", 5000);
  }

  // 字丁 — id="azaList" (cascade from 町村)
  // forrent.jp azaList の選択肢テキストは全角数字のみ: "１","２","３"
  // 丁目情報は 所在地名２ or 所在地名３ のどちらかに含まれる
  {
    const addr3 = norm(reinsData.所在地名３ || "");
    const azaFromAddr3 = addr3.match(/^(\d+)丁目/)?.[1] || null;
    const azaDigit = azaFromTown || azaFromAddr3;

    if (azaDigit) {
      // 半角→全角数字変換 (e.g. "1" → "１")
      const fullwidth = azaDigit.replace(/\d/g, c =>
        String.fromCharCode(c.charCodeAt(0) + 0xFEE0)
      );
      const azaOk = await selectById(mainFrame, "azaList", fullwidth, "字丁");
      ok("字丁", azaOk);
      await mainFrame.waitForTimeout(1000);
      // 残りを番地へ
      const rest = azaFromTown
        ? addr3  // 丁目は所在地名２にあった → 所在地名３は全て番地
        : addr3.replace(/^\d+丁目/, "").trim();
      if (rest) ok("番地", await fillById(mainFrame, "banchiNm", rest, "番地"));
    } else {
      // 丁目なし（一番町、二番町 等）→ azaListの最初の有効オプションを選択
      const azaSelected = await mainFrame.evaluate(() => {
        const el = document.getElementById("azaList");
        if (!el) return false;
        const opts = Array.from(el.options).filter(o => o.value && o.value !== "");
        if (opts.length > 0) {
          el.value = opts[0].value;
          el.dispatchEvent(new Event("change", { bubbles: true }));
          return opts[0].text;
        }
        return false;
      });
      if (azaSelected) {
        ok("字丁", true);
        console.log(`[forrent] + 字丁(auto): "${azaSelected}"`);
        await mainFrame.waitForTimeout(1000);
      }
      if (addr3) ok("番地", await fillById(mainFrame, "banchiNm", addr3, "番地"));
    }

    // 番地が未設定の場合（新築等で番地未確定）→ ハイフンをデフォルト設定
    const banchiVal = await mainFrame.evaluate(() => document.getElementById("banchiNm")?.value || "");
    if (!banchiVal.trim()) {
      ok("番地", await fillById(mainFrame, "banchiNm", "-", "番地(デフォルト)"));
    }
  }

  // ═══ 3. 会社間流通チェックボックス OFF ═══
  // id="bukkenNmDispFlg"   — 物件名を公開
  // id="heyaNoDispFlg"     — 部屋番号を公開
  // id="shosaiJushoDispFlg1" — 詳細住所を公開
  await setCheckbox(mainFrame, "bukkenNmDispFlg", false, "会社間流通:物件名");
  await setCheckbox(mainFrame, "heyaNoDispFlg", false, "会社間流通:部屋番号");
  await setCheckbox(mainFrame, "shosaiJushoDispFlg1", false, "会社間流通:詳細住所");

  // ═══ 4. お金 ═══
  await fillMoneyFields(mainFrame, reinsData, ok);

  // ═══ 5. 間取り ═══

  // 間取りタイプ — select name="${bukkenInputForm.madoriTypeKbnCd}"
  //   ワンルーム(01), K(02), DK(03), SDK(04), LDK(05), SLDK(06), LK(07), SK(08), SLK(09)
  const madoriCode = reinsData.間取タイプ ? MADORI_TYPE_CODE[norm(reinsData.間取タイプ)] : null;
  if (madoriCode) ok("間取りタイプ", await selectByName(mainFrame, `${S}madoriTypeKbnCd}`, madoriCode, "間取りタイプ"));

  // 部屋数 — id="heyaCntInput", max=2
  // ワンルーム(01)の場合、部屋数は入力不可（バリデーションエラーになる）
  if (madoriCode !== "01") {
    const rooms = norm(reinsData.間取部屋数)?.match(/(\d+)/)?.[1];
    if (rooms) ok("部屋数", await fillById(mainFrame, "heyaCntInput", rooms, "部屋数"));
  }

  // 面積 — id="mensekiIntegerInput"(max=3) + id="mensekiDecimalInput"(max=2)
  const areaStr = norm(reinsData.使用部分面積)?.replace(/㎡|m2/gi, "");
  if (areaStr) {
    const parts = areaStr.split(".");
    ok("面積(整数)", await fillById(mainFrame, "mensekiIntegerInput", parts[0], "面積(整数)"));
    ok("面積(小数)", await fillById(mainFrame, "mensekiDecimalInput", parts[1] || "00", "面積(小数)"));
  }

  // ═══ 6. 入居時期（状況区分） ═══
  // nyukyoKbnCd1(即=1), nyukyoKbnCd2(相談=2), nyukyoKbnCd3(年月指定=3)
  // evaluate で直接設定 + onclick ハンドラ発火（frame内 click() が不安定なため）
  {
    const nyukyo = norm(reinsData.入居時期 || "");
    let nyukyoId = "nyukyoKbnCd2"; // default: 相談
    if (/即/.test(nyukyo)) {
      nyukyoId = "nyukyoKbnCd1";
    } else {
      const ymMatch = nyukyo.match(/(\d{4})\s*年\s*(\d{1,2})\s*月/);
      if (ymMatch) {
        nyukyoId = "nyukyoKbnCd3";
        await mainFrame.waitForTimeout(300);
        await fillByName(mainFrame, `${S}nyukyoNen}`, ymMatch[1], "入居年");
        await fillByName(mainFrame, `${S}nyukyoTsuki}`, ymMatch[2], "入居月");
      }
    }
    const nyukyoResult = await mainFrame.evaluate((id) => {
      const radio = document.getElementById(id);
      if (!radio) return false;
      radio.checked = true;
      radio.dispatchEvent(new Event("change", { bubbles: true }));
      // Fire onclick handler directly (doVisible etc.)
      if (radio.onclick) radio.onclick();
      else if (radio.getAttribute("onclick")) {
        try { new Function(radio.getAttribute("onclick")).call(radio); } catch {}
      }
      return true;
    }, nyukyoId);
    ok("入居時期", nyukyoResult);
    if (nyukyoResult) console.log(`[forrent] + 入居時期: ${nyukyoId} (${nyukyo || "相談"})`);
    else console.log(`[forrent] x 入居時期: ${nyukyoId} 設定失敗`);
    await mainFrame.waitForTimeout(300);
  }

  // ═══ 7. 取引態様 ═══
  // 修正点6: 常に仲介先物(4)を選択
  try {
    await mainFrame.selectOption("#torihikiTaiyoKbnCd", "4");
    console.log("[forrent] + 取引態様: code=4 (仲介先物)");
    filled["取引態様"] = true;
  } catch (e) {
    console.log(`[forrent] x 取引態様: ${e.message.slice(0, 60)}`);
    errors.push("取引態様");
  }

  // ═══ 8. ★マーク（客付可） ═══
  // hoshiFlg1=あり(1), hoshiFlg2=なし(0) — 必須選択
  ok("★マーク", await mainFrame.evaluate(() => {
    const el = document.getElementById("hoshiFlg1");
    if (el) {
      el.checked = true;
      el.dispatchEvent(new Event("change", { bubbles: true }));
      return true;
    }
    return false;
  }));
  if (filled["★マーク"]) console.log("[forrent] + ★マーク: あり");

  // ═══ 9. 地図表示 ═══
  // mapHyojiFlg — ネットの地図上で物件を表示する
  await setCheckbox(mainFrame, "mapHyojiFlg", true, "地図表示");
  filled["地図表示"] = true;

  // ═══ 10. 条件radioボタン ═══
  // 各条件のデフォルト: 可(1)/不可(2)/相談(3) — REINSデータがなければ「相談(3)」or「可(1)」
  await fillConditionRadios(mainFrame, reinsData, ok);

  // ═══ 11. 仲介手数料 ═══
  // chukaiTesuryoFlg: index 0=あり — 仲介先物なので常にあり
  ok("仲介手数料", await selectRadioByIndex(mainFrame, "chukaiTesuryoFlg", 0));

  // ═══ 12. 管理形態 ═══
  // kanriKeitaiKbnCd: index 3 = 指定なし（41pt実績値）
  ok("管理形態", await selectRadioByIndex(mainFrame, "kanriKeitaiKbnCd", 3));

  // ═══ 13. 省エネルギー ═══
  // energyKbnCd: index 0 = 対象外（41pt実績値）
  ok("省エネ", await selectRadioByIndex(mainFrame, "energyKbnCd", 0));

  // ═══ 14. 定期借家 + 契約期間（修正点1） ═══
  // 常に契約期間を設定する（定期借家/普通借家共通）
  {
    const isTeiki = reinsData.備考3 && /定期借家|定借/.test(norm(reinsData.備考3));

    // 契約期間パース: REINS「契約期間」フィールド or 備考3
    let contractNen = "2"; // デフォルト: 2年
    const contractRaw = norm(reinsData.契約期間 || "");
    const nenMatch = contractRaw.match(/(\d+)\s*年/);
    const monthMatch = contractRaw.match(/(\d+)\s*(?:ヶ?月|月)/);
    if (nenMatch) {
      contractNen = nenMatch[1];
    } else if (monthMatch) {
      contractNen = String(Math.ceil(parseInt(monthMatch[1]) / 12));
    }
    // 備考3からの年数で上書き
    if (isTeiki) {
      const biko3 = norm(reinsData.備考3 || "");
      const bikoNen = biko3.match(/定期借家\D*(\d+)年/);
      if (bikoNen) contractNen = bikoNen[1];
      ok("定期借家", await selectRadioByIndex(mainFrame, "teikiShakuyaFlg", 0));
    }

    // 契約期間: 年/月指定 + 年数を常に設定
    await selectRadioByIndex(mainFrame, "teikiShakuyaKbnCd", 1);
    await fillByName(mainFrame, `${S}teikiShakuyaNen}`, contractNen, "契約年数");
    ok("契約期間", true);
    console.log(`[forrent] + 契約期間: ${contractNen}年 ${isTeiki ? "(定期借家)" : "(普通借家)"}`);
  }

  // ═══ 15. 保証人代行 ═══
  // hoshoninDaikoKbnCd: index 1 (value="2") = 必加入（先方指定ルール）
  // Options: index 0 = 任意加入, index 1 = 必加入
  ok("保証人代行", await selectRadioByIndex(mainFrame, "hoshoninDaikoKbnCd", 1));

  // ═══ 16. BB(ブロードバンド)対応 ═══
  // bbCpyKbnCd: index 1 = 2番目の選択肢（41pt実績値）
  ok("BB対応", await selectRadioByIndex(mainFrame, "bbCpyKbnCd", 1));

  // ═══ 17. その他費用 ═══
  // etcHiyoFlg + etcHiyo1(万) + etcHiyo2(百) — 初期費用（鍵交換代、消毒、クリーニング等）
  // Priority: 物確 structured data > REINS biko regex > default 2万
  try {
    await setCheckbox(mainFrame, "etcHiyoFlg", true, "その他費用");
    let totalYen = 0;
    const foundItems = [];
    let source = "";

    // (A) 物確 structured data — sum of 鍵交換代 + 消毒代 + クリーニング代 + サポート代 + 事務手数料
    if (initialCostData) {
      const costKeys = ["鍵交換代", "消毒代", "クリーニング代", "サポート代", "事務手数料"];
      for (const key of costKeys) {
        if (initialCostData[key] && initialCostData[key] > 0) {
          totalYen += initialCostData[key];
          foundItems.push(`${key}${initialCostData[key]}円`);
        }
      }
      if (totalYen > 0) source = "bukaku";
    }

    // (B) REINS biko regex fallback
    if (totalYen === 0) {
      const allBiko = norm([reinsData.その他一時金, reinsData.備考1, reinsData.備考2, reinsData.備考3,
        reinsData.条件フリー].filter(Boolean).join(" "));
      const costPatterns = [
        /鍵交換[代費]?\D*([\d,.]+)\s*円/g,
        /(?:室内)?消毒[代費]?\D*([\d,.]+)\s*円/g,
        /クリーニング[代費]?\D*([\d,.]+)\s*円/g,
        /(?:室内)?清掃[代費]?\D*([\d,.]+)\s*円/g,
        /抗菌[代費]?\D*([\d,.]+)\s*円/g,
        /害虫駆除[代費]?\D*([\d,.]+)\s*円/g,
        /(?:安心|入居|24時間)サポート[代費]?\D*([\d,.]+)\s*円/g,
        /事務手数料\D*([\d,.]+)\s*円/g,
        /書類作成[代費]?\D*([\d,.]+)\s*円/g,
      ];
      for (const pat of costPatterns) {
        let m;
        while ((m = pat.exec(allBiko)) !== null) {
          const yen = parseInt(m[1].replace(/[,\.]/g, ""), 10);
          if (yen > 0 && yen < 500000) {
            totalYen += yen;
            foundItems.push(`${m[0].replace(/\D*([\d,.]+)\s*円/, '')}${yen}円`);
          }
        }
      }
      if (totalYen === 0) {
        const genericMatch = allBiko.match(/(?:初期費用|その他[一費]?[時金]?)\D*([\d,.]+)\s*円/);
        if (genericMatch) {
          totalYen = parseInt(genericMatch[1].replace(/[,\.]/g, ""), 10);
          foundItems.push(`初期費用${totalYen}円`);
        }
      }
      if (totalYen > 0) source = "REINS";
    }

    if (totalYen > 0) {
      const man = Math.floor(totalYen / 10000);
      const sen = Math.round((totalYen % 10000) / 100);
      await fillByName(mainFrame, `${S}etcHiyo1}`, String(man), "その他費用(万)");
      if (sen > 0) await fillByName(mainFrame, `${S}etcHiyo2}`, String(sen).padStart(2, "0"), "その他費用(百)");
      console.log(`[forrent] + その他費用: ${totalYen}円 [${source}] (${foundItems.join(', ')})`);
    } else {
      // (C) Default: 2万円
      console.log("[forrent] ? その他費用: 物確/REINS初期費用データなし → デフォルト2万円");
      await fillByName(mainFrame, `${S}etcHiyo1}`, "2", "その他費用(万)");
    }
    filled["その他費用"] = true;
  } catch (e) {
    console.log(`[forrent] x その他費用: ${e.message.slice(0, 60)}`);
  }

  // ═══ 17.5. その他諸費用（退去時費用含む） ═══
  // etcShohiyoFlg + etcShohiyoShosai
  // forrent 構造 (2026-05-14 確認):
  //   - 「ほか初期費用」(etcHiyo) = 入居時の入会金・鍵交換代等 → セクション 17 で処理
  //   - 「その他諸費用」(etcShohiyo) = 退去時費用・更新料等 → こちら
  // kento 指示: 「まずは『あり』にチェックを入れてから文言入力」「更新料もここに書くのがいい」
  try {
    await setCheckbox(mainFrame, "etcShohiyoFlg", true, "その他諸費用");
    const koshinryo = norm(reinsData.更新料 || "");
    const parts = [];
    if (koshinryo && !/^(なし|ー|0)$/i.test(koshinryo)) {
      parts.push(`更新料 ${koshinryo}`);
    }
    // 備考3 から退去時費用キーワードを含むセンテンスを抽出
    const biko = norm(reinsData.備考3 || "");
    if (biko) {
      const sentences = biko.split(/[、。\n]+/).map(s => s.trim()).filter(Boolean);
      const exitKeywords = ["退去時クリーニング", "退去時", "原状回復", "解約予告", "短期解約", "違約金"];
      for (const s of sentences) {
        if (exitKeywords.some(kw => s.includes(kw)) && !parts.some(p => p.includes(s))) {
          parts.push(s);
        }
      }
    }
    if (parts.length === 0) {
      parts.push("退去時クリーニング代・更新料等は別途ご案内します");
    }
    // 「その他諸費用詳細」も forrent 禁止文字 (半角カナ・半角数字・半角記号) 対象。
    // 更新料 (REINS 生データ) や biko に半角が混ざるので toFullWidth で正規化。
    const shohiText = sanitizeForLength(toFullWidth(parts.join("、")), 200);
    await fillByName(mainFrame, `${S}etcShohiyoShosai}`, shohiText, "その他諸費用詳細");
    console.log(`[forrent] + その他諸費用: ${shohiText.slice(0, 60)}${shohiText.length > 60 ? "..." : ""}`);
    filled["その他諸費用"] = true;
  } catch (e) {
    console.log(`[forrent] x その他諸費用: ${e.message.slice(0, 60)}`);
  }

  // ═══ 18. 損保（火災保険） ═══
  // sonpoFlg checkbox のみ ON。金額・契約年数は入力しない (kento 指示 2026-05-14)
  try {
    await setCheckbox(mainFrame, "sonpoFlg", true, "損保");
    filled["損保"] = true;
  } catch (e) {
    console.log(`[forrent] x 損保: ${e.message.slice(0, 60)}`);
  }

  // ═══ 19. 保証人代行会社区分 ═══
  // hoshoninDaikoKaishaKbnCd: "2" (その他) + 固定テキスト（先方指定ルール）
  try {
    await selectByName(mainFrame, `${S}hoshoninDaikoKaishaKbnCd}`, "2", "保証人代行会社");
    await mainFrame.waitForTimeout(300);
    await fillByName(mainFrame, `${S}hoshoninDaikoShosai}`, "詳細お問い合わせください", "保証会社名");
    console.log("[forrent] + 保証人代行: その他 / 詳細お問い合わせください");
    filled["保証人代行会社"] = true;
  } catch (e) {
    console.log(`[forrent] x 保証人代行会社: ${e.message.slice(0, 60)}`);
  }

  // ═══ 20. 設備環境区分 ═══
  // setsubiKankyoKbnCd / setsubiKankyoKbnCd2: "9" = 指定なし
  try {
    await selectByName(mainFrame, `${S}setsubiKankyoKbnCd}`, "9", "設備環境区分1");
    await selectByName(mainFrame, `${S}setsubiKankyoKbnCd2}`, "9", "設備環境区分2");
    filled["設備環境区分"] = true;
  } catch (e) {
    console.log(`[forrent] x 設備環境区分: ${e.message.slice(0, 60)}`);
  }

  // ═══ 20.5. 駐車場状況区分 ═══
  // chushajoJokyoKbnCd: 1=空あり, 2=空なし, 3=近隣あり
  {
    const parking = norm(reinsData.駐車場 || reinsData.備考3 || "");
    let parkingIdx = 1; // default: 空なし(2) → index 1
    if (/駐車場\s*あり|駐車場\s*有|駐車場.*空|敷地内.*駐|[Pp]arking/i.test(parking)) {
      parkingIdx = 0; // 空あり(1) → index 0
    } else if (/近隣.*駐|駐車場.*近/i.test(parking)) {
      parkingIdx = 2; // 近隣あり(3) → index 2
    }
    ok("駐車場状況", await selectRadioByIndex(mainFrame, "chushajoJokyoKbnCd", parkingIdx));
  }

  // ═══ 21. 元付業者（修正点7-10） ═══
  try {
    // 修正点7: 元付会社名（30文字制限）
    if (reinsData.商号) {
      const gyoshaNm = reinsData.商号.slice(0, 30);
      await fillByName(mainFrame, `${S}mototsukeGyoshaNm}`, gyoshaNm, "元付業者名");
      filled["元付業者名"] = true;
    }
    // 修正点8: 元付担当者名（不明ならハイフン）
    await fillByName(mainFrame, `${S}mototsukeTantoNm}`, "-", "元付担当者名");
    filled["元付担当者名"] = true;
    // 修正点9: 元付電話番号
    const tel = (reinsData.代表電話番号 || "").replace(/[-\s]/g, "");
    if (tel) {
      await fillByName(mainFrame, `${S}mototsukeTelNo}`, tel, "元付電話番号");
      filled["元付電話番号"] = true;
    }
    // 修正点10: 元付確認日 = 入稿当日
    const today = new Date();
    const dateStr = `${today.getFullYear()}/${String(today.getMonth() + 1).padStart(2, "0")}/${String(today.getDate()).padStart(2, "0")}`;
    await fillByName(mainFrame, `${S}mototsukeKakuninDate}`, dateStr, "元付確認日");
    filled["元付確認日"] = true;
  } catch (e) {
    console.log(`[forrent] x 元付業者: ${e.message.slice(0, 60)}`);
  }

  // ═══ 22. 貴社物件コード（修正点11） ═══
  {
    const reinsId = reinsData.物件番号 || "";
    const kishaCode = `fng${reinsId}`;
    await fillByName(mainFrame, `${S}kishaBukkenCd1}`, kishaCode, "貴社物件コード");
    filled["貴社物件コード"] = true;
  }

  // ═══ 22. 開口向き（バルコニー方向） ═══
  // kaikomukiKbnCd: 8択ラジオ (0=北,1=北東,2=東,3=南東,4=南,5=南西,6=西,7=北西)
  {
    const dir = norm(reinsData.バルコニー方向 || "");
    const DIR_MAP = {
      "北": 0, "北東": 1, "東": 2, "南東": 3, "東南": 3,
      "南": 4, "南西": 5, "西南": 5, "西": 6, "北西": 7, "西北": 7,
    };
    const idx = DIR_MAP[dir];
    if (idx !== undefined) {
      ok("開口向き", await selectRadioByIndex(mainFrame, "kaikomukiKbnCd", idx));
    }
  }

  // ═══ 23. 物件名特記フラグ ═══
  // bukkenNmTokkiFlg: checkbox — 名寄せスコア対象の可能性あり
  await setCheckbox(mainFrame, "bukkenNmTokkiFlg", true, "物件名特記");
  filled["物件名特記"] = true;

  // ═══ 24. ネット掲載 ═══
  // shijiIsize: 1=掲載, 3=保留
  try {
    await mainFrame.selectOption("#shijiIsize", "3");
    console.log("[forrent] + ネット掲載: 保留(3)");
    filled["ネット掲載"] = true;
  } catch (e) {
    console.log(`[forrent] x ネット掲載: ${e.message.slice(0, 60)}`);
  }

  // ═══ 24.5. スマピク掲載 ═══
  // DOM search for SmaPic checkbox (ID/name varies)
  try {
    const smapicChecked = await mainFrame.evaluate(() => {
      // Search by known patterns: sumapiku, smapiku, smapic, スマピク
      const candidates = [
        document.getElementById("sumapikuFlg"),
        document.getElementById("smapikuFlg"),
        document.querySelector('[name*="sumapiku"]'),
        document.querySelector('[name*="smapiku"]'),
        document.querySelector('[id*="sumapiku"]'),
        document.querySelector('[id*="smapiku"]'),
      ].filter(Boolean);
      // Also search by label text
      if (candidates.length === 0) {
        const labels = document.querySelectorAll("label");
        for (const label of labels) {
          if (label.textContent.includes("スマピク")) {
            const forId = label.getAttribute("for");
            if (forId) {
              const el = document.getElementById(forId);
              if (el) candidates.push(el);
            }
            const cb = label.querySelector('input[type="checkbox"]');
            if (cb) candidates.push(cb);
          }
        }
      }
      if (candidates.length > 0) {
        const cb = candidates[0];
        if (!cb.checked) {
          cb.checked = true;
          cb.dispatchEvent(new Event("change", { bubbles: true }));
        }
        return { found: true, id: cb.id || cb.name || "unknown" };
      }
      return { found: false };
    });
    if (smapicChecked.found) {
      console.log(`[forrent] + スマピク掲載: ON (${smapicChecked.id})`);
      filled["スマピク掲載"] = true;
    } else {
      console.log("[forrent] ? スマピク掲載: checkbox not found in DOM");
    }
  } catch (e) {
    console.log(`[forrent] x スマピク掲載: ${e.message.slice(0, 60)}`);
  }

  // ═══ 25. 見学予約（修正点3） ═══
  // kengakuYoyaku: checkbox — ネット掲載=掲載(1)の場合は常にチェック
  await setCheckbox(mainFrame, "kengakuYoyaku", true, "見学予約");
  filled["見学予約"] = true;

  // ═══ 26. 店舗案内ピックアップ（修正点4） ═══
  await setCheckbox(mainFrame, "tenpiku", true, "店舗案内ピックアップ");
  filled["店舗案内ピックアップ"] = true;

  // ═══ 27. 得意なエリア枠（修正点5） ═══
  await setCheckbox(mainFrame, "tokueri", true, "得意なエリア枠");
  filled["得意なエリア枠"] = true;

  console.log("[forrent] === FORM FILL END ===");
  console.log(`[forrent] OK: ${Object.keys(filled).length}, NG: ${errors.length}`);
  if (errors.length > 0) console.log(`[forrent] ERRORS: ${errors.join(", ")}`);

  return { filled, errors };
}

// ── お金フィールド ──
async function fillMoneyFields(f, data, ok) {
  // ── 賃料: chinryo1(万) + chinryo2(千) ──
  // REINS: "7.0万円" → chinryo1="7", chinryo2="0"
  // REINS: "10.5万円" → chinryo1="10", chinryo2="5"
  const rentM = norm(data.賃料)?.match(/([\d.]+)万/);
  if (rentM) {
    const man = parseFloat(rentM[1]);
    const c1 = Math.floor(man);
    const c2 = Math.round((man - c1) * 10); // 千の位
    ok("賃料(万)", await fillByName(f, `${S}chinryo1}`, String(c1), "賃料(万)"));
    ok("賃料(千)", await fillByName(f, `${S}chinryo2}`, String(c2), "賃料(千)"));
  }

  // ── 管理費/共益費: kanrihi1(万) + kanrihi2(円) ──
  // REINS: "5,000円" → kanrihi1="", kanrihi2="5000"
  // 共益費 or 管理費 のどちらかに金額がある
  const mgmtRaw = norm(data.共益費) || "";
  const mgmtRaw2 = norm(data.管理費) || "";
  const mgmtM = mgmtRaw.match(/([\d,]+)円/) || mgmtRaw2.match(/([\d,]+)円/);
  if (mgmtM) {
    const yen = parseInt(mgmtM[1].replace(/,/g, ""));
    const man = Math.floor(yen / 10000);
    const rem = yen % 10000;
    if (man > 0) ok("管理費(万)", await fillByName(f, `${S}kanrihi1}`, String(man), "管理費(万)"));
    ok("管理費(円)", await fillByName(f, `${S}kanrihi2}`, String(rem), "管理費(円)"));
  } else if (/なし|ー|^0$/.test(mgmtRaw) || /なし|ー|^0$/.test(mgmtRaw2)) {
    await setCheckbox(f, "kanrihiFlg", false, "管理費フラグ");
  } else {
    // REINSに管理費/共益費データなし → フラグOFF（「なし」扱い）
    console.log("[forrent] ? 管理費/共益費: データなし → フラグOFF");
    await setCheckbox(f, "kanrihiFlg", false, "管理費フラグ");
  }

  // ── 敷金: shikikin1 + shikikin2 + shikikinKbnCd(ヶ月=1/万円=2) ──
  await fillDeposit(f, data.敷金, {
    flgId: "shikikinFlg",
    n1: `${S}shikikin1}`, n2: `${S}shikikin2}`,
    monthId: "shikikinKbnCd1", yenId: "shikikinKbnCd2",
    label: "敷金",
  }, ok);

  // ── 礼金: reikin1 + reikin2 + reikinKbnCd(ヶ月=1/万円=2) ──
  await fillDeposit(f, data.礼金, {
    flgId: "reikinFlg",
    n1: `${S}reikin1}`, n2: `${S}reikin2}`,
    monthId: "reikinKbnCd1", yenId: "reikinKbnCd2",
    label: "礼金",
  }, ok);

  // ── 保証金: hoshokin1 + hoshokin2 + hoshokinKbnCd(ヶ月=1/万円=2) ──
  // REINS 保証金が空 / "なし" / "ー" / "0" の場合は hoshokinFlg を OFF
  await fillDeposit(f, data.保証金, {
    flgId: "hoshokinFlg",
    n1: `${S}hoshokin1}`, n2: `${S}hoshokin2}`,
    monthId: "hoshokinKbnCd1", yenId: "hoshokinKbnCd2",
    label: "保証金",
  }, ok);

  // ── 償却金: shokyakukin1 + shokyakukin2 + shokyakukinKbnCd ──
  // REINS の償却は (償却コード / 償却月数 / 償却率) の 3 つで表現される。
  // forrent 側は ヶ月単位 / 万円単位 がメインなので、償却月数 → "Nヶ月" 文字列に変換して
  // fillDeposit に流す。償却率のみのケースは当面 OFF (forrent input が率対応していない)。
  let shokyakuRaw = null;
  if (data.償却月数) {
    shokyakuRaw = `${data.償却月数}ヶ月`;
  } else if (data.償却コード && /^[1-9]\d*$/.test(String(data.償却コード).trim())) {
    // REINS によっては償却月数が空でコードに数字だけ入るケース → 月数扱い
    shokyakuRaw = `${data.償却コード}ヶ月`;
  }
  // 償却率のみ (例: "50%") は forrent 入力フォームに率 input が無いため OFF 固定
  await fillDeposit(f, shokyakuRaw, {
    flgId: "shokyakukinFlg",
    n1: `${S}shokyakukin1}`, n2: `${S}shokyakukin2}`,
    monthId: "shokyakukinKbnCd1", yenId: "shokyakukinKbnCd2",
    label: "償却金",
  }, ok);
}

/** 敷金/礼金: "1ヶ月" or "10万円" or "50,000円" or "なし" */
async function fillDeposit(f, raw, cfg, ok) {
  if (!raw) {
    await setCheckbox(f, cfg.flgId, false, `${cfg.label}フラグ`);
    return;
  }
  const s = raw.trim();
  if (s === "ー" || s === "0" || /^なし$/i.test(s) || s === "") {
    await setCheckbox(f, cfg.flgId, false, `${cfg.label}フラグ`);
    return;
  }
  // "1ヶ月", "2ヶ月", "1.5ヶ月", "1か月", "1カ月" pattern
  // Form has two fields: n1 (integer) + n2 (decimal) — e.g. "1.5" → n1="1", n2="5"
  const monthM = s.match(/(\d+\.?\d*)(?:ヶ|か|カ)?月/);
  if (monthM) {
    await f.click(`#${cfg.monthId}`).catch(() => {});
    await f.waitForTimeout(200);
    const v = parseFloat(monthM[1]);
    const intPart = Math.floor(v);
    const decPart = Math.round((v - intPart) * 10);
    ok(`${cfg.label}(整数)`, await fillByName(f, cfg.n1, String(intPart), `${cfg.label}(ヶ月・整数)`));
    if (decPart > 0) ok(`${cfg.label}(小数)`, await fillByName(f, cfg.n2, String(decPart), `${cfg.label}(ヶ月・小数)`));
    return;
  }
  // "10万円", "10.5万円" pattern
  const manM = s.match(/([\d.]+)万/);
  if (manM) {
    await f.click(`#${cfg.yenId}`).catch(() => {});
    await f.waitForTimeout(200);
    const v = parseFloat(manM[1]);
    ok(`${cfg.label}(万)`, await fillByName(f, cfg.n1, String(Math.floor(v)), `${cfg.label}(万)`));
    const sen = Math.round((v - Math.floor(v)) * 10);
    if (sen > 0) ok(`${cfg.label}(千)`, await fillByName(f, cfg.n2, String(sen), `${cfg.label}(千)`));
    return;
  }
  // "50,000円", "100000円" — convert to 万 unit
  const yenM = s.match(/([\d,]+)\s*円/);
  if (yenM) {
    const yen = parseInt(yenM[1].replace(/,/g, ""), 10);
    if (yen > 0) {
      await f.click(`#${cfg.yenId}`).catch(() => {});
      await f.waitForTimeout(200);
      const man = Math.floor(yen / 10000);
      const sen = Math.round((yen % 10000) / 1000);
      ok(`${cfg.label}(万)`, await fillByName(f, cfg.n1, String(man), `${cfg.label}(万)`));
      if (sen > 0) ok(`${cfg.label}(千)`, await fillByName(f, cfg.n2, String(sen), `${cfg.label}(千)`));
      return;
    }
  }
  // Pure number — treat as months (split integer/decimal)
  const numM = s.match(/^(\d+\.?\d*)$/);
  if (numM) {
    await f.click(`#${cfg.monthId}`).catch(() => {});
    await f.waitForTimeout(200);
    const v = parseFloat(numM[1]);
    const intPart = Math.floor(v);
    const decPart = Math.round((v - intPart) * 10);
    ok(`${cfg.label}(整数)`, await fillByName(f, cfg.n1, String(intPart), `${cfg.label}(ヶ月・整数)`));
    if (decPart > 0) ok(`${cfg.label}(小数)`, await fillByName(f, cfg.n2, String(decPart), `${cfg.label}(ヶ月・小数)`));
    return;
  }
  // Unrecognized format (e.g. "保証金") — flag OFF
  console.log(`[forrent] ? ${cfg.label}: unknown format "${raw}" → フラグOFF`);
  await setCheckbox(f, cfg.flgId, false, `${cfg.label}フラグ`);
}

// ── 条件radioボタン一括設定 ──
// 入居条件 (法人/学生/性別/単身/二人/子ども/ペット/楽器/事務所/ルームシェア)
// REINSデータから判別できる場合はそちらを優先、不明なら「相談(3)」or「可(1)」
async function fillConditionRadios(mainFrame, reinsData, ok) {
  // 各条件: [radioName, defaultIndex, label]
  // 41pt実績: 全て index 0（可/不問）がデフォルト
  // ペット・楽器・事務所・ルームシェア: index 0=不可(2択の場合)
  const conditions = [
    ["hojinKbnCd", 0, "法人入居"],      // idx0=可, 1=不可, 2=相談
    ["gakuseiKbnCd", 0, "学生"],         // idx0=可, 1=不可, 2=相談
    ["seibetsuKbnCd", 0, "男女"],        // idx0=不問, 1=男性のみ, 2=女性のみ
    ["tanshinKbnCd", 0, "単身"],         // idx0=可, 1=不可, 2=相談
    ["futariKbnCd", 0, "二人入居"],      // idx0=可, 1=不可
    ["kodomoKbnCd", 0, "子ども"],        // idx0=可, 1=不可, 2=相談
    ["petKbnCd", 0, "ペット"],           // idx0=不可(2択), REINSでペット可なら変更
    ["gakkiKbnCd", 0, "楽器"],           // idx0=不可(2択)
    ["jimushoRiyoKbnCd", 0, "事務所利用"],// idx0=不可(2択)
    ["roomShareKbnCd", 0, "ルームシェア"],// idx0=不可(2択)
  ];

  // REINSデータから条件を推測（index override）
  const overrides = {};
  const setsubi = norm(reinsData.設備 || "");
  const joukenFree = norm(reinsData.条件フリー || "");
  const biko = norm(reinsData.備考3 || "");
  const setsubiFree = norm(reinsData.設備フリー || "");
  const combined = [setsubi, joukenFree, biko, setsubiFree].join(" ");

  // Detect pet/instrument/office/roomshare from REINS data
  // 3-choice radio: idx0=不可, idx1=可, idx2=相談
  // ペット飼育可能な場合でも「相談」(idx=2)を設定（先方運用統一）
  if (/ペット可|ペット相談|ペットOK|ペット飼育可|小型犬|猫/.test(combined)) {
    overrides["petKbnCd"] = 2; // 相談
  }
  if (/楽器可|楽器相談|楽器OK|ピアノ可/.test(combined)) {
    overrides["gakkiKbnCd"] = 1; // 可
  }
  if (/事務所可|事務所利用可|SOHO|事務所相談/.test(combined)) {
    overrides["jimushoRiyoKbnCd"] = 1; // 可
  }
  if (/ルームシェア可|ルームシェア相談/.test(combined)) {
    overrides["roomShareKbnCd"] = 1; // 可
  }

  let filledCount = 0;
  for (const [name, defaultIdx, label] of conditions) {
    const idx = overrides[name] ?? defaultIdx;
    const result = await selectRadioByIndex(mainFrame, name, idx);
    if (result) filledCount++;
  }
  ok("入居条件", filledCount > 0);
  console.log(`[forrent] + 入居条件: ${filledCount}/${conditions.length}項目設定`);
}

// 交通 (Phase 7 で skills/forrent/fill-transport.js に分離)

// ══════════════════════════════════════════════════════════
//  テキスト入力
// ══════════════════════════════════════════════════════════


module.exports = {
  fillPropertyForm,
};
