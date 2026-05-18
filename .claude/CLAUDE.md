# suumo-dashboard — Project Rules

## Overview
REINS-to-forrent.jp listing automation. Vanilla HTML front +薄い Node http サーバ + 6-stage Playwright パイプライン (Phase 6, 2026-05)。リアルタイム可視化は headed Playwright のブラウザ自身が担うので、フロントは polling で十分。

## Tech Stack
- Frontend: vanilla HTML / CSS / JS (`public/`) — Next.js / React / Tailwind / Framer Motion / Socket.IO は全削除済み (Phase 6)
- Backend: Node 標準 http モジュール (`api-server.js`)。Express も非依存
- Playwright (Chromium, headed) for REINS / forrent.jp automation
- Anthropic SDK + OpenAI SDK (`skills/image-ai.js`, `skills/text-ai.js`)
- Sharp / Notion SDK / Slack Web API
- JavaScript (no TypeScript, no bundler)
- Tests: `npm test` (= node で test-*.js を順次実行)。**`bun test` は使わない** — bun は `*.test.js` パターンしか拾わず、本プロジェクトの `test-*.js` を素通りする

## Key Notes
- Dev / Prod: `node api-server.js` (default port 3500、`PORT=` で上書き可)。3456 は別プロジェクトに使われているので避ける (port-routing rule: runtime-board で衝突確認済)
- 単発入稿 CLI: `node runNyuko.js <reinsId>` — api-server 経由でも内部的に spawn される
- 3 endpoint: `POST /run` (spawn runNyuko 後 stdout から runId を抽出して返す) / `GET /status/:runId` (run.json をそのまま返す) / `GET /history` (nyuko-history.jsonl の末尾 50 件)
- **REINS↔forrent フィールド対応表 SSOT**: `docs/forrent-field-mapping.html` (TOC + 21 セクション + 付録 + セルフチェックリスト)。スキル層 (`skills/forrent/*` / `skills/reins.js`) 変更時は同期させる
- Skills layer in `skills/`: reins, forrent (facade), bukaku, image-cascade, google-images, google-maps, image-ai, text-ai, score-checker, score-escalation, suumo-check, transport-filler, slack, forrent-reader
  - **`skills/forrent.js` は Phase 7 (2026-05-14) で 67 LOC facade に縮減**。実装は `skills/forrent/` 配下 11 モジュール: constants / validate / form-helpers / session / fill-texts / fill-tokucho / fill-transport / fill-images / fill-shuhen / fill-form / register
  - public API (`require("../skills/forrent")` の export) は完全互換 → stage / api-server 側は無変更
  - `bukaku.js` は 2026-05-14 に ATBB 代替検討 (100件評価で実用マッチ率 65.2%、大手系列流通契約なしが構造要因) の結果として継続確定。検証資産は `scripts/legacy/atbb/` と `docs/legacy/atbb/`、意思決定は `../../.claude/data/decisions/0001-atbb-route-sunset.md`
- Batch/operational scripts in `scripts/` (e.g., `reins-to-notion.js`, `dedupe.js`, `migrate-nyuko-status.js`)
- E2E / smoke / diagnostic scripts: `scripts/legacy/` — 本流フローからは参照されない
- Requires `.env.local` with REINS/SUUMO credentials, Notion token, Anthropic API key, OpenAI API key, Slack token
- フロント (`public/`) の見た目を弄るときは `.claude/frontend-style.md` を参照 (functional minimalism 規範)

## Architecture (2026-05 refactor)
- `scripts/batch-nyuko.js` は薄い orchestrator (processProperty ~71 行)。パイプラインは `scripts/stages/01..06-*.js` の 6 stage に分割
- 各 stage I/O は `logs/runs/{ts}_{reinsId}/{stage}/{input,output}.json` に永続化 (`scripts/lib/artifact.js`)
- 途中再開: `bun run scripts/resume-nyuko.js {runId} --from {stage}` (cache から prior stage 復元、`--from 06` は forrentPage 復元不能で不可)
- forrent 必須項目: `config/forrent-required.spec.json` + `skills/forrent` の `validateBySpec` (実体は `skills/forrent/validate.js`)。新 field は JSON に entry 追加するだけ (JS 変更不要)
- 文字数制限フィールド: `skills/forrent` の `sanitizeForLength(text, maxLen)` (実体は `skills/forrent/fill-texts.js`) 経由必須 (CRLF +1 char anti-pattern 予防)。biko だけ toFullWidth 前段が必要で inline 維持
- ダッシュボード UI (`api-server.js` → spawn `runNyuko.js`) も同じ 6 stage 経由 (Phase 3 / 6)。skill 直接呼び出しは `reins.login` (Step 0) のみ。`forrent.X` を api-server から呼ばない
- 設計正典: `docs/refactor/{contract.md, stages.md, adding-required-field.md}`、各 phase の検証: `docs/refactor/phase{1..7}-*.md` + `phase7.5-archive-and-feedback.md`
- main commit `28245ff` が pre-refactor snapshot。挙動の semantic 等価性を確認する基準点

