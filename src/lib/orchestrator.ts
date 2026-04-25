// Orchestrates a single submission sync: dedup → fetch detail → fetch problem
// meta → build files → content-equality check → commit → PR → auto-merge.
//
// Pure module: takes its dependencies (LeetCode client, GitHub client, dedup
// gate, config, optional notify/log) so it can be tested without touching
// chrome.* or the network. background.ts wires it up to the SW.

import type { ProblemMeta, SubmissionDetail } from "./leetcode";
import { buildTestsJson, extensionForLang, htmlToMarkdown } from "./leetcode";
import { contentMatches } from "./dedup";
import { generateBootstrapFiles, generateProblemFiles } from "./repo-bootstrap";

export interface SyncConfig {
  repoName: string;
  authorName: string;
  authorEmail: string;
  baseBranch: string;
  notificationsEnabled: boolean;
  requiredCheckContext: string;
}

export type SkipReason =
  | "already_processed"
  | "in_flight"
  | "unchanged"
  | "missing_detail"
  | "missing_problem_meta"
  | "no_username";

export type SyncOutcome =
  | {
      status: "synced";
      submissionId: string;
      pullRequestUrl: string;
      pullRequestNumber: number;
      branch: string;
    }
  | { status: "skipped"; submissionId: string; reason: SkipReason }
  | { status: "error"; submissionId: string; error: string };

export type LogLevel = "info" | "warn" | "error";

export interface OrchestratorDeps {
  leetcode: {
    fetchUsername(): Promise<string | null>;
    fetchSubmissionDetail(id: string | number): Promise<SubmissionDetail | null>;
    fetchProblemMeta(slug: string): Promise<ProblemMeta | null>;
    fetchRecentAcSubmissions(username: string, limit?: number): Promise<Array<{ id: string }>>;
  };
  github: {
    repoExists(): Promise<boolean>;
    createRepoForUser(opts: { name: string; description?: string; private?: boolean }): Promise<{ full_name: string }>;
    setBranchProtection(branch: string, requiredCheck: string): Promise<void>;
    getFileContent(path: string, ref?: string): Promise<string | null>;
    commitFiles(opts: {
      branch: string;
      baseBranch: string;
      files: Array<{ path: string; content: string }>;
      message: string;
      author: { name: string; email: string };
    }): Promise<{ commitSha: string }>;
    openPullRequest(opts: {
      branch: string;
      baseBranch: string;
      title: string;
      body: string;
    }): Promise<{ number: number; node_id: string; html_url: string }>;
    enableAutoMerge(nodeId: string, mergeMethod?: "SQUASH" | "MERGE" | "REBASE"): Promise<void>;
  };
  dedup: {
    hasBeenProcessed(id: string): Promise<boolean>;
    tryAcquireLock(id: string): { release: () => void } | null;
    markProcessed(id: string): Promise<void>;
    getLastSyncedId(): Promise<string | null>;
  };
  config: SyncConfig;
  notify?: (title: string, message: string, url?: string) => void;
  log?: (level: LogLevel, message: string, extra?: unknown) => void;
}

