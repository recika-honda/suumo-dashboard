# Frontend Style — vanilla HTML/CSS 規範

Phase 6 以降 (2026-05) のフロント (`public/index.html`, `public/style.css`) の見た目を弄るときの規範。参考: https://thariqs.github.io/html-effectiveness/ (functional minimalism)。Next.js / React / Tailwind は意図的に外している (Anti-pattern 参照)。

## Tone

- **Functional minimalism**: 余白で区切り、装飾で区切らない
- カラーは 2 色 + 白背景: `#111` (text) / `#999` (muted) / `#fff` (bg)。中間トーンを増やさない
- 角丸・影 (box-shadow)・グラデーション・カラーアイコン・ホバーで派手な変化 — **使わない**
- アニメーションは「`→` の hover 時 3px シフト」程度の subtle なもののみ

## Section Head (番号付きセクション)

```html
<section>
  <header class="section-head">
    <span class="section-num">01</span>
    <span class="section-title">新規入稿</span>
    <span class="section-meta">latest 50</span>  <!-- optional, 右端 muted -->
  </header>
  ...
</section>
```

- `01` `02` `03` の **2 桁 zero-pad**、`#999` / `font-size: 0.7rem` / `letter-spacing: 0.08em`
- title は `#111` / `font-size: 1rem` / `font-weight: 500`
- meta は `margin-left: auto` で右端に流す
- section 間 余白 `4rem`、見出し下 `1.5rem`
- `h1` は太い罫線で区切らない (`margin-bottom: 3.5rem` の余白で区切る)

## Form

- `input`: `border: none` + `border-bottom: 1px solid #ddd`。focus で `#111` に。box / 塗り / 角丸は使わない
- input フォントは monospace (REINS 物件番号のような数字列が等幅で揃う)
- `button`: `background: transparent` + `color: #111` + `::after { content: "→" }`。hover で矢印を `translateX(3px)` で右に微シフト
- disabled は `color: #bbb` のみ (背景を変えない)

## Lists (進捗・履歴)

- monospace で揃える (`ui-monospace, "SF Mono", Menlo`)
- font-size `0.8rem` / color `#333`
- prefix は `→` で統一 (色 `#999`、`display: flex` + `gap: 0.75rem` で左端揃え)
- 履歴の文字列は `MM-DD HH:MM   STATUS    物件名 / score` で空白整列 (monospace 前提)
- 進捗の各行は `name (count)` or `name — error` のフォーマット

## レイアウト

- `max-width: 640px` 中央寄せ
- `padding: 4rem 1.5rem` (上下たっぷり、左右ややゆとり)
- `line-height: 1.7`
- `font-size: 15px` body ベース
- `-webkit-font-smoothing: antialiased`

## Timestamp 表示

- 永続化 (`logs/nyuko-history.jsonl#ts`, `run.json#steps[].at`) は **UTC ISO 8601** で書く (`new Date().toISOString()`)。複数 TZ 運用に強い形を保持
- **表示時に必ずブラウザ TZ で localize する**。`public/index.html` の `formatLocalTs(iso)` ヘルパが正典 (`Date` 経由で `getMonth/getDate/getHours/getMinutes` を取り、`MM-DD HH:MM` に整形)
- アンチパターン: ISO 文字列を `.slice(11, 16)` のような機械切り抜きで表示する — UTC のまま画面に出て JST との時差で「最新が早朝 5 時」のような混乱が出る (実際に踏んだバグ、2026-05)
- 新しい時刻フィールドを表示するときも必ず `formatLocalTs` 経由で

## 文言の言語

- セクション見出し / 主要 UI 文言は日本語 (`新規入稿` / `進捗` / `履歴`)
- メタ情報 / 状態 / 短い英字ラベルは英語小文字 (`latest 50` / `starting...` / `loading...` / `events`)
- ハイブリッドが情報密度を上げる (日本語見出し + 英字メタ)

## Anti-pattern

- Tailwind / styled-components / CSS-in-JS / フレームワーク CSS を入れる — Phase 6 で意図的に削った歴史
- 装飾アイコン (Material / FontAwesome / Lucide 等) を入れる — `→` だけで足りる
- ホバーで色相変化 / 影追加 / scale 変形などの派手なエフェクト
- 章番号を `1.` `2.` のような半角ピリオド形式に戻す (`01` `02` の zero-pad に統一済)
- 長い line-length のリスト (履歴の物件名は `.slice(0, 24)` で切る)
