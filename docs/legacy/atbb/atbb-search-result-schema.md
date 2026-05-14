# ATBB 検索結果一覧 (bfcm300s008) スキーマ

検証日: 2026-05-13
検証条件: フリーワード "世田谷区" / 賃貸居住用 → 20 件ヒット

## ページレベル

- URL: `https://atbb.athome.co.jp/front-web/mainservlet/bfcm300s008`
- 1 ページあたり 20 件（`shosai_0` 〜 `shosai_19`）
- カード ID: `#bukkenCard_0` 〜 `#bukkenCard_19`

⚠️ 件数表示の DOM が単純な innerText でヒットしない。`#bukkenCard_N` の最大 N + ページネーション情報から推定するのが安全。

## カード構造 (`#bukkenCard_N`)

```html
<div id="bukkenCard_N" class="property_card counted">
  <div class="property_title">
    <div class="title-bar">
      <span class="number">No.X</span>           <!-- 表示順 -->
      <span class="type">貸アパート</span>        <!-- 物件種目 -->
      <p class="name">建物名/部屋番号</p>          <!-- "/" 区切り、無い場合は建物名のみ -->
      <p class="date">公開日：<span>YYYY/MM/DD</span></p>
    </div>
  </div>
  <div class="property_info">
    <div class="left">                            <!-- サムネ + 画像枚数 -->
      <span class="sheets">画像：N点</span>
    </div>
    <div class="right">
      <div class="payment">
        <dl>
          <dt>賃料</dt>
          <dd><img id="price_img_N"></dd>         <!-- 賃料は画像化 (txt2img) -->
        </dl>
        <dl>
          <div><dt>管理費等</dt><dd>3,000円</dd></div>  <!-- 管理費 + 共益費 + 雑費 の合計 -->
          <div><dt>礼金</dt><dd>1ヶ月</dd></div>
          <div><dt>敷金</dt><dd>1ヶ月</dd></div>
          <div><dt>敷引</dt><dd>-</dd></div>
        </dl>
      </div>
      <div class="info">
        <table>                                   <!-- 1st table -->
          <tr><th>間取り</th><td>ワンルーム</td></tr>
          <tr><th>所在地</th><td>世田谷区三宿２丁目 22ー10</td></tr>
          <tr><th>交通</th><td>東急田園都市線 池尻大橋 徒歩10分</td></tr>
        </table>
        <table>                                   <!-- 2nd table -->
          <tr><th>専有面積</th><td>10.00㎡</td><th>階建/階</th><td>2階建/2階</td></tr>
          <tr><th>築年月</th><td>1970/03</td><th>坪単価</th><td>0.83万円</td></tr>
          <tr><th>建物構造</th><td>木造</td><th>物件番号</th><td><img id="bkn_no_img_N"></td></tr>
        </table>
      </div>
    </div>
  </div>
  <div class="property_data">
    <dl>
      <dt>広告転載</dt><dd>転載不可 | 要確認 | 転載可</dd>
      <dt>取引態様</dt><dd>★媒介 | 代理 | 貸主</dd>
    </dl>
    <p class="company"><a>(株)社名</a></p>           <!-- 元付業者 -->
    <p class="tel">TEL : <a>03-XXXX-XXXX</a></p>
    <p>東京都知事免許...</p>
  </div>
  <div class="property_buttons">
    <button id="shosai_N">詳細</button>            <!-- 詳細ページ遷移 -->
  </div>
</div>
```

## 各フィールドの抽出仕様