export function createOrchestrator(deps: OrchestratorDeps) {
  const log = deps.log ?? (() => {});
  const notify = deps.notify ?? (() => {});

  async function ensureRepoExists(): Promise<{ created: boolean }> {
    if (await deps.github.repoExists()) return { created: false };

    log("info", `Creating sync repo: ${deps.config.repoName}`);
    await deps.github.createRepoForUser({
      name: deps.config.repoName,
      description: "Auto-synced LeetCode solutions with a Python test harness.",
    });

    const bootstrap = generateBootstrapFiles({
      projectName: deps.config.repoName,
      description: "Auto-synced LeetCode solutions with a Python test harness.",
    });
    const branch = `bootstrap-${Date.now()}`;
    await deps.github.commitFiles({
      branch,
      baseBranch: deps.config.baseBranch,
      files: bootstrap,
      message: "Bootstrap sync repo",
      author: { name: deps.config.authorName, email: deps.config.authorEmail },
    });
    const pr = await deps.github.openPullRequest({
      branch,
      baseBranch: deps.config.baseBranch,
      title: "Bootstrap sync repo",
      body: "Initial scaffold: pyproject.toml, pytest harness, helpers, GitHub Actions workflow.",
    });
    try {
      await deps.github.enableAutoMerge(pr.node_id);
    } catch (e) {
      log("warn", "auto-merge could not be enabled on bootstrap PR", e);
    }
    return { created: true };
  }

  async function syncSubmission(submissionId: string): Promise<SyncOutcome> {
    const idStr = String(submissionId);

    if (await deps.dedup.hasBeenProcessed(idStr)) {
      return { status: "skipped", submissionId: idStr, reason: "already_processed" };
    }

    const lock = deps.dedup.tryAcquireLock(idStr);
    if (!lock) return { status: "skipped", submissionId: idStr, reason: "in_flight" };

    try {
      const detail = await deps.leetcode.fetchSubmissionDetail(idStr);
      if (!detail) return { status: "skipped", submissionId: idStr, reason: "missing_detail" };

      const problem = await deps.leetcode.fetchProblemMeta(detail.question.titleSlug);
      if (!problem) return { status: "skipped", submissionId: idStr, reason: "missing_problem_meta" };

      const testsJson = buildTestsJson(problem);
      const langExt = extensionForLang(detail.lang.name);
      const generated = generateProblemFiles({
        questionFrontendId: problem.questionFrontendId,
        titleSlug: problem.titleSlug,
        title: problem.title,
        difficulty: problem.difficulty,
        langExt,
        code: detail.code,
        testsJson,
        problemMarkdown: htmlToMarkdown(problem.content),
        runtimeDisplay: detail.runtimeDisplay,
        memoryDisplay: detail.memoryDisplay,
        runtimePercentile: detail.runtimePercentile,
        memoryPercentile: detail.memoryPercentile,
        topicTags: problem.topicTags.map(t => t.name),
      });

      // Layer 3 dedup: identical solution? Skip without committing.
      const solutionFile = generated.files.find(f => f.path.includes("/solution."));
      if (solutionFile) {
        const existing = await safeGetFileContent(solutionFile.path);
        if (contentMatches(existing, solutionFile.content)) {
          await deps.dedup.markProcessed(idStr);
          return { status: "skipped", submissionId: idStr, reason: "unchanged" };
        }
      }

      const branch = `leetcode/${problem.questionFrontendId.padStart(4, "0")}-${problem.titleSlug}-${idStr}`;
      const commitMsg = `${problem.questionFrontendId}. ${problem.title}`;

      await deps.github.commitFiles({
        branch,
        baseBranch: deps.config.baseBranch,
        files: generated.files,
        message: commitMsg,
        author: { name: deps.config.authorName, email: deps.config.authorEmail },
      });

      const pr = await deps.github.openPullRequest({
        branch,
        baseBranch: deps.config.baseBranch,
        title: commitMsg,
        body: prBody(detail, problem),
      });

      try {
        await deps.github.enableAutoMerge(pr.node_id);
      } catch (e) {
        log("warn", `auto-merge enable failed for PR #${pr.number}`, e);
      }

      await deps.dedup.markProcessed(idStr);

      if (deps.config.notificationsEnabled) {
        notify(`${problem.questionFrontendId}. ${problem.title} synced`, `PR #${pr.number}`, pr.html_url);
      }

      log("info", `Synced submission ${idStr} → PR #${pr.number}`);

      return {
        status: "synced",
        submissionId: idStr,
        pullRequestUrl: pr.html_url,
        pullRequestNumber: pr.number,
        branch,
      };
    } catch (e) {
      log("error", `Sync failed for submission ${idStr}`, e);
      return { status: "error", submissionId: idStr, error: e instanceof Error ? e.message : String(e) };
    } finally {
      lock.release();
    }
  }

  async function safetyPoll(): Promise<SyncOutcome[]> {
    const username = await deps.leetcode.fetchUsername();
    if (!username) return [{ status: "skipped", submissionId: "n/a", reason: "no_username" }];

    const recent = await deps.leetcode.fetchRecentAcSubmissions(username, 20);
    const lastSynced = await deps.dedup.getLastSyncedId();
    const candidates = lastSynced
      ? recent.filter(s => Number(s.id) > Number(lastSynced))
      : recent;

    // Process oldest-first so the high-water mark advances monotonically.
    const ordered = [...candidates].sort((a, b) => Number(a.id) - Number(b.id));

    const outcomes: SyncOutcome[] = [];
    for (const sub of ordered) {
      outcomes.push(await syncSubmission(sub.id));
    }
    return outcomes;
  }

  async function safeGetFileContent(path: string): Promise<string | null> {
    try {
      return await deps.github.getFileContent(path);
    } catch {
      return null;
    }
  }

  return { syncSubmission, safetyPoll, ensureRepoExists };
}

function prBody(detail: SubmissionDetail, problem: ProblemMeta): string {
  return [
    `Auto-synced from LeetCode.`,
    ``,
    `**Difficulty:** ${problem.difficulty}`,
    `**Runtime:** ${detail.runtimeDisplay} (faster than ${detail.runtimePercentile.toFixed(2)}%)`,
    `**Memory:** ${detail.memoryDisplay} (less than ${detail.memoryPercentile.toFixed(2)}%)`,
    ``,
    `[View on LeetCode](https://leetcode.com/problems/${problem.titleSlug}/)`,
  ].join("\n");
}
