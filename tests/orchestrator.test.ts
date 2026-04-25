import { describe, expect, test, mock, beforeEach } from "bun:test";
import { createOrchestrator, type OrchestratorDeps, type SyncConfig } from "../src/lib/orchestrator";
import type { ProblemMeta, SubmissionDetail } from "../src/lib/leetcode";

const baseConfig: SyncConfig = {
  repoName: "leetcode",
  authorName: "Test Author",
  authorEmail: "test@example.com",
  baseBranch: "main",
  notificationsEnabled: true,
  requiredCheckContext: "pytest",
};

function makeDetail(overrides: Partial<SubmissionDetail> = {}): SubmissionDetail {
  return {
    runtime: 50,
    runtimeDisplay: "50 ms",
    runtimePercentile: 90.5,
    memory: 17.4,
    memoryDisplay: "17.4 MB",
    memoryPercentile: 65.0,
    code: "class Solution:\n    def twoSum(self, nums, target):\n        pass\n",
    timestamp: 1700000000,
    statusCode: 10,
    lang: { name: "python3", verboseName: "Python 3" },
    question: {
      questionId: "1",
      questionFrontendId: "1",
      titleSlug: "two-sum",
      title: "Two Sum",
      difficulty: "Easy",
    },
    ...overrides,
  };
}

function makeProblem(overrides: Partial<ProblemMeta> = {}): ProblemMeta {
  return {
    questionFrontendId: "1",
    title: "Two Sum",
    titleSlug: "two-sum",
    difficulty: "Easy",
    content: "<p>Given an array...</p>",
    topicTags: [{ name: "Array", slug: "array" }],
    sampleTestCase: "[2,7,11,15]\n9",
    exampleTestcaseList: ["[2,7,11,15]\n9"],
    metaData: JSON.stringify({
      name: "twoSum",
      params: [
        { name: "nums", type: "integer[]" },
        { name: "target", type: "integer" },
      ],
      return: { type: "integer[]" },
    }),
    ...overrides,
  };
}

function makeDeps(overrides: Partial<OrchestratorDeps> = {}): OrchestratorDeps {
  const dedupState = { processed: new Set<string>(), inFlight: new Set<string>(), lastSynced: null as string | null };

  return {
    leetcode: {
      fetchUsername: mock(async () => "testuser"),
      fetchSubmissionDetail: mock(async () => makeDetail()),
      fetchProblemMeta: mock(async () => makeProblem()),
      fetchRecentAcSubmissions: mock(async () => []),
    },
    github: {
      repoExists: mock(async () => true),
      createRepoForUser: mock(async () => ({ full_name: "testuser/leetcode" })),
      setBranchProtection: mock(async () => undefined),
      getFileContent: mock(async () => null),
      commitFiles: mock(async () => ({ commitSha: "abc123" })),
      openPullRequest: mock(async () => ({ number: 42, node_id: "PR_node", html_url: "https://github.com/x/y/pull/42" })),
      enableAutoMerge: mock(async () => undefined),
    },
    dedup: {
      hasBeenProcessed: mock(async (id: string) => dedupState.processed.has(id)),
      tryAcquireLock: mock((id: string) => {
        if (dedupState.inFlight.has(id)) return null;
        dedupState.inFlight.add(id);
        return { release: () => dedupState.inFlight.delete(id) };
      }),
      markProcessed: mock(async (id: string) => {
        dedupState.processed.add(id);
        if (!dedupState.lastSynced || Number(id) > Number(dedupState.lastSynced)) {
          dedupState.lastSynced = id;
        }
      }),
      getLastSyncedId: mock(async () => dedupState.lastSynced),
    },
    config: baseConfig,
    ...overrides,
  };
}

