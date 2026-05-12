# 新しい forrent 必須項目を踏んだ時の対応手順

forrent.jp に物件入稿しようとして「○○ を入力して下さい」のようなバリデーションエラーが
連続して出るようになったら、その項目を REINS 抽出時点で先に検出して REG_FAIL として
弾く方が効率的 (ブラウザ起動・画像取得・AI 分類を全スキップできる)。

その追加は **コードを 1 行も書かずに、設定ファイルに 1 entry 追加するだけ** で済む。

## 手順

### 1. spec ファイルを開く

`config/forrent-required.spec.json`

### 2. `fields` 配列に entry を 1 つ追加する

例: `所在地` が forrent サーバ側必須になった場合 (全物件種目)

```json
{
  "key": "所在地",
  "label": "所在地",
  "appliesTo": "ALL",
  "rejectReason": "REINSデータに所在地がありません"
}
```

例: `面積` が マンション・アパート・テラスハウス で必須になった場合

```json
{
  "key": "面積",
  "label": "面積",
  "appliesTo": { "物件種目": ["マンション", "アパート", "テラス・タウンハウス"] },
  "rejectReason": "REINSデータに面積がありません"
}
```

### 3. テストを走らせる

```bash
bun run scripts/test/test-spec-validator.js
```

新しいルールに対するテストケースを `tests` 配列に追加して PASS することを確認する
(任意だが推奨)。

### 4. dry-run で副作用がないか確認

```bash
bun run scripts/batch-nyuko.js --dry-run
```

### 5. 実物件で smoke test (任意)

REINS から該当項目が空の物件を 1 件選び、`bun run scripts/batch-nyuko.js` で実行。
Notion Status が「入稿失敗」に遷移し、Slack に該当 reason で通知が来ることを確認。

## spec フィールドの意味

| field | 意味 | 必須 |
|---|---|---|
| `key` | reinsData (REINS 抽出 object) のフィールド名 | ✅ |
| `label` | UI / log 表示用ラベル (現状は missingField と同義で使う) | ✅ |
| `appliesTo` | 適用条件。`"ALL"` または `{ "物件種目": ["値1", "値2"] }` | ✅ |
| `rejectReason` | REG_FAIL 戻り値の `reason` フィールドに入る文字列 | ✅ |
| `$comment` | 任意のメモ。ロジックに影響しない | optional |

## appliesTo の文法

- `"ALL"` (文字列): 全物件種目で適用
- `{ "key": ["値1", "値2"] }`: reinsData の指定 key の値が配列に含まれる場合のみ適用
- 複数キーは AND 合成 (例: 物件種目=マンション かつ 構造=木造 のとき)
- 不正な形式 (例: 配列でなく文字列を指定) は `console.warn` で警告 + skip

## ルールが効いていることの確認方法

```bash
node scripts/test/test-spec-validator.js
```

期待出力:
```
PASS: 建物名 empty → REG_FAIL
PASS: 建物名 whitespace → REG_FAIL (trim+falsy)
...
Total: 9/9
```

## ルールを削除したい場合

該当 entry を `fields` 配列から削除して保存するだけ。コード変更不要。

## 参考

- 実装: `skills/forrent.js` の `validateBySpec` / `appliesToMatches` / `checkRequiredFromReinsData`
- spec 本体: `config/forrent-required.spec.json`
- テストハーネス: `scripts/test/test-spec-validator.js`
- 設計記録: `docs/refactor/contract.md` §3 (REG_FAIL の戻り値) / `docs/refactor/stages.md` §01-reins-extract (早期 REG_FAIL の動作)
