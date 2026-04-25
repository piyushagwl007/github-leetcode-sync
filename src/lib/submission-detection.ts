// Pure helpers for detecting accepted submissions in LeetCode's network traffic.
// Extracted from inject.ts so the URL matcher and response predicate are
// testable without mocking window.fetch or chrome.runtime.

// LeetCode polls this URL every ~500ms after a submission while the verdict
// transitions from PENDING → STARTED → SUCCESS. Matching captures the
// numeric submission id from the path.
export const SUBMISSION_CHECK_PATH_REGEX = /\/submissions\/detail\/(\d+)\/check\/?$/;

export function extractSubmissionId(url: string): string | null {
  const m = SUBMISSION_CHECK_PATH_REGEX.exec(url);
  return m ? m[1]! : null;
}

export interface CheckResponse {
  state?: string;
  status_msg?: string;
  status_code?: number;
}

// True only when LeetCode has finished judging AND the verdict is Accepted.
// Handles the in-between polls (PENDING/STARTED) and rejected submissions
// (Wrong Answer / Time Limit Exceeded / Runtime Error / Compile Error).
export function isAcceptedSubmission(
  data: unknown
): data is CheckResponse & { state: "SUCCESS"; status_msg: "Accepted" } {
  if (!data || typeof data !== "object") return false;
  const d = data as Record<string, unknown>;
  return d.state === "SUCCESS" && d.status_msg === "Accepted";
}

// Resolve the URL of a fetch() call regardless of whether the input is a
// string, URL, or Request — they all need to be supported because LeetCode's
// frontend uses the Request form.
export function resolveFetchUrl(input: unknown): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.toString();
  if (typeof Request !== "undefined" && input instanceof Request) return input.url;
  if (input && typeof input === "object" && "toString" in input) return String(input);
  return "";
}

// The window.postMessage envelope content scripts listen for. Defining the
// constants here so producer (inject.ts) and consumer (content.ts) cannot
// drift apart.
export const MESSAGE_SOURCE = "github-leetcode-sync";
export const MESSAGE_TYPE_ACCEPTED = "submission_accepted";

export interface AcceptedMessage {
  source: typeof MESSAGE_SOURCE;
  type: typeof MESSAGE_TYPE_ACCEPTED;
  submissionId: string;
}

export function isAcceptedMessage(data: unknown): data is AcceptedMessage {
  if (!data || typeof data !== "object") return false;
  const d = data as Record<string, unknown>;
  return (
    d.source === MESSAGE_SOURCE &&
    d.type === MESSAGE_TYPE_ACCEPTED &&
    typeof d.submissionId === "string" &&
    d.submissionId.length > 0
  );
}