describe("syncSubmission — happy path", () => {
  test("commits files, opens PR, enables auto-merge, marks processed", async () => {
    const deps = makeDeps();
    const orch = createOrchestrator(deps);

    const result = await orch.syncSubmission("12345");

    expect(result.status).toBe("synced");
    if (result.status !== "synced") throw new Error("type narrow");
    expect(result.pullRequestNumber).toBe(42);
    expect(result.pullRequestUrl).toContain("/pull/42");
    expect(result.branch).toBe("leetcode/0001-two-sum-12345");

    expect(deps.github.commitFiles).toHaveBeenCalledTimes(1);
    expect(deps.github.openPullRequest).toHaveBeenCalledTimes(1);
    expect(deps.github.enableAutoMerge).toHaveBeenCalledTimes(1);
    expect(deps.dedup.markProcessed).toHaveBeenCalledWith("12345");
  });

  test("commit author and message use the configured values", async () => {
    const deps = makeDeps();
    const orch = createOrchestrator(deps);
    await orch.syncSubmission("12345");

    const commit = (deps.github.commitFiles as unknown as { mock: { calls: unknown[][] } }).mock.calls[0]![0] as {
      author: { name: string; email: string };
      message: string;
      baseBranch: string;
    };
    expect(commit.author).toEqual({ name: "Test Author", email: "test@example.com" });
    expect(commit.message).toBe("1. Two Sum");
    expect(commit.baseBranch).toBe("main");
  });

  test("commits all three problem files (solution, tests.json, README)", async () => {
    const deps = makeDeps();
    const orch = createOrchestrator(deps);
    await orch.syncSubmission("12345");
    const commit = (deps.github.commitFiles as unknown as { mock: { calls: unknown[][] } }).mock.calls[0]![0] as {
      files: Array<{ path: string }>;
    };
    const paths = commit.files.map(f => f.path).sort();
    expect(paths).toEqual([
      "solutions/0001-two-sum/README.md",
      "solutions/0001-two-sum/solution.py",
      "solutions/0001-two-sum/tests.json",
    ]);
  });

  test("PR title and body include the problem title, runtime, memory", async () => {
    const deps = makeDeps();
    const orch = createOrchestrator(deps);
    await orch.syncSubmission("12345");
    const pr = (deps.github.openPullRequest as unknown as { mock: { calls: unknown[][] } }).mock.calls[0]![0] as {
      title: string;
      body: string;
    };
    expect(pr.title).toBe("1. Two Sum");
    expect(pr.body).toContain("50 ms");
    expect(pr.body).toContain("17.4 MB");
    expect(pr.body).toContain("Easy");
    expect(pr.body).toContain("two-sum");
  });

  test("fires notification when notifications enabled", async () => {
    const notify = mock(() => {});
    const deps = makeDeps({ notify });
    const orch = createOrchestrator(deps);
    await orch.syncSubmission("12345");
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify.mock.calls[0]![0]).toContain("Two Sum");
  });

  test("does not fire notification when notifications disabled", async () => {
    const notify = mock(() => {});
    const deps = makeDeps({ notify, config: { ...baseConfig, notificationsEnabled: false } });
    const orch = createOrchestrator(deps);
    await orch.syncSubmission("12345");
    expect(notify).not.toHaveBeenCalled();
  });
});

