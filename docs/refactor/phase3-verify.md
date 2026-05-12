# Phase 3 動作確認結果

## 概要

Phase 3 (T3.1〜T3.3) 完了後の検証。各 stage に artifact 書き込みを差し込み、resume コマンドを実装した。

実施日時: 2026-05-12
ブランチ: `refactor/cleanup-2026-05`

## 1. artifact ヘルパー (T3.1) 動作確認

```js
node -e "
const a = require('./scripts/lib/artifact');
const tmp = '/tmp/phase3-test-...';
fs.mkdirSync(tmp, {recursive: true});
a.writeStageInput(tmp, '01-reins-extract', { reinsId: 'TEST123', index: 0 });
a.writeStageOutput(tmp, '01-reins-extract', { status: 'OK', reinsData: {...}, propertyName: 'テストマンション' });
"
→ input: {"reinsId":"TEST123","index":0}
→ output: {"status":"OK","reinsData":{"建物名":"テストマンション"},"propertyName":"テストマンション"}
→ artifact OK
```

✅ write/read 往復、ディレクトリ自動作成、JSON 整形すべて動作。

## 2. 各 stage の artifact 書き込み (T3.2) コードパス確認

各 stage の return パスすべてに `writeStageOutput(runDir, STAGE, ...)` が差し込まれている (T3.2 reviewer で全パス網羅確認済):

| Stage | Return パス | 書き込み確認 |
|---|---|---|
| 01-reins-extract | NOT_FOUND / REG_FAIL early / OK | 全 3 経路 ✅ |
| 02-images-download | OK | ✅ |
| 03-images-classify | OK (内部 try/catch で失敗握り潰し) | ✅ |
| 04-texts-generate | OK | ✅ |
| 05-forrent-fill | FORRENT_LOGIN_FAIL / OK | 全 2 経路 ✅ |
| 06-forrent-register | SUCCESS / REG_FAIL | ✅ |

processProperty (batch-nyuko.js) で `runDir` を 6 stage すべてに流すよう wiring 済。

## 3. resume コマンド (T3.3) 動作確認

### 3.1 usage validation
```
$ node scripts/resume-nyuko.js
Usage: bun run scripts/resume-nyuko.js <runId> --from <stageName>
Stages: 01-reins-extract / 02-images-download / 03-images-classify / 04-texts-generate / 05-forrent-fill / 06-forrent-register
(exit 1)
```
✅

### 3.2 不正 stage / 06 指定
```
$ node scripts/resume-nyuko.js fake-run --from XX
unknown stage: XX
(exit 1)

$ node scripts/resume-nyuko.js fake-run --from 06-forrent-register
[resume] --from 06-forrent-register は forrentPage を復元できないため不可。
         代わりに --from 05-forrent-fill を使ってください (stage 05 + 06 を同時実行)。
(exit 1)
```
✅

### 3.3 reinsId / downloadDir 復元の堅牢性
- reinsId: stage 01 input.json (artifact が正典) を優先、無ければ runId 末尾 (`{ts}_{reinsId}`) から復元
- downloadDir: stage 02 input.json (artifact が正典) を優先、無ければ `~/Desktop/suumo-nyuko/{reinsId}` フォールバック
- これにより過去 run と完全整合。stage 02 で別ディレクトリに保存される事故を回避

### 3.4 chromium launch の最小化
- `needsContext` を `startIdx <= 03 || startIdx === 05` に絞ることで、`--from 04-texts-generate` 単独 resume 時に chromium 起動をスキップ

## 4. dry-run 動作 (regression check)

```
$ bun run scripts/batch-nyuko.js --dry-run
  Notion「広告待ち」: 1件
  [dry-run] 物件一覧:
    - 100139101936
{"processed":0,"succeeded":0,"failed":0,"dryRun":true,"pending":1,"results":[]}
(exit 0)
```
✅ Phase 1 / Phase 2 同様、dryRun branch が正しく動作。

## 5. 全モジュール load 検証

```
$ node -e "require('./scripts/batch-nyuko'); require('./scripts/resume-nyuko');"
all OK
```
✅

## 6. Acceptance Criteria 達成状況

| AC | 結果 |
|---|---|
| 1. 新しい run が走ると各 stage の input.json / output.json が生成される | ✅ コードパス確認 (T3.2 reviewer 全パス網羅) |
| 2. resume-nyuko.js で過去 run の途中から再実行できる | ⏸ 実 run 後に kento トリガーで実機確認 (TF.1 で兼ねる) |
| 3. dry-run が引き続き動く | ✅ |

## 7. 未確認事項 (実 run 必要)

以下は kento トリガーの実物件 smoke test (TF.1) で確認:
- `logs/runs/{ts}_{reinsId}/{stage}/output.json` が 6 ファイル生成されるか
- 各 output.json が valid JSON か
- forrentPage / mainFrame が `[Page]` / `[Frame]` 文字列に置換されているか
- resume コマンドが現実の runId に対して機能するか

## 8. 結論

✅ **Phase 3 完了** (実 run 検証は TF.1 で兼ねる)。Phase 4 (validation を JSON spec 化) に進んでよい。

## 9. 残課題 (リリースブロッカーではない)

- T3.3 reviewer Minor 5 件: コメント追加 / 名前リファイン / `--from 02` 復元時の二重ガード等。Phase 5 以降で吸収。
