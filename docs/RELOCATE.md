# 新 mac への移行 runbook

旧 mac (kento Mac mini) → 新 mac (kento の別 mac、現在大木さんが使用中) への完全切替手順。

## 前提

- 同一 Apple ID / 同一 kento ユーザ (`/Users/kentohonda/`)
- REINS / SUUMO / forrent / Notion / Slack / 業者間サイト (atbb / itandi / iele love bb) のアカウント情報はそのまま (= kento の本人アカウント)
- Notion DB / Slack channel / GitHub repo は共有 SSOT、変更不要
- 新 mac には外付け SSD (AgentSSD) は繋がない前提 → code は新 mac のローカル (`~/dev/suumo-dashboard`) に clone する
- Chrome Remote Desktop 経由で kento が新 mac を操作

旧 mac は **既に watch-nyuko を停止済** (`launchctl unload jp.fango.watch-nyuko.plist`、2026-05-18 実施)。

## Phase 1: 新 mac の環境準備

新 mac の Claude Code で以下を順に確認・インストール:

### 1.1 node (fnm) + bun が入っているか

```bash
node --version   # v24.x 期待
bun --version    # 1.3.x 期待
which node       # /Users/kentohonda/.fnm/aliases/default/bin/node 期待
```

入ってなければ:

```bash
# fnm + node
brew install fnm
fnm install 24
fnm default 24
fnm alias default 24  # ~/.fnm/aliases/default/bin/node が指す先を作る

# bun
curl -fsSL https://bun.sh/install | bash
```

### 1.2 git / gh が入っているか

```bash
git --version
gh --version
gh auth status   # kntkn アカウントでログイン済か
```

未認証なら `gh auth login` で kntkn の GitHub にログイン。

### 1.3 native binary 依存 (必須) — **package.json / bun.lock に出ないため最も抜けやすい**

> **重要**: 以下 3 点は `bun install` では入らない。OS レベルの binary なので個別にインストールする。
> 過去、poppler の入れ忘れで maisoku 経路 (stage 02c) が新 mac で全停止し、smoke 1 件目で発覚した
> (gotcha 2026-05-18)。同じ轍を踏まないよう、依存解決 (Phase 4) の前にここで必ず揃える。

native binary は 3 つ。runtime (node/bun) でも node deps でもない第 3 の系統として扱う。

#### (a) ImageMagick — `magick` (stage 04b 画像加工に必須)

```bash
brew install imagemagick
magick --version   # Version: ImageMagick 7.x が出れば OK
```

stage 04b (画像リタッチ) が `magick` を spawn してホワイトバランス / ガンマ補正 / リサイズを行う。
未導入だと stage 04b の加工が全 image で失敗する (失敗時は stage 03 の元画像にフォールバックするので
入稿自体は止まらないが、画質改善効果がゼロになる)。

#### (b) poppler — `pdftotext` / `pdftoppm` (stage 02c maisoku OCR に必須)

```bash
brew install poppler
pdftotext -v       # pdftotext version 24.x が出れば OK
pdftoppm -v        # 同上
```

stage 02c (マイソク PDF テキスト抽出) が dual-mode で使う:
primary = `pdftotext` で PDF 内テキストを直接抽出、fallback = `pdftoppm` で PDF→JPEG 変換してから
Vision OCR。両 path とも poppler 依存なので、**未導入だと maisoku 経路が完全に死ぬ**
(取りこぼし特徴コードの自動獲得がゼロになる)。RELOCATE.md の旧版で明記漏れだったため今回追記。

#### (c) Real-ESRGAN — `realesrgan-ncnn-vulkan` binary + models (stage 04b 超解像に使用)

Homebrew formula は無い。GitHub release から binary + models を手動配置する。

