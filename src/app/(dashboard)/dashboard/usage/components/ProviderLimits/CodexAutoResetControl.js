"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { formatCodexCreditBalance } from "./utils";

const MODES = ["off", "auto", "smart"];

async function readResponse(response) {
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || "Could not update auto reset");
  if (!MODES.includes(result.mode)) throw new Error("Invalid auto reset status");
  return result;
}

export default function CodexAutoResetControl({ connectionId, credits, creditLoading, disabled, children }) {
  const [status, setStatus] = useState({ mode: "off" });
  const [ready, setReady] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const [pendingMode, setPendingMode] = useState(null);
  const dialogRef = useRef(null);
  const cancelRef = useRef(null);
  const endpoint = `/api/usage/${encodeURIComponent(connectionId)}/codex-auto-reset`;
  const labelId = `auto-reset-${connectionId}`;

  const loadStatus = useCallback(async (signal) => {
    try {
      const result = await readResponse(await fetch(endpoint, { cache: "no-store", signal }));
      if (signal?.aborted) return;
      setStatus(result);
      setReady(true);
      setError(null);
    } catch (fetchError) {
      if (!signal?.aborted) setError(fetchError.message || "Could not load auto reset");
    }
  }, [endpoint]);

  useEffect(() => {
    const controller = new AbortController();
    Promise.resolve().then(() => loadStatus(controller.signal));
    return () => controller.abort();
  }, [loadStatus]);

  useEffect(() => {
    if (status.mode === "off" || saving) return;
    const controller = new AbortController();
    const interval = setInterval(() => loadStatus(controller.signal), 60000);
    return () => {
      clearInterval(interval);
      controller.abort();
    };
  }, [loadStatus, saving, status.mode]);

  useEffect(() => {
    if (pendingMode) {
      dialogRef.current?.showModal();
      cancelRef.current?.focus();
    } else {
      dialogRef.current?.close();
    }
  }, [pendingMode]);

  async function saveMode(mode) {
    if (saving) return;
    setSaving(true);
    setError(null);
    try {
      const result = await readResponse(await fetch(endpoint, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode, acknowledged: mode !== "off" }),
      }));
      setStatus(result);
      setPendingMode(null);
    } catch (saveError) {
      await loadStatus();
      setError(saveError.message || "Could not update auto reset");
      setPendingMode(null);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="min-w-0 border-t border-border-subtle px-3 py-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <label htmlFor={labelId} className="text-xs font-medium text-text-primary">Auto Reset</label>
          <select
            id={labelId}
            aria-describedby={`${labelId}-status`}
            value={status.mode}
            disabled={!ready || saving || disabled}
            onChange={(event) => {
              const mode = event.target.value;
              if (mode === status.mode) return;
              if (mode === "off") saveMode(mode);
              else setPendingMode(mode);
            }}
            className="h-8 rounded-lg border border-border-subtle bg-surface px-2 text-sm text-text-primary focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary/60 disabled:cursor-not-allowed disabled:opacity-50"
          >
            <option value="off">Off</option>
            <option value="auto">Auto</option>
            <option value="smart">Smart</option>
          </select>
          {children}
        </div>
        <p className="text-xs text-text-muted">
          Usage credits: <span className="font-medium tabular-nums text-text-primary">
            {creditLoading ? "Loading…" : formatCodexCreditBalance(credits)}
          </span>
        </p>
      </div>
      <p id={`${labelId}-status`} className="mt-1 text-xs text-text-muted" role="status">
        {saving ? "Saving…" : !ready ? (error ? "Auto reset status unavailable." : "Loading auto reset…")
          : status.reason || (status.mode === "off" ? "Automatic reset is off." : "Waiting for fresh quota, usage credits, and reset-bank details.")}
        {status.lastResetAt && <> Last reset: {new Date(status.lastResetAt).toLocaleString()}.</>}
      </p>
      {error && (
        <p role="alert" className="mt-1 text-xs text-red-600 dark:text-red-400">
          {error}{" "}
          <button type="button" onClick={() => loadStatus()} disabled={saving} className="underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary/60">Retry</button>
        </p>
      )}
      <dialog
        ref={dialogRef}
        aria-labelledby={`${labelId}-confirm-title`}
        aria-describedby={`${labelId}-confirm-description`}
        onCancel={(event) => {
          if (saving) event.preventDefault();
          else setPendingMode(null);
        }}
        className="m-auto w-11/12 max-w-sm rounded-xl border border-border-subtle bg-surface p-4 text-text-primary shadow-lg backdrop:bg-black/50"
      >
        <h2 id={`${labelId}-confirm-title`} className="text-base font-semibold">Enable {pendingMode === "auto" ? "Auto" : "Smart"} Reset?</h2>
        <p id={`${labelId}-confirm-description`} className="mt-2 text-sm text-text-muted">
          {pendingMode === "auto"
            ? "Redeem reset credits shortly before expiry when used quota can be restored."
            : "Wait until usage credits are exhausted, then use recent consumption and credit expiry to choose when to restore used quota."}
          {" "}9Router checks quota, usage credits, and reset-bank details first. Each redemption spends one reset credit and cannot be undone.
        </p>
        <div className="mt-4 flex flex-wrap justify-end gap-2">
          <button ref={cancelRef} type="button" disabled={saving} onClick={() => setPendingMode(null)} className="rounded-lg border border-border-subtle px-3 py-2 text-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary/60 disabled:opacity-50">Cancel</button>
          <button type="button" disabled={saving} onClick={() => saveMode(pendingMode)} className="rounded-lg bg-primary px-3 py-2 text-sm font-medium text-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary/60 disabled:opacity-50">{saving ? "Saving…" : "Enable automatic redemption"}</button>
        </div>
      </dialog>
    </div>
  );
}