| フィールド | セレクタ | パース | 例 |
|----------|---------|-------|---|
| 物件種目 | `.title-bar .type` | trim | "貸アパート" / "貸マンション" |
| 建物名 | `.title-bar p.name` | "/" で split[0] | "三宿高橋荘" |
| 部屋番号 | `.title-bar p.name` | "/" で split[1] | "203" / "２０２" / undefined |
| 公開日 | `.title-bar p.date span` | YYYY/MM/DD | "2026/04/10" |
| 画像枚数 | `.sheets` | "画像：N点" → N | 16 |
| 管理費等 | `.payment dl div` で dt="管理費等" の dd | "X,XXX円" → number | 3000 |
| 礼金 | 同上 dt="礼金" | "Xヶ月" or "X.X万円" or "-" | "1ヶ月" |
| 敷金 | 同上 dt="敷金" | 同上 | "1ヶ月" |
| 敷引 | 同上 dt="敷引" | 同上 | "1ヶ月" / "-" |
| 間取り | `.info table:nth-of-type(1)` で th="間取り" の td | trim | "ワンルーム" / "1K" |
| 所在地 | 同上 th="所在地" | **空白正規化必須** (`replace(/\s+/g, "")`) | "世田谷区三宿２丁目22ー10" |
| 交通 | 同上 th="交通" | **空白正規化必須** | "東急田園都市線池尻大橋徒歩10分" |
| 専有面積 | `.info table:nth-of-type(2)` で th="専有面積" の td | "X.XX㎡" → number | 10.00 |
| 階建/階 | 同上 th="階建/階" | "X階建/Y階" | "2階建/2階" |
| 築年月 | 同上 th="築年月" | "YYYY/MM" | "1970/03" |
| 坪単価 | 同上 th="坪単価" | "X.XX万円" → number | 0.83 |
| 建物構造 | 同上 th="建物構造" | trim | "木造" / "RC" / "鉄骨" |
| 物件番号 (ATBB) | `img#bkn_no_img_N` の data-bukkenno | **画像化されているため取得不能** | (hash値のみ取得可) |
| 取引態様 | `.property_data dl` で dt="取引態様" の dd | trim | "★媒介" / "代理" / "貸主" |
| 元付業者名 | `.property_data .company a` | trim | "(株)神和不動産" |
| 元付TEL | `.property_data .tel a` | trim | "03-5481-1901" |
| 詳細ボタン | `button#shosai_N` | click → 詳細ページ遷移 | — |
| 賃料 | `img#price_img_N` | **画像化** | (REINSから取得した値で代用) |

## ⚠️ ATBB 側で「画像化」されているフィールド

スクレイピング防止のため以下は画像 (`txt2img` API):
- **賃料** (`price_img_N`)
- **物件番号** (`bkn_no_img_N`)

→ matching には使わない。**REINS の `物件番号` も別体系で ATBB の `物件番号` と突合不能**。

## マッチング戦略への含意

**実観測された重要パターン: 同一物件が複数社から登録される**

検証時に card[1] と card[2] が「同じ物件 (奥沢6丁目15-2 / 1973-08築 / 10.50㎡ / 2階)」を別社が登録していた:

| | card[1] | card[2] |
|---|---|---|
| 名前 | 細谷方/202 | 細谷方(ホソヤカタ)/２０２ |
| 部屋番号 | 202 | ２０２ (全角) |
| 敷引 | 1ヶ月 | - |
| 登録社 | (株)エスモード | (株)バレッグス 賃貸管理部 |
| 公開日 | 2026/05/11 | 2026/05/01 |

含意:
1. **建物名の表記揺れ** が同物件内でも起こる（読み仮名有無、全角/半角）
2. **賃料・条件も登録社毎に微妙に違う**ことがある（細部）
3. **元付業者の取り違え** は致命的（REINS の元付業者と一致する card を選ぶべき）

## マッチング判定ロジック (v1 草案)

入力 (REINS):
- 建物名, 部屋番号, 賃料, 敷金, 礼金, 専有面積, 築年月, 階建/階, 所在地, 物件種目, 商号 (元付業者)

候補絞り込み (検索結果の各 bukkenCard_N):

```
score = 0.0
+ if 部屋番号 一致 (全角/半角正規化後)          : 0.30
+ if 専有面積 一致 (±0.5㎡)                    : 0.15
+ if 築年月 一致 (年月完全一致)                 : 0.15
+ if 階建/階 一致                              : 0.10
+ if 物件種目 一致 (REINSのマンション vs ATBBの貸マンション等を辞書変換) : 0.10
+ if 所在地 一致 (番地まで normalize して文字一致) : 0.10
+ if 元付業者名 一致 (REINSの商号と部分一致)     : 0.10

confidence:
  >= 0.70 → matched (高信頼)
  0.50 - 0.69 → ambiguous (人間レビュー or 賃料/間取りの追加チェック)
  < 0.50 → 不一致候補としてスキップ
```

複数 card が >= 0.70 になった場合は、**より新しい publishDate** や **元付業者名の最も近い card** を選ぶ。

賃料を判定に使わない理由: ATBB 側は画像化、REINS 側の万円表示と比較するのに OCR が必要で、コスト対効果が低い。築年月・専有面積・階で識別の方が確実。
