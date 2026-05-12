// ════════════════════════════════════════════════════════
//  Slack DM notifier (kento user token → 大木さん DM)
// ════════════════════════════════════════════════════════
//
// Uses kento's user token (xoxp-) so the DM appears as
// kento's own message. Target channel is the DM channel ID
// (D...) — no need to call conversations.open.

const { WebClient } = require("@slack/web-api");

function getClient() {
  const token = process.env.SLACK_USER_TOKEN;
  if (!token) return null;
  return new WebClient(token);
}

async function notifyNyukoSuccess({ reinsId, propertyName, score, registrationType }) {
  const channel = process.env.SLACK_DM_CHANNEL_ID;
  const client = getClient();
  if (!client || !channel) {
    console.error("[slack] SLACK_USER_TOKEN / SLACK_DM_CHANNEL_ID 未設定 — 通知スキップ");
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
    const res = await client.chat.postMessage({
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
    await client.chat.postMessage({ channel, text, unfurl_links: false, unfurl_media: false });
    return { ok: true };
  } catch (e) {
    console.error(`[slack] DM送信失敗: ${e.message}`);
    return { ok: false, error: e.message };
  }
}

module.exports = { notifyNyukoSuccess, notifyError };
