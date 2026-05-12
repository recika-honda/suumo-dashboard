# processProperty 現状契約 (Pre-refactor Snapshot)

リファクタ前の `scripts/batch-nyuko.js` における `processProperty` 関数 (および呼び出し元 `main`) の入出力契約。リファクタ後にこのドキュメントと挙動が一致していることを確認するためのリファレンス。

参照ソース: `scripts/batch-nyuko.js` (commit `28245ff`)

---

## 1. processProperty の引数

定義: `scripts/batch-nyuko.js:167`

```js
async function processProperty(context, reinsPage, reinsId, index, total, runLog)
```

| 引数 | 型 | 意味 |
|---|---|---|
| `context` | Playwright BrowserContext | forrent ページ等を新規作成するための共有コンテキスト |
| `reinsPage` | Playwright Page | REINS 用に main() で 1 回ログイン済みの Page (使い回し) |
| `reinsId` | string | 処理対象の REINS 物件番号 |
| `index` | number | バッチ内インデックス (0 始まり) |
| `total` | number | バッチ総件数 (進捗表示用) |
| `runLog` | object | `createRunLog(reinsId)` で作成した run logger (`{ dir, data, step, finish }`) |

---

## 2. 戻り値の status enum

processProperty 自体が返しうる status:

| status | 発生箇所 | 意味 | 性質 |
|---|---|---|---|
| `SUCCESS` | line 418 | forrent.jp 下書き保存成功 | — |
| `NOT_FOUND` | line 193 | REINS で物件番号検索 0 件 | データ起因 (恒久) |
| `REG_FAIL` | line 216, 230, 418 | バリデーション失敗 (早期 or 確認画面) | データ起因 (恒久) |
| `FORRENT_LOGIN_FAIL` | line 320 | forrent.jp ログイン失敗 | 環境/transient |
| `ERROR` | line 437 | 想定外の exception | transient |

main() が追加で付ける status (processProperty の Promise.race / 例外で発生):

| status | 発生箇所 | 意味 | 性質 |
|---|---|---|---|
| `TIMEOUT` | line 513 | 15 分以内に処理完了しない | transient |

---

## 3. 各 status における戻り値 object の field 一覧

### SUCCESS (line 415-427)
```js
{
  reinsId,
  propertyName: reinsData.建物名 || reinsId,
  status: "SUCCESS",
  score: number | null,                    // forrent score (43pt 満点)
  registrationType: string,                // "下書き保存" | "本登録" 等
  filledFields: number,                    // forrent フォームで入力した field 数
  uploadedImages: number,                  // アップロード成功画像数
  transport: number,                       // 入力した交通件数
  shuhen: number,                          // 入力した周辺環境件数
  errors: Array<string>,                   // forrent register 時のエラー (regResult.errors)
  formFillErrors: number,                  // form fill 時の累計エラー数
}
```

### NOT_FOUND (line 193)
```js
{
  reinsId,
  status: "NOT_FOUND",
  propertyName: "N/A",
}
```

### REG_FAIL (early - 建物名欠落, line 214-220)
```js
{
  reinsId,
  status: "REG_FAIL",
  propertyName: reinsId,                   // 物件名取得前なので reinsId 流用
  reason: "REINSデータに建物名がありません",
}
```

### REG_FAIL (early - 部屋番号欠落, マンション・アパート限定, line 228-234)
```js
{
  reinsId,
  status: "REG_FAIL",
  propertyName: reinsData.建物名,
  reason: "REINSデータに部屋番号がありません",
}
```

早期判定条件: `["マンション", "アパート"].includes(reinsData.物件種目) && !reinsData.部屋番号`

### REG_FAIL (登録時, line 415-427)
SUCCESS と同形 (regResult.saved が false の場合 status だけ REG_FAIL)。reason は付かない (errors 配列にバリデーションメッセージが入る)。

### FORRENT_LOGIN_FAIL (line 320)
```js
{
  reinsId,
  status: "FORRENT_LOGIN_FAIL",
  propertyName: reinsData.建物名,
}
```

### ERROR (line 434-439)
```js
{
  reinsId,
  propertyName: reinsData?.建物名 || reinsId,
  status: "ERROR",
  error: string,                           // err.message.slice(0, 200)
}
```

