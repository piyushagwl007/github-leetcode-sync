import { describe, expect, test, mock } from "bun:test";
import { createGitHubClient, decodeBase64, type GitHubDeps } from "../src/lib/github";

// Helper: mock fetch that returns scripted responses by URL+method.
type Route = {
  match: (url: string, init: RequestInit) => boolean;
  respond: (url: string, init: RequestInit) => Response;
};

function makeFetch(routes: Route[]) {
  return mock(async (url: string | URL | Request, init?: RequestInit) => {
    const u = typeof url === "string" ? url : url.toString();
    const i = init ?? {};
    const route = routes.find(r => r.match(u, i));
    if (!route) throw new Error(`Unrouted fetch: ${i.method ?? "GET"} ${u}`);
    return route.respond(u, i);
  });
}

function makeDeps(fetchFn: ReturnType<typeof makeFetch>): GitHubDeps {
  return {
    fetchFn: fetchFn as unknown as typeof fetch,
    token: "ghp_xxx",
    owner: "alice",
    repo: "myrepo",
  };
}

function jsonRes(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

describe("authHeaders (via any rest call)", () => {
  test("includes Bearer auth, github accept, and User-Agent", async () => {
    const fetchFn = makeFetch([
      { match: () => true, respond: () => jsonRes({}) },
    ]);
    const client = createGitHubClient(makeDeps(fetchFn));
    await client.repoExists();
    const [, init] = fetchFn.mock.calls[0]!;
    const headers = (init as RequestInit).headers as Record<string, string>;
    expect(headers["Authorization"]).toBe("Bearer ghp_xxx");
    expect(headers["Accept"]).toBe("application/vnd.github+json");
    expect(headers["User-Agent"]).toBe("github-leetcode-sync");
    expect(headers["X-GitHub-Api-Version"]).toBe("2022-11-28");
  });
});

describe("createRepoForUser", () => {
  test("POSTs to /user/repos with auto-merge friendly defaults", async () => {
    const fetchFn = makeFetch([
      {
        match: (u, i) => u.endsWith("/user/repos") && i.method === "POST",
        respond: () => jsonRes({ full_name: "alice/newrepo" }),
      },
    ]);
    const client = createGitHubClient(makeDeps(fetchFn));

    const result = await client.createRepoForUser({ name: "newrepo", description: "hi" });

    expect(result.full_name).toBe("alice/newrepo");
    const [, init] = fetchFn.mock.calls[0]!;
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body.name).toBe("newrepo");
    expect(body.description).toBe("hi");
    expect(body.private).toBe(false);
    expect(body.auto_init).toBe(true);
    expect(body.allow_auto_merge).toBe(true);
    expect(body.allow_squash_merge).toBe(true);
    expect(body.allow_merge_commit).toBe(false);
    expect(body.allow_rebase_merge).toBe(false);
    expect(body.delete_branch_on_merge).toBe(true);
  });

  test("supports private repos and missing description", async () => {
    const fetchFn = makeFetch([
      { match: () => true, respond: () => jsonRes({ full_name: "alice/r" }) },
    ]);
    const client = createGitHubClient(makeDeps(fetchFn));
    await client.createRepoForUser({ name: "r", private: true });
    const body = JSON.parse((fetchFn.mock.calls[0]![1] as RequestInit).body as string);
    expect(body.private).toBe(true);
    expect(body.description).toBe("");
  });

  test("propagates HTTP errors with status and body", async () => {
    const fetchFn = makeFetch([
      { match: () => true, respond: () => new Response("name taken", { status: 422 }) },
    ]);
    const client = createGitHubClient(makeDeps(fetchFn));
    await expect(client.createRepoForUser({ name: "r" })).rejects.toThrow(/422.*name taken/);
  });
});

describe("repoExists", () => {
  test("returns true on 200", async () => {
    const fetchFn = makeFetch([{ match: () => true, respond: () => jsonRes({ id: 1 }) }]);
    const client = createGitHubClient(makeDeps(fetchFn));
    expect(await client.repoExists()).toBe(true);
  });

  test("returns false on 404", async () => {
    const fetchFn = makeFetch([
      { match: () => true, respond: () => new Response("not found", { status: 404 }) },
    ]);
    const client = createGitHubClient(makeDeps(fetchFn));
    expect(await client.repoExists()).toBe(false);
  });

  test("throws on other errors", async () => {
    const fetchFn = makeFetch([
      { match: () => true, respond: () => new Response("server down", { status: 500 }) },
    ]);
    const client = createGitHubClient(makeDeps(fetchFn));
    await expect(client.repoExists()).rejects.toThrow(/500.*server down/);
  });
});

