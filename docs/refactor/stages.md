# Stage 分割設計 (Phase 2)

processProperty を 6 つの stage に分割する設計。各 stage は独立した関数として `scripts/stages/0X-name.js` に実装し、`processProperty` は順番に呼び出すだけの薄い orchestrator にする。

設計の不変条件: `docs/refactor/contract.md` §3 (戻り値) §4 (Notion) §5 (Slack) §8 (不変条件) を破らない。

## 共通の引数規約

すべての stage 関数は以下の規約に従う:

- 単一の options object 引数 (位置引数を増やさない、追加に強い)
- `logStep(name, extra?)` を受け取り、ステージ内で適切な点で呼ぶ (run.json への step 記録)
- `runDir` (optional) を受け取り、artifact 書き出しに使う (Phase 3 で本格利用)
- 戻り値は plain object。Playwright のハンドル (Page / Frame) を含めるのは Stage 05 → 06 のリレーのみ
- 例外は基本的に caller (processProperty) に伝播させる。non-critical な失敗は内部 try/catch + 戻り値の status で表現

## 依存グラフ

```
01-reins-extract
   ├─ reinsData  ──→ 03-images-classify
   │                  04-texts-generate
   │                  05-forrent-fill
   └─ (search 後の reinsPage 状態) ─→ 02-images-download

02-images-download
   └─ downloaded ──→ 03-images-classify

03-images-classify
   ├─ processedImages ──→ 05-forrent-fill
   └─ initialCostData ──→ 05-forrent-fill

04-texts-generate
   └─ texts ──→ 05-forrent-fill

05-forrent-fill
   ├─ forrentPage ──→ 06-forrent-register
   └─ mainFrame ───→ 06-forrent-register

06-forrent-register
   └─ regResult ──→ processProperty (return aggregator)
```

## Stage 仕様

### 01-reins-extract
**ファイル**: `scripts/stages/01-reins-extract.js`
**Export**: `async function runReinsExtract({ reinsPage, reinsId, index, logStep, runDir? })`

**入力**:
| field | 型 | 意味 |
|---|---|---|
| `reinsPage` | Playwright Page | REINS ログイン済みページ (使い回し) |
| `reinsId` | string | REINS 物件番号 |
| `index` | number | バッチ内 index (0 以外なら検索ページに再 navigate) |
| `logStep` | function | run.json への step 記録 |
| `runDir` | string? | reins-data.json artifact 書き出し先 |

**出力**: `{ status, reinsData?, propertyName?, reason? }`
| status | 追加 field |
|---|---|
| `"OK"` | `reinsData: object` (REINS 抽出データ全件), `propertyName: string` (建物名) |
| `"NOT_FOUND"` | (なし) |
| `"REG_FAIL"` | `propertyName: string`, `reason: string` (建物名 or 部屋番号 欠落) |

**副作用**:
- REINS の検索ページに navigate (index > 0 のとき)
- `reins.searchByNumber` + `reins.extractPropertyData` を呼ぶ
- **終了時 `reinsPage` は物件詳細ページに遷移済み** (Stage 02 の前提)
- `runDir/reins-data.json` を書き出し (runDir 指定時のみ)

**依存**: なし (最初の stage)

**失敗 status**: `NOT_FOUND` (検索 0 件) / `REG_FAIL` (forrent 必須項目欠落、`forrent.checkRequiredFromReinsData` を内部で呼ぶ)

---

### 02-images-download
**ファイル**: `scripts/stages/02-images-download.js`
**Export**: `async function runImagesDownload({ reinsPage, downloadDir, logStep })`

**入力**:
| field | 型 | 意味 |
|---|---|---|
| `reinsPage` | Playwright Page | 01 で物件詳細ページに居る状態 |
| `downloadDir` | string | 画像保存先 (例: `~/Desktop/suumo-nyuko/{reinsId}`) |
| `logStep` | function | step 記録 |

**出力**: `{ downloaded: Array<{ slot, url, localPath, label, ... }> }`
- `reins.screenshotAllImages` の戻り値そのまま

**副作用**:
- `reins.extractImageData` で image meta 抽出
- `reins.screenshotAllImages` で downloadDir に PNG 保存

**依存**: 01-reins-extract が成功している (reinsPage が物件詳細ページにあること)

**失敗 status**: なし。空配列を返しうるが status enum は返さない (caller は length チェック等)

---

### 03-images-classify
**ファイル**: `scripts/stages/03-images-classify.js`
**Export**: `async function runImagesClassify({ context, reinsData, downloaded, downloadDir, logStep, launchOpts })`

