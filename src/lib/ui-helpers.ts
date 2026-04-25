// Pure helpers for the options + popup UI. Extracted so the validation rules
// and status-line formatting can be unit-tested without a DOM.

export interface ConfigInput {
  githubToken?: string;
  githubOwner?: string;
  repoName?: string;
  authorName?: string;
  authorEmail?: string;
  baseBranch?: string;
}

export type ValidationResult =
  | { ok: true }
  | { ok: false; errors: string[] };

export function validateConfig(values: ConfigInput): ValidationResult {
  const errors: string[] = [];

  if (!values.githubToken?.trim()) errors.push("GitHub token is required.");
  if (!values.githubOwner?.trim()) errors.push("GitHub username is required (verify your token to fill it).");
  if (!values.repoName?.trim()) errors.push("Repo name is required.");
  if (values.repoName && !/^[a-zA-Z0-9._-]+$/.test(values.repoName)) {
    errors.push("Repo name may only contain letters, numbers, dots, underscores, and hyphens.");
  }
  if (values.authorEmail && !isValidEmail(values.authorEmail)) {
    errors.push("Author email must be a valid email address.");
  }
  if (values.baseBranch && !/^[a-zA-Z0-9._/-]+$/.test(values.baseBranch)) {
    errors.push("Base branch contains invalid characters.");
  }

  return errors.length ? { ok: false, errors } : { ok: true };
}

function isValidEmail(s: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s.trim());
}

export interface StatusState {
  configured: boolean;
  owner: string | null;
  repo: string | null;
  lastSyncedId: string | null;
}

export function formatStatus(state: StatusState): string {
  if (!state.configured) return "Not configured — open Settings.";
  const target = state.owner && state.repo ? `${state.owner}/${state.repo}` : "(no target)";
  if (!state.lastSyncedId) return `Configured: ${target}. No syncs yet.`;
  return `Last synced submission #${state.lastSyncedId} → ${target}`;
}

export interface SyncOutcomeSummary {
  status: "synced" | "skipped" | "error";
}

export function summarizeOutcomes(outcomes: SyncOutcomeSummary[]): string {
  if (outcomes.length === 0) return "No new submissions.";
  const synced = outcomes.filter(o => o.status === "synced").length;
  const skipped = outcomes.filter(o => o.status === "skipped").length;
  const errored = outcomes.filter(o => o.status === "error").length;
  const parts: string[] = [];
  if (synced) parts.push(`${synced} synced`);
  if (skipped) parts.push(`${skipped} skipped`);
  if (errored) parts.push(`${errored} errored`);
  return parts.length ? parts.join(" · ") : "No new submissions.";
}

// Suggests sensible defaults based on a verified GitHub user's profile so
// the user doesn't have to hand-fill obvious fields.
export interface GitHubUser {
  login: string;
  id: number;
  name?: string | null;
  email?: string | null;
}

export interface SuggestedDefaults {
  githubOwner: string;
  authorName: string;
  authorEmail: string;
  noreplyEmail: string;
}

export function defaultsFromUser(user: GitHubUser): SuggestedDefaults {
  return {
    githubOwner: user.login,
    authorName: user.name?.trim() || user.login,
    authorEmail: (user.email && user.email.trim()) || `${user.id}+${user.login}@users.noreply.github.com`,
    noreplyEmail: `${user.id}+${user.login}@users.noreply.github.com`,
  };
}
