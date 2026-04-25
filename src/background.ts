// Service worker entrypoint. Wires the orchestrator to chrome.* APIs:
// listens for accepted submissions from content scripts, runs a periodic
// safety poll, exposes manual sync from the popup.

import { createDedupGate } from "./lib/dedup";
import { createGitHubClient } from "./lib/github";
import { createLeetCodeClient } from "./lib/leetcode";
import { createOrchestrator, type SyncConfig } from "./lib/orchestrator";

const ALARM_NAME = "leetcode-safety-poll";
const POLL_INTERVAL_MINUTES = 30;
const REQUIRED_CHECK = "pytest";

type StoredConfig = Partial<{
  githubToken: string;
  githubOwner: string;
  repoName: string;
  authorName: string;
  authorEmail: string;
  baseBranch: string;
  notificationsEnabled: boolean;
}>;

const leetcodeClient = createLeetCodeClient({
  fetchFn: fetch.bind(globalThis),
  getCookie: name =>
    new Promise(resolve => {
      chrome.cookies.get({ url: "https://leetcode.com", name }, c => resolve(c?.value ?? null));
    }),
});

const dedupGate = createDedupGate({
  storage: chrome.storage.local as unknown as Parameters<typeof createDedupGate>[0]["storage"],
});

async function loadStoredConfig(): Promise<StoredConfig> {
  return chrome.storage.sync.get([
    "githubToken",
    "githubOwner",
    "repoName",
    "authorName",
    "authorEmail",
    "baseBranch",
    "notificationsEnabled",
  ]) as Promise<StoredConfig>;
}

async function buildOrchestrator() {
  const stored = await loadStoredConfig();
  if (!stored.githubToken || !stored.githubOwner || !stored.repoName) {
    throw new Error("Extension is not configured. Open the options page.");
  }
  const config: SyncConfig = {
    repoName: stored.repoName,
    authorName: stored.authorName ?? stored.githubOwner,
    authorEmail: stored.authorEmail ?? `${stored.githubOwner}@users.noreply.github.com`,
    baseBranch: stored.baseBranch ?? "main",
    notificationsEnabled: stored.notificationsEnabled ?? true,
    requiredCheckContext: REQUIRED_CHECK,
  };
  const github = createGitHubClient({
    fetchFn: fetch.bind(globalThis),
    token: stored.githubToken,
    owner: stored.githubOwner,
    repo: stored.repoName,
  });
  return createOrchestrator({
    leetcode: leetcodeClient,
    github,
    dedup: dedupGate,
    config,
    notify: notifyUser,
    log: (level, msg, extra) => {
      const fn = level === "error" ? console.error : level === "warn" ? console.warn : console.log;
      fn(`[leetcode-sync] ${msg}`, extra ?? "");
    },
  });
}

function notifyUser(title: string, message: string, _url?: string) {
  chrome.notifications.create({
    type: "basic",
    iconUrl: chrome.runtime.getURL("icons/icon-128.png"),
    title,
    message,
  });
}

// -- Lifecycle -------------------------------------------------------------

chrome.runtime.onInstalled.addListener(details => {
  chrome.alarms.create(ALARM_NAME, { periodInMinutes: POLL_INTERVAL_MINUTES });
  if (details.reason === "install") {
    chrome.runtime.openOptionsPage();
  }
});

chrome.runtime.onStartup.addListener(() => {
  chrome.alarms.create(ALARM_NAME, { periodInMinutes: POLL_INTERVAL_MINUTES });
});

// -- Periodic safety poll --------------------------------------------------

chrome.alarms.onAlarm.addListener(async alarm => {
  if (alarm.name !== ALARM_NAME) return;
  try {
    const orch = await buildOrchestrator();
    const results = await orch.safetyPoll();
    if (results.length > 0) {
      console.log(`[leetcode-sync] safety poll processed ${results.length} submissions`);
    }
  } catch (e) {
    console.warn("[leetcode-sync] safety poll skipped:", e);
  }
});

// -- Messages from content script + popup ----------------------------------

interface SubmissionMessage {
  type: "submission_accepted";
  submissionId: string | number;
}

interface ManualSyncMessage {
  type: "manual_sync";
}

interface GetStatusMessage {
  type: "get_status";
}

type Message = SubmissionMessage | ManualSyncMessage | GetStatusMessage;

chrome.runtime.onMessage.addListener((raw: unknown, _sender, sendResponse) => {
  const msg = raw as Message;
  if (msg?.type === "submission_accepted" && msg.submissionId != null) {
    (async () => {
      try {
        const orch = await buildOrchestrator();
        const result = await orch.syncSubmission(String(msg.submissionId));
        sendResponse({ ok: true, result });
      } catch (e) {
        sendResponse({ ok: false, error: e instanceof Error ? e.message : String(e) });
      }
    })();
    return true;
  }
  if (msg?.type === "manual_sync") {
    (async () => {
      try {
        const orch = await buildOrchestrator();
        await orch.ensureRepoExists();
        const results = await orch.safetyPoll();
        sendResponse({ ok: true, results });
      } catch (e) {
        sendResponse({ ok: false, error: e instanceof Error ? e.message : String(e) });
      }
    })();
    return true;
  }
  if (msg?.type === "get_status") {
    (async () => {
      const stored = await loadStoredConfig();
      const lastSyncedId = await dedupGate.getLastSyncedId();
      sendResponse({
        ok: true,
        configured: Boolean(stored.githubToken && stored.githubOwner && stored.repoName),
        owner: stored.githubOwner ?? null,
        repo: stored.repoName ?? null,
        lastSyncedId,
      });
    })();
    return true;
  }
  return false;
});