```bash
# 1. GitHub release から macOS 版 zip を取得 (実績: v0.2.5.0)
#    https://github.com/xinntao/Real-ESRGAN/releases
#    realesrgan-ncnn-vulkan-YYYYMMDD-macos.zip を DL

# 2. 配置先を作って展開 (repo 内 tools/realesrgan/ を推奨)
mkdir -p ~/dev/suumo-dashboard/tools/realesrgan
cd ~/dev/suumo-dashboard/tools/realesrgan
unzip ~/Downloads/realesrgan-ncnn-vulkan-*-macos.zip
# 展開後: realesrgan-ncnn-vulkan (binary) + models/ (realesrgan-x4plus.bin/.param 等)

# 3. Gatekeeper の quarantine 属性を外す (これをしないと「開発元を検証できません」で起動不可)
xattr -dr com.apple.quarantine ~/dev/suumo-dashboard/tools/realesrgan

# 4. 動作確認 (Apple Silicon は Metal/Vulkan 経由で GPU 動作)
~/dev/suumo-dashboard/tools/realesrgan/realesrgan-ncnn-vulkan -h
```

binary が見つからない場合、stage 04b は超解像を skip して ImageMagick 加工のみで続行する
(元画像でも入稿は valid なので安全側に倒れる)。よって Real-ESRGAN は (a)(b) より優先度はやや低いが、
画質を最大化するなら導入する。

#### binary / models のパス解決順 (T001 design doc と一致)

stage 04b は以下の順でパスを解決する。明示指定したいときは env で上書きする
(詳細は `docs/refactor/retouch-stage-design.md` §4):

binary (`REALESRGAN_BIN`):

1. `REALESRGAN_BIN` env (明示指定・最優先)
2. repo 同梱 `tools/realesrgan/realesrgan-ncnn-vulkan`
3. 開発機 fallback `~/Desktop/suumo-nyuko/_upscale-tool/realesrgan-ncnn-vulkan`

models (`REALESRGAN_MODELS`):

1. `REALESRGAN_MODELS` env (明示指定・最優先)
2. repo 同梱 `tools/realesrgan/models/`
3. 開発機 fallback `~/Desktop/suumo-nyuko/_upscale-tool/models/`

> **園田PC (本番ホスト) の注意**: 園田PC は kento の `/Users/kentohonda/` ではない **別 macOS ユーザ**。
> 上記 fallback (3) の `~/Desktop/...` は kento の開発機にしか無いため当てにできない。
> 園田PC では binary / models を repo 同梱 (2) に置くか、`.env.local` の `REALESRGAN_BIN` /
> `REALESRGAN_MODELS` で園田PC の実 `$HOME` 基準の絶対パスを明示する。Desktop ハードコードに依存しない。

## Phase 2: code を clone

```bash
mkdir -p ~/dev
cd ~/dev
git clone git@github.com:kntkn/suumo-dashboard.git
cd suumo-dashboard
git checkout refactor/cleanup-2026-05
git log --oneline -5
```

最新 4 commit (capacity fallback / measurement / pipeline / forrent escalation 等) が見えれば OK。

## Phase 3: `.env.local` を作成

`.env.local` は git 管理外 (gitignore 済)。kento が **旧 mac の値を読み上げて新 mac に手で paste する**。Chrome Remote Desktop 越しなので 1 個ずつ。

```bash
cd ~/dev/suumo-dashboard
touch .env.local
chmod 600 .env.local
```

入れるキー (旧 mac から値を取って来る):

```
NOTION_TOKEN=...
NOTION_DATABASE_ID=...
NOTION_NYUKO_DB_ID=...
ANTHROPIC_API_KEY=...
OPENAI_API_KEY=...
SLACK_USER_TOKEN=...
SLACK_DM_CHANNEL_ID=...
REINS_LOGIN_ID=...
REINS_LOGIN_PASS=...
SUUMO_LOGIN_ID=...
SUUMO_LOGIN_PASS=...
ITANDI_EMAIL=...
ITANDI_PASSWORD=...
IELOVEBB_EMAIL=...
IELOVEBB_PASSWORD=...
POLL_INTERVAL_SEC=60
PORT=3500
```

stage 04b (画像リタッチ) 関連の env は任意。既定でオン動作するので、未設定でも動く。
必要なときだけ追記する (値・解決順は T001 doc `docs/refactor/retouch-stage-design.md` §4 / §6 と一致):

```
# stage 04b — 既定オン。"0" で stage 04b を skip (即時 rollback)
PHASE_RETOUCH=1
# Real-ESRGAN binary / models のパス上書き (園田PC など repo 同梱を使わない場合のみ)
# 解決順: env → repo 同梱 tools/realesrgan/ → 開発機 ~/Desktop fallback
REALESRGAN_BIN=/絶対パス/realesrgan-ncnn-vulkan
REALESRGAN_MODELS=/絶対パス/models
```

