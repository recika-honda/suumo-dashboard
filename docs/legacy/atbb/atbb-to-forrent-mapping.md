# ATBB → forrent.jp マッピング表

REINS は廃止しない（テキストデータの主ソース）が、**画像と初期費用** の取得を ATBB に切り替える。本ドキュメントは ATBB 物件詳細ページの DOM 構造と forrent.jp 入力欄の対応表。

検証物件: 「三宿高橋荘 203」（東急田園都市線 池尻大橋）
検証日: 2026-05-13
検証 URL: `https://atbb.athome.co.jp/front-web/mainservlet/bfcm381s016`

---

## ATBB 物件詳細ページのセクション構成

XPath ルート: `/html/body/table/tbody/tr[3]/td/table/tbody/tr/td[2]/form[2]`

| div index | class | title | 内容 |
|-----------|-------|-------|------|
| 0 | top-buttons | — | 操作ボタン群 |
| 1 | contents_box | — | 物件概要（住所等） |
| 2 | flex | — | サムネ画像 |
| 3 | contents_box conpact | — | 簡易情報 |
| **4** | **contents_box withCarousel** | **画像N点** | **物件画像（カルーセル）** |
| **5** | **contents_box** | **建物情報** | **建物情報・費用・契約条件 の 3 テーブル** |
| 6 | toggle-button | — | 折りたたみ |
| **7** | **contents_box** | **会員間情報** | **仲介手数料(報酬)・取引態様・登録会員 等** |

⚠️ ユーザー提供 XPath の `div[6]/p[2]` は環境差で `div[5]/p[2]` の場合もある。
スキル実装では **`p.box_title` のテキストで「費用」「契約条件」「会員間情報」を識別** する方が頑健。

---

## 画像取得

```javascript
// div[4] = 画像セクション
const imgUrls = Array.from(
  imageDiv.querySelectorAll("img")
).map(i => i.src)
 .filter(src => src.includes("img4.athome.jp/image_files/path/"));
```

- 画像 URL の形式: `https://img4.athome.jp/image_files/path/<hash>`
- 同じ画像が複数回出現する場合がある（カルーセルの先頭サムネ重複）→ URL で dedup 必須
- alt 属性は空。カテゴリ分類は **Claude Vision に投げる（既存 image-ai.js のまま）**

---

## 費用テーブル（建物情報セクション内 2nd table）

セレクタ: `div[title="建物情報"] > table:nth-of-type(2)`
セル構造: `<td class="common-head">ラベル</td><td class="common-data">値</td>` (1 行に 1 or 2 ペア)

### ATBB 費用項目 一覧

| ATBB ラベル | 値の型 | 値の例 |
|------------|--------|--------|
| 賃料 | **画像** (`<img id="price_img_X-Y">`) | `txt2img?...` OCR or 別ソース必要 |
| 管理費 | テキスト | "なし" / "X円" / "Xヶ月" |
| 礼金 | テキスト | "なし" / "Xヶ月" / "X万円" |
| 敷金 | テキスト | "なし" / "Xヶ月" / "X万円" |
| 敷引 | テキスト | "" / "あり" / "X万円" |
| 共益費 | テキスト | "なし" / "X円/月" |
| 雑費 | テキスト | "" / "X円" |
| 鍵交換代等 | テキスト | "" / "X円" |
| 保証金 | テキスト | "なし" / "X万円" |
| 保証金償却 | テキスト | "" / "X円" / "Xヶ月" |
| 賃貸保証 | テキスト | "" / 保証会社情報 |
| クレジットカード決済 | テキスト | "" / "可" |
| 保険等加入 | テキスト | "加入要" / "" |
| その他一時金 | テキスト | "" / 金額 |
| ランニングコスト | テキスト | "" / 金額 |

### 契約条件テーブル（建物情報セクション内 3rd table）

| ATBB ラベル | 値の例 |
|------------|--------|
| 現況 | "空家" / "居住中" |
| 入居日 | "即時" / "YYYY/MM/DD" |
| 契約期間 | "2年" / "X年Xヶ月" / "定期借家 X年" |
| 更新料 | "" / "新賃料Xヶ月" |
| 入居条件 | テキスト |
| 設備保証 | テキスト |
| フリーレント | テキスト |

