# Capacity-Exceeded Fallback Design

2026-05-17 PM, FNG26 incident response (REG_FAIL crisis: 本日 escalation 圏内 12/14 = 86% 失敗)

## 1. Goal

forrent.jp の **掲載可能件数 (ネット / スマピク / 店舗ピックアップ) 上限到達**で escalation 路線が拒否された時、REG_FAIL に倒さず **「掲載保留」として登録完了する fallback** を入れる。

これにより:
- SUCCESS 率 (掲載保留 + 掲載指示 計) は本日実測 8/25 → ~20/25 (80%+) に回復見込み
- 大木さんが後で枠を空けたら手動で「掲載保留 → 掲載指示」に転換できる (forrent ダッシュボード上)
- Slack `#ex_fango` 通知は今まで通り「掲載指示」成功時のみ (既存仕様維持)

## 2. Root cause recap

本日 12 件 REG_FAIL のうち **8 件**で forrent の errors 配列が以下と完全一致:

```
ネット掲載可能件数を超えているため、掲載指示をOFFにしました。
スマピク掲載可能件数を超えているため、掲載指示をOFFにしました。
店舗案内ピックアップ掲載可能件数を超えているため、掲載指示をOFFにしました。
```

過去 200 run sweep でも capacity 系が 26 件 × 3 行で**支配的**。Phase δ T021 (checkedCodes 増加) は無関係、Phase ε で score が上がって escalation 圏内が増えた結果、forrent の月次掲載枠を朝のうちに食い尽くした副作用。

残り 4 件は `missing_required_field` (元付業者の入稿漏れ) で本 fix のスコープ外、設計通りの早期 reject。

## 3. Fallback flow

既存 escalation chain (`skills/forrent/register.js#registerProperty` line 472-568):

```
confirm-attempt1 (validated, score>=34)
  → teisei → edit-after-teisei
  → modify (shiji=1 + sumapiku/tenpiku ON) → edit-after-modify
  → 再 confirm → confirm-after-escalate
  → revalidation.hasError ? REG_FAIL : register → final-escalated
```

新 fallback hook を **revalidation.hasError かつ isCapacityExceededOnly(errors) の時**に挿入:

```
confirm-after-escalate (capacity errors only)
  → [NEW] teisei (2回目) → edit-after-fallback
  → [NEW] revert (shiji=3=保留 + sumapiku/tenpiku uncheck) → edit-after-fallback-modify
  → [NEW] 3 回目 confirm → confirm-after-fallback
  → validation green expected → register → final-fallback
  → return { saved:true, registrationType:"掲載保留", escalated:false, capacityExceeded:true, escalationAttempted:true }
```

つまり最終的に「通常路線 (掲載保留) と同じ form 状態」に戻してから登録するだけ。新 form 操作なし (`selectOption` + `uncheck` の Playwright native API のみ)。

## 4. Detection (pure helper)

```js
const CAPACITY_EXCEEDED_PATTERN = /掲載可能件数を超えている/;

function isCapacityExceededOnly(errors) {
  if (!Array.isArray(errors) || errors.length === 0) return false;
  return errors.every(e => typeof e === "string" && CAPACITY_EXCEEDED_PATTERN.test(e));
}
```

- `every` で全 entry が capacity 系のときだけ true
- 1 件でも他の本物エラーが混じってたら通常 REG_FAIL に倒す (誤判定回避)
- pure function、unit test 可能、env switch なしで挙動 frozen

## 5. Implementation diff sketch (`skills/forrent/register.js`)

### 5.1 既存 line 507-528 (revalidation.hasError 分岐) を以下に置換

```js
if (revalidation.hasError) {
  console.log(`[forrent] 再バリデーションエラー: ${revalidation.errors.slice(0, 8).join(" / ")}`);
  if (artifactDir) {
    try {
      fs.writeFileSync(
        path.join(artifactDir, "validation-after-escalate.json"),
        JSON.stringify(revalidation, null, 2)
      );
    } catch {}
  }

  // ── NEW: capacity exceeded fallback ──
  const fallbackEnabled = process.env.CAPACITY_FALLBACK_ENABLED !== "0";
  if (fallbackEnabled && isCapacityExceededOnly(revalidation.errors)) {
    console.log("[forrent] === CAPACITY EXCEEDED → FALLBACK TO 掲載保留 ===");
    const fbResult = await attemptCapacityFallback({
      page, confirmFrame, mainFrame, artifactDir, dialogs,
      initialScore, escalateScore: revalidation.score || initialScore,
      escalationCfg,
    });
    return fbResult;
  }

  // 既存 REG_FAIL 返却 (capacity 以外の本物エラー or fallback disabled)
  return {
    saved: false,
    registrationType: null,
    score: revalidation.score || initialScore,
    escalated: true,
    threshold: escalationCfg.threshold,
    dialogs,
    errors: revalidation.errors,
    errorRows: revalidation.errorRows,
    error: `バリデーションエラー (再確認): ${revalidation.errors[0] || "詳細不明"}`,
  };
}
```

