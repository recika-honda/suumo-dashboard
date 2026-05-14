# Phase 6 動作確認結果

## 概要

ダッシュボードのフロントを Next.js 15 + React 19 + Tailwind 4 + Socket.IO + Framer Motion から vanilla HTML/CSS/JS に置換。バックエンドも Express を捨てて Node 標準 http モジュールに置換。

実施日: 2026-05
ブランチ: `refactor/cleanup-2026-05` 系列

## 1. 動機

Phase 1〜4 でパイプライン (`scripts/stages/`) は安定化したが、フロントとサーバはリッチすぎる stack のまま残っていた:
- React 19 + Next.js App Router + Tailwind v4 + Framer Motion + Socket.IO クライアント
- ビルド工程必須 (`next build`)、依存大量、ホットリロードで dev サーバが別途必要
- リアルタイム性は実質 **headed Playwright のブラウザ画面** が担っており、ダッシュボードはステップ進捗を眺める程度の用途
- 入稿頻度が今後さらに低下する (Notion 駆動の自動化が本流化) ことを踏まえると、UI のメンテコストが過剰

→ 「ダッシュボードは過去履歴ビューワに収束する」前提で、フロントを最小化する。

## 2. 変更内容

### Frontend
- `public/index.html` (162 行) — form + 進捗表示 (polling) + 履歴一覧、単一ページ
- `public/style.css` (150 行) — functional minimalism
- 削除: `app/`, `components/`, `next.config.js`, `tailwind.config.js`, `postcss.config.js`, `tsconfig.json`, `socket-client.ts` 等

### Backend
- `api-server.js` (200 行) — Node 標準 `http` モジュールのみ
- 3 endpoint + 静的配信:
  - `POST /run` — `{reinsId}` を受け取り `runNyuko.js` を spawn、stdout 先頭から runId を抽出して返す
  - `GET /status/:runId` — `logs/runs/{runId}/run.json` をそのまま返す
  - `GET /history` — `logs/nyuko-history.jsonl` 末尾 50 件
- 削除: Express, `server.js` (Socket.IO カスタムサーバ), `STAGE_EVENT_TO_UI` マップ

### 進捗表示メカニズム
- 旧: Socket.IO で `STAGE_EVENT_TO_UI` マップ経由のイベント push (server.js 側で文言整形)
- 新: `public/index.html` が `setInterval` 3 秒間隔で `GET /status/:runId` を polling → `run.json#steps[]` を読み取り表示 (文言整形もフロント側)
- stages 内で `logStep(name, payload)` を呼ぶ → `createRunLog#step` が即 flush → 次の polling で UI 反映

### Tech Stack 残存
- Playwright (Chromium, headed)
- Anthropic SDK / OpenAI SDK
- Sharp / Notion SDK / Slack Web API
- JavaScript only (TypeScript / bundler 廃止)

## 3. ファイル数 / 依存数の縮減

| 指標 | Phase 5 時点 | Phase 6 後 |
|------|------------|---------|
| Frontend file count | ~30 (app/, components/) | 2 (`public/index.html`, `public/style.css`) |
| Frontend deps | Next/React/Tailwind/Framer/Socket.io-client | 0 (生 HTML/CSS/JS) |
| Backend deps | Express + Socket.io + custom server | 0 (Node 標準 http) |
| ビルド工程 | `next build` 必須 | 不要 |

`package.json` の dependencies は:
- `@anthropic-ai/sdk`, `@notionhq/client`, `@slack/web-api`, `dotenv`, `openai`, `playwright`, `sharp`
- React / Next.js / Express / Socket.IO / Tailwind / Framer Motion 全削除

## 4. 全入口が同じ stages を経由する不変条件

Phase 3 で確立した「dashboard / batch / watch / cli の全入口が `scripts/stages/` を通る」性質は Phase 6 でも保持:
- `api-server.js POST /run` → spawn `runNyuko.js` → `processProperty` → `stages/01..06`
- `scripts/batch-nyuko.js` → `processProperty` → `stages/01..06`
- `scripts/watch-nyuko.js` → spawn `batch-nyuko.js` → 同上
- `scripts/resume-nyuko.js {runId} --from {stage}` → `stages/{stage..06}`

→ skills / spec / sanitizeForLength の修正 1 箇所で全入口に反映される性質は維持。

## 5. Acceptance Criteria 達成状況

| AC | 結果 |
|---|---|
| 1. フロントから React/Next/Tailwind/Framer/Socket.IO 削除 | ✅ |
| 2. バックエンドから Express 削除、Node 標準 http のみ | ✅ |
| 3. 進捗表示が polling 方式で動作 | ✅ `public/index.html` line 103 で 3 秒 polling |
| 4. 3 endpoint (run / status / history) のみで完結 | ✅ `api-server.js` line 176-185 |
| 5. dashboard も `stages/` 経由の不変条件を維持 | ✅ spawn `runNyuko.js` → `processProperty` |
| 6. ビルド工程不要で起動可能 | ✅ `node api-server.js` のみ |

## 6. 残課題

- `README.md` を Next.js 時代の記述から Phase 6 構成に更新 (本 verify と同時に着手)
- `docs/e2e-spec.md` の現役判定 (Phase 6 で UI を縮小したため、E2E spec が現状と整合するか未確認)
- Anti-pattern として「フロントを Next/React/Socket.IO 等に機能性のため戻す」を CLAUDE.md に追加 (✅ 既に記載済)

## 7. 結論

✅ **Phase 6 完了**。フロント・バックエンドが最小化され、入稿頻度低下のトレンドに整合した形になった。Notion 駆動の自動入稿 (本流) はこの変更の影響を受けない (`watch-nyuko.js` / `batch-nyuko.js` 経路は別)。