describe("syncSubmission — dedup gates", () => {
  test("Layer 2 (already processed) bails out before any GitHub call", async () => {
    const deps = makeDeps();
    deps.dedup.hasBeenProcessed = mock(async () => true);
    const orch = createOrchestrator(deps);

    const result = await orch.syncSubmission("12345");

    expect(result).toEqual({ status: "skipped", submissionId: "12345", reason: "already_processed" });
    expect(deps.leetcode.fetchSubmissionDetail).not.toHaveBeenCalled();
    expect(deps.github.commitFiles).not.toHaveBeenCalled();
  });

  test("Layer 1 (in-flight lock) bails out without releasing or marking", async () => {
    const deps = makeDeps();
    deps.dedup.tryAcquireLock = mock(() => null);
    const orch = createOrchestrator(deps);

    const result = await orch.syncSubmission("12345");

    expect(result).toEqual({ status: "skipped", submissionId: "12345", reason: "in_flight" });
    expect(deps.leetcode.fetchSubmissionDetail).not.toHaveBeenCalled();
    expect(deps.dedup.markProcessed).not.toHaveBeenCalled();
  });

  test("Layer 3 (content equality) skips commit and marks processed", async () => {
    const deps = makeDeps();
    // Pre-existing file matches what we'd commit
    deps.github.getFileContent = mock(async () => makeDetail().code);
    const orch = createOrchestrator(deps);

    const result = await orch.syncSubmission("12345");

    expect(result).toEqual({ status: "skipped", submissionId: "12345", reason: "unchanged" });
    expect(deps.github.commitFiles).not.toHaveBeenCalled();
    expect(deps.github.openPullRequest).not.toHaveBeenCalled();
    expect(deps.dedup.markProcessed).toHaveBeenCalledWith("12345");
  });

  test("Layer 3 tolerates getFileContent throwing (treats as missing → commits)", async () => {
    const deps = makeDeps();
    deps.github.getFileContent = mock(async () => {
      throw new Error("rate limited");
    });
    const orch = createOrchestrator(deps);

    const result = await orch.syncSubmission("12345");

    expect(result.status).toBe("synced");
    expect(deps.github.commitFiles).toHaveBeenCalled();
  });
});

describe("syncSubmission — missing data", () => {
  test("missing submission detail → skipped", async () => {
    const deps = makeDeps();
    deps.leetcode.fetchSubmissionDetail = mock(async () => null);
    const orch = createOrchestrator(deps);

    const result = await orch.syncSubmission("12345");

    expect(result).toEqual({ status: "skipped", submissionId: "12345", reason: "missing_detail" });
    expect(deps.github.commitFiles).not.toHaveBeenCalled();
  });

  test("missing problem meta → skipped", async () => {
    const deps = makeDeps();
    deps.leetcode.fetchProblemMeta = mock(async () => null);
    const orch = createOrchestrator(deps);

    const result = await orch.syncSubmission("12345");

    expect(result).toEqual({ status: "skipped", submissionId: "12345", reason: "missing_problem_meta" });
  });
});

describe("syncSubmission — error handling", () => {
  test("commit failure surfaces as error outcome but lock is released", async () => {
    const deps = makeDeps();
    deps.github.commitFiles = mock(async () => {
      throw new Error("commit failed: 422 unprocessable");
    });
    const orch = createOrchestrator(deps);

    const result = await orch.syncSubmission("12345");

    expect(result.status).toBe("error");
    if (result.status !== "error") throw new Error("type narrow");
    expect(result.error).toContain("commit failed");
    // Lock should be released — a retry should be able to acquire it
    expect(deps.dedup.tryAcquireLock("12345")).not.toBeNull();
  });

  test("auto-merge failure does not fail the sync (PR is still useful)", async () => {
    const deps = makeDeps();
    deps.github.enableAutoMerge = mock(async () => {
      throw new Error("auto-merge not available");
    });
    const log = mock(() => {});
    const orch = createOrchestrator({ ...deps, log });

    const result = await orch.syncSubmission("12345");

    expect(result.status).toBe("synced");
    expect(deps.dedup.markProcessed).toHaveBeenCalled();
    expect(log).toHaveBeenCalled();
  });
});