## Phase 7 / 7.5 (2026-05-14)

- **forrent.js 分割**: 3,136 LOC monolith → 67 LOC facade + 11 サブモジュール (`skills/forrent/`)。facade パターンで public API 維持。詳細: `docs/refactor/phase7-forrent-split.md`
- **TIMEOUT auto-resume**: watch-nyuko が batch の report から TIMEOUT を検出 → `findResumeStage(runDir)` (`scripts/lib/run-inspect.js`) で次の stage を判定 → `resume-nyuko.js` を spawn して 1 物件 1 回まで自動 retry。履歴は `logs/retries.jsonl`
- **Notion フィードバック**: batch/watch から Notion を「入稿失敗」フリップ時に「失敗カテゴリ」(Select) + 「入稿失敗理由」(Rich text) も同送。カテゴリ判定は純粋関数 `scripts/lib/notion-feedback.js#categorizeError`。Notion DB にプロパティ未追加でも graceful フォールバックで Status のみは確実に反映
- **logs/runs アーカイブ**: `scripts/archive-runs.js` で SUCCESS 7d / 失敗 30d → tar.gz、90d → `logs/runs/archive/yyyy-mm/` 移送。launchd で毎日 03:00 自動実行 (`scripts/com.recika.fango.archive-runs.plist`)。`logs/diag/` は調査用 run の隔離先 (本番 `logs/runs/` と分離)

## Phase 1 + 2 + 3a + P1 (2026-05-15)

- **Phase 1 — Vision モデル upgrade** (`skills/image-ai.js`): `gpt-4o-mini` + `detail:low` → `gpt-4o` + `detail:high`、プロンプト改訂 (21=その他 を最後の手段化、誤分類 hard case 例を追加)。126513 で 21→41pt 検証済。
- **Phase 2 — IMAGE_INSUFFICIENT 早期 exit** (`scripts/stages/02-images-download.js`): REINS raw ≤ 閾値で screenshot を撮らず early exit。Notion を「画像欠落」(orange option、API で追加済) にフリップ。121583 で 7分→25秒 検証済。
- **Phase 3a — 物確 cascade (商号判定なし)** (`skills/image-cascade.js`): 物件名+部屋番号で itandi に直接検索、ヒットしたら画像取得。`bukaku.js` の `itandiLogin`/`itandiSearchProperty`/`itandiGetImages`/`downloadImage` を export して再利用。Phase 3b (atbb) / 3c (essquare) は次回。
- **REG_FAIL P1 fix**: (1) `toFullWidth` を etcHiyo/etcShohiyo に適用 (`toLocaleString()` の半角混入対策)、(2) 新 helper `sanitizeForForrentText` (NFKD → strip Latin combining → **NFC recompose** → toFullWidth → length cap) を catchCopy/freeComment に適用、(3) spec.json に `地上階層` entry 追加 (Stage 01 14秒 reject)。127191 で 25→38pt 検証済 (escalated)。
- **escalation** (Phase 7+ から継続): score ≥ 34 で 訂正→掲載→sumapiku/tenpiku ON→再確認→登録。閾値 `config/score-escalation.json` + env `SCORE_ESCALATION_THRESHOLD`。
- **テスト**: `npm test` で **152 cases pass** (70 → +18 score-escalation + 14 pipeline-statuses + 7 image-cascade + 18 to-full-width + 18 sanitize-for-forrent-text + 3 spec-validator + 3 notion-feedback)。

