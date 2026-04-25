// Service worker entrypoint. Real orchestration logic lands in PR #6.
chrome.runtime.onInstalled.addListener(() => {
  console.log("github-leetcode-sync background worker installed");
});

export {};
