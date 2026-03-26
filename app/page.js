"use client";

import { useState, useEffect, useCallback } from "react";
import { io } from "socket.io-client";
import { motion, AnimatePresence } from "framer-motion";

const STEPS = [
  { label: "REINS ログイン", icon: "key" },
  { label: "データ抽出", icon: "search" },
  { label: "画像スクリーンショット", icon: "image" },
  { label: "AI 画像処理 + 周辺環境", icon: "sparkle" },
  { label: "AI テキスト生成", icon: "text" },
  { label: "SUUMO フォーム入力", icon: "upload" },
  { label: "一時保存", icon: "chart" },
];

export default function NyukoPage() {
  const [socket, setSocket] = useState(null);
  const [connected, setConnected] = useState(false);
  const [phase, setPhase] = useState("input"); // "input" | "running" | "done"
  const [reinsId, setReinsId] = useState("");
  const [steps, setSteps] = useState(
    STEPS.map((s) => ({ ...s, status: "pending", detail: "" }))
  );
  const [result, setResult] = useState(null);
  const [errorMsg, setErrorMsg] = useState("");

  // ── Socket.io ──
  useEffect(() => {
    const s = io(window.location.origin, { reconnection: true });
    s.on("connect", () => setConnected(true));
    s.on("disconnect", () => setConnected(false));

    s.on("step-update", ({ stepIndex, status, detail }) => {
      setSteps((prev) =>
        prev.map((step, i) =>
          i === stepIndex ? { ...step, status, detail: detail || step.detail } : step
        )
      );
    });

    s.on("done", (data) => {
      setResult(data);
      setPhase("done");
    });

    s.on("error", ({ message }) => {
      setErrorMsg(message);
      setPhase("done");
    });

    setSocket(s);
    return () => s.disconnect();
  }, []);

  // ── Start Automation ──
  const handleStart = useCallback(() => {
    if (!socket || !reinsId.trim()) return;
    setPhase("running");
    setErrorMsg("");
    setResult(null);
    setSteps(STEPS.map((s) => ({ ...s, status: "pending", detail: "" })));
    socket.emit("start-nyuko", { reinsId: reinsId.trim() });
  }, [socket, reinsId]);

  // ── Reset ──
  const handleReset = useCallback(() => {
    setPhase("input");
    setReinsId("");
    setResult(null);
    setErrorMsg("");
    setSteps(STEPS.map((s) => ({ ...s, status: "pending", detail: "" })));
  }, []);

  return (
    <div className="min-h-screen flex flex-col">
      {/* Header */}
      <header className="glass border-b border-[var(--color-border)] px-6 py-4">
        <div className="max-w-2xl mx-auto flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-violet-500 to-purple-700 flex items-center justify-center text-xs font-bold">
              S
            </div>
            <div>
              <h1 className="text-sm font-semibold tracking-tight">
                SUUMO Auto-Nyuko
              </h1>
              <p className="text-[10px] text-white/30 tracking-widest uppercase">
                REINS to SUUMO Pipeline
              </p>
            </div>
          </div>
          <div
            className={`w-1.5 h-1.5 rounded-full ${
              connected ? "bg-emerald-400" : "bg-red-400"
            }`}
            title={connected ? "Connected" : "Disconnected"}
          />
        </div>
      </header>

      {/* Main */}
      <main className="flex-1 px-6 py-10">
        <div className="max-w-2xl mx-auto">
          <AnimatePresence mode="wait">
            {phase === "input" && (
              <InputPhase
                key="input"
                reinsId={reinsId}
                setReinsId={setReinsId}
                onStart={handleStart}
                connected={connected}
              />
            )}
            {phase === "running" && (
              <RunningPhase key="running" steps={steps} reinsId={reinsId} />
            )}
            {phase === "done" && (
              <DonePhase
                key="done"
                result={result}
                errorMsg={errorMsg}
                reinsId={reinsId}
                onReset={handleReset}
              />
            )}
          </AnimatePresence>
        </div>
      </main>
    </div>
  );
}

