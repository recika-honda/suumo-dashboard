# suumo-dashboard — Project Rules

## Overview
End-to-end REINS-to-SUUMO listing automation dashboard with AI image classification, real-time progress via WebSocket.

## Tech Stack
- Next.js 15 (App Router) + custom Express server with Socket.IO for real-time updates
- React 19, Tailwind CSS 4, Framer Motion
- Playwright for REINS/SUUMO/ForRent browser automation
- Anthropic SDK for AI image analysis and text generation (`skills/image-ai.js`, `skills/text-ai.js`)
- Sharp for image processing, Notion SDK, Slack Web API
- JavaScript (no TypeScript)

## Key Notes
- Dev: `bun run dev` / Prod: `bun run start` — both use `server.js` (Express + Next.js + Socket.IO)
- Skills layer in `skills/`: reins, forrent, bukaku-images, google-images, google-maps, image-ai, text-ai, score-checker, suumo-check, transport-filler
- Batch/operational scripts in `scripts/` (e.g., `reins-to-notion.js`, `dedupe.js`, `migrate-nyuko-status.js`)
- E2E / smoke / diagnostic scripts: `scripts/legacy/` (e.g., `e2e-test-15.js`, `batch-test.js`, `diagnose-nyuko.js`) — 本流フローからは参照されない
- Requires `.env.local` with REINS/SUUMO credentials, Notion token, Anthropic API key, Slack token

## Architecture (2026-05 refactor)
- `scripts/batch-nyuko.js` は薄い orchestrator (processProperty ~71 行)。パイプラインは `scripts/stages/01..06-*.js` の 6 stage に分割
- 各 stage I/O は `logs/runs/{ts}_{reinsId}/{stage}/{input,output}.json` に永続化 (`scripts/lib/artifact.js`)
- 途中再開: `bun run scripts/resume-nyuko.js {runId} --from {stage}` (cache から prior stage 復元、`--from 06` は forrentPage 復元不能で不可)
- forrent 必須項目: `config/forrent-required.spec.json` + `skills/forrent.js#validateBySpec`。新 field は JSON に entry 追加するだけ (JS 変更不要)
- 文字数制限フィールド: `skills/forrent.js#sanitizeForLength(text, maxLen)` 経由必須 (CRLF +1 char anti-pattern 予防)。biko だけ toFullWidth 前段が必要で inline 維持
- ダッシュボード UI (`server.js#runNyuko`) も同じ 6 stage 経由 (Phase 3)。skill 直接呼び出しは `reins.login` (Step 0) のみ。`forrent.X` を server.js から呼ばない
- 設計正典: `docs/refactor/{contract.md, stages.md, adding-required-field.md}`、各 phase の検証: `docs/refactor/phase{1..4}-verify.md`
- main commit `28245ff` が pre-refactor snapshot。挙動の semantic 等価性を確認する基準点

## Adding UI progress events (Phase 4)

UI に新しい中間進捗を出したい時の運用:
1. stages 内の該当処理開始直前に `logStep("○○_start", payload)` を追加 (event 名はフェーズ名のみ、DOM/selector の知識を入れない)
2. `server.js` の `STAGE_EVENT_TO_UI` マップに 1 行追加: `{ step: N, msg: "..." }` or `{ step: N, msg: (p) => \`${p.count}枚処理中\` }`
3. それだけで UI に `emit(N, "running", msg)` が流れる。stages の他 caller (batch-nyuko の `runLog.step`) は steps 配列に append するだけで副作用ゼロ
4. **完了系 event** (`form_filled` / `images_classified` 等) は map に**入れない** — server.js 側で stage 直後に `emit(N, "done", ...)` するため二重発火回避

## Diagnosing smoke test REG_FAIL
Stage 01 早期 REG_FAIL or forrent サーバ側「○○ を入力して下さい」が出たら:
1. `cat logs/runs/{latest}_{reinsId}/01-reins-extract/output.json` で reinsData の中身確認
2. field 欠落なら 3-layer probe: (a) DOM の該当 `<div class="col-sm-4">` 中身、(b) API レスポンス `getInitData` の対応キー (略号は `.claude/reins-api-keys.md`)、(c) playwright screenshot で人間目視
3. 3 layer 全て空 → 元付業者の入力漏れ。`config/forrent-required.spec.json` に entry 追加で次回 14 秒で reject (詳細: `docs/refactor/adding-required-field.md`)
4. DOM/API には値あるが reinsData に無い → extractor バグ。`skills/reins.js#extractPropertyData` の regex を修正