### TIMEOUT (main() で生成, line 510-516)
```js
{
  reinsId,
  propertyName: "N/A",
  status: "TIMEOUT",
  error: err.message,
}
```

タイムアウト閾値: `PROPERTY_TIMEOUT_MS = 15 * 60 * 1000` (15 分, line 39)

⚠ **現状の semantic 注意**: processProperty 内の try-catch (line 312-440) は Step 5 以降しか覆っていない。Step 1-4 で発生した例外は processProperty の reject として伝播し、main() 側 Promise.race の catch (line 509) で**無条件に `status: "TIMEOUT"` としてラベルされる** (タイムアウト由来でなくても)。これは現状仕様。

### REG_FAIL (登録時, line 415-427) — 完全 field 列挙
SUCCESS と同一 return 文 (`status: regResult.saved ? "SUCCESS" : "REG_FAIL"`) なので field 集合は同じ。早期 REG_FAIL との差分:

```js
{
  reinsId,
  propertyName: reinsData.建物名 || reinsId,
  status: "REG_FAIL",
  score: number | null,                // 登録試行時に取得済なら付く
  registrationType: null,              // saved=false なので null
  filledFields: number,
  uploadedImages: number,
  transport: number,
  shuhen: number,
  errors: Array<string>,               // ★ 登録時 REG_FAIL のみ。早期は空
  formFillErrors: number,
  // ★ reason は無い (早期 REG_FAIL との差分)
}
```

→ Slack `notifyError` には `result.error || result.status` を渡す (line 573)。登録時 REG_FAIL は `error` field が無いので **文字列 `"REG_FAIL"` が Slack に流れる** ことに注意。

### main() による追記 (全 status 共通, line 518-519)
```js
result.duration = Math.round((Date.now() - startTime) / 1000);  // 秒
result.runDir = runLog.dir;                                      // logs/runs/{ts}_{reinsId}
```

---

## 4. main() における status → Notion ステータス遷移

main() の line 530-567:

| processProperty の status | Notion の遷移 | 補足 |
|---|---|---|
| `SUCCESS` | `掲載保留` (`updateNotionStatus(pageId, "掲載保留")`) | 成功カウント++ |
| `REG_FAIL` | `入稿失敗` | データ起因なのでリトライしない |
| `NOT_FOUND` | `入稿失敗` | データ起因なのでリトライしない |
| `FORRENT_LOGIN_FAIL` | (更新なし) | 「広告待ち」維持 → 次回ポーリングで再試行 |
| `TIMEOUT` | (更新なし) | 「広告待ち」維持 → 次回ポーリングで再試行 |
| `ERROR` | (更新なし) | 「広告待ち」維持 → 次回ポーリングで再試行 |

判定ロジック (line 559):
```js
const dataLevelFailure = result.status === "REG_FAIL" || result.status === "NOT_FOUND";
if (dataLevelFailure) {
  await updateNotionStatus(pageId, "入稿失敗");
}
```

Notion 更新失敗時の挙動 (commit `28245ff` 実コード):
- **SUCCESS パスの catch (line 537)**: `result.notionUpdateFailed = true` を立てる + 処理継続
- **失敗パス (REG_FAIL/NOT_FOUND) の catch (line 565)**: `console.error` のみ。**`notionUpdateFailed` は立てない** (現状仕様 — 当初 contract.md に「両方で立てる」と誤記していたが原本コードを確認して訂正)

---

## 5. Slack 通知の発火条件

main() の line 540-577:

| status | 通知関数 | 内容 |
|---|---|---|
| `SUCCESS` | `slack.notifyNyukoSuccess({reinsId, propertyName, score, registrationType})` | 大木さんへの DM、掲載保留登録のお知らせ |
| 上記以外 (失敗系すべて) | `slack.notifyError({reinsId, propertyName, error})` | エラー通知 (`error` field は `result.error || result.status`) |

通知失敗は catch して console.error に出すのみ (処理は継続)。

---

## 6. Run log (createRunLog)

定義: `scripts/batch-nyuko.js:54-100`

各 property につき以下を生成:
- ディレクトリ: `logs/runs/{yyyymmdd-hhmmss}_{reinsId}/`
- ファイル: `run.json` (step ログ + finish summary)
- ファイル: `reins-data.json` (Step 1 抽出後、line 200-204)
- ファイル: `confirm-attempt{N}.html|png` (登録時のスナップショット, forrent.js 側から書く)