describe("getFileContent", () => {
  test("returns decoded base64 content on 200", async () => {
    const fetchFn = makeFetch([
      {
        match: u => u.includes("/contents/"),
        respond: () => jsonRes({ content: btoa("hello world\n"), encoding: "base64" }),
      },
    ]);
    const client = createGitHubClient(makeDeps(fetchFn));
    expect(await client.getFileContent("foo.txt")).toBe("hello world\n");
  });

  test("returns null on 404", async () => {
    const fetchFn = makeFetch([
      { match: () => true, respond: () => new Response("nope", { status: 404 }) },
    ]);
    const client = createGitHubClient(makeDeps(fetchFn));
    expect(await client.getFileContent("missing.txt")).toBeNull();
  });

  test("returns empty string when file is empty", async () => {
    const fetchFn = makeFetch([
      { match: () => true, respond: () => jsonRes({ encoding: "base64" }) },
    ]);
    const client = createGitHubClient(makeDeps(fetchFn));
    expect(await client.getFileContent("empty.txt")).toBe("");
  });

  test("appends ?ref= when ref is provided", async () => {
    const fetchFn = makeFetch([
      {
        match: u => u.includes("?ref=feature"),
        respond: () => jsonRes({ content: btoa("x"), encoding: "base64" }),
      },
    ]);
    const client = createGitHubClient(makeDeps(fetchFn));
    expect(await client.getFileContent("a.txt", "feature")).toBe("x");
  });
});

describe("commitFiles (Git Data API dance)", () => {
  test("does the full 5-step dance and returns the new commit sha", async () => {
    const calls: string[] = [];
    const fetchFn = makeFetch([
      {
        match: u => u.includes("/git/ref/heads/main"),
        respond: u => {
          calls.push(`GET ${u}`);
          return jsonRes({ object: { sha: "base-commit-sha" } });
        },
      },
      {
        match: u => u.includes("/git/commits/base-commit-sha"),
        respond: u => {
          calls.push(`GET ${u}`);
          return jsonRes({ tree: { sha: "base-tree-sha" } });
        },
      },
      {
        match: (u, i) => u.endsWith("/git/blobs") && i.method === "POST",
        respond: (u, i) => {
          const body = JSON.parse(i.body as string);
          calls.push(`POST blob ${body.content.length}b`);
          return jsonRes({ sha: `blob-sha-${body.content.length}` });
        },
      },
      {
        match: (u, i) => u.endsWith("/git/trees") && i.method === "POST",
        respond: (u, i) => {
          calls.push(`POST tree`);
          const body = JSON.parse(i.body as string);
          expect(body.base_tree).toBe("base-tree-sha");
          expect(body.tree).toHaveLength(2);
          expect(body.tree[0].mode).toBe("100644");
          return jsonRes({ sha: "new-tree-sha" });
        },
      },
      {
        match: (u, i) => u.endsWith("/git/commits") && i.method === "POST",
        respond: (u, i) => {
          calls.push(`POST commit`);
          const body = JSON.parse(i.body as string);
          expect(body.tree).toBe("new-tree-sha");
          expect(body.parents).toEqual(["base-commit-sha"]);
          expect(body.author).toEqual({ name: "Author", email: "a@b.c" });
          return jsonRes({ sha: "new-commit-sha" });
        },
      },
      {
        match: (u, i) => u.endsWith("/git/refs") && i.method === "POST",
        respond: (u, i) => {
          calls.push(`POST ref`);
          const body = JSON.parse(i.body as string);
          expect(body.ref).toBe("refs/heads/feature");
          expect(body.sha).toBe("new-commit-sha");
          return jsonRes({});
        },
      },
    ]);
    const client = createGitHubClient(makeDeps(fetchFn));

    const result = await client.commitFiles({
      branch: "feature",
      baseBranch: "main",
      files: [
        { path: "a.txt", content: "AAA" },
        { path: "dir/b.txt", content: "BBBB" },
      ],
      message: "test commit",
      author: { name: "Author", email: "a@b.c" },
    });

    expect(result.commitSha).toBe("new-commit-sha");
    expect(calls.length).toBeGreaterThanOrEqual(6);
    expect(calls[0]).toContain("GET");
    expect(calls.at(-1)).toBe("POST ref");
  });

  test("rejects when given empty files array", async () => {
    const fetchFn = makeFetch([{ match: () => true, respond: () => jsonRes({}) }]);
    const client = createGitHubClient(makeDeps(fetchFn));
    await expect(
      client.commitFiles({
        branch: "x",
        baseBranch: "main",
        files: [],
        message: "m",
        author: { name: "n", email: "e" },
      })
    ).rejects.toThrow(/no files/);
  });
});