describe("safetyPoll", () => {
  test("returns no_username when not signed in", async () => {
    const deps = makeDeps();
    deps.leetcode.fetchUsername = mock(async () => null);
    const orch = createOrchestrator(deps);

    const results = await orch.safetyPoll();

    expect(results).toHaveLength(1);
    expect(results[0]).toEqual({ status: "skipped", submissionId: "n/a", reason: "no_username" });
    expect(deps.leetcode.fetchRecentAcSubmissions).not.toHaveBeenCalled();
  });

  test("processes only submissions with id > lastSyncedId", async () => {
    const deps = makeDeps();
    deps.dedup.getLastSyncedId = mock(async () => "100");
    deps.leetcode.fetchRecentAcSubmissions = mock(async () => [
      { id: "150" },
      { id: "120" },
      { id: "90" },  // older than lastSynced — should be skipped
      { id: "50" },  // older — skipped
    ]);
    const orch = createOrchestrator(deps);

    await orch.safetyPoll();

    // Only 150 and 120 should be synced — 2 syncSubmission calls
    expect(deps.leetcode.fetchSubmissionDetail).toHaveBeenCalledTimes(2);
  });

  test("processes oldest-first so high-water mark advances monotonically", async () => {
    const calls: string[] = [];
    const deps = makeDeps();
    deps.dedup.getLastSyncedId = mock(async () => null);
    deps.leetcode.fetchRecentAcSubmissions = mock(async () => [
      { id: "200" },
      { id: "100" },
      { id: "150" },
    ]);
    deps.leetcode.fetchSubmissionDetail = mock(async (id) => {
      calls.push(String(id));
      return makeDetail();
    });
    const orch = createOrchestrator(deps);

    await orch.safetyPoll();

    expect(calls).toEqual(["100", "150", "200"]);
  });

  test("no lastSyncedId → processes all returned submissions", async () => {
    const deps = makeDeps();
    deps.dedup.getLastSyncedId = mock(async () => null);
    deps.leetcode.fetchRecentAcSubmissions = mock(async () => [
      { id: "1" }, { id: "2" }, { id: "3" },
    ]);
    const orch = createOrchestrator(deps);

    const results = await orch.safetyPoll();

    expect(results).toHaveLength(3);
    expect(results.every(r => r.status === "synced")).toBe(true);
  });
});

describe("ensureRepoExists", () => {
  test("no-op when repo already exists", async () => {
    const deps = makeDeps();
    deps.github.repoExists = mock(async () => true);
    const orch = createOrchestrator(deps);

    const result = await orch.ensureRepoExists();

    expect(result.created).toBe(false);
    expect(deps.github.createRepoForUser).not.toHaveBeenCalled();
    expect(deps.github.commitFiles).not.toHaveBeenCalled();
  });

  test("creates repo and commits bootstrap files in a PR when missing", async () => {
    const deps = makeDeps();
    deps.github.repoExists = mock(async () => false);
    const orch = createOrchestrator(deps);

    const result = await orch.ensureRepoExists();

    expect(result.created).toBe(true);
    expect(deps.github.createRepoForUser).toHaveBeenCalledWith({
      name: "leetcode",
      description: expect.any(String),
    });
    expect(deps.github.commitFiles).toHaveBeenCalledTimes(1);
    expect(deps.github.openPullRequest).toHaveBeenCalledTimes(1);
    expect(deps.github.enableAutoMerge).toHaveBeenCalledTimes(1);

    const commit = (deps.github.commitFiles as unknown as { mock: { calls: unknown[][] } }).mock.calls[0]![0] as {
      files: Array<{ path: string }>;
      branch: string;
    };
    expect(commit.branch).toMatch(/^bootstrap-\d+$/);
    expect(commit.files.some(f => f.path === "pyproject.toml")).toBe(true);
    expect(commit.files.some(f => f.path === "solutions/conftest.py")).toBe(true);
    expect(commit.files.some(f => f.path === "solutions/test_solutions.py")).toBe(true);
  });

  test("tolerates auto-merge failure on bootstrap PR", async () => {
    const deps = makeDeps();
    deps.github.repoExists = mock(async () => false);
    deps.github.enableAutoMerge = mock(async () => {
      throw new Error("not enabled yet");
    });
    const log = mock(() => {});
    const orch = createOrchestrator({ ...deps, log });

    await expect(orch.ensureRepoExists()).resolves.toEqual({ created: true });
  });
});
