// Three-layer deduplication for LeetCode submission sync.
//
//   Layer 1 — in-flight lock: a per-submission-ID set in memory. The page-world
//             fetch interceptor may fire several times for the same submission
//             as LeetCode polls Pending → Accepted; this collapses them.
//
//   Layer 2 — persisted ID set: chrome.storage.local. Capped at MAX_PROCESSED_IDS
//             so storage stays bounded. Survives service-worker restart.
//
//   Layer 3 — content equality: caller compares the new file body against the
//             existing GitHub blob using `contentMatches`. Skips no-op commits
//             (re-solved with identical code) so we don't churn green squares.

const MAX_PROCESSED_IDS = 500;

const KEY_PROCESSED = "processedSubmissionIds";
const KEY_LAST = "lastSyncedSubmissionId";

export interface ChromeStorageLike {
  get(keys: string | string[]): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
}

export interface DedupDeps {
  storage: ChromeStorageLike;
}

export interface SubmissionLock {
  release: () => void;
}

export function createDedupGate(deps: DedupDeps) {
  const inFlight = new Set<string>();

  async function readState(): Promise<{ processed: string[]; last: string | null }> {
    const data = await deps.storage.get([KEY_PROCESSED, KEY_LAST]);
    const processed = Array.isArray(data[KEY_PROCESSED]) ? (data[KEY_PROCESSED] as string[]) : [];
    const lastRaw = data[KEY_LAST];
    const last = typeof lastRaw === "string" ? lastRaw : null;
    return { processed, last };
  }

  async function hasBeenProcessed(submissionId: string): Promise<boolean> {
    const { processed } = await readState();
    return processed.includes(submissionId);
  }

  // Synchronous: only consults in-memory state. Returns null if a sync for this
  // submission is already in flight; caller should bail out silently.
  function tryAcquireLock(submissionId: string): SubmissionLock | null {
    if (inFlight.has(submissionId)) return null;
    inFlight.add(submissionId);
    return {
      release: () => {
        inFlight.delete(submissionId);
      },
    };
  }

  function isLocked(submissionId: string): boolean {
    return inFlight.has(submissionId);
  }

  async function markProcessed(submissionId: string): Promise<void> {
    const { processed, last } = await readState();
    if (processed.includes(submissionId)) {
      // Already recorded — but still update last-synced if this ID is higher,
      // so the alarm poll's high-water mark stays correct.
      const nextLast = pickHigherId(last, submissionId);
      if (nextLast !== last) await deps.storage.set({ [KEY_LAST]: nextLast });
      return;
    }
    const appended = [...processed, submissionId];
    const trimmed = appended.length > MAX_PROCESSED_IDS
      ? appended.slice(appended.length - MAX_PROCESSED_IDS)
      : appended;
    await deps.storage.set({
      [KEY_PROCESSED]: trimmed,
      [KEY_LAST]: pickHigherId(last, submissionId),
    });
  }

  async function getLastSyncedId(): Promise<string | null> {
    const { last } = await readState();
    return last;
  }

  async function getProcessedIds(): Promise<string[]> {
    const { processed } = await readState();
    return processed;
  }

  return {
    hasBeenProcessed,
    tryAcquireLock,
    isLocked,
    markProcessed,
    getLastSyncedId,
    getProcessedIds,
  };
}

// Layer 3: GitHub content equality. Whitespace is normalized so trailing
// newline differences (GitHub appends one) and CRLF/LF mismatches don't
// trigger spurious commits.
export function contentMatches(existing: string | null, candidate: string): boolean {
  if (existing === null) return false;
  return normalize(existing) === normalize(candidate);
}

function normalize(s: string): string {
  return s.replace(/\r\n/g, "\n").replace(/\s+$/g, "");
}

// LeetCode submission IDs are auto-increment integers, monotonically increasing.
// They fit in Number.MAX_SAFE_INTEGER comfortably (~9e15 ceiling, IDs are ~1e9).
function pickHigherId(a: string | null, b: string): string {
  if (a === null) return b;
  return Number(b) > Number(a) ? b : a;
}