### 5.2 新 helper (registerProperty より上に配置)

```js
/**
 * 編集画面で shijiIsize=3 (保留) に戻し、sumapiku/tenpiku を uncheck する。
 * escalation で枠超過拒否された後の fallback path 専用。
 */
async function revertShijiAndCheckboxes(editFrame) {
  await editFrame.evaluate(() => window.scrollTo(0, 0));
  try {
    await editFrame.waitForFunction(
      () => !!document.getElementById("shijiIsize"),
      { timeout: SHIJI_APPEAR_TIMEOUT_MS }
    );
  } catch (e) {
    return { ok: false, error: `#shijiIsize が編集画面に現れませんでした (fallback, ${SHIJI_APPEAR_TIMEOUT_MS / 1000}s)` };
  }
  try {
    await editFrame.selectOption("#shijiIsize", "3");
  } catch (e) {
    return { ok: false, error: `shijiIsize 保留 selectOption 失敗: ${e.message.slice(0, 200)}` };
  }
  // sumapiku/tenpiku は shijiIsize=3 で disabled になるはずだが、念のため明示 uncheck
  try {
    await editFrame.evaluate(() => {
      for (const id of ["sumapiku", "tenpiku"]) {
        const el = document.getElementById(id);
        if (el && el.checked) el.checked = false;
      }
    });
  } catch {}
  return await editFrame.evaluate(() => {
    const sel = document.getElementById("shijiIsize");
    const sumapiku = document.getElementById("sumapiku");
    const tenpiku = document.getElementById("tenpiku");
    return {
      ok: true,
      shijiValue: sel?.value,
      sumapikuChecked: !!sumapiku?.checked,
      tenpikuChecked: !!tenpiku?.checked,
    };
  });
}

/**
 * Capacity-exceeded 時の fallback: 編集画面に戻って shiji=3 + uncheck + 再 confirm + 登録。
 * 戻り値は registerProperty と同じ shape。
 */