// ══════════════════════════════════════════════════════════
//  INPUT PHASE
// ══════════════════════════════════════════════════════════
function InputPhase({ reinsId, setReinsId, onStart, connected }) {
  const handleKeyDown = (e) => {
    if (e.key === "Enter" && reinsId.trim()) onStart();
  };

  return (
    <motion.div
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -12 }}
      className="flex flex-col items-center gap-8"
    >
      <div className="text-center">
        <h2 className="text-2xl font-semibold tracking-tight mb-2">
          REINS 物件番号を入力
        </h2>
        <p className="text-sm text-white/40">
          物件番号から自動でSUUMO入稿を行います
        </p>
      </div>

      <div className="w-full max-w-md">
        <div className="glass rounded-xl p-6 glow-accent">
          <label className="block text-xs text-white/40 mb-2 font-medium">
            物件番号
          </label>
          <div className="flex gap-3">
            <input
              type="text"
              value={reinsId}
              onChange={(e) => setReinsId(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="例: 012345678901"
              autoFocus
              className="flex-1 bg-white/5 border border-white/10 rounded-lg px-4 py-3
                         text-white placeholder-white/20 text-sm font-mono
                         focus:outline-none focus:border-violet-500/50 focus:ring-1 focus:ring-violet-500/20
                         transition-all"
            />
            <button
              onClick={onStart}
              disabled={!reinsId.trim() || !connected}
              className="px-6 py-3 rounded-lg bg-violet-600 text-white text-sm font-medium
                         hover:bg-violet-500 transition-all
                         disabled:opacity-30 disabled:cursor-not-allowed
                         active:scale-95"
            >
              入稿開始
            </button>
          </div>
        </div>
      </div>

      {/* Quick info */}
      <div className="grid grid-cols-3 gap-4 w-full max-w-md">
        {[
          { label: "REINS", desc: "データ取得" },
          { label: "AI", desc: "画像分析・テキスト生成" },
          { label: "SUUMO", desc: "自動入稿" },
        ].map((item) => (
          <div
            key={item.label}
            className="glass rounded-lg p-3 text-center"
          >
            <p className="text-xs font-medium text-white/60">{item.label}</p>
            <p className="text-[10px] text-white/25 mt-0.5">{item.desc}</p>
          </div>
        ))}
      </div>
    </motion.div>
  );
}

// ══════════════════════════════════════════════════════════
//  RUNNING PHASE
// ══════════════════════════════════════════════════════════
function RunningPhase({ steps, reinsId }) {
  const currentStep = steps.findIndex((s) => s.status === "running");
  const completedCount = steps.filter((s) => s.status === "done").length;

  return (
    <motion.div
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -12 }}
      className="flex flex-col items-center gap-6"
    >
      <div className="text-center">
        <h2 className="text-lg font-semibold tracking-tight mb-1">
          入稿処理中
        </h2>
        <p className="text-xs text-white/30 font-mono">{reinsId}</p>
      </div>

      {/* Progress bar */}
      <div className="w-full max-w-md">
        <div className="h-1 bg-white/5 rounded-full overflow-hidden">
          <motion.div
            className="h-full bg-gradient-to-r from-violet-600 to-violet-400 rounded-full"
            initial={{ width: 0 }}
            animate={{ width: `${((completedCount + 0.5) / steps.length) * 100}%` }}
            transition={{ duration: 0.5, ease: "easeOut" }}
          />
        </div>
        <div className="flex justify-between mt-1.5">
          <span className="text-[10px] text-white/20">
            Step {completedCount + 1} / {steps.length}
          </span>
          <span className="text-[10px] text-white/20">
            {Math.round(((completedCount + 0.5) / steps.length) * 100)}%
          </span>
        </div>
      </div>

      {/* Steps list */}
      <div className="w-full max-w-md space-y-2">
        {steps.map((step, i) => (
          <motion.div
            key={i}
            initial={{ opacity: 0, x: -8 }}
            animate={{ opacity: 1, x: 0 }}
            transition={{ delay: i * 0.05 }}
            className={`glass rounded-lg px-4 py-3 flex items-center gap-3 transition-all duration-300 ${
              step.status === "running" ? "glow-accent border-violet-500/30" : ""
            }`}
          >
            <StepIcon status={step.status} />
            <div className="flex-1 min-w-0">
              <p
                className={`text-sm ${
                  step.status === "running"
                    ? "text-white"
                    : step.status === "done"
                      ? "text-white/60"
                      : "text-white/25"
                }`}
              >
                {step.label}
              </p>
              {step.detail && (
                <p className="text-[11px] text-white/30 truncate mt-0.5">
                  {step.detail}
                </p>
              )}
            </div>
            <span className="text-[10px] text-white/15 tabular-nums shrink-0">
              {i + 1}/{steps.length}
            </span>
          </motion.div>
        ))}
      </div>
    </motion.div>
  );
}