describe("openPullRequest", () => {
  test("POSTs to /pulls with head/base/title/body and returns metadata", async () => {
    const fetchFn = makeFetch([
      {
        match: (u, i) => u.endsWith("/pulls") && i.method === "POST",
        respond: () => jsonRes({ number: 42, node_id: "PR_node_id", html_url: "https://x" }),
      },
    ]);
    const client = createGitHubClient(makeDeps(fetchFn));

    const result = await client.openPullRequest({
      branch: "feature",
      baseBranch: "main",
      title: "T",
      body: "B",
    });

    expect(result.number).toBe(42);
    expect(result.node_id).toBe("PR_node_id");
    const body = JSON.parse((fetchFn.mock.calls[0]![1] as RequestInit).body as string);
    expect(body.head).toBe("feature");
    expect(body.base).toBe("main");
    expect(body.title).toBe("T");
    expect(body.body).toBe("B");
    expect(body.maintainer_can_modify).toBe(true);
  });
});

describe("enableAutoMerge", () => {
  test("issues GraphQL enablePullRequestAutoMerge mutation with SQUASH", async () => {
    const fetchFn = makeFetch([
      {
        match: u => u === "https://api.github.com/graphql",
        respond: () => jsonRes({ data: { enablePullRequestAutoMerge: { pullRequest: { id: "x" } } } }),
      },
    ]);
    const client = createGitHubClient(makeDeps(fetchFn));

    await client.enableAutoMerge("PR_node_id");

    const body = JSON.parse((fetchFn.mock.calls[0]![1] as RequestInit).body as string);
    expect(body.query).toContain("enablePullRequestAutoMerge");
    expect(body.variables.input.pullRequestId).toBe("PR_node_id");
    expect(body.variables.input.mergeMethod).toBe("SQUASH");
  });

  test("supports overriding merge method", async () => {
    const fetchFn = makeFetch([
      { match: () => true, respond: () => jsonRes({ data: { enablePullRequestAutoMerge: { pullRequest: { id: "x" } } } }) },
    ]);
    const client = createGitHubClient(makeDeps(fetchFn));
    await client.enableAutoMerge("id", "REBASE");
    const body = JSON.parse((fetchFn.mock.calls[0]![1] as RequestInit).body as string);
    expect(body.variables.input.mergeMethod).toBe("REBASE");
  });

  test("propagates GraphQL errors", async () => {
    const fetchFn = makeFetch([
      { match: () => true, respond: () => jsonRes({ errors: [{ message: "PR not mergeable" }] }) },
    ]);
    const client = createGitHubClient(makeDeps(fetchFn));
    await expect(client.enableAutoMerge("id")).rejects.toThrow(/PR not mergeable/);
  });
});

describe("setBranchProtection", () => {
  test("PUTs the protection payload with strict required check", async () => {
    const fetchFn = makeFetch([
      {
        match: (u, i) => u.includes("/branches/main/protection") && i.method === "PUT",
        respond: () => jsonRes({}),
      },
    ]);
    const client = createGitHubClient(makeDeps(fetchFn));

    await client.setBranchProtection("main", "test");

    const body = JSON.parse((fetchFn.mock.calls[0]![1] as RequestInit).body as string);
    expect(body.required_status_checks.strict).toBe(true);
    expect(body.required_status_checks.contexts).toEqual(["test"]);
    expect(body.allow_force_pushes).toBe(false);
    expect(body.enforce_admins).toBe(false);
  });
});

describe("decodeBase64", () => {
  test("decodes ascii", () => {
    expect(decodeBase64(btoa("hello"))).toBe("hello");
  });

  test("decodes utf-8", () => {
    const utf8Bytes = new TextEncoder().encode("héllo 🌍");
    let bin = "";
    for (const b of utf8Bytes) bin += String.fromCharCode(b);
    expect(decodeBase64(btoa(bin))).toBe("héllo 🌍");
  });

  test("strips embedded whitespace (GitHub returns multi-line base64)", () => {
    const input = btoa("hello world").replace(/(.{4})/g, "$1\n");
    expect(decodeBase64(input)).toBe("hello world");
  });
});