> 園田PC は別 macOS ユーザのため、`REALESRGAN_BIN` / `REALESRGAN_MODELS` を設定するなら
> 園田PC の実 `$HOME` 基準の絶対パスにする (`/Users/kentohonda/...` のハードコードは使わない)。

旧 mac で kento が値を読み上げるには (旧 mac で実行):

```bash
cat /Volumes/AgentSSD/04_FANGO/FNG26_AI入稿システム/code/suumo-dashboard/.env.local
```

kento が 1 行ずつ Chrome Remote Desktop で paste する。最後に新 mac で確認:

```bash
wc -l .env.local       # 17 行期待 (空行込みでも 18 程度)
grep -c "=" .env.local # 17 期待
```

## Phase 4: 依存解決 + asset 確認

```bash
cd ~/dev/suumo-dashboard
bun install            # node_modules を作る (5-10 分)
ls assets/facility-logos/ | head  # 20 個ほどの PNG が見えれば OK
```

Playwright Chromium のダウンロードも自動発生 (`bun install` 経由)。`~/Library/Caches/ms-playwright/` が作られる。

## Phase 5: 業者間サイト初回ログイン (smoke 1 件)

新 mac 上で、初回 smoke を 1 件動かす。これで以下が自動発生:

1. forrent / REINS / 業者間サイトへ初回ログイン (`ensureLoggedIn` パターン)
2. `.playwright-data/` 配下に storageState (cookies JSON) が生成される
3. logs/runs/{ts}_{reinsId}/ に artifact 生成

**重要**: 旧 mac の watch-nyuko は既に停止済なので、業者間サイトの多重ログイン罠は発生しない (`~/.claude/rules/atbb-session-management.md` Rule 6 遵守)。

```bash
# Notion で「広告待ち」になっている物件 ID を 1 件選んで実行
# (例: bun run scripts/watch-nyuko.js --once でも可)
node runNyuko.js <reinsId>
```

期待結果:
- `logs/runs/` に新 run dir 生成
- `run.json#status` が `SUCCESS` (掲載保留 or 掲載指示)
- Notion 側の当該物件 Status が更新される
- (掲載指示なら) Slack `#ex_fango` に通知

エラーパターン:
- `REINS_LOGIN_FAIL` → `.env.local` の REINS_LOGIN_ID/PASS が間違い
- `FORRENT_LOGIN_FAIL` → forrent ログイン要、Playwright が手動入力プロンプトを出す可能性 (Chrome Remote Desktop で kento が入力)
- `NOT_FOUND` → 当該物件が REINS で取り下げ済 (別物件で再試行)

## Phase 6: launchd 自動化

### 6.1 wrapper script を新 mac 用に書く

`scripts/run-watch-nyuko-mac.sh` を新規作成 (旧 `run-watch-nyuko.sh` は AgentSSD mount 待ちが入っているため新 mac で使えない、別 script を作る):

```bash
cat > scripts/run-watch-nyuko-mac.sh <<'EOF'
#!/bin/bash
# Wrapper for launchd on the new mac (no AgentSSD dependency).
set -e

PROJECT="$HOME/dev/suumo-dashboard"
NODE="$HOME/.fnm/aliases/default/bin/node"

if [ ! -d "$PROJECT" ]; then
  echo "[wrapper] $(date): project not found at $PROJECT — exit"
  exit 1
fi
if [ ! -x "$NODE" ]; then
  echo "[wrapper] $(date): node not executable at $NODE — exit"
  exit 1
fi

cd "$PROJECT"
exec "$NODE" scripts/watch-nyuko.js
EOF
chmod +x scripts/run-watch-nyuko-mac.sh
```

### 6.2 plist 配置