// ══════════════════════════════════════════════════════════
//  DONE PHASE
// ══════════════════════════════════════════════════════════
function DonePhase({ result, errorMsg, reinsId, onReset }) {
  if (errorMsg) {
    return (
      <motion.div
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        exit={{ opacity: 0, y: -12 }}
        className="flex flex-col items-center gap-6"
      >
        <div className="w-full max-w-md glass rounded-xl p-6 glow-danger border-red-500/20">
          <div className="flex items-center gap-3 mb-4">
            <div className="w-8 h-8 rounded-full bg-red-500/15 flex items-center justify-center">
              <svg className="w-4 h-4 text-red-400" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
              </svg>
            </div>
            <div>
              <h3 className="text-sm font-semibold text-red-400">
                エラーが発生しました
              </h3>
              <p className="text-xs text-white/30 font-mono">{reinsId}</p>
            </div>
          </div>
          <p className="text-sm text-white/60">{errorMsg}</p>
        </div>
        <button onClick={onReset} className="text-sm text-violet-400 hover:text-violet-300 transition-colors">
          最初からやり直す
        </button>
      </motion.div>
    );
  }

  if (!result) return null;

  const hasDraft = result.draftSaved === true;
  const hasScore = result.score !== null && result.score !== undefined;
  const scoreColor = hasScore
    ? result.score >= 40 ? "emerald" : result.score >= 35 ? "amber" : "red"
    : "white";
  const glowClass = hasDraft
    ? "glow-success border-emerald-500/20"
    : hasScore
      ? result.score >= 40 ? "glow-success border-emerald-500/20" : "glow-accent border-violet-500/20"
      : "glow-accent border-violet-500/20";

  return (
    <motion.div
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -12 }}
      className="flex flex-col items-center gap-5"
    >
      {/* Status header */}
      <div className={`w-full max-w-md glass rounded-xl p-6 ${glowClass}`}>
        <div className="flex items-center justify-between mb-4">
          <div>
            <h3 className={`text-sm font-semibold ${hasDraft ? "text-emerald-400" : hasScore && result.score >= 40 ? "text-emerald-400" : "text-violet-400"}`}>
              {hasDraft ? "一時保存完了" : "入稿完了"}
            </h3>
            <p className="text-xs text-white/30 mt-0.5">
              {result.propertyName || reinsId}
            </p>
            {hasDraft && (
              <p className="text-[10px] text-emerald-400/60 mt-1">
                forrent.jpで確認 → 本登録してください
              </p>
            )}
          </div>
          {hasScore && (
            <div className="text-right">
              <p className="text-3xl font-bold tabular-nums text-white">
                {result.score}
                <span className="text-sm text-white/30 font-normal ml-1">/ 43</span>
              </p>
              <p className="text-[10px] text-white/25">名寄せスコア</p>
            </div>
          )}
        </div>

        {/* Score bar */}
        {hasScore && (
          <div className="h-2 bg-white/5 rounded-full overflow-hidden mb-4">
            <div
              className={`h-full rounded-full transition-all ${
                scoreColor === "emerald" ? "bg-emerald-500"
                  : scoreColor === "amber" ? "bg-amber-500"
                    : "bg-red-500"
              }`}
              style={{ width: `${(result.score / 43) * 100}%` }}
            />
          </div>
        )}

        {/* Summary grid */}
        <div className="grid grid-cols-4 gap-2 text-xs">
          <div className="bg-white/3 rounded-lg p-2 text-center">
            <p className="text-white/25 text-[10px] mb-0.5">フィールド</p>
            <p className="text-white font-semibold">{result.filledFields}</p>
          </div>
          <div className="bg-white/3 rounded-lg p-2 text-center">
            <p className="text-white/25 text-[10px] mb-0.5">画像</p>
            <p className="text-white font-semibold">{result.uploadedImages}</p>
          </div>
          <div className="bg-white/3 rounded-lg p-2 text-center">
            <p className="text-white/25 text-[10px] mb-0.5">交通</p>
            <p className="text-white font-semibold">{result.transport?.length || 0}</p>
          </div>
          <div className="bg-white/3 rounded-lg p-2 text-center">
            <p className="text-white/25 text-[10px] mb-0.5">周辺環境</p>
            <p className="text-white font-semibold">{result.shuhen?.length || 0}</p>
          </div>
        </div>
      </div>

      {/* Generated texts */}
      {(result.catchCopy || result.comment) && (
        <div className="w-full max-w-md glass rounded-xl p-4">
          <h4 className="text-xs text-white/40 mb-3 font-medium">
            AI生成テキスト
          </h4>
          {result.catchCopy && (
            <div className="mb-3">
              <p className="text-[10px] text-white/25 mb-1">キャッチコピー</p>
              <p className="text-sm text-white/80 bg-white/3 rounded-lg p-2.5">
                {result.catchCopy}
              </p>
            </div>
          )}
          {result.comment && (
            <div>
              <p className="text-[10px] text-white/25 mb-1">フリーコメント</p>
              <p className="text-xs text-white/60 bg-white/3 rounded-lg p-2.5 leading-relaxed whitespace-pre-wrap">
                {result.comment}
              </p>
            </div>
          )}
        </div>
      )}

      {/* Validation errors from confirmation page */}
      {result.validationErrors?.length > 0 && (
        <div className="w-full max-w-md glass rounded-xl p-4 border-red-500/10">
          <h4 className="text-xs text-red-400/70 mb-2 font-medium">
            バリデーションエラー ({result.validationErrors.length}件)
          </h4>
          <div className="space-y-1">
            {result.validationErrors.map((err, i) => (
              <p key={i} className="text-[11px] text-red-300/50">
                {err}
              </p>
            ))}
          </div>
        </div>
      )}

      {/* Pipeline warnings */}
      {result.errors?.length > 0 && (
        <div className="w-full max-w-md glass rounded-xl p-4 border-amber-500/10">
          <h4 className="text-xs text-amber-400/70 mb-2 font-medium">
            注意事項 ({result.errors.length}件)
          </h4>
          <div className="space-y-1">
            {result.errors.map((err, i) => (
              <p key={i} className="text-[11px] text-white/30">
                {err}
              </p>
            ))}
          </div>
        </div>
      )}

      {/* Saved path */}
      {result.savedTo && (
        <p className="text-[10px] text-white/15 font-mono">
          {result.savedTo}
        </p>
      )}

      {/* Reset button */}
      <button
        onClick={onReset}
        className="px-6 py-2.5 rounded-lg bg-violet-600 text-white text-sm font-medium
                   hover:bg-violet-500 transition-all active:scale-95"
      >
        次の物件を入稿
      </button>
    </motion.div>
  );
}