### 会員間情報テーブル（div[title="会員間情報"]）

forrent.jp 入稿で必須となる重要項目:

| ATBB ラベル | 値の例 | forrent 用途 |
|------------|--------|-------------|
| 報酬 | "■客付手数料 借主：100％ 客付：100％" | **仲介手数料 + AD 計算** |
| 取引態様 | "★媒介" / "代理" / "貸主" | 取引態様欄 |
| 登録会員 | 元付業者の社名・住所・TEL | 元付確認用 |
| 広告転載 | "■アットホーム媒体：転載不可" | 広告掲載可否 |
| 内見情報 | "内見可能" | 備考送り |
| 鍵情報 | 鍵 ID 等 | 内見手配時 |
| 公開満了日 | "YYYY/MM/DD" | 期限管理 |

---

## forrent.jp 入力欄 → ATBB ソース 対応表

forrent.jp の「お金・駐車場等」セクションを基準に、ATBB 由来データへのマッピング。

| forrent.jp 項目 | UI 入力形式 | ATBB ソース | 変換ロジック | フォールバック |
|---|---|---|---|---|
| **月額賃料** | 万円 | 賃料 (画像) | OCR or **REINS の `賃料`** を優先 | REINS（現状通り） |
| **管理費** | あり チェック + 万円/月 | 共益費 + 管理費 | "X,XXX円/月" → 万円換算 (例: 3,000円 → 0.3万円)。両者を合算 | REINS `管理費` |
| **礼金** | あり + ヶ月 or 万円 | 礼金 | "Xヶ月" → ヶ月欄、"X万円" → 万円欄、"なし" → チェックoff | REINS `礼金` |
| **敷金** | あり + ヶ月 or 万円 | 敷金 | 同上 | REINS `敷金` |
| **敷金積増** | あり + 総額 | (なし) | ATBB に該当項目なし → 空のまま | — |
| **償却金** | あり | 保証金償却 | "" → off、値あり → on | — |
| **敷引** | あり | 敷引 | "" → off、値あり → on | — |
| **保証金** | あり + 万円 | 保証金 | "なし" → off、"X万円" → on + 値 | REINS `保証金` |
| **ほか初期費用** (入会金等) | あり + 詳細 | 鍵交換代等 + 雑費 + その他一時金 | 全て連結 or "あり" にトグル | — |
| **その他諸費用** (退去時費用含む) | あり + 詳細 | ランニングコスト + 備考の抽出 | テキスト連結 | — |
| **仲介手数料** | 指定なし / あり / 不要 | 報酬 (会員間情報) | "借主：100％" → "あり"、"借主：50％" → 半月、"借主：0％" → "不要" | REINS / デフォルト 1ヶ月 |
| **損保** | 要 + 万円/年 | 保険等加入 | "加入要" → 要 (金額は別途デフォルト or 備考から) | — |
| **契約期間** | 普通借家 / 定期借家 / 指定なし + 年・ヶ月 | 契約期間 | "定期借家" 文字あれば定期、なければ普通借家。"X年" → 年欄、"Xヶ月" → ヶ月欄 | REINS `契約期間` |
| **保証会社** | あり | 賃貸保証 | "" → off、値あり → on | — |
| **駐車場 (付無料・有)** | あり | 建物情報の `駐車場` | "あり" or 詳細 | REINS `駐車場` |
| **特優賃** | あり | (なし) | ATBB に該当項目なし | — |

---

## ATBB 検索仕様の注意

検証で判明した制約:

1. **検索対象**: ATBB に「流通契約」で公開されている物件のみ。REINS にあっても ATBB に出ていない物件は検索不能（→ Stage 02 で REG_FAIL `ATBB_NOT_FOUND`）
2. **検索フォーム**: `/html/body/.../form/table[2]/tbody/tr[2]/td/div[1]/label/input` (= `name=atbbShumokuDaibunrui` value=06 「賃貸居住用」) を選んでから `freeWordSearchSubject` に建物名入力 → `searchFreeWord(...)` ボタンクリック
3. **検索結果リンク**: `<button id="shosai_N">詳細</button>`（N は 0 始まり） → `imgAuthCheckShosaiClicked()` 経由でページ遷移
4. **reCAPTCHA**: 検索送信時に v3 reCAPTCHA が動くが（score 0.3〜0.8）、通常ログイン状態では自動通過
5. **賃料の画像化**: 賃料欄は `txt2img` API で動的画像生成される（スクレイピング防止）。マッピング上は **REINS の賃料を使う方が確実**