**入力**:
| field | 型 | 意味 |
|---|---|---|
| `context` | Playwright BrowserContext | bukaku の Context (内部で newPage する) |
| `reinsData` | object | 01 の reinsData (bukaku 検索キーに使う) |
| `downloaded` | Array | 02 の downloaded |
| `downloadDir` | string | crop 後保存先 |
| `logStep` | function | step 記録 |
| `launchOpts` | object | shuhen 用 chromium.launch のオプション |

**出力**: `{ processedImages: Array<{ localPath, categoryId, categoryLabel, sourceIndex, ... }>, initialCostData: object | null }`

**副作用**:
- Anthropic API (`analyzeAndCropImages`) で画像分類
- `fetchBukakuData` を context で並列実行 (PDF 解析 + 物確画像取得)
- 5pt カテゴリ不足時、bukaku 画像を追加分類
- 別 Chromium を立ち上げ (`launchOpts` 指定) → `fetchShuhenPhotos` で周辺環境写真取得
- 別 Chromium は finally で必ず close (リソースリーク防止、contract.md §8 不変条件)

**依存**: 01 の reinsData, 02 の downloaded

**失敗 status**: なし。catch で継続 (processedImages が短くなる / shuhen が空になるだけ)。例外は外に出さない

---

### 04-texts-generate
**ファイル**: `scripts/stages/04-texts-generate.js`
**Export**: `async function runTextsGenerate({ reinsData, logStep })`

**入力**:
| field | 型 | 意味 |
|---|---|---|
| `reinsData` | object | 01 の reinsData |
| `logStep` | function | step 記録 |

**出力**: `{ catchCopy: string, freeComment: string }`
- `text-ai.generateTexts` の戻り値そのまま

**副作用**: Anthropic API (`generateTexts`)

**依存**: 01 の reinsData

**失敗 status**: なし。`generateTexts` 内部で fallback して空文字を返しうる

---

### 05-forrent-fill
**ファイル**: `scripts/stages/05-forrent-fill.js`
**Export**: `async function runForrentFill({ context, reinsData, processedImages, initialCostData, texts, logStep })`

**入力**:
| field | 型 | 意味 |
|---|---|---|
| `context` | Playwright BrowserContext | forrent ページを newPage する |
| `reinsData` | object | 01 |
| `processedImages` | Array | 03 |
| `initialCostData` | object | null | 03 |
| `texts` | object | 04 |
| `logStep` | function | step 記録 |

**出力**: `{ status, forrentPage?, mainFrame?, filled?, uploaded?, transport?, shuhen?, allErrors? }`
| status | 追加 field |
|---|---|
| `"OK"` | `forrentPage: Page`, `mainFrame: Frame`, `filled: object`, `uploaded: Array`, `transport: object`, `shuhen: object`, `allErrors: Array` |
| `"FORRENT_LOGIN_FAIL"` | (なし。forrentPage は内部で close 済み) |

**副作用**:
- `context.newPage()` で forrent 用 Page 作成
- `forrent.login` (失敗時 forrentPage を close)
- `forrent.navigateToNewProperty`
- `forrent.fillPropertyForm` / `fillTexts` / `uploadImages` / `fillTokucho` / `fillTransportViaMap` / `fillShuhenKankyo` / `syncShuhenDestinationFields`

**依存**: 01 / 03 / 04

**失敗 status**: `FORRENT_LOGIN_FAIL`

**注意**: 戻り値に Playwright ハンドル (forrentPage, mainFrame) を含む唯一の stage。06-forrent-register が消費する。caller (processProperty) は OK 経路で 06 を呼んだ後に必ず forrentPage.close() する責務を負う

---

### 06-forrent-register
**ファイル**: `scripts/stages/06-forrent-register.js`
**Export**: `async function runForrentRegister({ forrentPage, mainFrame, runDir, logStep })`

**入力**:
| field | 型 | 意味 |
|---|---|---|
| `forrentPage` | Playwright Page | 05 の戻り値 |
| `mainFrame` | Playwright Frame | 05 の戻り値 |
| `runDir` | string? | confirm-attempt{N}.html|png artifact 書き出し先 (共通規約に揃え `runDir` で統一) |
| `logStep` | function | step 記録 |

**出力**: `{ status, score?, registrationType?, errors? }`
| status | 追加 field |
|---|---|
| `"SUCCESS"` | `score: number | null`, `registrationType: string` (例: "下書き保存") |
| `"REG_FAIL"` | `score: number | null`, `registrationType: null`, `errors: Array<string>` |

**副作用**:
- `forrent.registerProperty` を呼ぶ (確認画面遷移 + 登録 + score 取得)
- `runDir/confirm-attempt{N}.html|png` を書き出し (forrent.js 内部から)

**依存**: 05 (forrentPage, mainFrame)

**失敗 status**: `REG_FAIL` (regResult.saved=false)

