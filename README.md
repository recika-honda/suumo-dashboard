# suumo-dashboard

REINS 物件データの取得から forrent.jp（SUUMO 系）への入稿までを自動化するシステム。Notion DB をトリガーにした完全自動入稿が本流、ダッシュボード UI は単発入稿と過去履歴閲覧用。

## Tech Stack (Phase 6, 2026-05)

- **Frontend**: vanilla HTML / CSS / JS (`public/`) — Next.js / React / Tailwind / Framer Motion / Socket.IO は全廃
- **Backend**: Node 標準 `http` モジュール (`api-server.js`、200 行)。Express も非依存
- **Browser Automation**: Playwright (Chromium, headed)
- **AI**: Anthropic Claude API + OpenAI API (画像分類 / テキスト生成)
- **Data**: Notion API / Slack Web API / Sharp
- **Language**: JavaScript (TypeScript / バンドラなし、ビルド工程不要)

## Architecture

```
api-server.js              # Node http 薄サーバ (3 endpoint + 静的配信)
runNyuko.js                # 単一物件 CLI
public/                    # vanilla フロント (form + polling 進捗 + 履歴)
scripts/
  ├── batch-nyuko.js       # Notion 駆動の入稿 orchestrator (本番運用本流)
  ├── watch-nyuko.js       # Notion ポーリング常駐 (+ TIMEOUT 自動 resume / Phase 7.5)
  ├── resume-nyuko.js      # 既存 run の途中再開
  ├── archive-runs.js      # logs/runs アーカイブ (SUCCESS 7d / 失敗 30d / archive 90d)
  ├── run-archive-runs.sh  # archive-runs.js の launchd ラッパー
  ├── com.recika.fango.archive-runs.plist  # launchd 設定 (毎日 03:00)
  ├── pipeline-statuses.js # status → Notion 遷移マッピング
  ├── stages/              # 6 stage パイプライン (本リポの中核)
  │   ├── 01-reins-extract.js
  │   ├── 02-images-download.js
  │   ├── 03-images-classify.js
  │   ├── 04-texts-generate.js
  │   ├── 05-forrent-fill.js
  │   └── 06-forrent-register.js
  ├── lib/
  │   ├── artifact.js       # stage 入出力の永続化ヘルパー
  │   ├── run-inspect.js    # findResumeStage / retries.jsonl I/O (Phase 7.5)
  │   └── notion-feedback.js # failure category + reason builder (Phase 7.5)
  ├── test/                # 単体テスト (npm test で 70 cases pass)
  └── legacy/              # 本流外スクリプトのアーカイブ (Phase 5)
skills/                    # 外部世界 (REINS/forrent/Anthropic 等) のラッパ
  ├── forrent.js           # facade (67 LOC) — Phase 7 で 11 modules に分割
  ├── forrent/             # Phase 7 サブモジュール群
  │   ├── constants.js      # URLs / Selectors / コード変換表
  │   ├── validate.js       # 純粋 validation (REG_FAIL spec evaluator)
  │   ├── form-helpers.js   # fillById / fillByName / selectByName 等
  │   ├── session.js        # login / navigateToNewProperty
  │   ├── fill-texts.js     # norm / toFullWidth / sanitizeForLength / fillTexts
  │   ├── fill-tokucho.js   # 特徴項目 (SETSUBI_TO_TOKUCHO mapping)
  │   ├── fill-transport.js # 交通 (ViaMap / Cascade / Rakuraku)
  │   ├── fill-images.js    # 画像アップロード
  │   ├── fill-shuhen.js    # 周辺環境
  │   ├── fill-form.js      # fillPropertyForm + money/deposit/conditions
  │   └── register.js       # scrapeValidation / registerProperty
  └── (reins, bukaku, google-images, image-ai, text-ai, slack, score-checker, suumo-check, transport-filler, forrent-reader)
config/
  └── forrent-required.spec.json  # forrent 必須項目 spec
docs/refactor/             # リファクタ設計記録 (contract / stages / phase1-7-verify + phase7.5)
logs/
  ├── runs/                # production run artifacts
  ├── diag/                # 調査・smoke test 用 run (本番から隔離)
  ├── retries.jsonl        # TIMEOUT auto-resume の履歴 (Phase 7.5)
  └── nyuko-history.jsonl  # 全 run の 1 行サマリ
```

設計の正典:
- 入出力契約: `docs/refactor/contract.md`
- 6 stage 仕様: `docs/refactor/stages.md`
- 新必須項目追加: `docs/refactor/adding-required-field.md`
- 検証履歴: `docs/refactor/phase{1..7}-*.md` + `docs/refactor/phase7.5-archive-and-feedback.md`
- forrent 分割の正典: `docs/refactor/phase7-forrent-split.md`

全入口 (api-server / batch / watch / cli) が同じ `scripts/stages/` を経由する設計。spec / sanitizeForLength の修正 1 箇所で全フローに反映される。

## Prerequisites

