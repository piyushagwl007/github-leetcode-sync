// Page-world script. Injected into leetcode.com via a <script src> tag from
// content.ts so it can monkey-patch window.fetch in the page's own JS realm.
//
// Why the page world: in MV3, content scripts run in an *isolated* world
// where window.fetch is a separate object from the page's. Patching it from
// a content script wouldn't intercept the page's own submission polls.
//
// Body sniffing: we clone the response so the page can still consume the
// body normally. Only POST + 200 + matching URL are checked, so the cost
// per call is essentially zero.

import {
  MESSAGE_SOURCE,
  MESSAGE_TYPE_ACCEPTED,
  extractSubmissionId,
  isAcceptedSubmission,
  resolveFetchUrl,
} from "./lib/submission-detection";

(() => {
  const ORIG_FETCH = window.fetch;

  const patched = async function patchedFetch(
    ...args: Parameters<typeof fetch>
  ): Promise<Response> {
    const response = await ORIG_FETCH.apply(window, args);

    try {
      const url = resolveFetchUrl(args[0]);
      const submissionId = extractSubmissionId(url);
      if (submissionId && response.ok) {
        // Inspect off the critical path; never throw, never block the page.
        response
          .clone()
          .json()
          .then(data => {
            if (isAcceptedSubmission(data)) {
              window.postMessage(
                { source: MESSAGE_SOURCE, type: MESSAGE_TYPE_ACCEPTED, submissionId },
                window.location.origin
              );
            }
          })
          .catch(() => {});
      }
    } catch {
      // Patch must never break the page.
    }

    return response;
  };

  // Preserve any static properties on fetch (e.g. fetch.preconnect) so the
  // patched function is a complete drop-in replacement.
  window.fetch = Object.assign(patched, ORIG_FETCH) as typeof fetch;
})();
