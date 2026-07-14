/**
 * Stage 06: forrent.jp register (確認画面 → 登録 → スコア検証)
 *
 * 設計: docs/refactor/stages.md §06-forrent-register
 *
 * 失敗の種類:
 *   - 登録試行が走ったが forrent バリデーションで蹴られた → REG_FAIL (errors 配列付き)
 *   - registerProperty 自体が throw した → REG_FAIL (errors 空、log のみ)
 *     ※ stage 内で catch して soft fail に変換 (元コードの semantic 維持、外側 try で
 *        ERROR ラベルにしない)
 *
 * caller (processProperty) は OK 経路で本 stage を呼んだ後、必ず forrentPage を
 * close する責務を負う。
 */

const fs = require("fs");
const path = require("path");
const forrent = require("../../skills/forrent");
const slack = require("../../skills/slack");
const nyukoRecord = require("../../skills/nyuko-record");
const {
  getEscalationConfig,
  formatSlackMessage,
  formatCapacityFallbackMessage,
} = require("../../skills/score-escalation");
const { writeStageInput, writeStageOutput } = require("../lib/artifact");

const STAGE = "06-forrent-register";

// Stage 01 が書き出した reins-data.json を読む (入稿記録の元データ)。
function readReinsData(runDir) {
  if (!runDir) return {};
  try {
    return JSON.parse(fs.readFileSync(path.join(runDir, "reins-data.json"), "utf8"));
  } catch {
    return {};
  }
}

/**
 * @param {object} opts
 * @param {import("playwright").Page} opts.forrentPage
 * @param {import("playwright").Frame} opts.mainFrame
 * @param {string} [opts.runDir]
 * @param {(name: string, extra?: object) => void} opts.logStep
 * @param {string} [opts.reinsId]      - escalation 通知の貴社物件コード生成に使用
 * @param {string} [opts.propertyName] - escalation 通知の物件名
 * @returns {Promise<{
 *   status: "SUCCESS" | "REG_FAIL",
 *   score: number | null,
 *   registrationType: string | null,
 *   escalated: boolean,
 *   escalationAttempted: boolean,
 *   capacityExceeded: boolean,
 *   errors: Array<string>,
 * }>}
 */
