// Popup UI. Shows current sync status and offers a manual sync trigger.

import { formatStatus, summarizeOutcomes, type StatusState, type SyncOutcomeSummary } from "../lib/ui-helpers";

const $ = <T extends HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`#${id} not found`);
  return el as T;
};

const els = {
  status: $("status"),
  syncBtn: $<HTMLButtonElement>("sync-now"),
  optionsBtn: $<HTMLButtonElement>("open-options"),
  result: $("last-result"),
};

interface StatusResponse {
  ok: boolean;
  configured?: boolean;
  owner?: string | null;
  repo?: string | null;
  lastSyncedId?: string | null;
}

async function loadStatus(): Promise<void> {
  const res = (await chrome.runtime.sendMessage({ type: "get_status" })) as StatusResponse;
  if (!res?.ok) {
    els.status.textContent = "Could not reach background worker.";
    return;
  }
  const state: StatusState = {
    configured: res.configured ?? false,
    owner: res.owner ?? null,
    repo: res.repo ?? null,
    lastSyncedId: res.lastSyncedId ?? null,
  };
  els.status.textContent = formatStatus(state);
  els.syncBtn.disabled = !state.configured;
}

async function manualSync(): Promise<void> {
  els.syncBtn.disabled = true;
  setResult("Syncing…", "");
  try {
    const res = (await chrome.runtime.sendMessage({ type: "manual_sync" })) as {
      ok: boolean;
      results?: SyncOutcomeSummary[];
      error?: string;
    };
    if (!res?.ok) {
      setResult(`Failed: ${res?.error ?? "unknown error"}`, "error");
      return;
    }
    setResult(summarizeOutcomes(res.results ?? []), "success");
    await loadStatus();
  } catch (e) {
    setResult(`Failed: ${e instanceof Error ? e.message : String(e)}`, "error");
  } finally {
    els.syncBtn.disabled = false;
  }
}

function setResult(text: string, kind: "success" | "error" | ""): void {
  els.result.textContent = text;
  els.result.className = "result visible" + (kind ? ` ${kind}` : "");
}

els.syncBtn.addEventListener("click", manualSync);
els.optionsBtn.addEventListener("click", () => chrome.runtime.openOptionsPage());

void loadStatus();
