# ATBB 路線 — 廃案アーカイブ

**廃案日**: 2026-05-14
**廃案理由**: FANGO 後藤さん判断
**判断材料**: 100 件サンプルでマッチ率 65%。残り 35% (主に大手系列: 三井不動産レジデンシャル・住友林業・東建コーポレーション・東急住宅リース・パナソニックホームズ・エイブル系) が **構造的に ATBB 流通契約しておらず取得不能**。これらが常時 REG_FAIL になると朝 11:00 入稿締切に間に合わない物件が増え、運用上のクリティカル問題。bukaku (物確) 継続が安全と判断。

## 当初構想
- REINS から物件名取得 → ATBB フリーワード検索 → 詳細ページから「画像 16+ 点 + 初期費用 + 仲介手数料 (会員間情報) + 契約条件」抽出 → forrent.jp に入稿
- bukaku (物確 PDF 解析) を完全置換する想定だった

## 主要発見 (将来再評価時の参考)

### 機能仕様
- ATBB のフリーワード検索: **REINS 物件名そのまま** で十分機能 (戦略 11 個試したが S1_raw 以外不要だった)
- 賃貸居住用 radio (`atbbShumokuDaibunrui=06`) **クリック必須** (押さないと freeWordSearchSubject 入力欄が DOM に出現しない)
- フリーワード入力は `el.value = X; dispatchEvent('input')` でなく Playwright `page.fill()` が安全 (人間のキーボード event sequence をシミュレートしないと内部 state が動かない可能性あり、ただし今回はこれ以外の anti-bot 措置が決定的だった)

### Anti-bot 必須
- `navigator.webdriver` 隠蔽 + UA 設定 + `--disable-blink-features=AutomationControlled` の **3 点セット必須**
- これなしだと reCAPTCHA v3 で bot 判定 → ATBB が検索結果を空で返す (= NOT_FOUND 偽陽性が大量発生)
- 詳細: `atbb.js` の launch args / `addInitScript`

### セッション管理
- ATBB は同一アカウント多重ログイン禁止
- Persistent Context (launchPersistentContext + user-data-dir) は profile 破損が頻発 → 廃案
- **storageState (cookies JSON export)** が安全
- 詳細: `~/.claude/rules/atbb-session-management.md` (グローバルルール)

### スキーマ
- 検索結果カード: `#bukkenCard_N` (1 ページ 20 件)、`.title-bar p.name` で "建物名/部屋番号", `.info table` で 専有面積・築年月・階・所在地、`.property_data` で 元付業者・取引態様
- 詳細ページ: `div.contents_box[title="建物情報"]` 配下 3 テーブル (建物情報・費用・契約条件)、`div.contents_box[title="画像N点"]` で画像 URL (`img4.athome.jp/image_files/path/...`)、`div.contents_box[title="会員間情報"]` で 報酬 (= 仲介手数料・AD)
- 賃料・物件番号 は ATBB 側で **画像化** (`txt2img` API, スクレイピング防止) → 数値取得は REINS 経由
- 詳細スキーマ: `../../docs/legacy/atbb/atbb-search-result-schema.md`, `atbb-to-forrent-mapping.md`

## ファイル

| ファイル | 内容 |
|---------|------|
| `atbb.js` | ATBB login, navigation, search, kick logic (ConcurrentLoginException 突破), card extraction |
| `atbb-matcher.js` | REINS データとの照合スコアリング (建物名一致 + 部屋番号 + 専有面積 + 築年月 + 階 + 物件種目 + 所在地 + 元付業者) |
| `atbb-match-tester.js` | 100 件規模の精度測定 CLI |
| `atbb-vantage-test.js` | 「ヴァンテジオ世田谷」単発検証 (anti-bot 措置効果確認用) |
| `atbb-radio-bug-test.js` | radio click 有無の挙動比較 (歴史的経緯メモ) |
| `logs-atbb-matching/` | 過去の測定結果 JSONL + console log |

## 再評価する時の手順
1. このディレクトリ全部を `scripts/` / `skills/` に戻す
2. `.env.local` の `ATBB_LOGIN_ID` / `ATBB_LOGIN_PASS` を有効化 (要新規アカウント — 旧 ID `002807970005` は失効済みの可能性)
3. `node scripts/atbb-match-tester.js --limit 100` で精度を再測定
4. ATBB 側の市場カバー率改善 (大手系列の流通参入) があれば検討価値あり

## 関連グローバルルール (削除しない)
`~/.claude/rules/atbb-session-management.md` — Persistent Context 破損リスク・多重ログイン・storageState 方式の知見