async function attemptCapacityFallback({
  page, confirmFrame, mainFrame, artifactDir, dialogs,
  initialScore, escalateScore, escalationCfg,
}) {
  // 訂正で編集画面へ戻る
  const teiseiClicked = await clickTeiseiButton(confirmFrame);
  if (!teiseiClicked) {
    return { saved: false, registrationType: null, score: escalateScore, escalated: true, escalationAttempted: true, capacityExceeded: true, threshold: escalationCfg.threshold, error: "fallback: 訂正ボタンが見つかりません" };
  }
  const editFrame = await waitForEditReady(page, confirmFrame, EDIT_READY_TIMEOUT_MS);
  await saveFrameArtifacts(page, editFrame, artifactDir, "edit-after-fallback");

  // shiji=3 + uncheck
  const revert = await revertShijiAndCheckboxes(editFrame);
  if (!revert.ok) {
    await saveFrameArtifacts(page, editFrame, artifactDir, "edit-fallback-failed");
    return { saved: false, registrationType: null, score: escalateScore, escalated: true, escalationAttempted: true, capacityExceeded: true, threshold: escalationCfg.threshold, error: revert.error };
  }
  await editFrame.waitForTimeout(500);
  await saveFrameArtifacts(page, editFrame, artifactDir, "edit-after-fallback-modify");

  // 再確認
  const reconfirmClicked = await clickConfirmButton(editFrame);
  if (!reconfirmClicked) {
    return { saved: false, registrationType: null, score: escalateScore, escalated: true, escalationAttempted: true, capacityExceeded: true, threshold: escalationCfg.threshold, error: "fallback: 再確認ボタンが見つかりません" };
  }
  const fallbackConfirmFrame = await waitForConfirmReady(page, editFrame, CONFIRM_READY_TIMEOUT_MS);
  const fallbackValidation = await scrapeValidation(fallbackConfirmFrame);
  await saveFrameArtifacts(page, fallbackConfirmFrame, artifactDir, "confirm-after-fallback");

  if (fallbackValidation.hasError) {
    if (artifactDir) {
      try {
        fs.writeFileSync(path.join(artifactDir, "validation-after-fallback.json"), JSON.stringify(fallbackValidation, null, 2));
      } catch {}
    }
    return {
      saved: false, registrationType: null,
      score: fallbackValidation.score || escalateScore,
      escalated: true, escalationAttempted: true, capacityExceeded: true,
      threshold: escalationCfg.threshold, dialogs,
      errors: fallbackValidation.errors, errorRows: fallbackValidation.errorRows,
      error: `fallback バリデーションエラー: ${fallbackValidation.errors[0] || "詳細不明"}`,
    };
  }

  // 登録
  const regClicked = await clickRegistrationButton(fallbackConfirmFrame);
  if (!regClicked) {
    return { saved: false, registrationType: null, score: fallbackValidation.score || escalateScore, escalated: true, escalationAttempted: true, capacityExceeded: true, threshold: escalationCfg.threshold, error: "fallback: 登録ボタンが見つかりません" };
  }
  const finalFrame = await waitForFinalReady(page, fallbackConfirmFrame, FINAL_READY_TIMEOUT_MS);
  const result = await readFinalState(finalFrame);
  const finalScore = result.score || fallbackValidation.score || escalateScore;
  await saveFrameArtifacts(page, finalFrame, artifactDir, "final-fallback");

  if (!result.isComplete) {
    const errMsg = result.hasErrorText
      ? `fallback 登録後にエラー画面: ${(result.bodySnippet || "").slice(0, 400)}`
      : "fallback 登録完了マーカーが現れませんでした";
    return { saved: false, registrationType: null, score: finalScore, escalated: true, escalationAttempted: true, capacityExceeded: true, threshold: escalationCfg.threshold, dialogs, errors: [errMsg], error: errMsg };
  }

  return {
    saved: true,
    registrationType: "掲載保留",
    score: finalScore,
    escalated: false,         // 最終的には掲載保留扱い
    escalationAttempted: true, // 一度 escalation を試みた事実は記録
    capacityExceeded: true,    // capacity 起因で降格した signal
    threshold: escalationCfg.threshold,
    dialogs,
    errors: [],
  };
}
```

## 6. Stage 06 / batch-nyuko / pipeline-statuses への影響

### 6.1 stage 06 (`scripts/stages/06-forrent-register.js`)

return shape を拡張 (additive、既存 caller 影響なし):

```js
return {
  status: regResult.saved ? "SUCCESS" : "REG_FAIL",
  score: regResult.score || null,
  registrationType: regResult.registrationType,
  escalated: !!regResult.escalated,
  escalationAttempted: !!regResult.escalationAttempted, // NEW
  capacityExceeded: !!regResult.capacityExceeded,       // NEW
  errors: regResult.errors || [],
  exceptionMessage,
};
```

logStep にも新 step を追加:
- `register_capacity_fallback_start` (capacityExceeded 検出時)
- `register_capacity_fallback_success` (fallback 成功時、saved=true で 掲載保留)
- `register_capacity_fallback_failed` (fallback 中の異常時)

### 6.2 `pipeline-statuses.js` — 変更不要

既存 `resolveNotionStatus(result)` は `status=SUCCESS && escalated=false → 掲載保留` を返す。fallback 後の result は **escalated:false** なので自動的に 掲載保留 になる。capacityExceeded の有無は Notion ステータスには反映しない (forrent 上で「掲載保留」になっており、大木さんが手動で空き枠 → 掲載指示に転換するワークフロー前提)。

### 6.3 `batch-nyuko.js` — 変更最小

Notion update payload に capacityExceeded を渡すかは optional。現状の `registrationType: result.registrationType` (= "掲載保留") で表示上は同じ。ただし debug 性のため **run.json には capacityExceeded:true が残る**ので、後の集計で「capacity fallback 件数 / 月」を取れる (Phase ζ collector に追加候補)。

### 6.4 Slack 通知 (`stage 06`) — 変更不要

既存条件 `regResult.saved && regResult.escalated` のまま。fallback 経路は escalated:false なので通知されない (= 「掲載指示」未達なので通知不要、既存仕様維持)。

## 7. Tests

### 7.1 Unit test (新規 `scripts/test/test-capacity-fallback-detection.js`)

```js
const test = require("node:test");
const assert = require("node:assert");
const { isCapacityExceededOnly } = require("../../skills/forrent/register");