**注意**: caller (processProperty) は呼び出し後に必ず `forrentPage.close()` する

---

## processProperty の薄化後の構造 (T2.8 のターゲット)

⚠ **例外ラベリングの semantic** (contract.md §8 不変条件):
- Step 1-4 で発生した例外は **try で覆わず**、processProperty から伝播させる → main() の Promise.race catch で **`TIMEOUT`** ラベルになる (現状仕様)
- Step 5 以降で発生した例外は processProperty 内 try-catch で捕捉し、**`ERROR`** ラベルを返す
- リファクタで try の範囲を変えない (TIMEOUT ↔ ERROR のラベル境界が変わってしまう)

`LAUNCH_OPTS` は batch-nyuko.js 既存の module-level 定数 (line 105 付近, headless options) をそのまま渡す。

```js
async function processProperty(context, reinsPage, reinsId, index, total, runLog) {
  const downloadDir = path.join(os.homedir(), "Desktop", "suumo-nyuko", reinsId);
  fs.mkdirSync(downloadDir, { recursive: true });
  printHeader({ reinsId, index, total });
  const logStep = runLog ? runLog.step : () => {};
  const runDir = runLog ? runLog.dir : undefined;

  // ── Step 1-4: try 外。例外は伝播 → main() で TIMEOUT ラベル ──
  const r1 = await runReinsExtract({ reinsPage, reinsId, index, logStep, runDir });
  if (r1.status === "NOT_FOUND") return { reinsId, status: "NOT_FOUND", propertyName: "N/A" };
  if (r1.status === "REG_FAIL") return { reinsId, status: "REG_FAIL", propertyName: r1.propertyName, reason: r1.reason };
  if (runLog) runLog.data.propertyName = r1.propertyName;

  const r2 = await runImagesDownload({ reinsPage, downloadDir, logStep });

  const r3 = await runImagesClassify({
    context, reinsData: r1.reinsData, downloaded: r2.downloaded,
    downloadDir, logStep, launchOpts: LAUNCH_OPTS,
  });

  const r4 = await runTextsGenerate({ reinsData: r1.reinsData, logStep });

  // ── Step 5-6: try で覆い、例外は ERROR ラベル ──
  // 原本コード batch-nyuko.js@28245ff line 312 の try と等価範囲 (Step 5 開始 〜 Step 6 終了)
  let r5;
  try {
    r5 = await runForrentFill({
      context, reinsData: r1.reinsData,
      processedImages: r3.processedImages, initialCostData: r3.initialCostData,
      texts: r4, logStep,
    });
    if (r5.status === "FORRENT_LOGIN_FAIL") {
      return { reinsId, status: "FORRENT_LOGIN_FAIL", propertyName: r1.propertyName };
    }

    const r6 = await runForrentRegister({
      forrentPage: r5.forrentPage, mainFrame: r5.mainFrame,
      runDir, logStep,
    });
    return {
      reinsId,
      propertyName: r1.propertyName || reinsId,
      status: r6.status,
      score: r6.score || null,
      registrationType: r6.registrationType,
      filledFields: Object.keys(r5.filled).length,
      uploadedImages: r5.uploaded.length,
      transport: r5.transport.filled.length,
      shuhen: r5.shuhen.filled.length,
      errors: r6.errors || [],
      formFillErrors: r5.allErrors.length,
    };
  } catch (err) {
    logStep("pipeline_exception", { error: err.message.slice(0, 300) });
    return {
      reinsId,
      propertyName: r1.propertyName || reinsId,
      status: "ERROR",
      error: err.message.slice(0, 200),
    };
  } finally {
    // r5 未代入 (Step 5 例外即発火) または FORRENT_LOGIN_FAIL (Stage 05 仕様で
    //  戻り値に forrentPage を含めない) のいずれでも、optional chaining で安全に短絡。
    await r5?.forrentPage?.close().catch(() => {});
  }
}
```

行数目標: < 80 行 (現状 247 行 → -160 行強の削減)。

## 依存グラフが closed であることの確認

各 stage が必要とする入力と提供する出力をマトリクスで確認:

| Stage | needs | provides |
|---|---|---|
| 01 | reinsPage, reinsId, index | reinsData, propertyName |
| 02 | reinsPage (01 後の状態), downloadDir | downloaded |
| 03 | context, reinsData (01), downloaded (02), downloadDir | processedImages, initialCostData |
| 04 | reinsData (01) | texts |
| 05 | context, reinsData (01), processedImages (03), initialCostData (03), texts (04) | forrentPage, mainFrame, filled, uploaded, transport, shuhen, allErrors |
| 06 | forrentPage (05), mainFrame (05), runDir | score, registrationType, errors |

closed = ✅ (すべての needs が外部入力 or 先行 stage の provides で満たされている)
