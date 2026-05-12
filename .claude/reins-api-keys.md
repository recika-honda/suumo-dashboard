REINS 物件詳細が内部で叩く API: `/main/api/BK/GBK003200/getInitData`
JSON は略号キー (ヘボン式子音抜き)。よく使うキーの対応 (2026-05-12 確認):

| API key | 意味 | 例 |
|---|---|---|
| `bkknBngu` | 物件番号 | "100139100018" |
| `ttmnmi` | 棟名 (= 建物名) | "羽沢コート" |
| `hyBngu` | 部屋番号 | "101" / "" (空) |
| `kdby` | 号棟 | "" |
| `syuBbnMnsk` | 専有面積 (= 使用部分面積) | 68.04 |
| `cnryu` | 賃料 (万円) | 21.5 |
| `mdrTyp` / `mdrHysu` | 間取タイプ code / 部屋数 | "05"=LDK / 2 |
| `cknngtNn` / `cknngtTk` | 築年 / 築月 | "1974" / "06" |
| `tdufknmi` | 都道府県 | "東京都" |
| `shzicmi1/2/3` | 所在地名 1/2/3 | "渋谷区" |
| `ekmi1..3` / `ensnRykshu1..3` / `thHn11..13` | 駅名 / 沿線 / 駅徒歩 | "恵比寿" / "山手線" / 16 |
| `shugu` / `dihyuDnw` | 商号 / 代表電話 | "リアライズ・アセットプランナー（株）" / "03-..." |
| `zmnFlmi` | 図面ファイル名 | "賃貸マイソク羽沢コート.pdf" |
| `gzuUmFlg` | 画像有無 | "0"=無 / "1"=有 |
| `nyurykKitiKbn` | 入居時期区分 | "05"=即時 |
| `trhktiyu` | 取引態様 | "3"=専任 |

新 field 抽出時は (a) playwright response listener で getInitData の JSON を dump → 上表更新 → (b) `skills/reins.js#extractPropertyData` の regex 追加 (現状 body.innerText ベース、API 直叩きへの切替は将来検討)。