```bash
cat > ~/Library/LaunchAgents/jp.fango.watch-nyuko.plist <<'EOF'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>jp.fango.watch-nyuko</string>

  <key>ProgramArguments</key>
  <array>
    <string>/bin/bash</string>
    <string>/Users/kentohonda/dev/suumo-dashboard/scripts/run-watch-nyuko-mac.sh</string>
  </array>

  <key>RunAtLoad</key>
  <true/>

  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
    <key>Crashed</key>
    <true/>
  </dict>

  <key>ThrottleInterval</key>
  <integer>60</integer>

  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>/Users/kentohonda/.bun/bin:/Users/kentohonda/.fnm/aliases/default/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
    <key>HOME</key>
    <string>/Users/kentohonda</string>
  </dict>

  <key>StandardOutPath</key>
  <string>/Users/kentohonda/Library/Logs/watch-nyuko.out.log</string>

  <key>StandardErrorPath</key>
  <string>/Users/kentohonda/Library/Logs/watch-nyuko.err.log</string>
</dict>
</plist>
EOF

# 構文 check
plutil -lint ~/Library/LaunchAgents/jp.fango.watch-nyuko.plist
# OK と出れば成功
```

### 6.3 launchd に登録

```bash
launchctl load ~/Library/LaunchAgents/jp.fango.watch-nyuko.plist
sleep 3
launchctl list | grep watch-nyuko
# PID + 0 + jp.fango.watch-nyuko が出れば OK
```

### 6.4 log 確認

```bash
tail -f ~/Library/Logs/watch-nyuko.out.log
# 1 分以内に Notion polling 開始の log が出れば動作中
```

## Phase 7: 動作確認 + 旧 mac 撤去

### 7.1 新 mac で 24h 観察

1 日 (24h) ほど自然に hourly cycle を回してから判定:
- `logs/runs/` に複数 run が SUCCESS で並んでいるか
- Slack `#ex_fango` に掲載指示通知が来ているか (score≥34 物件があれば)
- Notion DB の Status 遷移が正常か (広告待ち → 掲載保留/掲載指示済み)

### 7.2 旧 mac の clean up

新 mac が安定動作したら、旧 mac で:

```bash
# 完全撤去 (旧 mac 上で実行)
launchctl unload ~/Library/LaunchAgents/jp.fango.watch-nyuko.plist 2>/dev/null || true
rm ~/Library/LaunchAgents/jp.fango.watch-nyuko.plist

# code は読み取り専用にして archive (削除はしない、過去 run 履歴の audit に使う)
chmod -R a-w /Volumes/AgentSSD/04_FANGO/FNG26_AI入稿システム/code/suumo-dashboard/
```

## トラブルシュート

### 業者間サイトで「すでにログインされています」エラー
- 旧 mac の cookies が ATBB / itandi サーバ側に残っている可能性
- 旧 mac の `.playwright-data/` を削除 (`rm -rf /Volumes/AgentSSD/04_FANGO/FNG26_AI入稿システム/code/suumo-dashboard/.playwright-data/`)
- 30 分待ってからサーバ側 session expire を期待して新 mac で再 smoke

### node コマンドが見つからない
- fnm の alias が壊れている可能性 (`fnm alias default 24` で再設定)
- plist の PATH も確認

### launchctl が起動しない
- `plutil -lint` で構文確認
- `~/Library/Logs/watch-nyuko.err.log` に exit code が出ていないか確認
- ProgramArguments のパスが実在するか `ls` で確認

### bun install が失敗
- ネットワーク制約 / proxy 設定 を確認
- `npm install --legacy-peer-deps` で代替 (bun と node_modules は互換)

## 参考: 移行物のチェックリスト

- [ ] native binary 3 点導入済: `magick --version` / `pdftotext -v` / `realesrgan-ncnn-vulkan -h` が全て OK
- [ ] Real-ESRGAN は `xattr -dr com.apple.quarantine` 済 + binary/models のパス (repo 同梱 or env) 確定
- [ ] git clone 成功 (`refactor/cleanup-2026-05` ブランチ)
- [ ] `.env.local` 17 行作成済
- [ ] `bun install` 完了 + Playwright Chromium ダウンロード済
- [ ] smoke 1 件 SUCCESS (新 mac で初回ログイン完了 = `.playwright-data/` 生成)
- [ ] `~/Library/LaunchAgents/jp.fango.watch-nyuko.plist` 配置 + plutil -lint OK
- [ ] `launchctl load` 成功 + `launchctl list` に表示
- [ ] watch-nyuko.out.log に Notion polling log が出ている
- [ ] Slack 通知 (掲載指示) を 1 回観察
- [ ] 24h 観察 OK → 旧 mac 撤去
