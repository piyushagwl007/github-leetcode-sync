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
  const TAG = "[leetcode-sync inject]";
  const ORIG_FETCH = window.fetch;
  console.log(`${TAG} fetch patch installed`);

  const patched = async function patchedFetch(
    ...args: Parameters<typeof fetch>
  ): Promise<Response> {
    const response = await ORIG_FETCH.apply(window, args);

    try {
      const url = resolveFetchUrl(args[0]);
      const submissionId = extractSubmissionId(url);
      if (submissionId && response.ok) {
        console.log(`${TAG} matched check URL for submission ${submissionId}`);
        // Inspect off the critical path; never throw, never block the page.
        response
          .clone()
          .json()
          .then(data => {
            const accepted = isAcceptedSubmission(data);
            const state = (data as { state?: string })?.state;
            const verdict = (data as { status_msg?: string })?.status_msg;
            console.log(
              `${TAG} verdict for ${submissionId}: state=${state} msg=${verdict} → ${
                accepted ? "POSTING" : "ignored"
              }`
            );
            if (accepted) {
              window.postMessage(
                { source: MESSAGE_SOURCE, type: MESSAGE_TYPE_ACCEPTED, submissionId },
                window.location.origin
              );
            }
          })
          .catch(err => console.warn(`${TAG} could not parse check response`, err));
      }
    } catch (err) {
      console.warn(`${TAG} unexpected error in patch (page not affected)`, err);
    }

    return response;
  };

  // Preserve any static properties on fetch (e.g. fetch.preconnect) so the
  // patched function is a complete drop-in replacement.
  window.fetch = Object.assign(patched, ORIG_FETCH) as typeof fetch;
})();