async function runForrentRegister({ forrentPage, mainFrame, runDir, logStep, reinsId, propertyName }) {
  writeStageInput(runDir, STAGE, { hasForrentPage: !!forrentPage, hasMainFrame: !!mainFrame, reinsId, propertyName });
  console.error("  [6/6] 登録...");
  logStep("register_start");
  let regResult = { saved: false, registrationType: null, escalated: false };
  let exceptionMessage = null;
  try {
    regResult = await forrent.registerProperty(forrentPage, mainFrame, {
      artifactDir: runDir,
    });
    if (regResult.saved) {
      const scoreText = regResult.score ? ` (${regResult.score}pt/43pt)` : "";
      console.error(`  -> ${regResult.registrationType}完了${scoreText}`);
      logStep("register_success", {
        score: regResult.score,
        escalated: !!regResult.escalated,
        escalationAttempted: !!regResult.escalationAttempted,
        capacityExceeded: !!regResult.capacityExceeded,
      });
    } else {
      const firstErr = (regResult.errors || [])[0] || regResult.error || "不明";
      console.error(`  -> 登録失敗: ${firstErr}`);
      if (regResult.errors && regResult.errors.length) {
        for (const e of regResult.errors.slice(0, 8)) console.error(`       - ${e}`);
      }
      logStep("register_failed", {
        error: regResult.error || null,
        errors: regResult.errors || [],
        score: regResult.score || null,
        escalated: !!regResult.escalated,
        escalationAttempted: !!regResult.escalationAttempted,
        capacityExceeded: !!regResult.capacityExceeded,
      });
    }
  } catch (e) {
    exceptionMessage = e.message.slice(0, 200);
    console.error(`  -> 登録エラー: ${exceptionMessage}`);
    logStep("register_exception", { error: exceptionMessage });
  }

  // ── 掲載指示 (escalation) 成功時の Slack 通知 — best-effort ──
  if (regResult.saved && regResult.escalated) {
    try {
      const cfg = getEscalationConfig();
      const kishaCode = reinsId ? `fng${reinsId}` : "";
      const text = formatSlackMessage(
        { propertyName: propertyName || reinsId || "", kishaCode, score: regResult.score ?? "" },
        cfg.slack
      );
      const sent = await slack.notifyEscalationSuccess({ channel: cfg.slack.channel, text });
      if (sent.ok) {
        console.error(`  [slack] 掲載指示通知 → #${cfg.slack.channelName} (ts: ${sent.ts})`);
        logStep("slack_notify_escalated", { ok: true, ts: sent.ts });
      } else {
        console.error(`  [slack] 掲載指示通知スキップ/失敗: ${sent.error || "skipped"}`);
        logStep("slack_notify_escalated", { ok: false, error: sent.error || "skipped" });
      }
    } catch (e) {
      console.error(`  [slack] 掲載指示通知 例外: ${e.message}`);
      logStep("slack_notify_escalated", { ok: false, error: e.message });
    }

    // ── 入稿記録: 掲載指示 (score≥34) 物件の REINS 詳細を Notion に追記 — best-effort ──
    // 記録トリガーはここ (Stage 01 の全件記録から移設)。env 未設定/失敗でも止めない。
    try {
      const reinsData = readReinsData(runDir);
      const r = await nyukoRecord.recordExtraction({
        reinsId,
        reinsData,
        status: "掲載指示",
        score: regResult.score ?? null,
      });
      logStep("nyuko_record", { ok: r.ok, skipped: r.skipped, reason: r.reason });
      if (r.ok) {
        console.error(`  [入稿記録] Notion追記 (${regResult.score ?? "?"}pt)`);
      } else if (!r.skipped) {
        console.error(`  [入稿記録] Notion追記失敗: ${r.error}`);
      }
    } catch (e) {
      logStep("nyuko_record", { ok: false, error: e.message });
      console.error(`  [入稿記録] 例外: ${e.message}`);
    }
  }

  // ── capacity fallback (escalation 試行後の保留 fallback) 成功時の Slack 通知 ──
  // escalated:false / capacityExceeded:true で SUCCESS となるケース。既存 escalation
  // success 通知 (escalated:true) とは排他、同時発火しない。
  // 2026-07-14 kento 指示: 掲載枠フル時は通知しない (.env.local で SLACK_NOTIFY_CAPACITY_FALLBACK=0)。
  if (regResult.saved && regResult.capacityExceeded && process.env.SLACK_NOTIFY_CAPACITY_FALLBACK === "0") {
    logStep("slack_notify_capacity_fallback", { ok: false, skipped: true });
  } else if (regResult.saved && regResult.capacityExceeded) {
    try {
      const cfg = getEscalationConfig();
      const kishaCode = reinsId ? `fng${reinsId}` : "";
      const text = formatCapacityFallbackMessage(
        {
          propertyName: propertyName || reinsId || "",
          kishaCode,
          score: regResult.score ?? "",
          threshold: cfg.threshold,
        },
        cfg.slack
      );
      const sent = await slack.notifyEscalationSuccess({ channel: cfg.slack.channel, text });
      if (sent.ok) {
        console.error(`  [slack] capacity fallback 通知 → #${cfg.slack.channelName} (ts: ${sent.ts})`);
        logStep("slack_notify_capacity_fallback", { ok: true, ts: sent.ts });
      } else {
        console.error(`  [slack] capacity fallback 通知スキップ/失敗: ${sent.error || "skipped"}`);
        logStep("slack_notify_capacity_fallback", { ok: false, error: sent.error || "skipped" });
      }
    } catch (e) {
      console.error(`  [slack] capacity fallback 通知 例外: ${e.message}`);
      logStep("slack_notify_capacity_fallback", { ok: false, error: e.message });
    }
  }

  const out = {
    status: regResult.saved ? "SUCCESS" : "REG_FAIL",
    score: regResult.score || null,
    registrationType: regResult.registrationType,
    escalated: !!regResult.escalated,
    escalationAttempted: !!regResult.escalationAttempted,
    capacityExceeded: !!regResult.capacityExceeded,
    errors: regResult.errors || [],
    exceptionMessage,
  };
  writeStageOutput(runDir, STAGE, out);
  return out;
}

module.exports = { runForrentRegister };