- Node.js 18+ (実行は `node`、依存 install は `bun install` 推奨)
- Anthropic API Key / OpenAI API Key
- Notion API Token + Database ID
- Slack Bot Token (#ex_fango 通知用)
- REINS / forrent.jp のアカウント
- **デスクトップ環境必須** (`headless: false` でブラウザが画面表示される)

## Setup

```bash
git clone https://github.com/kntkn/suumo-dashboard.git
cd suumo-dashboard

# Install dependencies
bun install

# Install Playwright browser
bunx playwright install chromium

# Configure env vars
cp .env.example .env.local
# Edit .env.local
```

### Environment Variables

| Variable | Required | Description |
|---|---|---|
| `REINS_LOGIN_ID` | Yes | REINS ログイン ID |
| `REINS_LOGIN_PASS` | Yes | REINS ログインパスワード |
| `SUUMO_LOGIN_ID` | Yes | forrent.jp ログイン ID |
| `SUUMO_LOGIN_PASS` | Yes | forrent.jp ログインパスワード |
| `ANTHROPIC_API_KEY` | Yes | Claude API key |
| `OPENAI_API_KEY` | Yes | OpenAI API key |
| `NOTION_TOKEN` | Yes | Notion API token |
| `NOTION_DATABASE_ID` | Yes | 物件 DB ID |
| `SLACK_BOT_TOKEN` | Yes | `#ex_fango` 通知用 |
| `ITANDI_EMAIL` / `ITANDI_PASSWORD` | No | ITANDI BB (物確補助) |
| `IELOVEBB_EMAIL` / `IELOVEBB_PASSWORD` | No | いえらぶ BB (物確補助) |
| `PORT` | No | Server port (default: 3500) |

## Run

### ダッシュボード UI (単発入稿 + 履歴閲覧)

```bash
node api-server.js
# → http://localhost:3500
```

ビルド不要。3 endpoint のみ:
- `POST /run` — `{reinsId}` を投げると runNyuko.js を spawn
- `GET /status/:runId` — `logs/runs/{runId}/run.json` をそのまま返却 (フロントが 3 秒間隔で polling)
- `GET /history` — `logs/nyuko-history.jsonl` 末尾 50 件

### Notion 駆動の自動入稿 (本番運用本流)

```bash
# 常駐ポーリング (推奨)
bash scripts/run-watch-nyuko.sh
# または
bun run scripts/watch-nyuko.js
```

Notion Status="広告待ち" の物件を検出すると `batch-nyuko.js` を spawn して入稿。
詳細: `/Volumes/AgentSSD/04_FANGO/FNG26_AI入稿システム/.claude/CLAUDE.md` §Notion駆動の自動入稿フロー

### 単発入稿 (CLI)

```bash
node runNyuko.js <reinsId>
```

### 途中再開

```bash
bun run scripts/resume-nyuko.js {runId} --from {stage}
# 例: bun run scripts/resume-nyuko.js 20260512-090000_100139015499 --from 05-forrent-fill
```

`--from 06-forrent-register` は forrentPage を復元できないため不可 (`--from 05-forrent-fill` で代用)。

## Tests

```bash
npm test        # node で test-*.js を順次実行
```

`bun test` は使わない (bun は `*.test.js` / `*.spec.js` パターンしか拾わず、本プロジェクトの
`test-*.js` ファイルを素通りする)。`package.json#scripts.test` で順序を明示制御している。

70 cases (2026-05-14):
- `test-sanitize-for-length.js` — CRLF +1 char 回帰 (14)
- `test-spec-validator.js` — forrent 必須項目 spec (11)
- `test-run-inspect.js` — Phase 7.5 findResumeStage / retries.jsonl (11)
- `test-validate.js` — Phase 7 resolvePropertyTypeCode / appliesToMatches (17)
- `test-notion-feedback.js` — Phase 7.5 categorizeError / reason builder (17)

## ログ / Artifact

- `logs/runs/{yyyymmdd-hhmmss}_{reinsId}/run.json` — ステップ毎のタイムスタンプと最終 status
- `logs/runs/.../{stage}/input.json` `output.json` — 6 stage 各々の入出力 artifact
- `logs/runs/.../06-forrent-register/confirm-attempt{N}.html|png` — 確認画面スナップショット
- `logs/nyuko-history.jsonl` — 入稿履歴
- `logs/retries.jsonl` — TIMEOUT 自動 resume の履歴 (Phase 7.5)
- `logs/diag/` — 調査用 run の隔離先 (本番 `logs/runs/` と分離)
- `logs/archive-runs.log` — アーカイブ自動化の launchd 実行ログ

アーカイブ管理 (Phase 7.5): `node scripts/archive-runs.js [--dry-run]` で SUCCESS 7 日超を tar.gz、失敗系 30 日超を tar.gz、tar.gz 90 日超を `logs/runs/archive/yyyy-mm/` に移送。launchd plist を `~/Library/LaunchAgents/` に置けば毎日 03:00 JST で自動実行 (詳細は `scripts/com.recika.fango.archive-runs.plist` のコメント)。

## Documentation

詳細仕様・ドメイン知識・運用フローは:
- プロジェクト CLAUDE.md: `/Volumes/AgentSSD/04_FANGO/FNG26_AI入稿システム/.claude/CLAUDE.md`
- コードベース CLAUDE.md: `./.claude/CLAUDE.md`
- リファクタ設計記録: `./docs/refactor/`
