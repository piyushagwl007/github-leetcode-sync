// Options page UI. Loads stored config, lets the user paste a GitHub PAT and
// verify it (auto-filling owner / author defaults from the GitHub user
// profile), then writes back to chrome.storage.sync.

import { defaultsFromUser, validateConfig, type GitHubUser } from "../lib/ui-helpers";

const $ = <T extends HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`#${id} not found`);
  return el as T;
};

const els = {
  form: $<HTMLFormElement>("config-form"),
  token: $<HTMLInputElement>("github-token"),
  verifyBtn: $<HTMLButtonElement>("verify-token"),
  tokenStatus: $("token-status"),
  repoName: $<HTMLInputElement>("repo-name"),
  owner: $<HTMLInputElement>("github-owner"),
  authorName: $<HTMLInputElement>("author-name"),
  authorEmail: $<HTMLInputElement>("author-email"),
  noreplySuggestion: $("noreply-suggestion"),
  useNoreplyBtn: $<HTMLButtonElement>("use-noreply"),
  baseBranch: $<HTMLInputElement>("base-branch"),
  notifications: $<HTMLInputElement>("notifications"),
  saveBtn: $<HTMLButtonElement>("save"),
  saveStatus: $("save-status"),
  errors: $("errors"),
};

const STORAGE_KEYS = [
  "githubToken",
  "githubOwner",
  "repoName",
  "authorName",
  "authorEmail",
  "baseBranch",
  "notificationsEnabled",
] as const;

async function loadConfig(): Promise<void> {
  const stored = (await chrome.storage.sync.get([...STORAGE_KEYS])) as Record<string, unknown>;
  els.token.value = (stored.githubToken as string) ?? "";
  els.owner.value = (stored.githubOwner as string) ?? "";
  els.repoName.value = (stored.repoName as string) ?? "leetcode-solutions";
  els.authorName.value = (stored.authorName as string) ?? "";
  els.authorEmail.value = (stored.authorEmail as string) ?? "";
  els.baseBranch.value = (stored.baseBranch as string) ?? "main";
  els.notifications.checked = (stored.notificationsEnabled as boolean) ?? true;

  if (stored.githubToken && !stored.githubOwner) {
    setTokenStatus("Token saved but unverified. Click Verify.", "");
  } else if (stored.githubOwner) {
    setTokenStatus(`Authenticated as ${stored.githubOwner}.`, "success");
  }
}

async function verifyToken(): Promise<void> {
  const token = els.token.value.trim();
  if (!token) {
    setTokenStatus("Paste a token first.", "error");
    return;
  }
  setTokenStatus("Verifying…", "");
  els.verifyBtn.disabled = true;
  try {
    const res = await fetch("https://api.github.com/user", {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
    });
    if (!res.ok) {
      const body = await res.text();
      setTokenStatus(`Verification failed: ${res.status} ${body.slice(0, 100)}`, "error");
      return;
    }
    const user = (await res.json()) as GitHubUser;
    const defaults = defaultsFromUser(user);
    els.owner.value = defaults.githubOwner;
    if (!els.authorName.value) els.authorName.value = defaults.authorName;
    if (!els.authorEmail.value) els.authorEmail.value = defaults.authorEmail;
    els.noreplySuggestion.textContent = defaults.noreplyEmail;
    els.useNoreplyBtn.dataset.value = defaults.noreplyEmail;
    setTokenStatus(`Authenticated as ${user.login}.`, "success");
  } catch (e) {
    setTokenStatus(`Verification failed: ${e instanceof Error ? e.message : String(e)}`, "error");
  } finally {
    els.verifyBtn.disabled = false;
  }
}

async function save(event: SubmitEvent): Promise<void> {
  event.preventDefault();
  const config = {
    githubToken: els.token.value.trim(),
    githubOwner: els.owner.value.trim(),
    repoName: els.repoName.value.trim(),
    authorName: els.authorName.value.trim(),
    authorEmail: els.authorEmail.value.trim(),
    baseBranch: els.baseBranch.value.trim() || "main",
    notificationsEnabled: els.notifications.checked,
  };

  const validation = validateConfig(config);
  if (!validation.ok) {
    showErrors(validation.errors);
    return;
  }
  showErrors([]);

  await chrome.storage.sync.set(config);
  setSaveStatus("Saved.", "success");
  setTimeout(() => setSaveStatus("", ""), 2000);
}

function showErrors(errors: string[]): void {
  if (errors.length === 0) {
    els.errors.classList.remove("visible");
    els.errors.textContent = "";
    return;
  }
  els.errors.innerHTML = "<strong>Please fix:</strong><ul>" +
    errors.map(e => `<li>${escapeHtml(e)}</li>`).join("") +
    "</ul>";
  els.errors.classList.add("visible");
}

function setTokenStatus(text: string, kind: "success" | "error" | ""): void {
  els.tokenStatus.textContent = text;
  els.tokenStatus.className = "status" + (kind ? ` ${kind}` : "");
}

function setSaveStatus(text: string, kind: "success" | "error" | ""): void {
  els.saveStatus.textContent = text;
  els.saveStatus.className = "status" + (kind ? ` ${kind}` : "");
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

els.verifyBtn.addEventListener("click", verifyToken);
els.useNoreplyBtn.addEventListener("click", () => {
  const v = els.useNoreplyBtn.dataset.value;
  if (v) els.authorEmail.value = v;
});
els.form.addEventListener("submit", save);

void loadConfig();
