// Content script. Runs in the isolated world on leetcode.com/problems/*.
//
// Two responsibilities:
//   1. Inject the page-world fetch patch (inject.js) into the page realm.
//   2. Listen for window.postMessage events from inject.js and forward them
//      to the background service worker.

import { isAcceptedMessage } from "./lib/submission-detection";

(() => {
  const script = document.createElement("script");
  script.src = chrome.runtime.getURL("inject.js");
  script.type = "module";
  // Inject as early as possible so we patch fetch before the page uses it.
  (document.head ?? document.documentElement).appendChild(script);
  // The script element itself is no longer needed once the module starts loading.
  script.onload = () => script.remove();
})();

window.addEventListener("message", event => {
  if (event.source !== window) return;
  if (!isAcceptedMessage(event.data)) return;
  chrome.runtime
    .sendMessage({ type: "submission_accepted", submissionId: event.data.submissionId })
    .catch(err => {
      // SW may be unloaded; the alarm-driven safety poll will catch up.
      console.warn("[leetcode-sync] could not deliver submission to background:", err);
    });
});