---

## 賃料ソースの方針（重要決定事項）

ATBB は賃料を画像化している。OCR を組むより **REINS の賃料を主にする** のが現実的：

- **賃料・管理費・敷金・礼金の数値部分** → REINS（既に Stage 01 で抽出済み）
- **会員間情報（報酬 = 仲介手数料・AD）** → ATBB（REINS にない、ATBB の主要価値）
- **物件画像** → ATBB（REINS より多い、ATBB の主要価値）
- **契約期間・現況・入居日・保証会社等の細目** → ATBB を優先、REINS で補完

つまり ATBB の主要 ROI は **画像 + AD/手数料 + 補助項目**。賃料の OCR は不要。

---

## Stage 02 (atbb-fetch) の入出力契約（提案）

### Input
```typescript
{
  reinsData: {
    建物名: string,    // ATBB フリーワード検索のキー
    部屋番号: string,  // 検索結果から該当物件を絞り込むキー
    賃料: string,      // 結果との突合 (誤マッチ検知用)
  },
  context: BrowserContext,
  downloadDir: string,
}
```

### Output (成功時)
```typescript
{
  status: "OK",
  atbbData: {
    images: Array<{ url: string, localPath: string }>,
    initialCosts: {
      管理費: string | null,
      共益費: string | null,
      礼金: string | null,
      敷金: string | null,
      敷引: string | null,
      雑費: string | null,
      鍵交換代等: string | null,
      保証金: string | null,
      保証金償却: string | null,
      賃貸保証: string | null,
      クレジットカード決済: string | null,
      保険等加入: string | null,
      その他一時金: string | null,
      ランニングコスト: string | null,
    },
    contractTerms: {
      現況: string | null,
      入居日: string | null,
      契約期間: string | null,
      更新料: string | null,
      入居条件: string | null,
      フリーレント: string | null,
    },
    memberInfo: {
      報酬: string | null,        // "■客付手数料 借主：100％ 客付：100％"
      取引態様: string | null,    // "★媒介"
      登録会員: string | null,    // 元付業者情報（社名・TEL等）
      広告転載: string | null,
      内見情報: string | null,
      鍵情報: string | null,
      公開満了日: string | null,
    },
    parsed: {
      // 派生フィールド (forrent 入稿時に直接使う形)
      chukaiTesuryo: { type: "amount" | "ari" | "fuyo", value: number | null },  // 仲介手数料
      hosho: { has: boolean, amount: number | null },  // 保証金
      kanrihi_total_yen_per_month: number | null,  // 管理費+共益費 合算
    }
  }
}
```

### Output (失敗時)
```typescript
{
  status: "ATBB_NOT_FOUND",  // フリーワード検索で 0 件
  reason: "ATBBに物件が見つかりません",
}
// または
{
  status: "ATBB_LOGIN_FAIL",
  reason: "ATBBログイン失敗",
}
// または
{
  status: "ATBB_AMBIGUOUS",  // 複数件ヒットしたが部屋番号で絞り込めず
  reason: "ATBBで部屋番号を特定できません",
  candidates: [...],
}
```

---

## Open Questions

1. **ATBB に物件無し時の取扱い**: 「入稿失敗 (REG_FAIL)」で確定済み。早期短絡で Stage 03〜06 をスキップ
2. **賃料 OCR**: 現状不要（REINS 値を使う）。将来 ATBB のみのソースが必要になったら検討
3. **複数件ヒット時の部屋番号マッチング**: ATBB 検索結果一覧から部屋番号で絞り込むロジックが必要。検索結果一覧 (`bfcm300s008`) の各 row の HTML 構造を別途調査する必要あり
4. **同名建物の取り違え防止**: 賃料 + 専有面積 + 所在地 をクロスチェックして信頼度判定すべき