test("3 patterns exact match → true", () => {
  assert.strictEqual(isCapacityExceededOnly([
    "ネット掲載可能件数を超えているため、掲載指示をOFFにしました。",
    "スマピク掲載可能件数を超えているため、掲載指示をOFFにしました。",
    "店舗案内ピックアップ掲載可能件数を超えているため、掲載指示をOFFにしました。",
  ]), true);
});

test("only ネット → true (subset is also pure capacity)", () => {
  assert.strictEqual(isCapacityExceededOnly([
    "ネット掲載可能件数を超えているため、掲載指示をOFFにしました。",
  ]), true);
});

test("capacity + real error mixed → false", () => {
  assert.strictEqual(isCapacityExceededOnly([
    "ネット掲載可能件数を超えているため、掲載指示をOFFにしました。",
    "ほか初期費用詳細に禁止文字が含まれています(半角カナ、記号等)",
  ]), false);
});

test("empty array → false", () => {
  assert.strictEqual(isCapacityExceededOnly([]), false);
});

test("null → false", () => {
  assert.strictEqual(isCapacityExceededOnly(null), false);
});

test("non-array → false", () => {
  assert.strictEqual(isCapacityExceededOnly("not-array"), false);
});

test("non-string element → false", () => {
  assert.strictEqual(isCapacityExceededOnly([123, "ネット掲載可能件数を超えている"]), false);
});

test("partial-match phrase ('掲載可能件数を超えている' anywhere in string) → true", () => {
  // 将来 forrent が文言改定しても部分一致で拾えるか
  assert.strictEqual(isCapacityExceededOnly([
    "[error] ネット掲載可能件数を超えているため (revised wording)",
  ]), true);
});
```

`isCapacityExceededOnly` を register.js から **named export** に追加する (現状 export は `scrapeValidation, saveFrameArtifacts, registerProperty` のみ)。

### 7.2 E2E (Task #5)

REG_FAIL 12 victims のうち代表 3 件で `runNyuko.js` 経由再投入。`launchctl unload jp.fango.watch-nyuko.plist` を try/finally で wrap。

## 8. Rollback path

`CAPACITY_FALLBACK_ENABLED=0` env で即無効化、既存 REG_FAIL 路線に戻る。`.env.local` で設定。

## 9. Risks / Open questions

- **Q1**: forrent 側で同一物件を「掲載保留」として登録する時、既に REG_FAIL で 1 度書き込んだ部分データが衝突しないか?
  - **A**: REG_FAIL = 登録未完了 (commit されていない) ので新規扱いになるはず。E2E (Task #5) で 100139160817 等を再投入して確認。
- **Q2**: fallback 中に shijiIsize=3 にしても sumapiku/tenpiku の uncheck が forrent JS で再 toggle される race condition は?
  - **A**: shijiIsize=3 で changeShiji() が走り toggleSumapiku/toggleTenpiku が両者を disabled + uncheck にするはず。実 forrent で発火順を E2E で観察。
- **Q3**: 文言改定で `掲載可能件数を超えている` が変わった場合の検出失敗?
  - **A**: 部分一致 regex なので「掲載可能件数を超え」までは耐性あり。完全に文言変更されたら fallback skip → REG_FAIL に倒れる (= 安全側 degrade)。
- **Q4**: capacityExceeded フラグの長期的な意味付け?
  - **A**: Phase ζ collector で「capacity 起因 fallback 件数」を集計、forrent 契約枠の運用判断 (枠拡張 / 古い物件 OFF) の signal にする。

## 10. Acceptance criteria

- AC1: `isCapacityExceededOnly` の 8 unit tests pass
- AC2: 既存 npm test 全 pass (regression なし)
- AC3: E2E 再投入で REG_FAIL 物件 3/3 が「掲載保留」として登録完了 (Task #5)
- AC4: 再投入時 run.json に `capacityExceeded: true` + `escalationAttempted: true` が記録される
- AC5: forrent ダッシュボード上で当該物件が「掲載保留」エントリとして見える (大木さんが手動転換可能)
- AC6: watch-nyuko routine が unload→load を try/finally で完全復元 (PID 確認)
- AC7: `CAPACITY_FALLBACK_ENABLED=0` で従来通り REG_FAIL に戻ることを smoke で確認