// ══════════════════════════════════════════════════════════
//  STEP ICON
// ══════════════════════════════════════════════════════════
function StepIcon({ status }) {
  if (status === "done") {
    return (
      <div className="w-6 h-6 rounded-full bg-emerald-500/15 flex items-center justify-center shrink-0">
        <svg className="w-3.5 h-3.5 text-emerald-400" fill="none" viewBox="0 0 24 24" strokeWidth={2.5} stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" d="M4.5 12.75l6 6 9-13.5" />
        </svg>
      </div>
    );
  }
  if (status === "running") {
    return (
      <div className="w-6 h-6 rounded-full bg-violet-500/15 flex items-center justify-center shrink-0 relative">
        <div className="w-2 h-2 rounded-full bg-violet-400 animate-pulse" />
        <div
          className="absolute inset-0 rounded-full border border-violet-400/30"
          style={{ animation: "pulse-ring 1.5s ease-out infinite" }}
        />
      </div>
    );
  }
  if (status === "error") {
    return (
      <div className="w-6 h-6 rounded-full bg-red-500/15 flex items-center justify-center shrink-0">
        <svg className="w-3.5 h-3.5 text-red-400" fill="none" viewBox="0 0 24 24" strokeWidth={2.5} stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
        </svg>
      </div>
    );
  }
  // pending
  return (
    <div className="w-6 h-6 rounded-full bg-white/5 flex items-center justify-center shrink-0">
      <div className="w-1.5 h-1.5 rounded-full bg-white/15" />
    </div>
  );
}
