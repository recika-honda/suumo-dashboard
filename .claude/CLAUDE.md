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
- Skills layer in `skills/`: reins, forrent (facade), bukaku, google-images, google-maps, image-ai, text-ai, score-checker, suumo-check, transport-filler, slack, forrent-reader
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
- **テスト**: `npm test` で 70 cases pass (sanitize-for-length / spec-validator / run-inspect / validate / notion-feedback)

## Adding UI progress events (Phase 6 update)

Phase 4 で導入した `STAGE_EVENT_TO_UI` マップは server.js 削除に伴い廃止。Phase 6 のフロントは polling 方式で `run.json#steps` を読み取って表示するため、stages 側で `logStep(name, payload)` を呼べば自動で UI に反映される。

新しい中間進捗を出したい時の運用:
1. stages 内の該当処理開始直前に `logStep("○○_start", payload)` を追加 (event 名はフェーズ名のみ、DOM/selector の知識を入れない)
2. `createRunLog#step` が `{name, at, ...payload}` を `run.json#steps[]` に append + 即 flush するので、フロントの polling (3 秒間隔) で順次表示される
3. 文言整形は `public/index.html` の polling ハンドラ側で行う (現状は `name (count)` or `name — error` のフォーマット)
4. stages の logStep 形式は batch-nyuko / watch-nyuko 経路 (本番運用) と同じものを共有 — UI 専用イベントを作らない

## Diagnosing smoke test REG_FAIL
Stage 01 早期 REG_FAIL or forrent サーバ側「○○ を入力して下さい」が出たら:
1. `cat logs/runs/{latest}_{reinsId}/01-reins-extract/output.json` で reinsData の中身確認
2. field 欠落なら 3-layer probe: (a) DOM の該当 `<div class="col-sm-4">` 中身、(b) API レスポンス `getInitData` の対応キー (略号は `.claude/reins-api-keys.md`)、(c) playwright screenshot で人間目視
3. 3 layer 全て空 → 元付業者の入力漏れ。`config/forrent-required.spec.json` に entry 追加で次回 14 秒で reject (詳細: `docs/refactor/adding-required-field.md`)
4. DOM/API には値あるが reinsData に無い → extractor バグ。`skills/reins.js#extractPropertyData` の regex を修正