### env vars (上書き可、`.env.local` で設定)
| var | default | 用途 |
|-----|---------|------|
| `OPENAI_VISION_MODEL` | `gpt-4o` | Vision 分類モデル (skills/image-ai.js) |
| `OPENAI_VISION_DETAIL` | `high` | Vision detail 解像度 (low/high) |
| `IMAGE_INSUFFICIENT_THRESHOLD` | `2` | REINS raw <= N で IMAGE_INSUFFICIENT 判定 |
| `PHASE3_CASCADE` | (enabled) | `0` で cascade 無効化 (デバッグ用) |
| `SCORE_ESCALATION_THRESHOLD` | `34` | score >= N で escalation 路線へ昇格 |
| `NYUKO_HEADLESS` | `0` | headed default。`1` で headless (debug only、本番非推奨) |

## Adding UI progress events (Phase 6 update)

Phase 4 で導入した `STAGE_EVENT_TO_UI` マップは server.js 削除に伴い廃止。Phase 6 のフロントは polling 方式で `run.json#steps` を読み取って表示するため、stages 側で `logStep(name, payload)` を呼べば自動で UI に反映される。

新しい中間進捗を出したい時の運用:
1. stages 内の該当処理開始直前に `logStep("○○_start", payload)` を追加 (event 名はフェーズ名のみ、DOM/selector の知識を入れない)
2. `createRunLog#step` が `{name, at, ...payload}` を `run.json#steps[]` に append + 即 flush するので、フロントの polling (3 秒間隔) で順次表示される
3. 文言整形は `public/index.html` の polling ハンドラ側で行う (現状は `name (count)` or `name — error` のフォーマット)
4. stages の logStep 形式は batch-nyuko / watch-nyuko 経路 (本番運用) と同じものを共有 — UI 専用イベントを作らない

## Finding forrent.jp 特徴項目 (categoryTokuchoCd) codes

新しいデフォルト/マッピング追加時、forrent にログインせずに保存済み HTML から id を引く:
1. `logs/runs/*/edit-after-teisei.html` を開く (escalation 経由 run が確実に持つ)
2. `grep -oE '"id":"[0-9]+","name":"[^"]+"' edit-after-teisei.html | sort -u` で全 categoryTokuchoCd の id-name pair が取れる
3. checkbox 実在確認: `grep -c 'categoryTokuchoCd.*value="<CODE>"' edit-after-teisei.html`

**FANGO デフォルト**: REINS データに依らず常時チェックする特徴項目は `skills/forrent/fill-tokucho.js#DEFAULT_TOKUCHO_CODES` で一元管理。追加したい code は配列に append するだけで `fillTokucho` の step 3 で自動 union される (キーワード推定との重複は Set で吸収)。

## Diagnosing smoke test REG_FAIL
Stage 01 早期 REG_FAIL or forrent サーバ側「○○ を入力して下さい」が出たら:
1. `cat logs/runs/{latest}_{reinsId}/01-reins-extract/output.json` で reinsData の中身確認
2. field 欠落なら 3-layer probe: (a) DOM の該当 `<div class="col-sm-4">` 中身、(b) API レスポンス `getInitData` の対応キー (略号は `.claude/reins-api-keys.md`)、(c) playwright screenshot で人間目視
3. 3 layer 全て空 → 元付業者の入力漏れ。`config/forrent-required.spec.json` に entry 追加で次回 14 秒で reject (詳細: `docs/refactor/adding-required-field.md`)
4. DOM/API には値あるが reinsData に無い → extractor バグ。`skills/reins.js#extractPropertyData` の regex を修正

## Diagnosing IMAGE_INSUFFICIENT (Phase 2 + 3a)
status=`IMAGE_INSUFFICIENT` の run が出たら:
1. `run.json#steps` で `image_insufficient_detected` (rawCount=N, threshold=T) を確認 → REINS 元データの画像枚数
2. `cascade_start` → `cascade_hit` または `cascade_miss` で物確 PF 試行結果を確認 (attempts 配列に各 PF の status)
3. `cascade_miss` だった場合: 該当物件が itandi BB に登録されていない可能性大 (元付業者の運用次第)。Phase 3b/3c 実装後は atbb/essquare も自動試行
4. **smoke で cascade を強制発火させたい場合**: `IMAGE_INSUFFICIENT_THRESHOLD=10 node runNyuko.js <reinsId>` で raw≤10 の物件にも cascade を試させる (production の閾値 2 は変えない)
5. Notion 「画像欠落」になった物件は素材依頼ワークフローへ。再 REINS 取得で raw が増えれば次サイクルで通常 path へ復帰