`runLog.step(name, extra)` で随時 append。`runLog.finish({status, propertyName, score, duration, errors, registrationType})` で確定 + `logs/nyuko-history.jsonl` に 1 行追記。

履歴 jsonl の 1 行形式 (line 82-92):
```js
{
  ts: ISO 文字列,
  reinsId,
  propertyName: string | null,
  status: string,
  score: number | null,
  duration: number | null,
  errorsCount: number,
  firstError: string | null,
  runDir: string,
}
```

---

## 7. パイプラインのステップ順序 (現状の processProperty 内部)

| Step | 行 | 処理 | 失敗時の status |
|---|---|---|---|
| Step 1 | 187-204 | `reins.searchByNumber` + `reins.extractPropertyData` | `NOT_FOUND` (検索 0 件) |
| 早期 validation | 206-234 | 建物名 / (マンション・アパート時の) 部屋番号 必須チェック | `REG_FAIL` (reason 付き) |
| Step 2 | 237-241 | `reins.extractImageData` + `reins.screenshotAllImages` | (例外時 `ERROR`) |
| Step 3 | 243-274 | `analyzeAndCropImages` + `fetchBukakuData` (並列) + 不足時 bukaku 画像追加 | (例外時 `ERROR`) |
| Step 3.5 | 276-300 | 別 Chromium で `fetchShuhenPhotos` (周辺環境写真) | (catch して継続) |
| Step 4 | 302-306 | `generateTexts` (キャッチコピー + フリーコメント) | (例外時 `ERROR`) |
| Step 5 | 308-383 | forrent ログイン → フォーム入力 (form/texts/images/tokucho/transport/shuhen) | `FORRENT_LOGIN_FAIL` |
| ★ shuhen DOM 同期 | 349-364 | `mainFrame.evaluate` で `shuhenKankyoNm[i]` ↔ `destination${i+1}` 同期 (リファクタ対象: T1.1) | non-critical (catch のみ) |
| Step 6 | 385-411 | `forrent.registerProperty` (確認画面 → 登録) | `REG_FAIL` (regResult.saved=false) |

---

## 8. 不変条件 (リファクタ後も維持すべきもの)

### 戻り値の構造
- status enum 6 種 (SUCCESS / NOT_FOUND / REG_FAIL / FORRENT_LOGIN_FAIL / TIMEOUT / ERROR) は増減させない
- 各 status の field 構造は維持 (上記 §3)
- **SUCCESS / 登録時 REG_FAIL の戻り値は以下 8 field を維持**: `score`, `registrationType`, `filledFields`, `uploadedImages`, `transport`, `shuhen`, `errors`, `formFillErrors` (履歴 jsonl・ダッシュボード UI で参照される可能性があるため、現状未使用に見えても削らない)

### 副作用とフロー
- Notion 遷移マッピング (§4) は維持
- Slack 通知の発火条件 (§5) は維持
- Run log のディレクトリ構造・jsonl 構造 (§6) は維持
- 早期 validation の判定ロジック (建物名空 / マンション・アパートで部屋番号欠落) は維持

### リソース管理
- forrent ログイン失敗時、forrentPage はクローズされる (リソースリーク防止, line 319)
- 別 Chromium で起動する shuhen ブラウザは finally で必ず close される (line 298-300)
- Promise.race による 15 分タイムアウトは main() 側で維持

### 例外ラベリングの semantic (現状仕様、リファクタで変えない)
- **Step 1-4 の例外は main() 側で `TIMEOUT` としてラベルされる** (try-catch が Step 5 から始まるため、processProperty が直接 reject → Promise.race の catch で TIMEOUT 扱いに落ちる)
- リファクタで try の範囲を Step 1 から覆うと「Step 1-4 例外が ERROR ラベルになる」という挙動変化が起きる → 意図的な変更でない限り**同じ範囲で try を維持**
- (Notion 遷移上は TIMEOUT も ERROR も「広告待ち維持 → 再試行」で同じ振る舞いだが、Slack 通知本文と history.jsonl のラベルが変わる)

### 履歴 jsonl の型補足 (§6)
- `propertyName` の実値は string (`"建物名"` または `"N/A"`)。`| null` は createRunLog 初期化直後のみで、`finish()` 後は必ず string
