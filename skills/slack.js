// ════════════════════════════════════════════════════════
//  Slack notifier (bot token → #ex_fango_monitoring)
// ════════════════════════════════════════════════════════
//
// Uses the FANGO bot token (xoxb-, SLACK_BOT_TOKEN) so messages
// appear from the bot (honda-bot). Falls back to SLACK_USER_TOKEN
// (xoxp-) when the bot token is unset, or at send time when the
// bot cannot post (e.g. not yet invited to a private channel →
// channel_not_found / not_in_channel).

const { WebClient } = require("@slack/web-api");

function getClient() {
  const token = process.env.SLACK_BOT_TOKEN || process.env.SLACK_USER_TOKEN;
  if (!token) return null;
  return new WebClient(token);
}

// bot が private channel に未招待だと channel_not_found になる。
// その場合のみ user token で再送する (移行期の取りこぼし防止)。
async function postMessage(payload) {
  const client = getClient();
  if (!client) throw new Error("SLACK_BOT_TOKEN / SLACK_USER_TOKEN 未設定");
  try {
    return await client.chat.postMessage(payload);
  } catch (e) {
    const code = e.data && e.data.error;
    const userToken = process.env.SLACK_USER_TOKEN;
    const canFallback =
      process.env.SLACK_BOT_TOKEN &&
      userToken &&
      (code === "channel_not_found" || code === "not_in_channel");
    if (!canFallback) throw e;
    console.error(`[slack] bot token 送信失敗 (${code}) — user token で再送`);
    return await new WebClient(userToken).chat.postMessage(payload);
  }
}

async function notifyNyukoSuccess({ reinsId, propertyName, score, registrationType }) {
  // 2026-06-15 kento 指示: Slack 通知は score>=34 の掲載指示 (notifyEscalationSuccess) のみ。
  // 入稿完了 (掲載保留含む) 通知は SLACK_NOTIFY_SUCCESS=0 で無効化。
  if (process.env.SLACK_NOTIFY_SUCCESS === "0") return { ok: false, skipped: true };
  const channel = process.env.SLACK_DM_CHANNEL_ID;
  const client = getClient();
  if (!client || !channel) {
    console.error("[slack] SLACK_BOT_TOKEN / SLACK_DM_CHANNEL_ID 未設定 — 通知スキップ");
    return { ok: false, skipped: true };
  }

  const scoreLine = score ? `名寄せスコア: ${score}/43` : "名寄せスコア: 取得不可";
  const regType = registrationType || "掲載保留";
  const kishaCode = `fng${reinsId}`;
  const text = [
    `✅ 入稿完了（${regType}で登録・大木さん確認待ち）`,
    `物件: ${propertyName || reinsId}`,
    `REINS: ${reinsId}`,
    `貴社物件コード: ${kishaCode}`,
    scoreLine,
    `forrent管理画面: https://www.fn.forrent.jp/fn/`,
  ].join("\n");

  try {
    const res = await postMessage({
      channel,
      text,
      unfurl_links: false,
      unfurl_media: false,
    });
    return { ok: true, ts: res.ts };
  } catch (e) {
    console.error(`[slack] DM送信失敗: ${e.message}`);
    return { ok: false, error: e.message };
  }
}

async function notifyError({ reinsId, propertyName, error }) {
  // 2026-06-15 kento 指示: 入稿失敗の Slack 通知は無効 (SLACK_NOTIFY_ERROR=0)。
  if (process.env.SLACK_NOTIFY_ERROR === "0") return { ok: false, skipped: true };
  const channel = process.env.SLACK_DM_CHANNEL_ID;
  const client = getClient();
  if (!client || !channel) return { ok: false, skipped: true };

  const kishaCode = `fng${reinsId}`;
  const text = [
    `⚠️ 入稿失敗`,
    `物件: ${propertyName || reinsId}`,
    `REINS: ${reinsId}`,
    `貴社物件コード: ${kishaCode}`,
    `原因: ${(error || "").slice(0, 200)}`,
  ].join("\n");

  try {
    await postMessage({ channel, text, unfurl_links: false, unfurl_media: false });
    return { ok: true };
  } catch (e) {
    console.error(`[slack] DM送信失敗: ${e.message}`);
    return { ok: false, error: e.message };
  }
}

/**
 * 掲載指示 (escalation 路線) 成功時の通知。
 * #ex_fango (or config.slack.channel) にフォーマット済テキストを投稿する。
 * 失敗してもパイプライン全体は止めない (best-effort)。
 *
 * @param {object} args
 * @param {string} args.channel - Slack channel ID (例: C09B0527NSF)
 * @param {string} args.text    - 投稿本文 (score-escalation.formatSlackMessage の出力)
 * @returns {Promise<{ok:boolean, ts?:string, skipped?:boolean, error?:string}>}
 */
async function notifyEscalationSuccess({ channel, text }) {
  const client = getClient();
  if (!client) {
    console.error("[slack] SLACK_BOT_TOKEN 未設定 — escalation 通知スキップ");
    return { ok: false, skipped: true };
  }
  if (!channel) {
    console.error("[slack] channel 未設定 — escalation 通知スキップ");
    return { ok: false, skipped: true };
  }
  try {
    const res = await postMessage({
      channel,
      text,
      unfurl_links: false,
      unfurl_media: false,
    });
    return { ok: true, ts: res.ts };
  } catch (e) {
    console.error(`[slack] escalation 通知失敗: ${e.message}`);
    return { ok: false, error: e.message };
  }
}

module.exports = { notifyNyukoSuccess, notifyError, notifyEscalationSuccess };
