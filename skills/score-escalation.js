/**
 * skills/score-escalation.js
 *
 * forrent.jp 名寄せスコアが閾値以上なら「掲載保留」を「掲載指示」に昇格させる判定と
 * 関連 config / メッセージ整形を担う純関数モジュール。
 *
 * Lazy init: config 読み込みは getEscalationConfig() で遅延、テストで mock 可能。
 * 副作用なし: I/O は loadConfigFromDisk() のみ、shouldEscalate / formatSlackMessage は純関数。
 */

const fs = require("fs");
const path = require("path");

const DEFAULT_CONFIG = Object.freeze({
  threshold: 34,
  slack: Object.freeze({
    channel: "C09B0527NSF",
    channelName: "ex_fango",
    messageTemplate:
      "🤖完全自動入稿完了\n物件名: {propertyName}\n貴社物件コード: {kishaCode}\n最終名寄せスコア: {score}",
    capacityFallbackTemplate:
      "[capacity fallback] 掲載指示できず保留にしました\n物件名: {propertyName}\n貴社物件コード: {kishaCode}\n名寄せスコア: {score} (閾値 {threshold} 以上だが forrent 掲載枠フル)",
  }),
});

const CONFIG_PATH = path.join(__dirname, "..", "config", "score-escalation.json");

let _cached = null;

/**
 * ディスクから config を読む (sync)。存在しなければ DEFAULT_CONFIG を返す。
 * env SCORE_ESCALATION_THRESHOLD があれば threshold を上書きする。
 * SLACK_ESCALATION_CHANNEL があれば slack.channel を上書きする。
 *
 * @param {object} [opts]
 * @param {string} [opts.configPath] - config JSON のパス
 * @param {object} [opts.env] - process.env 互換オブジェクト (テスト注入用)
 * @returns {{threshold:number, slack:{channel:string,channelName:string,messageTemplate:string}}}
 */
function loadConfigFromDisk(opts = {}) {
  const configPath = opts.configPath || CONFIG_PATH;
  const env = opts.env || process.env;
  let cfg = { ...DEFAULT_CONFIG, slack: { ...DEFAULT_CONFIG.slack } };
  try {
    if (fs.existsSync(configPath)) {
      const raw = fs.readFileSync(configPath, "utf-8");
      const parsed = JSON.parse(raw);
      if (typeof parsed.threshold === "number" && Number.isFinite(parsed.threshold)) {
        cfg.threshold = parsed.threshold;
      }
      if (parsed.slack && typeof parsed.slack === "object") {
        cfg.slack = { ...cfg.slack, ...parsed.slack };
      }
    }
  } catch (e) {
    console.error(`[score-escalation] config 読込失敗 (default fallback): ${e.message}`);
  }
  if (env.SCORE_ESCALATION_THRESHOLD) {
    const n = parseInt(env.SCORE_ESCALATION_THRESHOLD, 10);
    if (Number.isFinite(n)) cfg.threshold = n;
  }
  if (env.SLACK_ESCALATION_CHANNEL) {
    cfg.slack.channel = env.SLACK_ESCALATION_CHANNEL;
  }
  return cfg;
}

/**
 * cache 付き config 取得。テストでは clearCache() でリセット可能。
 */
function getEscalationConfig() {
  if (!_cached) _cached = loadConfigFromDisk();
  return _cached;
}

function clearCache() {
  _cached = null;
}

/**
 * 純関数: score が threshold 以上なら true。
 * null/undefined/NaN は false (安全側: 昇格させない)。
 *
 * @param {number|null|undefined} score
 * @param {{threshold:number}} cfg
 * @returns {boolean}
 */
function shouldEscalate(score, cfg) {
  if (!cfg || typeof cfg.threshold !== "number") return false;
  if (score === null || score === undefined) return false;
  if (typeof score !== "number" || !Number.isFinite(score)) return false;
  return score >= cfg.threshold;
}

/**
 * Slack メッセージ整形 (純関数)。
 *
 * @param {{propertyName:string, kishaCode:string, score:number}} vars
 * @param {{messageTemplate:string}} slackCfg
 * @returns {string}
 */
function formatSlackMessage(vars, slackCfg) {
  const template = (slackCfg && slackCfg.messageTemplate) || DEFAULT_CONFIG.slack.messageTemplate;
  return template
    .replace("{propertyName}", String(vars.propertyName ?? ""))
    .replace("{kishaCode}", String(vars.kishaCode ?? ""))
    .replace("{score}", String(vars.score ?? ""));
}

/**
 * Capacity fallback (掲載指示できず保留にしました) 通知用メッセージ整形 (純関数)。
 *
 * 名寄せスコアは閾値以上だが、forrent 側の掲載枠フル等で escalation を昇格できず
 * 「掲載保留」のままにした場合の Slack 通知文を整形する。
 *
 * slackCfg は以下のいずれかを受け取る:
 * - string: テンプレート文字列そのもの
 * - object: { capacityFallbackTemplate?: string } 形式 (config.slack を直接渡す想定)
 * - 未指定/null: getEscalationConfig().slack.capacityFallbackTemplate を使う
 * いずれも欠落時は DEFAULT_CONFIG.slack.capacityFallbackTemplate に fallback。
 *
 * @param {{propertyName:string, kishaCode:string, score:number, threshold:number}} vars
 * @param {string|{capacityFallbackTemplate?:string}} [slackCfg]
 * @returns {string}
 */
function formatCapacityFallbackMessage(vars, slackCfg) {
  let template;
  if (typeof slackCfg === "string") {
    template = slackCfg;
  } else if (slackCfg && typeof slackCfg.capacityFallbackTemplate === "string") {
    template = slackCfg.capacityFallbackTemplate;
  } else if (slackCfg === undefined || slackCfg === null) {
    const cfg = getEscalationConfig();
    template = (cfg && cfg.slack && cfg.slack.capacityFallbackTemplate)
      || DEFAULT_CONFIG.slack.capacityFallbackTemplate;
  } else {
    template = DEFAULT_CONFIG.slack.capacityFallbackTemplate;
  }
  return template
    .replace("{propertyName}", String(vars.propertyName ?? ""))
    .replace("{kishaCode}", String(vars.kishaCode ?? ""))
    .replace("{score}", String(vars.score ?? ""))
    .replace("{threshold}", String(vars.threshold ?? ""));
}

module.exports = {
  DEFAULT_CONFIG,
  CONFIG_PATH,
  loadConfigFromDisk,
  getEscalationConfig,
  clearCache,
  shouldEscalate,
  formatSlackMessage,
  formatCapacityFallbackMessage,
};
