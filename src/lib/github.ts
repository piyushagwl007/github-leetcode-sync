// GitHub REST + GraphQL client.
//
// Designed to do atomic multi-file commits via the Git Data API (so a single
// PR can land solution + tests.json + README in one commit), open a PR, and
// enable auto-merge so CI gates the merge to main.

const REST = "https://api.github.com";
const GQL = "https://api.github.com/graphql";
const USER_AGENT = "github-leetcode-sync";

export interface GitHubAuthor {
  name: string;
  email: string;
}

export interface FileToCommit {
  path: string;
  content: string;
}

export interface CreateRepoOptions {
  name: string;
  description?: string;
  private?: boolean;
}

export interface GitHubDeps {
  fetchFn: typeof fetch;
  token: string;
  owner: string;
  repo: string;
}

export function createGitHubClient(deps: GitHubDeps) {
  function authHeaders(extra: Record<string, string> = {}): Record<string, string> {
    return {
      Authorization: `Bearer ${deps.token}`,
      Accept: "application/vnd.github+json",
      "User-Agent": USER_AGENT,
      "X-GitHub-Api-Version": "2022-11-28",
      ...extra,
    };
  }

  async function rest<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await deps.fetchFn(`${REST}${path}`, {
      method,
      headers: authHeaders(body ? { "Content-Type": "application/json" } : {}),
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`GitHub ${method} ${path} → ${res.status}: ${text}`);
    }
    if (res.status === 204) return undefined as T;
    return (await res.json()) as T;
  }

  async function gql<T>(query: string, variables: Record<string, unknown>): Promise<T> {
    const res = await deps.fetchFn(GQL, {
      method: "POST",
      headers: authHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({ query, variables }),
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`GitHub GraphQL ${res.status}: ${text}`);
    }
    const json = (await res.json()) as { data?: T; errors?: Array<{ message: string }> };
    if (json.errors?.length) throw new Error(json.errors.map(e => e.message).join("; "));
    if (!json.data) throw new Error("GitHub GraphQL returned no data");
    return json.data;
  }

  // -- Repo creation / configuration ----------------------------------------

  async function createRepoForUser(opts: CreateRepoOptions): Promise<{ full_name: string }> {
    return rest<{ full_name: string }>("POST", "/user/repos", {
      name: opts.name,
      description: opts.description ?? "",
      private: opts.private ?? false,
      auto_init: true,
      allow_auto_merge: true,
      allow_squash_merge: true,
      allow_merge_commit: false,
      allow_rebase_merge: false,
      delete_branch_on_merge: true,
      squash_merge_commit_title: "PR_TITLE",
      squash_merge_commit_message: "PR_BODY",
    });
  }

  async function repoExists(): Promise<boolean> {
    const res = await deps.fetchFn(`${REST}/repos/${deps.owner}/${deps.repo}`, {
      headers: authHeaders(),
    });
    if (res.status === 404) return false;
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`GitHub repoExists → ${res.status}: ${text}`);
    }
    return true;
  }

  async function setBranchProtection(branch: string, requiredCheck: string): Promise<void> {
    await rest("PUT", `/repos/${deps.owner}/${deps.repo}/branches/${branch}/protection`, {
      required_status_checks: {
        strict: true,
        contexts: [requiredCheck],
      },
      enforce_admins: false,
      required_pull_request_reviews: null,
      restrictions: null,
      allow_force_pushes: false,
      allow_deletions: false,
    });
  }

  // -- Reading file content (for dedup content-equality) --------------------

  // Returns the file's raw text contents, or null if it does not exist.
  async function getFileContent(path: string, ref?: string): Promise<string | null> {
    const url = `${REST}/repos/${deps.owner}/${deps.repo}/contents/${encodeURI(path)}${
      ref ? `?ref=${encodeURIComponent(ref)}` : ""
    }`;
    const res = await deps.fetchFn(url, { headers: authHeaders() });
    if (res.status === 404) return null;
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`GitHub getFileContent → ${res.status}: ${text}`);
    }
    const data = (await res.json()) as { content?: string; encoding?: string };
    if (!data.content) return "";
    if (data.encoding === "base64") return decodeBase64(data.content);
    return data.content;
  }

  // -- Atomic multi-file commit via Git Data API ----------------------------

  // Creates a new branch off `baseBranch` containing one commit with all files.
  // Returns the new commit SHA. Caller should then open a PR on `branch`.
  async function commitFiles(opts: {
    branch: string;
    baseBranch: string;
    files: FileToCommit[];
    message: string;
    author: GitHubAuthor;
  }): Promise<{ commitSha: string }> {
    if (opts.files.length === 0) throw new Error("commitFiles: no files to commit");

    // 1. Get the SHA of the base branch tip.
    const baseRef = await rest<{ object: { sha: string } }>(
      "GET",
      `/repos/${deps.owner}/${deps.repo}/git/ref/heads/${opts.baseBranch}`
    );
    const baseSha = baseRef.object.sha;

    const baseCommit = await rest<{ tree: { sha: string } }>(
      "GET",
      `/repos/${deps.owner}/${deps.repo}/git/commits/${baseSha}`
    );
    const baseTreeSha = baseCommit.tree.sha;

    // 2. Create blobs for each file.
    const blobs = await Promise.all(
      opts.files.map(async f => {
        const blob = await rest<{ sha: string }>(
          "POST",
          `/repos/${deps.owner}/${deps.repo}/git/blobs`,
          { content: f.content, encoding: "utf-8" }
        );
        return { path: f.path, sha: blob.sha };
      })
    );

    // 3. Create a tree off the base tree containing all new blobs.
    const tree = await rest<{ sha: string }>(
      "POST",
      `/repos/${deps.owner}/${deps.repo}/git/trees`,
      {
        base_tree: baseTreeSha,
        tree: blobs.map(b => ({
          path: b.path,
          mode: "100644",
          type: "blob",
          sha: b.sha,
        })),
      }
    );

    // 4. Create the commit.
    const commit = await rest<{ sha: string }>(
      "POST",
      `/repos/${deps.owner}/${deps.repo}/git/commits`,
      {
        message: opts.message,
        tree: tree.sha,
        parents: [baseSha],
        author: opts.author,
        committer: opts.author,
      }
    );

    // 5. Create the new branch ref pointing at the commit.
    await rest("POST", `/repos/${deps.owner}/${deps.repo}/git/refs`, {
      ref: `refs/heads/${opts.branch}`,
      sha: commit.sha,
    });

    return { commitSha: commit.sha };
  }

  // -- Pull requests --------------------------------------------------------

  async function openPullRequest(opts: {
    branch: string;
    baseBranch: string;
    title: string;
    body: string;
  }): Promise<{ number: number; node_id: string; html_url: string }> {
    return rest<{ number: number; node_id: string; html_url: string }>(
      "POST",
      `/repos/${deps.owner}/${deps.repo}/pulls`,
      {
        head: opts.branch,
        base: opts.baseBranch,
        title: opts.title,
        body: opts.body,
        maintainer_can_modify: true,
      }
    );
  }

  // Auto-merge can only be enabled via GraphQL. Defaults to SQUASH so the
  // merged commit is authored as the PR author with the PR title as message.
  async function enableAutoMerge(pullRequestNodeId: string, mergeMethod: "SQUASH" | "MERGE" | "REBASE" = "SQUASH"): Promise<void> {
    await gql(
      `mutation enable($input: EnablePullRequestAutoMergeInput!) {
        enablePullRequestAutoMerge(input: $input) { pullRequest { id } }
      }`,
      { input: { pullRequestId: pullRequestNodeId, mergeMethod } }
    );
  }

  return {
    createRepoForUser,
    repoExists,
    setBranchProtection,
    getFileContent,
    commitFiles,
    openPullRequest,
    enableAutoMerge,
  };
}

// Plain-text base64 decoder that works in service worker + node + bun.
// GitHub's `contents` endpoint returns base64 with embedded newlines.
export function decodeBase64(b64: string): string {
  const cleaned = b64.replace(/\s+/g, "");
  if (typeof atob === "function") {
    const bin = atob(cleaned);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new TextDecoder("utf-8").decode(bytes);
  }
  return Buffer.from(cleaned, "base64").toString("utf-8");
}
