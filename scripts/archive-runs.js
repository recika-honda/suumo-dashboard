#!/usr/bin/env node
/**
 * archive-runs.js — logs/runs/ のディスク管理 (Phase 7.5, 2026-05-14)
 *
 * ポリシー (3 段):
 *   1. SUCCESS run dir が 7 日超 → tar.gz 化して dir 削除
 *   2. 失敗系 run dir (REG_FAIL / TIMEOUT / ERROR / NOT_FOUND / FORRENT_LOGIN_FAIL) が 30 日超 → tar.gz 化して dir 削除
 *   3. tar.gz が 90 日超 → logs/runs/archive/yyyy-mm/ に移送
 *
 * status 判定: logs/nyuko-history.jsonl から runDir basename をキーに引く。
 * history に無い (孤児) run は失敗系扱いで 30 日ルール適用。
 *
 * Usage:
 *   node scripts/archive-runs.js [--dry-run] [--success-days N] [--fail-days N] [--archive-days N]
 *
 * 出力:
 *   stderr に進捗 / 結果サマリ
 *   exit 0: 成功 (dry-run 含む)
 */

const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

const LOGS_DIR = path.join(__dirname, "..", "logs");
const RUNS_DIR = path.join(LOGS_DIR, "runs");
const HISTORY_PATH = path.join(LOGS_DIR, "nyuko-history.jsonl");
const ARCHIVE_BASE = path.join(RUNS_DIR, "archive");

const SUCCESS_DAYS = parseFlag("--success-days", 7);
const FAIL_DAYS = parseFlag("--fail-days", 30);
const ARCHIVE_DAYS = parseFlag("--archive-days", 90);
const DRY_RUN = process.argv.includes("--dry-run");

const NOW = Date.now();
const DAY_MS = 24 * 60 * 60 * 1000;

function parseFlag(name, fallback) {
  const idx = process.argv.indexOf(name);
  if (idx < 0) return fallback;
  const v = parseInt(process.argv[idx + 1], 10);
  return Number.isFinite(v) && v > 0 ? v : fallback;
}

function log(msg) {
  console.error(msg);
}

function loadHistoryByRunId() {
  if (!fs.existsSync(HISTORY_PATH)) return new Map();
  const map = new Map();
  const lines = fs.readFileSync(HISTORY_PATH, "utf8").split("\n").filter(Boolean);
  for (const line of lines) {
    try {
      const entry = JSON.parse(line);
      if (entry.runDir) {
        const runId = path.basename(entry.runDir);
        // 同じ runId に複数 entry がある場合は後勝ち (resume 後の最新を採用)
        map.set(runId, entry);
      }
    } catch {}
  }
  return map;
}

function ageDays(mtimeMs) {
  return (NOW - mtimeMs) / DAY_MS;
}

function isFailureStatus(status) {
  return ["REG_FAIL", "TIMEOUT", "ERROR", "NOT_FOUND", "FORRENT_LOGIN_FAIL"].includes(status);
}

function tarGzDir(srcDir, dstFile) {
  if (DRY_RUN) return;
  const parent = path.dirname(srcDir);
  const base = path.basename(srcDir);
  // -C parent base = parent dir に移動して base を tar すれば、tar.gz の中身に絶対 path を含めない
  execSync(`tar -czf "${dstFile}" -C "${parent}" "${base}"`, { stdio: "ignore" });
}

function rmRf(dir) {
  if (DRY_RUN) return;
  fs.rmSync(dir, { recursive: true, force: true });
}

function moveFile(src, dst) {
  if (DRY_RUN) return;
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.renameSync(src, dst);
}

function yyyymmOfMtime(mtimeMs) {
  const d = new Date(mtimeMs);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  return `${y}-${m}`;
}

function main() {
  log(`[archive] ${DRY_RUN ? "[DRY-RUN] " : ""}policy: SUCCESS>${SUCCESS_DAYS}d / FAIL>${FAIL_DAYS}d / ARCHIVE>${ARCHIVE_DAYS}d`);
  if (!fs.existsSync(RUNS_DIR)) {
    log(`[archive] logs/runs not found — nothing to do`);
    return;
  }

  const history = loadHistoryByRunId();
  log(`[archive] history entries: ${history.size}`);

  let compressed = 0;
  let archived = 0;
  let skipped = 0;
  let bytesFreed = 0;

  const entries = fs.readdirSync(RUNS_DIR, { withFileTypes: true });
  for (const ent of entries) {
    if (ent.name === "archive") continue; // archive/ サブツリーはスキップ

    const fullPath = path.join(RUNS_DIR, ent.name);
    let stat;
    try {
      stat = fs.statSync(fullPath);
    } catch {
      continue;
    }

    const age = ageDays(stat.mtimeMs);

    // (3) tar.gz の archive 移送
    if (ent.isFile() && ent.name.endsWith(".tar.gz")) {
      if (age > ARCHIVE_DAYS) {
        const dst = path.join(ARCHIVE_BASE, yyyymmOfMtime(stat.mtimeMs), ent.name);
        log(`[archive] archive → ${dst} (age=${age.toFixed(1)}d)`);
        moveFile(fullPath, dst);
        archived++;
      }
      continue;
    }

    // (1) (2) run dir の compress
    if (!ent.isDirectory()) {
      skipped++;
      continue;
    }

    const histEntry = history.get(ent.name);
    const isSuccess = histEntry?.status === "SUCCESS";
    const isFail = histEntry ? isFailureStatus(histEntry.status) : true;
    // history なし → 失敗系扱い (in-flight だった可能性もあるが、30 日超なら確実に終了)

    let shouldCompress = false;
    let label = "";
    if (isSuccess && age > SUCCESS_DAYS) {
      shouldCompress = true;
      label = `SUCCESS age=${age.toFixed(1)}d`;
    } else if (isFail && age > FAIL_DAYS) {
      shouldCompress = true;
      label = `${histEntry?.status || "orphan"} age=${age.toFixed(1)}d`;
    }

    if (!shouldCompress) {
      skipped++;
      continue;
    }

    const dstFile = path.join(RUNS_DIR, `${ent.name}.tar.gz`);
    if (fs.existsSync(dstFile)) {
      log(`[archive] skip ${ent.name} — tar.gz 既に存在`);
      continue;
    }

    log(`[archive] compress ${ent.name} (${label})`);
    try {
      tarGzDir(fullPath, dstFile);
      // dir size を測ってから削除
      try {
        const sizeBefore = sizeOfDir(fullPath);
        bytesFreed += sizeBefore;
      } catch {}
      rmRf(fullPath);
      compressed++;
    } catch (e) {
      log(`[archive] FAIL compress ${ent.name}: ${e.message.slice(0, 200)}`);
    }
  }

  const mb = (bytesFreed / 1024 / 1024).toFixed(1);
  log(`[archive] done: compressed=${compressed} archived=${archived} skipped=${skipped} freed=${mb}MB`);
}

function sizeOfDir(dir) {
  let total = 0;
  const stack = [dir];
  while (stack.length) {
    const cur = stack.pop();
    const entries = fs.readdirSync(cur, { withFileTypes: true });
    for (const e of entries) {
      const p = path.join(cur, e.name);
      if (e.isDirectory()) stack.push(p);
      else {
        try {
          total += fs.statSync(p).size;
        } catch {}
      }
    }
  }
  return total;
}

if (require.main === module) {
  try {
    main();
  } catch (e) {
    console.error(`[archive] fatal: ${e.message}`);
    process.exit(1);
  }
}

module.exports = { loadHistoryByRunId, ageDays, isFailureStatus };
