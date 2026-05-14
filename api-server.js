#!/usr/bin/env node
/**
 * api-server.js — 薄い HTTP API + 静的配信
 *
 * 設計方針 (Phase 6, 2026-05):
 *   - 入稿パイプラインは scripts/stages/ 6 stage に閉じ込め、本サーバはトリガーと
 *     状態参照のみを担う薄い層。Next.js / React / Socket.IO はすべて削除済み。
 *   - フロント (public/index.html) は polling で run.json を取得して進捗を表示する。
 *     リアルタイム要素は headed Playwright 自身のブラウザ画面で十分。
 *
 * Endpoint:
 *   POST /run                  → {reinsId} で runNyuko.js を spawn。最初の stdout
 *                                 行から `runId=...` を抽出して返す。
 *   GET  /status/:runId        → logs/runs/{runId}/run.json をそのまま返す。
 *   GET  /history              → logs/nyuko-history.jsonl の末尾 50 件を新しい順で返す。
 *   GET  /*                    → public/ から静的配信 (directory traversal 防御つき)。
 */
const http = require("http");
const path = require("path");
const fs = require("fs");
const { spawn } = require("child_process");

require("dotenv").config({ path: path.join(__dirname, ".env.local") });

const PORT = parseInt(process.env.PORT || "3500", 10);
const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, "public");
const RUNS_DIR = path.join(ROOT, "logs", "runs");
const HISTORY_PATH = path.join(ROOT, "logs", "nyuko-history.jsonl");
const MAX_BODY_BYTES = 1 << 20; // 1 MiB
const RUN_ID_TIMEOUT_MS = 8000;

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

function sendJson(res, status, payload) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(payload));
}

function sendText(res, status, msg, type = "text/plain; charset=utf-8") {
  res.statusCode = status;
  res.setHeader("Content-Type", type);
  res.end(msg);
}

function serveStatic(req, res) {
  // /  → /index.html
  const urlPath = req.url.split("?")[0];
  const reqPath = urlPath === "/" ? "/index.html" : urlPath;
  const fp = path.resolve(path.join(PUBLIC_DIR, reqPath));
  // directory traversal 防御
  if (!fp.startsWith(PUBLIC_DIR + path.sep) && fp !== PUBLIC_DIR) {
    return sendText(res, 403, "Forbidden");
  }
  if (!fs.existsSync(fp) || !fs.statSync(fp).isFile()) {
    return sendText(res, 404, "Not Found");
  }
  const ext = path.extname(fp).toLowerCase();
  res.statusCode = 200;
  res.setHeader("Content-Type", MIME[ext] || "application/octet-stream");
  fs.createReadStream(fp).pipe(res);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = "";
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error("body too large"));
        req.destroy();
        return;
      }
      raw += chunk;
    });
    req.on("end", () => resolve(raw));
    req.on("error", reject);
  });
}

async function handleRun(req, res) {
  let body;
  try {
    const raw = await readBody(req);
    body = JSON.parse(raw);
  } catch (e) {
    return sendJson(res, 400, { error: "invalid json or body too large" });
  }
  const reinsId = (body.reinsId || "").toString().trim();
  if (!/^\d+$/.test(reinsId)) {
    return sendJson(res, 400, { error: "reinsId must be digits only" });
  }

  const child = spawn("node", [path.join(ROOT, "runNyuko.js"), reinsId], {
    cwd: ROOT,
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
    env: process.env,
  });
  child.unref();

  let resolved = false;
  const onDone = (payload, status = 200) => {
    if (resolved) return;
    resolved = true;
    sendJson(res, status, payload);
  };

  // 最初の stdout 行から runId=... を抽出
  child.stdout.on("data", (chunk) => {
    if (resolved) return;
    const lines = chunk.toString().split("\n");
    for (const line of lines) {
      const m = line.match(/runId=([\w_-]+)/);
      if (m) {
        onDone({ runId: m[1] });
        return;
      }
    }
  });

  // 子プロセスが runId を出さずに死んだら 500
  child.on("exit", (code) => {
    onDone({ error: `runNyuko exited with code ${code} before emitting runId` }, 500);
  });

  // タイムアウトフォールバック
  setTimeout(() => {
    onDone({ error: "runNyuko did not emit runId within timeout" }, 504);
  }, RUN_ID_TIMEOUT_MS);
}

function handleStatus(req, res, runId) {
  // runId は \w_- のみ許可 (path traversal 防御)
  if (!/^[\w_-]+$/.test(runId)) {
    return sendJson(res, 400, { error: "invalid runId" });
  }
  const fp = path.join(RUNS_DIR, runId, "run.json");
  if (!fs.existsSync(fp)) return sendJson(res, 404, { error: "run not found" });
  try {
    const data = JSON.parse(fs.readFileSync(fp, "utf8"));
    return sendJson(res, 200, data);
  } catch (e) {
    return sendJson(res, 500, { error: `failed to read run.json: ${e.message}` });
  }
}

function handleHistory(req, res) {
  if (!fs.existsSync(HISTORY_PATH)) return sendJson(res, 200, { history: [] });
  try {
    const text = fs.readFileSync(HISTORY_PATH, "utf8");
    const lines = text.split("\n").filter(Boolean);
    const history = lines
      .slice(-50)
      .reverse()
      .map((l) => {
        try { return JSON.parse(l); } catch { return null; }
      })
      .filter(Boolean);
    return sendJson(res, 200, { history });
  } catch (e) {
    return sendJson(res, 500, { error: `failed to read history: ${e.message}` });
  }
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === "POST" && req.url === "/run") return handleRun(req, res);

    const statusMatch = req.url.match(/^\/status\/([\w_-]+)$/);
    if (req.method === "GET" && statusMatch) {
      return handleStatus(req, res, statusMatch[1]);
    }

    if (req.method === "GET" && req.url === "/history") {
      return handleHistory(req, res);
    }

    if (req.method === "GET") return serveStatic(req, res);

    sendJson(res, 405, { error: "method not allowed" });
  } catch (e) {
    console.error("[api-server] unhandled:", e);
    sendJson(res, 500, { error: e.message });
  }
});

server.listen(PORT, () => {
  console.log(`[api-server] listening on http://localhost:${PORT}`);
});
